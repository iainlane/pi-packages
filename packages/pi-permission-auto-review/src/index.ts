import type { ActivationResult } from './config/command.js'
import type { AutoReviewConfig } from './config/config.js'
import type { AuthorizerStatus, PermissionObservation } from './config/status.js'
import type { LoadConfigResult } from './config/store.js'
import type { InvestigationOutcome } from './investigation/investigation.js'
import type { ContextFile } from './presets/presets.js'
import type { PermissionReviewer } from './reviewer/reviewer.js'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  PermissionDecisionEvent,
  AuthorizerVerdict,
  PermissionsReadyEvent,
  PermissionsService,
} from '@gotgenes/pi-permission-system'
import type { ShellReviewLookup } from 'pi-bring-your-own-sandbox/consumer'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  getPermissionsService,
  PERMISSIONS_DECISION_CHANNEL,
  PERMISSIONS_READY_CHANNEL,
} from '@gotgenes/pi-permission-system'
import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer'
import { ActionCapture } from './action/capture.js'
import { escalationCall } from './action/request.js'
import { registerAutoReviewCommand } from './config/command.js'
import { EXTENSION_ID } from './config/config.js'
import { AUTHORIZER_STATUS } from './config/status.js'
import { configPath, loadConfig } from './config/store.js'
import { registerEscalationCommand } from './escalation/command.js'
import { appendEscalationDecision } from './escalation/decisions.js'
import { directEscalationLog } from './escalation/diagnostics.js'
import { PowerShellEscalationPreview } from './escalation/powershell-preview.js'
import { formatInvestigationOutcome, Investigation } from './investigation/investigation.js'
import { ManualApprovalController } from './manual/controller.js'
import { registerManualApprovalTool } from './manual/tool.js'
import { PRESETS } from './presets/presets.js'
import { UserMessageProvenance } from './provenance/provenance.js'
import { createPermissionReviewer } from './reviewer/reviewer.js'
import { captureSnapshot } from './reviewer/snapshot.js'
import { registerStatisticsCommand } from './statistics/command.js'
import { StatisticsRecorder } from './statistics/recorder.js'

const AUTHORIZER_NAME = 'auto-review'
// Long enough for a cancelled review to record its verdict, short enough not to hold up Pi's exit for a provider
// that ignores the abort
const SHUTDOWN_WAIT_MS = 2_000
const VERDICT_LABELS = [
  ['allow', 'allowed'],
  ['deny', 'denied'],
  ['defer', 'deferred'],
] as const

type Tally = Record<AuthorizerVerdict['kind'], number>

/** One reviewer per applied config, so a config change swaps the registered link without a reload */
interface Generation {
  /** The session's live context: `signal` and `ui` are read when used, not when the generation is made */
  runtime: Pick<
    ExtensionContext,
    'modelRegistry' | 'sessionManager' | 'signal' | 'ui' | 'abort' | 'hasUI' | 'cwd' | 'mode'
  >
  config: AutoReviewConfig | undefined
  controller: AbortController
  /** Its controller is replaced each time the session moves to other history, which ends the reviews in progress */
  history: { controller: AbortController }
  /** Ended when the reviewer is replaced, the session ends or the session moves to other history */
  sessionSignal: () => AbortSignal
  reviewer: PermissionReviewer
  authorize: Authorizer['authorize']
  dispose: (() => void) | undefined
}

const deferInvalidConfig: Authorizer['authorize'] = async (details, _query, log) => {
  log.review('auto_review.decision', {
    requestId: details.requestId,
    outcome: 'defer',
    errorCategory: 'config-invalid',
  })

  return { kind: 'defer' }
}

function warn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function investigates(config: AutoReviewConfig | undefined): boolean {
  return config !== undefined && PRESETS[config.preset].investigates
}

function statusText(status: AuthorizerStatus, tally: Tally, investigation: InvestigationOutcome | undefined): string {
  const { footer } = AUTHORIZER_STATUS[status]
  if (status === 'invalid-config' || status === 'unregistered') return footer

  const counts = VERDICT_LABELS.flatMap(([kind, label]) => (tally[kind] > 0 ? [`${tally[kind]} ${label}`] : []))
  const outcome = investigation === undefined ? [] : [formatInvestigationOutcome(investigation)]

  return [footer, ...counts, ...outcome].join(' · ')
}

export default function permissionAutoReview(pi: ExtensionAPI): void {
  const actions = new ActionCapture(pi)
  const provenance = new UserMessageProvenance(pi)
  const sandbox = createSandboxClient(pi, import.meta.filename)
  const investigation = new Investigation(sandbox)
  const recorder = new StatisticsRecorder(pi, {
    directory: () => join(getAgentDir(), 'extensions', EXTENSION_ID, 'statistics'),
  })
  // Reviews in progress, which shutdown lets finish recording their verdicts
  const outstanding = new Set<Promise<AuthorizerVerdict>>()
  const escalationReviews = new Map<string, Promise<AuthorizerVerdict>>()
  let investigationOutcome: InvestigationOutcome | undefined
  let sessionStarts = 0
  let generation: Generation | undefined
  let observation: PermissionObservation = 'registered'
  let tally: Tally = { allow: 0, deny: 0, defer: 0 }
  // As the latest run loaded them, which is what the agent itself was told
  let contextFiles: readonly ContextFile[] = []
  // One process hosts a node per session and subagent, and a link is only read by the node it registered in
  let sessionId: string | undefined
  let warnedMissingSessionId = false
  const manual = new ManualApprovalController(pi, actions, () => {
    const current = generation
    if (current?.config === undefined) {
      return undefined
    }
    const context = current.runtime

    return {
      context,
      sessionSignal: current.sessionSignal(),
      circuitOpen: () => current.reviewer.circuitOpen(),
      snapshot: () => {
        provenance.flush(context)

        return captureSnapshot({ context, actions })
      },
      statistics: recorder.sink(),
    }
  })
  const escalationPreview = new PowerShellEscalationPreview(sandbox, warn)
  actions.onCaptured(async (invocation, context, input) => {
    escalationPreview.capture(invocation, context, input)
    const current = generation
    const call = escalationCall(invocation)
    if (call === undefined || current?.config === undefined || !PRESETS[current.config.preset].decidesEscalations) {
      return undefined
    }
    const { toolCallId } = call
    let pending = escalationReviews.get(toolCallId)
    if (pending === undefined) {
      let lookup: ShellReviewLookup
      try {
        lookup = sandbox.findShellReviewSource(context, { toolCallId, toolName: call.toolName })
      } catch {
        return undefined
      }
      if (!lookup.ok || lookup.source.escalation?.toolCallId !== toolCallId) return undefined

      const { source } = lookup
      const session = sessionStarts
      const log = directEscalationLog(pi, toolCallId, () => generation !== undefined && sessionStarts === session)
      pending = startEscalationReview(toolCallId, current, async () =>
        current.reviewer.reviewEscalation(call, source, log),
      )
    }
    const verdict = await pending
    if (verdict.kind !== 'deny') return undefined

    return { block: true, reason: verdict.reason ?? 'Automatic review denied the escalation' }
  })
  pi.on('tool_execution_end', event => {
    escalationReviews.delete(event.toolCallId)
    escalationPreview.end(event.toolCallId)
  })
  registerManualApprovalTool(pi, manual)
  pi.events.on(PERMISSIONS_DECISION_CHANNEL, data => manual.decided(data as PermissionDecisionEvent))

  function setFooterStatus(context: Pick<ExtensionContext, 'ui'>, status: string | undefined): void {
    try {
      context.ui.setStatus(EXTENSION_ID, status)
    } catch {
      // The footer is a display; nothing that renders it may fail because of it
    }
  }

  function authorizerStatus(current: Generation | undefined): AuthorizerStatus {
    if (current?.config === undefined) return 'invalid-config'

    return current.dispose === undefined ? 'unregistered' : observation
  }

  function renderStatus(current: Generation): void {
    const outcome = investigates(current.config) ? investigationOutcome : undefined
    setFooterStatus(current.runtime, statusText(authorizerStatus(current), tally, outcome))
  }

  async function trackReview(current: Generation, start: () => Promise<AuthorizerVerdict>): Promise<AuthorizerVerdict> {
    const pending = Promise.resolve().then(start)
    outstanding.add(pending)
    let verdict: AuthorizerVerdict
    try {
      verdict = await pending
    } catch {
      verdict = { kind: 'defer' }
    } finally {
      outstanding.delete(pending)
    }
    if (generation === current) {
      tally[verdict.kind] += 1
      renderStatus(current)
    }

    return verdict
  }

  async function startEscalationReview(
    toolCallId: string,
    current: Generation,
    start: () => Promise<AuthorizerVerdict>,
  ): Promise<AuthorizerVerdict> {
    const pending = trackReview(current, start)
    escalationReviews.set(toolCallId, pending)
    return pending
  }

  function createGeneration(runtime: Generation['runtime'], config: AutoReviewConfig | undefined): Generation {
    const controller = new AbortController()
    const history = { controller: new AbortController() }
    const sessionSignal = (): AbortSignal => AbortSignal.any([controller.signal, history.controller.signal])
    const reviewer: PermissionReviewer =
      config === undefined
        ? {
            authorize: deferInvalidConfig,
            reviewEscalation: async () => ({ kind: 'defer' }),
            resetTurn: () => {},
            circuitOpen: () => false,
          }
        : createPermissionReviewer({
            config,
            actions,
            provenance,
            context: runtime,
            contextFiles: () => contextFiles,
            investigation,
            onInvestigation: outcome => {
              if (generation?.controller === controller) investigationOutcome = outcome
            },
            escalation: {
              record: (request, decision) => sandbox.recordEscalationDecision(runtime, request, decision),
              append: entry => appendEscalationDecision(pi, entry),
            },
            statistics: recorder.sink(),
            onRefusal: (action, refusal, snapshot) => manual.refuse(action, refusal, snapshot),
            get sessionSignal() {
              return sessionSignal()
            },
          })
    const created: Generation = {
      runtime,
      config,
      controller,
      history,
      sessionSignal,
      reviewer,
      authorize: async (details, query, log) => {
        const { toolCallId, toolName } = details
        const localToolAsk =
          details.source === 'tool_call' &&
          details.forwarding === undefined &&
          toolCallId !== undefined &&
          toolCallId !== '' &&
          toolName !== undefined &&
          toolName !== ''
        if (generation === created && observation !== 'uncaptured-ask') {
          const next = localToolAsk && !actions.hasInvocation(toolCallId) ? 'uncaptured-ask' : 'asked'
          if (next !== observation) {
            observation = next
            renderStatus(created)
          }
        }
        let decided: AuthorizerVerdict | undefined
        try {
          decided = manual.authorize(details)
        } catch {
          decided = { kind: 'deny', reason: 'Manual approval validation failed' }
        }
        if (decided !== undefined) {
          return decided
        }
        const start = async (): Promise<AuthorizerVerdict> => reviewer.authorize(details, query, log)
        const call =
          localToolAsk && (toolName === 'bash' || toolName === 'powershell')
            ? escalationCall(actions.invocation(toolCallId))
            : undefined
        if (call === undefined || call.toolName !== details.toolName) return trackReview(created, start)

        const shared = escalationReviews.get(call.toolCallId)
        if (shared === undefined) return startEscalationReview(call.toolCallId, created, start)

        const verdict = await shared
        if (verdict.kind === 'defer' && generation?.runtime === created.runtime) {
          recorder.watchDeferred(details.requestId)
        }

        return verdict
      },
      dispose: undefined,
    }

    return created
  }

  /** Throws when the service refuses the link, leaving `target` unregistered */
  function register(target: Generation, service: PermissionsService): void {
    target.dispose = service.registerAuthorizer(AUTHORIZER_NAME, target.authorize)
    renderStatus(target)
  }

  function retire(retired: Generation | undefined): void {
    retired?.dispose?.()
    retired?.controller.abort()
    manual.invalidate()
  }

  function reportIssues(issues: string[]): void {
    for (const issue of issues) {
      warn(`config issue at ${issue}`)
    }
  }

  function applyConfig(result: LoadConfigResult): ActivationResult {
    reportIssues(result.issues)
    // Commands only run inside a started session
    const current = generation!
    if (result.config === undefined) {
      return { kind: 'failed', message: 'the merged config is invalid; the previous reviewer remains active' }
    }
    const service = sessionId === undefined ? undefined : getPermissionsService(sessionId)
    if (service === undefined && current.dispose !== undefined) {
      // Without the service the old link cannot be released, and dropping its handle would leave it deciding
      // under the superseded config for the rest of the session
      return {
        kind: 'failed',
        message: 'pi-permission-system became unavailable while the old reviewer was still registered',
      }
    }

    const candidate = createGeneration(current.runtime, result.config)
    retire(current)
    generation = candidate
    renderStatus(candidate)
    if (service === undefined) {
      return { kind: 'pending' }
    }
    try {
      register(candidate, service)
    } catch (error) {
      // Nothing is registered now, so asks fall through to the human prompt and the next ready retries
      return { kind: 'failed', message: `the new reviewer could not be registered: ${describeError(error)}` }
    }

    return { kind: 'active' }
  }

  pi.on('session_start', (_event, ctx) => {
    retire(generation)
    escalationReviews.clear()
    escalationPreview.start()
    const projectTrusted = ctx.isProjectTrusted()
    const result = loadConfig(ctx.cwd, projectTrusted)
    reportIssues(result.issues)
    const projectPath = configPath(ctx.cwd, 'project')
    if (!projectTrusted && existsSync(projectPath)) {
      warn(`${projectPath} is ignored until Pi trusts this project`)
    }
    tally = { allow: 0, deny: 0, defer: 0 }
    observation = 'registered'
    contextFiles = []
    recorder.start(ctx.sessionManager)
    manual.start(ctx)
    investigationOutcome = undefined
    generation = createGeneration(ctx, result.config)
    renderStatus(generation)
    investigation.start(ctx)
    const session = (sessionStarts += 1)
    void investigation.availability().then(status => {
      if (session !== sessionStarts) {
        return
      }
      if (!status.available) {
        investigationOutcome ??= { kind: 'unavailable', reason: 'no-session-route' }
        if (investigates(generation?.config)) {
          warn(`the reviewer cannot investigate local state: ${status.reason}`)
        }
      }
      if (generation !== undefined) {
        renderStatus(generation)
      }
    })
  })

  // Registration happens only here: ready fires after every `session_start` and before any ask, and may
  // repeat, which the stored dispose handle turns into a no-op
  pi.events.on(PERMISSIONS_READY_CHANNEL, data => {
    const ready = data as PermissionsReadyEvent
    if (ready.sessionId === null) {
      if (!warnedMissingSessionId) {
        warnedMissingSessionId = true
        warn(`pi-permission-system published no keyed service for this node; ${AUTHORIZER_NAME} stays unregistered`)
      }

      return
    }
    sessionId ??= ready.sessionId
    const service = getPermissionsService(sessionId)
    if (generation === undefined) return

    escalationPreview.connect(service)
    if (generation.dispose !== undefined || service === undefined) {
      return
    }
    try {
      register(generation, service)
    } catch (error) {
      warn(`failed to register ${AUTHORIZER_NAME}: ${describeError(error)}`)
    }
  })

  // Pi loads a project's AGENTS.md and CLAUDE.md whether or not it trusts the project, and a cloned repository
  // could use them to vouch for its own actions
  pi.on('before_agent_start', (event, ctx) => {
    generation?.reviewer.resetTurn()
    const agentDir = resolve(getAgentDir())
    const projectTrusted = ctx.isProjectTrusted()
    contextFiles = (event.systemPromptOptions.contextFiles ?? []).filter(
      file => projectTrusted || dirname(resolve(file.path)) === agentDir,
    )
  })

  // Pi starts a turn before every model response, but Codex counts denials across everything the agent does for one
  // prompt. Retries and continuations start turns without `before_agent_start`
  pi.on('agent_settled', () => {
    generation?.reviewer.resetTurn()
  })

  const cancelReviews = (): void => {
    if (generation === undefined) {
      return
    }
    generation.history.controller.abort()
    generation.history.controller = new AbortController()
    manual.invalidate()
  }
  pi.on('session_tree', cancelReviews)
  pi.on('session_compact', cancelReviews)
  pi.on('session_before_switch', cancelReviews)
  pi.on('session_before_fork', cancelReviews)

  pi.on('session_shutdown', async (_event, ctx) => {
    setFooterStatus(ctx, undefined)
    escalationPreview.stop()
    escalationReviews.clear()
    retire(generation)
    generation = undefined
    sessionId = undefined
    warnedMissingSessionId = false
    const { promise: waited, resolve: stopWaiting } = Promise.withResolvers<void>()
    setTimeout(stopWaiting, SHUTDOWN_WAIT_MS).unref()
    await Promise.race([Promise.allSettled([...outstanding]), waited])
    manual.stop()
    recorder.close()
  })

  registerAutoReviewCommand(pi, { getActiveConfig: () => generation?.config, applyConfig })
  registerEscalationCommand(pi)
  registerStatisticsCommand(pi, recorder, () => ({
    authorizer: authorizerStatus(generation),
    config: generation?.config,
    investigation: investigationOutcome,
    circuitOpen: generation?.reviewer.circuitOpen() ?? false,
  }))
}
