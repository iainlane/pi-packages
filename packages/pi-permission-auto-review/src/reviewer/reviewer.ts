import type { ActionCapture } from '../action/capture.js'
import type { ReviewAction } from '../action/schema.js'
import type { AutoReviewConfig } from '../config/config.js'
import type { Investigation, InvestigationRun } from '../investigation/investigation.js'
import type { ContextFile, Preset, ReviewFailure, ReviewFields, ReviewOutcome } from '../presets/presets.js'
import type { UserMessageProvenance } from '../provenance/provenance.js'
import type { ReviewStatistics } from '../statistics/recorder.js'
import type { ReviewConversation } from './conversation.js'
import type { CallUsage, ModelCall } from './model-call.js'
import type { ReviewModelRegistry } from './model.js'
import type { ReviewSnapshot } from './snapshot.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Authorizer, AuthorizerVerdict, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { PRESETS } from '../presets/presets.js'
import { CallLog } from '../statistics/calls.js'
import { createModelCall } from './model-call.js'
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
  /** The session's sandbox for inspecting local state, for presets that investigate */
  investigation?: Pick<Investigation, 'availability' | 'forReview'>
  /** Receives every verdict with the calls behind it */
  statistics?: ReviewStatistics
  /** A reference that lets the person reconsider a refused action, when they can be asked */
  onRefusal?: (action: ReviewAction, refusal: string, snapshot: ReviewSnapshot) => string | undefined
}

export interface PermissionReviewer {
  authorize: Authorizer['authorize']
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
    | (Exclude<ReviewOutcome, { kind: 'failed' }> & { usage: CallUsage; snapshot: ReviewSnapshot })
    | { kind: 'failed'; failure: FailureCategory; fields?: ReviewFields; usage?: CallUsage }
  )

/**
 * Reviews until a verdict still applies to the session as it is when the verdict arrives. New user evidence, which
 * can authorize or restrict the action, starts another attempt within the same deadline
 */
async function reviewCurrentEvidence(
  runtime: ReviewerRuntime,
  preset: Preset,
  details: PromptPermissionDetails,
  conversation: ReviewConversation | undefined,
  options: { complete: ModelCall; contextWindow: number; investigation: boolean },
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

/** The tools for this review, when the session's sandbox meets the requirements */
async function startInvestigation(
  investigation: NonNullable<ReviewerRuntime['investigation']>,
  signal: AbortSignal,
): Promise<InvestigationRun | undefined> {
  const availability = await investigation.availability()

  return availability.available ? investigation.forReview(signal) : undefined
}

async function runReview(
  runtime: ReviewerRuntime,
  preset: Preset,
  details: PromptPermissionDetails,
  conversation: ReviewConversation | undefined,
): Promise<ReviewResult> {
  const { config, context } = runtime
  const deadline = Date.now() + config.timeoutMs
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs)
  const turnSignal = context.signal
  const signal = AbortSignal.any([
    timeoutController.signal,
    runtime.sessionSignal,
    ...(turnSignal === undefined ? [] : [turnSignal]),
  ])

  try {
    if (signal.aborted) {
      return { kind: 'failed', failure: 'cancelled' }
    }
    const resolved = resolveReviewModel(context.modelRegistry, config)
    if (!resolved.ok) {
      return { kind: 'failed', failure: resolved.category }
    }
    const model = resolved.value
    const usage = { input: 0, cacheRead: 0, output: 0 }
    const { statistics } = runtime
    const calls = statistics === undefined ? undefined : new CallLog(late => statistics.late(late), resolved.derived)
    const investigation =
      preset.investigates && runtime.investigation !== undefined
        ? await startInvestigation(runtime.investigation, signal)
        : undefined
    const complete = createModelCall({
      registry: context.modelRegistry,
      model,
      config,
      sessionId: context.sessionManager.getSessionId(),
      signal,
      timeoutSignal: timeoutController.signal,
      deadline,
      usage,
      investigation,
      calls,
    })
    const outcome = await reviewCurrentEvidence(runtime, preset, details, conversation, {
      complete,
      contextWindow: model.contextWindow,
      investigation: investigation !== undefined,
    })
    const investigated =
      investigation === undefined || investigation.calls === 0
        ? {}
        : { investigationCalls: investigation.calls, investigationBytes: investigation.bytes }

    return {
      ...outcome,
      fields: { ...outcome.fields, ...investigated },
      usage,
      calls,
      investigationCalls: investigation?.calls ?? 0,
      investigationRefusals: investigation?.refusals ?? 0,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createPermissionReviewer(runtime: ReviewerRuntime): PermissionReviewer {
  const { config } = runtime
  const preset = PRESETS[config.preset]
  // Per reviewer, so a retired one finishing a review late cannot trip its successor
  const limiter = preset.createLimiter()
  // As upstream keeps it: concurrent reviews each continue the conversation they started from, and the last to finish wins
  let conversation: ReviewConversation | undefined

  const authorize: Authorizer['authorize'] = async (details, _query, log) => {
    const startedAt = Date.now()
    const entryBase = { requestId: details.requestId, provider: config.provider, model: config.model }
    const elapsed = (): number => Math.max(0, Date.now() - startedAt)
    const logFailure = (entry: Record<string, unknown>): void => {
      log.review(DECISION_EVENT, entry)
      log.debug('auto_review.failure', entry)
    }
    // Every verdict leaves through here, so the statistics count each ask that this reviewer answered
    const finish = (
      verdict: AuthorizerVerdict,
      outcome: { failure?: string; circuitTripped?: true; work?: ReviewWork } = {},
    ): AuthorizerVerdict => {
      runtime.statistics?.review(details.requestId, {
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

      const result = await runReview(runtime, preset, details, conversation)
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

      conversation = result.conversation
      if (result.kind === 'allow') {
        limiter.recordNonDenial()
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'allow', durationMs, ...diagnostics })

        return finish({ kind: 'allow' }, { work: result })
      }
      const denialLimit = limiter.recordDenial()
      if (denialLimit !== undefined && limiter.limitAction === 'prompt') {
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'defer', denialLimit, durationMs, ...diagnostics })

        return finish({ kind: 'defer' }, { work: result })
      }
      if (denialLimit !== undefined) {
        interruptTurn(limiter.refusal() ?? result.reason)
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', denialLimit, durationMs, ...diagnostics })

        return finish({ kind: 'deny', reason: result.reason }, { circuitTripped: true, work: result })
      }
      log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', durationMs, ...diagnostics })
      const reference = runtime.onRefusal?.(action, result.reason, result.snapshot)
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

  return { authorize, resetTurn: () => limiter.resetTurn(), circuitOpen: () => limiter.refusal() !== undefined }
}
