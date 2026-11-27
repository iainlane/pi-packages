import type { ActionCapture } from '../action/capture.js'
import type { DirectEscalationRequest, ReviewRequest } from '../action/request.js'
import type { ReviewAction } from '../action/schema.js'
import type { AutoReviewConfig } from '../config/config.js'
import type { EscalationDecisionEntry } from '../escalation/decisions.js'
import type { Investigation, InvestigationOutcome, InvestigationRun } from '../investigation/investigation.js'
import type { ContextFile, Preset, ReviewFailure, ReviewFields, ReviewOutcome } from '../presets/presets.js'
import type { UserMessageProvenance } from '../provenance/provenance.js'
import type { ReviewStatistics } from '../statistics/recorder.js'
import type { ReviewConversation } from './conversation.js'
import type { CallUsage, ModelCall } from './model-call.js'
import type { ReviewModelRegistry } from './model.js'
import type { ReviewSnapshot } from './snapshot.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Authorizer, AuthorizerLog, AuthorizerVerdict } from '@gotgenes/pi-permission-system'
import type {
  DestinationDescription,
  EscalationDecision,
  EscalationRequest,
  ShellReviewSource,
} from 'pi-bring-your-own-sandbox/consumer'
import { isSandboxError } from 'pi-bring-your-own-sandbox/consumer'
import { PRESETS } from '../presets/presets.js'
import { CallLog } from '../statistics/calls.js'
import { createModelCall, raceWithSignal } from './model-call.js'
import { resolveReviewModel } from './model.js'
import { captureSnapshot, validateSnapshot } from './snapshot.js'

const DECISION_EVENT = 'auto_review.decision'
// Each attempt after the first reviews user evidence that arrived during the one before
const MAX_ATTEMPTS = 3

type FailureCategory =
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'stale-snapshot'
  | 'stale-authorization-exhausted'
  | 'escalation-preset-deferred'
  | 'escalation-source-unavailable'
  | ReviewFailure

export interface ReviewerRuntime {
  config: AutoReviewConfig
  actions: Pick<ActionCapture, 'resolve' | 'registryDigest'>
  provenance: Pick<UserMessageProvenance, 'flush'>
  /** Read at every review, since `signal` belongs to the turn in progress */
  context: Pick<ExtensionContext, 'sessionManager' | 'signal' | 'abort' | 'hasUI'> & {
    modelRegistry: ReviewModelRegistry
    ui: Pick<ExtensionContext['ui'], 'notify'>
  }
  /** The context files the user's trust covers, as of the latest run */
  contextFiles: () => readonly ContextFile[]
  /** Aborted when the reviewer is replaced, the session ends or the session moves to other history; read at every review */
  sessionSignal: AbortSignal
  /** Resolves the pending call and opens a copy on the first investigation call of each review */
  investigation?: Pick<Investigation, 'forReview'>
  onInvestigation?: (outcome: InvestigationOutcome) => void
  escalation?: {
    record: (request: EscalationRequest, decision: EscalationDecision) => void
    append: (entry: EscalationDecisionEntry) => void
  }
  /** Receives every verdict with the calls behind it */
  statistics?: ReviewStatistics
  /** A reference that lets the person reconsider a refused action, when they can be asked */
  onRefusal?: (action: ReviewAction, refusal: string, snapshot: ReviewSnapshot) => string | undefined
}

export interface PermissionReviewer {
  authorize: Authorizer['authorize']
  reviewEscalation: (
    request: DirectEscalationRequest,
    source: ShellReviewSource,
    log: AuthorizerLog,
  ) => Promise<AuthorizerVerdict>
  /** Clears the denials the preset counts per turn */
  resetTurn: () => void
  /** Whether the denial limit refuses every ask unreviewed */
  circuitOpen: () => boolean
}

type AttemptResult =
  | (Exclude<ReviewOutcome, { kind: 'failed' }> & { snapshot: ReviewSnapshot })
  | { kind: 'failed'; failure: FailureCategory; fields: ReviewFields }

/** The model calls of a review and its investigation calls, for statistics */
interface ReviewWork {
  calls?: CallLog | undefined
  investigationCalls?: number
  investigationRefusals?: number
}

type ReviewResult = ReviewWork &
  (
    | (Exclude<ReviewOutcome, { kind: 'failed' }> & {
        usage: CallUsage
        snapshot: ReviewSnapshot
        escalation?: { request: EscalationRequest; signal: AbortSignal }
      })
    | { kind: 'failed'; failure: FailureCategory; fields?: ReviewFields; usage?: CallUsage }
  )

/**
 * Reviews until a verdict still applies to the session as it is when the verdict arrives. New user evidence, which
 * can authorize or restrict the action, starts another attempt within the same deadline
 */
async function reviewCurrentEvidence(
  runtime: ReviewerRuntime,
  preset: Preset,
  details: ReviewRequest,
  conversation: ReviewConversation | undefined,
  options: {
    complete: ModelCall
    contextWindow: number
    investigation: boolean
    destination: DestinationDescription | undefined
    escalation: EscalationRequest | undefined
  },
): Promise<AttemptResult> {
  const { config, context } = runtime
  let continued = conversation
  for (let attempt = 1; ; attempt += 1) {
    // The last user message may still be waiting for its provenance record
    runtime.provenance.flush(context)
    const snapshot = captureSnapshot(runtime, details)
    if (snapshot.action === undefined) {
      return { kind: 'failed', failure: 'stale-snapshot', fields: { attempts: attempt } }
    }
    const outcome = await preset.review(
      {
        config,
        branch: snapshot.branch,
        projection: snapshot.projection,
        details,
        action: snapshot.action,
        contextFiles: runtime.contextFiles(),
        conversation: continued,
        contextWindow: options.contextWindow,
        destination: options.destination,
        escalation: options.escalation,
        investigation: options.investigation,
      },
      options.complete,
    )
    const fields = { ...outcome.fields, attempts: attempt }
    if (outcome.kind === 'failed') {
      return { ...outcome, fields }
    }

    runtime.provenance.flush(context)
    const latest = captureSnapshot(runtime, details)
    const validation = validateSnapshot(snapshot, latest)
    if (validation === 'current') {
      return { ...outcome, fields, snapshot: latest }
    }
    if (validation === 'stale-snapshot') {
      return { kind: 'failed', failure: 'stale-snapshot', fields }
    }
    if (attempt === MAX_ATTEMPTS) {
      return { kind: 'failed', failure: 'stale-authorization-exhausted', fields }
    }
    // The conversation so far judged evidence that no longer stands
    continued = undefined
  }
}

async function runReview(
  runtime: ReviewerRuntime,
  preset: Preset,
  request: { details: ReviewRequest; action: ReviewAction; source?: ShellReviewSource | undefined },
  conversation: ReviewConversation | undefined,
  log: AuthorizerLog,
): Promise<ReviewResult> {
  const { config, context } = runtime
  const { details, action } = request
  const deadline = Date.now() + config.timeoutMs
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs)
  const turnSignal = context.signal
  const signal = AbortSignal.any([
    timeoutController.signal,
    runtime.sessionSignal,
    ...(turnSignal === undefined ? [] : [turnSignal]),
  ])

  let investigation: InvestigationRun | undefined
  try {
    if (signal.aborted) {
      return { kind: 'failed', failure: 'cancelled' }
    }
    const route = runtime.investigation?.forReview(signal, details, request.source)
    const escalation = route?.escalation
    const requested =
      'input' in action &&
      (action.toolName === 'bash' || action.toolName === 'powershell') &&
      action.input['escalate'] !== undefined
    const toolCallId = 'toolCallId' in action ? action.toolCallId : undefined
    const routeFields = {
      ...route?.lookupFailure,
      ...((escalation !== undefined || requested) && toolCallId !== undefined && { toolCallId }),
    }
    if ((escalation !== undefined || requested) && !preset.decidesEscalations) {
      return { kind: 'failed', failure: 'escalation-preset-deferred', fields: routeFields }
    }
    if ((requested && escalation === undefined) || (escalation !== undefined && escalation.toolCallId !== toolCallId)) {
      return { kind: 'failed', failure: 'escalation-source-unavailable', fields: routeFields }
    }
    const resolved = resolveReviewModel(context.modelRegistry, config)
    if (!resolved.ok) {
      return { kind: 'failed', failure: resolved.category, fields: routeFields }
    }
    const model = resolved.value
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 }
    const { statistics } = runtime
    const calls = statistics === undefined ? undefined : new CallLog(late => statistics.late(late), resolved.derived)
    if (preset.investigates && route !== undefined) {
      investigation = route
      try {
        await raceWithSignal(investigation.negotiate(), signal)
      } catch (error) {
        if (!signal.aborted) throw error
        return {
          kind: 'failed',
          failure: timeoutController.signal.aborted ? 'timeout' : 'cancelled',
          fields: routeFields,
        }
      }
    }
    const available = investigation?.unavailableReason === undefined ? investigation : undefined
    const complete = createModelCall({
      registry: context.modelRegistry,
      model,
      config,
      sessionId: context.sessionManager.getSessionId(),
      signal,
      timeoutSignal: timeoutController.signal,
      deadline,
      usage,
      investigation: available,
      calls,
    })
    const outcome = await reviewCurrentEvidence(runtime, preset, details, conversation, {
      complete,
      contextWindow: model.contextWindow,
      destination: route?.destination,
      escalation,
      investigation: available !== undefined,
    })
    const investigated =
      investigation === undefined || investigation.calls === 0
        ? {}
        : { investigationCalls: investigation.calls, investigationBytes: investigation.bytes }

    const unavailableReason = investigation?.unavailableReason
    return {
      ...outcome,
      ...(outcome.kind !== 'failed' && escalation !== undefined && { escalation: { request: escalation, signal } }),
      fields: {
        ...outcome.fields,
        ...routeFields,
        ...investigated,
        ...investigation?.copyFailure,
        ...(unavailableReason !== undefined && { investigationUnavailable: unavailableReason }),
      },
      usage,
      calls,
      investigationCalls: investigation?.calls ?? 0,
      investigationRefusals: investigation?.refusals ?? 0,
    }
  } finally {
    clearTimeout(timeout)
    const cleanup = await investigation?.close()
    if (cleanup !== undefined) {
      log.review('auto_review.copy_cleanup', {
        ...requestIdentity(details),
        failure: cleanup.failure,
        ...(cleanup.failure === 'unconfirmed' ? cleanup.details : {}),
      })
      if (cleanup.failure === 'timed-out') {
        void cleanup.late.then(outcome => {
          log.review('auto_review.copy_cleanup', {
            ...requestIdentity(details),
            late: true,
            ...(outcome === 'not-opened' ? { opened: false } : { confirmed: outcome === 'confirmed' }),
            ...(typeof outcome === 'string' ? {} : outcome.details),
          })
        })
      }
    }
    const investigationOutcome = investigation?.outcome
    if (investigationOutcome !== undefined) {
      runtime.onInvestigation?.(investigationOutcome)
    }
  }
}

interface EscalationFailure {
  errorCategory: 'escalation-review-stale' | 'escalation-record-failed'
  escalationError?: string
}

function applyEscalationDecision(
  runtime: ReviewerRuntime,
  details: ReviewRequest,
  result: Exclude<ReviewResult, { kind: 'failed' }>,
  log: AuthorizerLog,
): EscalationFailure | undefined {
  const { escalation: pending, kind: verdict, rationale } = result
  if (pending === undefined) return undefined

  if (pending.signal.aborted) {
    return { errorCategory: 'escalation-review-stale' }
  }
  const escalation = pending.request
  runtime.provenance.flush(runtime.context)
  if (validateSnapshot(result.snapshot, captureSnapshot(runtime, details)) !== 'current') {
    return { errorCategory: 'escalation-review-stale' }
  }
  const writer = runtime.escalation
  if (writer === undefined || rationale === undefined) {
    return { errorCategory: 'escalation-record-failed', escalationError: 'EscalationDecisionUnavailable' }
  }

  try {
    writer.record(escalation, verdict)
  } catch (error) {
    return {
      errorCategory: 'escalation-record-failed',
      escalationError: isSandboxError(error) || error instanceof Error ? error.name : 'UnknownError',
    }
  }
  try {
    writer.append({ toolCallId: escalation.toolCallId, verdict, rationale })
  } catch {
    log.review('auto_review.escalation_ledger_failed', { toolCallId: escalation.toolCallId, verdict })
  }
  return undefined
}

/** A log whose failures are dropped, since logging must not change a verdict */
function quiet(log: AuthorizerLog): AuthorizerLog {
  const guarded =
    (write: AuthorizerLog['review']): AuthorizerLog['review'] =>
    (...args) => {
      try {
        write(...args)
      } catch {
        // The verdict stands without its log entry
      }
    }

  return { review: guarded(log.review.bind(log)), debug: guarded(log.debug.bind(log)) }
}

function requestIdentity(details: ReviewRequest): { requestId: string } | { toolCallId: string } {
  return details.source === 'byos_escalation' ? { toolCallId: details.toolCallId } : { requestId: details.requestId }
}

export function createPermissionReviewer(runtime: ReviewerRuntime): PermissionReviewer {
  const { config } = runtime
  const preset = PRESETS[config.preset]
  // Per reviewer, so a retired one finishing a review late cannot trip its successor
  const limiter = preset.createLimiter()
  // As upstream keeps it: concurrent reviews each continue the conversation they started from, and the last to finish wins
  let conversation: ReviewConversation | undefined

  async function review(
    details: ReviewRequest,
    rawLog: AuthorizerLog,
    source?: ShellReviewSource,
  ): Promise<AuthorizerVerdict> {
    const log = quiet(rawLog)
    const startedAt = Date.now()
    const entryBase = { ...requestIdentity(details), provider: config.provider, model: config.model }
    const elapsed = (): number => Math.max(0, Date.now() - startedAt)
    const logFailure = (entry: Record<string, unknown>): void => {
      log.review(DECISION_EVENT, entry)
      log.debug('auto_review.failure', entry)
    }
    const finish = (
      verdict: AuthorizerVerdict,
      outcome: { failure?: string; circuitTripped?: true; work?: ReviewWork } = {},
    ): AuthorizerVerdict => {
      runtime.statistics?.review(details.source === 'byos_escalation' ? undefined : details.requestId, {
        outcome: verdict.kind,
        failure: outcome.failure,
        circuitTripped: outcome.circuitTripped,
        durationMs: elapsed(),
        investigationCalls: outcome.work?.investigationCalls ?? 0,
        investigationRefusals: outcome.work?.investigationRefusals ?? 0,
        calls: outcome.work?.calls?.finish() ?? [],
      })

      return verdict
    }
    const refuseOpenCircuit = (reason: string, work?: ReviewWork): AuthorizerVerdict => {
      log.review('auto_review.circuit_open', {
        ...entryBase,
        outcome: 'deny',
        durationMs: elapsed(),
        errorCategory: 'circuit-open',
      })

      return finish({ kind: 'deny', reason }, { failure: 'circuit-open', ...(work === undefined ? {} : { work }) })
    }
    // As Codex does, stop the agent instead of letting it look for a way around denial after denial
    const interruptTurn = (reason: string): void => {
      try {
        if (runtime.context.hasUI) {
          runtime.context.ui.notify(reason, 'warning')
        } else {
          log.review('auto_review.circuit_tripped', { warning: reason })
        }
      } finally {
        runtime.context.abort()
      }
    }

    try {
      const resolved = runtime.actions.resolve(details, runtime.context.sessionManager.getSessionId())
      if (resolved.kind !== 'eligible') {
        const failure = resolved.kind === 'forwarded' ? 'forwarded-ineligible' : resolved.kind
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'defer', errorCategory: failure, durationMs: elapsed() })

        return finish({ kind: 'defer' }, { failure })
      }
      const { action } = resolved
      const refusal = limiter.refusal()
      if (refusal !== undefined) {
        return refuseOpenCircuit(refusal)
      }

      const result = await runReview(runtime, preset, { details, action, source }, conversation, log)
      // Another review tripped the circuit while this one ran
      const lateRefusal = limiter.refusal()
      if (lateRefusal !== undefined) {
        return refuseOpenCircuit(lateRefusal, result)
      }
      const durationMs = elapsed()
      const diagnostics = {
        policyRevision: preset.policyRevision,
        contextSource: 'active-branch',
        actionKind: action.kind,
        actionDigest: action.digest,
        ...result.fields,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      }
      if (result.kind === 'failed') {
        // The conversation may be what failed, such as one too long for the provider; an interruption says nothing of it
        if (result.failure !== 'cancelled') {
          conversation = undefined
        }
        // Deferring would open the human prompt the user just escaped, and Pi drops an interrupted call's verdict anyway
        const verdict: AuthorizerVerdict =
          result.failure === 'cancelled'
            ? { kind: 'deny', reason: 'The automatic review was cancelled before it finished' }
            : { kind: 'defer' }
        limiter.recordNonDenial()
        logFailure({ ...entryBase, outcome: verdict.kind, errorCategory: result.failure, durationMs, ...diagnostics })

        return finish(verdict, { failure: result.failure, work: result })
      }

      const promptLimit =
        result.kind === 'deny' && limiter.limitAction === 'prompt' ? limiter.recordDenial() : undefined
      if (promptLimit !== undefined) {
        conversation = result.conversation
        log.review(DECISION_EVENT, {
          ...entryBase,
          outcome: 'defer',
          denialLimit: promptLimit,
          durationMs,
          ...diagnostics,
        })

        return finish({ kind: 'defer' }, { work: result })
      }
      const escalationFailure = applyEscalationDecision(runtime, details, result, log)
      if (escalationFailure !== undefined) {
        conversation = undefined
        limiter.recordNonDenial()
        logFailure({ ...entryBase, outcome: 'defer', durationMs, ...diagnostics, ...escalationFailure })

        return finish({ kind: 'defer' }, { failure: escalationFailure.errorCategory, work: result })
      }
      conversation = result.conversation
      const decisionFields =
        result.escalation === undefined ? diagnostics : { ...diagnostics, escalationRationale: result.rationale }
      if (result.kind === 'allow') {
        limiter.recordNonDenial()
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'allow', durationMs, ...decisionFields })

        return finish({ kind: 'allow' }, { work: result })
      }
      const denialLimit = limiter.limitAction === 'interrupt' ? limiter.recordDenial() : undefined
      if (denialLimit !== undefined) {
        interruptTurn(limiter.refusal() ?? result.reason)
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', denialLimit, durationMs, ...decisionFields })

        return finish({ kind: 'deny', reason: result.reason }, { circuitTripped: true, work: result })
      }
      log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', durationMs, ...decisionFields })
      const reference =
        result.escalation === undefined ? runtime.onRefusal?.(action, result.reason, result.snapshot) : undefined
      const reason =
        reference === undefined
          ? result.reason
          : // pi-permission-system ends the reason with a full stop
            `${result.reason}. To ask the user to run this exact command anyway, call request_manual_approval with denial_id ${JSON.stringify(reference)} and a reason. Do not retry or change the command`

      return finish({ kind: 'deny', reason }, { work: result })
    } catch {
      // The chain does not isolate a link that throws, so every internal failure has to leave as a verdict
      conversation = undefined
      limiter.recordNonDenial()
      logFailure({ ...entryBase, outcome: 'defer', errorCategory: 'internal-error', durationMs: elapsed() })

      return finish({ kind: 'defer' }, { failure: 'internal-error' })
    }
  }

  return {
    authorize: async (details, _query, log) => review(details, log),
    reviewEscalation: async (request, source, log) => review(request, log, source),
    resetTurn: () => limiter.resetTurn(),
    circuitOpen: () => limiter.refusal() !== undefined,
  }
}
