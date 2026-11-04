import type { ActionCapture, CapturedInvocation } from '../action/capture.js'
import type { ReviewAction } from '../action/schema.js'
import type { ReviewSnapshot } from '../reviewer/snapshot.js'
import type { ReviewStatistics } from '../statistics/recorder.js'
import type { ManualStage } from '../statistics/summary.js'
import type { GrantHandle, InvocationIdentity } from './grants.js'
import type { DeniedAction } from './history.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import type {
  AuthorizerVerdict,
  PermissionDecisionEvent,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import { randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { inputDigest, projectSdkJson } from '../action/json.js'
import { EXTENSION_ID } from '../config/config.js'
import { genuineDirection, validateSession } from '../reviewer/snapshot.js'
import { canConfirm, confirmCapturedAction } from './confirmation.js'
import { InvocationGrants } from './grants.js'
import { DenialHistory, DenialReferenceError } from './history.js'
import { RejectionLedger } from './rejections.js'

export const MANUAL_APPROVAL_TOOL = 'request_manual_approval'
export const MANUAL_AUDIT_ENTRY_TYPE: string = `${EXTENSION_ID}:manual-audit.v1`
export const MAX_REASON_CHARACTERS = 2_000
const MAX_TRACKED = 1_024

const argumentsSchema = v.strictObject({
  denial_id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reason: v.pipe(
    v.string(),
    v.maxLength(MAX_REASON_CHARACTERS),
    v.check(reason => reason.trim() !== ''),
  ),
})

/** What the extension knows of the session when a manual approval is checked */
export interface ManualRuntime {
  context: Pick<ExtensionContext, 'cwd' | 'mode' | 'hasUI' | 'signal' | 'sessionManager'>
  sessionSignal: AbortSignal
  circuitOpen: () => boolean
  /** The session state now, with every pending provenance record written */
  snapshot: () => ReviewSnapshot
  statistics: ReviewStatistics | undefined
}

type AuditEvent =
  | 'approved'
  | 'rejected'
  | 'unavailable'
  | 'cancelled'
  | 'bound'
  | 'link_allowed'
  | 'dispatching'
  | 'completed'
  | 'failed'

interface Operation {
  epoch: number
  denial: DeniedAction
  reason: string
  wrapperToolCallId: string
  wrapperDigest: string
  fingerprint: string
  approvalId: string
  controller: AbortController
  handle: GrantHandle | undefined
  started: boolean
}

type ToolResult = Awaited<ReturnType<ExtensionToolContext['executeTool']>>['result']

class ManualApprovalError extends Error {
  readonly stage: ManualStage
  /** Why the request ended, for the statistics */
  readonly category: string | undefined
  /** Whether the statistics already contain this outcome */
  readonly recorded: boolean

  constructor(stage: ManualStage, message: string, options: { category?: string; recorded?: boolean } = {}) {
    super(message)
    this.name = 'ManualApprovalError'
    this.stage = stage
    this.category = options.category
    this.recorded = options.recorded ?? false
  }
}

function identity(invocation: CapturedInvocation | undefined): InvocationIdentity | undefined {
  if (invocation?.digest === undefined || invocation.registrationDigest === undefined) {
    return undefined
  }
  const { toolName, cwd, sessionId, digest, registrationDigest } = invocation

  return { toolName, cwd, sessionId, digest, registrationDigest }
}

function fingerprint(action: { toolName: string; cwd: string; digest: string }): string {
  return inputDigest({ toolName: action.toolName, cwd: action.cwd, digest: action.digest })
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason }
}

/**
 * Lets the model ask the person to run a shell call that automatic review refused, exactly as captured. The person
 * confirms the whole action, and the extension dispatches it once through Pi's normal tool path, where a grant lets
 * this extension allow that one nested call's asks
 */
export class ManualApprovalController {
  private readonly pi: Pick<ExtensionAPI, 'appendEntry' | 'on'>
  private readonly actions: Pick<ActionCapture, 'invocation' | 'onCaptured'>
  private readonly runtime: () => ManualRuntime | undefined
  private readonly history = new DenialHistory()
  private readonly grants = new InvocationGrants()
  private readonly operations = new Map<string, Operation>()
  /** Permission requests of operations, so their decisions can cancel them */
  private readonly requests = new Map<string, Operation>()
  private readonly finishedChildren = new Set<string>()
  private epoch = 0
  private rejections: RejectionLedger | undefined

  constructor(
    pi: Pick<ExtensionAPI, 'appendEntry' | 'on'>,
    actions: Pick<ActionCapture, 'invocation' | 'onCaptured'>,
    runtime: () => ManualRuntime | undefined,
  ) {
    this.pi = pi
    this.actions = actions
    this.runtime = runtime
    actions.onCaptured(invocation => this.captured(invocation))
    pi.on('message_end', event => {
      if (event.message.role === 'user') {
        this.invalidate()
      }
    })
    pi.on('agent_settled', () => this.invalidate())
    // A wrapper whose own ask was refused never reaches its body; that refusal counts as the person's rejection
    pi.on('tool_execution_end', event => {
      const operation = this.operations.get(event.toolCallId)
      if (operation !== undefined && !operation.started) {
        this.rejections?.reject(operation.fingerprint, 'manual-wrapper-blocked')
        this.runtime()?.statistics?.manual('blocked', { category: 'wrapper-blocked' })
        this.release(operation)
      }
    })
  }

  start(context: Pick<ExtensionContext, 'sessionManager'>): void {
    this.stop()
    this.rejections = new RejectionLedger({
      pi: this.pi,
      session: context.sessionManager,
      onIssue: () => {},
    })
  }

  /** Ends every pending request and approval; new user input, navigation and the end of a run all do this */
  invalidate(): void {
    this.epoch += 1
    for (const operation of [...this.operations.values()]) {
      this.release(operation)
    }
    this.grants.revokeAll()
    this.history.clear()
    this.requests.clear()
  }

  stop(): void {
    this.invalidate()
    this.rejections?.stop()
    this.rejections = undefined
  }

  /** The reference to offer with an automatic refusal, if the person can be asked about the action */
  refuse(action: ReviewAction, refusal: string, snapshot: ReviewSnapshot): string | undefined {
    const runtime = this.runtime()
    if (
      action.kind !== 'shell' ||
      action.registration === undefined ||
      runtime === undefined ||
      !canConfirm(runtime.context) ||
      !this.usable(runtime) ||
      this.reconsiderationBlocked(fingerprint(action), true)
    ) {
      return undefined
    }

    return this.history.remember({ action: { ...action, registration: action.registration }, snapshot, refusal })
  }

  /** The verdict for a manual request's own asks and for its dispatched call's asks; undefined for anything else */
  authorize(details: PromptPermissionDetails): AuthorizerVerdict | undefined {
    const id = details.toolCallId
    if (id === undefined) {
      return undefined
    }
    if (details.toolName === MANUAL_APPROVAL_TOOL) {
      const operation = this.operations.get(id)
      if (operation === undefined || details.forwarding !== undefined || !this.live(operation)) {
        return { kind: 'deny', reason: 'No current manual approval request exists for this call' }
      }
      this.track(details.requestId, operation)

      // Asking to appeal is not approval of the action, so the wrapper's own asks go to the next link or the person
      return { kind: 'defer' }
    }
    const child = [...this.operations.values()].find(operation => operation.handle?.childToolCallId === id)
    if (child !== undefined) {
      if (details.forwarding !== undefined || details.toolName !== child.denial.action.toolName) {
        return { kind: 'deny', reason: 'Manual approval cannot authorize a forwarded or substituted action' }
      }
      const verdict = this.grants.authorize(id, identity(this.actions.invocation(id))) ?? {
        kind: 'deny',
        reason: 'The manual approval was revoked',
      }
      this.track(details.requestId, child)
      if (verdict.kind === 'allow') {
        this.audit(child, 'link_allowed', details.requestId)
      }

      return verdict
    }

    return this.finishedChildren.has(id)
      ? { kind: 'deny', reason: 'This approved call has already finished' }
      : undefined
  }

  /** A refusal of one of an operation's asks ends the operation; a refusal by the person also records a rejection */
  decided(event: PermissionDecisionEvent): void {
    const operation = this.requests.get(event.requestId)
    if (operation === undefined) {
      return
    }
    this.requests.delete(event.requestId)
    if (event.result === 'deny') {
      if (event.resolution === 'user_denied') {
        this.rejections?.reject(operation.fingerprint, 'human-rejected')
      }
      operation.controller.abort()
    }
  }

  /** The body of `request_manual_approval` */
  async execute(
    wrapperToolCallId: string,
    input: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionToolContext,
  ): Promise<ToolResult> {
    const operation = this.operations.get(wrapperToolCallId)
    if (operation === undefined) {
      throw new DenialReferenceError('The manual approval request was not captured')
    }
    const statistics = this.runtime()?.statistics
    try {
      if (
        operation.started ||
        inputDigest(v.parse(argumentsSchema, input)) !== operation.wrapperDigest ||
        !this.current(operation)
      ) {
        throw new ManualApprovalError(
          'cancelled',
          'The manual approval request was cancelled, changed or already started',
          { category: 'context-changed' },
        )
      }
      operation.started = true
      const combined = AbortSignal.any([operation.controller.signal, ...(signal === undefined ? [] : [signal])])

      return await this.confirmAndRun(operation, combined, ctx)
    } catch (error) {
      const known = error instanceof ManualApprovalError ? error : undefined
      const stage = known?.stage ?? 'failed'
      if (stage !== 'rejected' && stage !== 'unavailable') {
        this.audit(operation, stage === 'cancelled' ? 'cancelled' : 'failed')
      }
      if (known?.recorded !== true) {
        statistics?.manual(stage, { category: known === undefined ? 'internal-error' : known.category })
      }
      throw error
    } finally {
      this.release(operation)
    }
  }

  private async confirmAndRun(
    operation: Operation,
    signal: AbortSignal,
    ctx: ExtensionToolContext,
  ): Promise<ToolResult> {
    const statistics = this.runtime()?.statistics
    const { action } = operation.denial
    const started = Date.now()
    const answer = await confirmCapturedAction(operation.denial, operation.reason, ctx, signal, () =>
      statistics?.manual('prompted'),
    )
    const waitMs = Math.max(0, Date.now() - started)
    if (answer !== 'approved') {
      const stage = answer === 'timed-out' ? 'cancelled' : answer
      statistics?.manual(stage, { waitMs, ...(answer === 'timed-out' ? { category: 'confirmation-timeout' } : {}) })
      if (answer === 'rejected') {
        this.rejections?.reject(operation.fingerprint, 'human-rejected')
      }
      this.audit(operation, stage)
      throw new ManualApprovalError(stage, `The manual approval was ${answer}`, { recorded: true })
    }
    statistics?.manual('approved', { waitMs })
    this.audit(operation, 'approved')
    if (
      !this.current(operation) ||
      ctx.cwd !== action.cwd ||
      ctx.sessionManager.getSessionId() !== action.sessionId ||
      !ctx.tools.some(tool => tool.name === action.toolName)
    ) {
      throw new ManualApprovalError('cancelled', 'The session changed, or the captured tool is unavailable', {
        category: 'context-changed',
      })
    }

    operation.handle = this.grants.arm(
      operation.wrapperToolCallId,
      {
        toolName: action.toolName,
        cwd: action.cwd,
        sessionId: action.sessionId,
        digest: action.digest,
        registrationDigest: inputDigest(projectSdkJson(action.registration)),
      },
      // The grant's identity covers the input and the tool, and the snapshot was compared just before arming
      () => !signal.aborted && this.live(operation),
    )
    this.audit(operation, 'dispatching')
    statistics?.manual('dispatched')
    const outcome = await ctx.executeTool(action.toolName, structuredClone(action.input), { signal })
    const executionMs = outcome.durationMs ?? 0
    // Pi reports a duration only for a call that ran; a blocked one has none
    if (outcome.durationMs !== undefined) {
      statistics?.manual('executed')
    }
    // Recorded first, so an unexpected result shape cannot lose the record of what ran
    if (outcome.isError) {
      const blocked = outcome.durationMs === undefined
      const stage = blocked ? 'blocked' : 'failed'
      statistics?.manual(stage, { executionMs, category: blocked ? 'execution-blocked' : 'execution-error' })
      this.audit(operation, 'failed')
      const text = outcome.result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
      throw new ManualApprovalError(stage, text || 'The approved call failed', { recorded: true })
    }
    statistics?.manual('completed', { executionMs })
    this.audit(operation, 'completed')

    return outcome.result
  }

  private captured(invocation: CapturedInvocation): ToolCallEventResult | undefined {
    try {
      if (this.finishedChildren.has(invocation.toolCallId)) {
        return block('This approved call has already finished')
      }
      const parent =
        invocation.parentToolCallId === undefined ? undefined : this.operations.get(invocation.parentToolCallId)
      if (parent !== undefined) {
        if (parent.handle === undefined) {
          return block('The manual approval is not armed')
        }
        const result = this.grants.observe(invocation.toolCallId, invocation.parentToolCallId, identity(invocation))
        if (result !== undefined) {
          return result
        }
        this.audit(parent, 'bound')

        return undefined
      }
      if (invocation.toolName === MANUAL_APPROVAL_TOOL) {
        return this.claim(invocation)
      }
      if (invocation.toolName === 'bash' && invocation.digest !== undefined) {
        const key = fingerprint({ toolName: invocation.toolName, cwd: invocation.cwd, digest: invocation.digest })
        if (this.reconsiderationBlocked(key, false) || this.pending(key)) {
          return block('The person rejected this action, or is deciding on it; new direction from them is needed first')
        }
      }

      return undefined
    } catch (error) {
      return block(error instanceof DenialReferenceError ? error.message : 'Manual approval validation failed')
    }
  }

  /** Claims the reference before any permission prompt for the request can appear */
  private claim(invocation: CapturedInvocation): ToolCallEventResult | undefined {
    const parsed = v.safeParse(argumentsSchema, invocation.input)
    if (invocation.digest === undefined || !parsed.success) {
      return block('A manual approval request needs a denial_id and a non-empty reason')
    }
    const captured = parsed.output
    const denial = this.history.peek(captured.denial_id)
    if (denial === undefined) {
      return block('Unknown, expired or already used denial reference')
    }
    const key = fingerprint(denial.action)
    if (this.reconsiderationBlocked(key, true)) {
      return block('The person rejected this action; new direction from them is needed first')
    }
    if (this.pending(key)) {
      return block('A manual approval request is already in progress for this action')
    }
    const operation: Operation = {
      epoch: this.epoch,
      denial: this.history.claim(captured.denial_id, invocation.toolCallId),
      reason: captured.reason.trim(),
      wrapperToolCallId: invocation.toolCallId,
      wrapperDigest: invocation.digest,
      fingerprint: key,
      approvalId: randomUUID(),
      controller: new AbortController(),
      handle: undefined,
      started: false,
    }
    if (!this.current(operation)) {
      this.history.release(invocation.toolCallId)
      return block('The session changed since the refusal')
    }
    this.operations.set(invocation.toolCallId, operation)
    this.runtime()?.statistics?.manual('requested')

    return undefined
  }

  private pending(key: string): boolean {
    return [...this.operations.values()].some(operation => operation.fingerprint === key)
  }

  private usable(runtime: ManualRuntime): boolean {
    return !runtime.circuitOpen() && !runtime.sessionSignal.aborted && runtime.context.signal?.aborted !== true
  }

  /**
   * Whether nothing has ended the request. New user input, the end of the run, navigation and a config change all
   * advance the epoch
   */
  private live(operation: Operation): boolean {
    const runtime = this.runtime()

    return (
      operation.epoch === this.epoch &&
      !operation.controller.signal.aborted &&
      runtime !== undefined &&
      this.usable(runtime) &&
      runtime.context.cwd === operation.denial.action.cwd &&
      this.actions.invocation(operation.wrapperToolCallId)?.digest === operation.wrapperDigest
    )
  }

  /**
   * Whether the request is live and the session still matches what the refusal judged. Compared at each decision, since
   * some changes, such as a context edit, advance no epoch
   */
  private current(operation: Operation): boolean {
    const runtime = this.runtime()

    return (
      this.live(operation) &&
      runtime !== undefined &&
      validateSession(operation.denial.snapshot, runtime.snapshot()) === 'current'
    )
  }

  private reconsiderationBlocked(key: string, appeal: boolean): boolean {
    const runtime = this.runtime()
    if (this.rejections === undefined || this.rejections.empty || runtime === undefined) {
      return false
    }

    return this.rejections.blocks(key, genuineDirection(runtime.snapshot().branch), appeal)
  }

  private track(requestId: string, operation: Operation): void {
    if (this.requests.size >= MAX_TRACKED && !this.requests.has(requestId)) {
      operation.controller.abort()
      return
    }
    this.requests.set(requestId, operation)
  }

  private audit(operation: Operation, event: AuditEvent, requestId?: string): void {
    const source =
      event === 'link_allowed' ? EXTENSION_ID : ['approved', 'rejected'].includes(event) ? 'host-ui' : 'execution'
    try {
      this.pi.appendEntry(MANUAL_AUDIT_ENTRY_TYPE, {
        approvalId: operation.approvalId,
        source,
        event,
        wrapperToolCallId: operation.wrapperToolCallId,
        ...(operation.handle?.childToolCallId === undefined
          ? {}
          : { childToolCallId: operation.handle.childToolCallId }),
        ...(requestId === undefined ? {} : { requestId }),
      })
    } catch {
      // The audit trail is diagnostic; a failed write must not change the outcome
    }
  }

  private release(operation: Operation): void {
    operation.controller.abort()
    operation.handle?.revoke()
    const child = operation.handle?.childToolCallId
    if (child !== undefined) {
      this.finishedChildren.add(child)
      if (this.finishedChildren.size > MAX_TRACKED) {
        this.finishedChildren.delete(this.finishedChildren.values().next().value!)
      }
    }
    if (this.operations.get(operation.wrapperToolCallId) === operation) {
      this.operations.delete(operation.wrapperToolCallId)
    }
    for (const [id, candidate] of this.requests) {
      if (candidate === operation) {
        this.requests.delete(id)
      }
    }
    this.history.release(operation.wrapperToolCallId)
  }
}
