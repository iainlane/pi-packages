import type { ActionCapture } from '../action/capture.js'
import type { AutoReviewConfig } from '../config/config.js'
import type { Investigation, InvestigationRun } from '../investigation/investigation.js'
import type { ContextFile, Preset, ReviewFailure, ReviewFields, ReviewOutcome } from '../presets/presets.js'
import type { UserMessageProvenance } from '../provenance/provenance.js'
import type { ReviewConversation } from './conversation.js'
import type { CallUsage, ModelCall } from './model-call.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Authorizer, AuthorizerVerdict, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { PRESETS } from '../presets/presets.js'
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
  context: Pick<ExtensionContext, 'modelRegistry' | 'sessionManager' | 'signal' | 'abort' | 'hasUI'> & {
    ui: Pick<ExtensionContext['ui'], 'notify'>
  }
  /** The context files the user's trust covers, as of the latest run */
  contextFiles: () => readonly ContextFile[]
  /** Aborted when the reviewer is replaced, the session ends or the session moves to other history; read at every review */
  sessionSignal: AbortSignal
  /** The session's sandbox for inspecting local state, for presets that investigate */
  investigation?: Pick<Investigation, 'availability' | 'forReview'>
}

export interface PermissionReviewer {
  authorize: Authorizer['authorize']
  /** Clears the denials the preset counts per turn */
  resetTurn: () => void
}

type AttemptResult =
  | Exclude<ReviewOutcome, { kind: 'failed' }>
  | { kind: 'failed'; failure: FailureCategory; fields: ReviewFields }

type ReviewResult =
  | (Exclude<ReviewOutcome, { kind: 'failed' }> & { usage: CallUsage })
  | { kind: 'failed'; failure: FailureCategory; fields?: ReviewFields; usage?: CallUsage }

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
    const validation = validateSnapshot(snapshot, captureSnapshot(runtime, details))
    if (validation === 'current') {
      return { ...outcome, fields }
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

    return { ...outcome, fields: { ...outcome.fields, ...investigated }, usage }
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
    const refuseOpenCircuit = (reason: string): AuthorizerVerdict => {
      log.review('auto_review.circuit_open', {
        ...entryBase,
        outcome: 'deny',
        durationMs: elapsed(),
        errorCategory: 'circuit-open',
      })

      return { kind: 'deny', reason }
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
        log.review(DECISION_EVENT, {
          ...entryBase,
          outcome: 'defer',
          errorCategory: resolved.kind === 'forwarded' ? 'forwarded-ineligible' : resolved.kind,
          durationMs: elapsed(),
        })

        return { kind: 'defer' }
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
        return refuseOpenCircuit(lateRefusal)
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

        return verdict
      }

      conversation = result.conversation
      if (result.kind === 'allow') {
        limiter.recordNonDenial()
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'allow', durationMs, ...diagnostics })

        return { kind: 'allow' }
      }
      const denialLimit = limiter.recordDenial()
      if (denialLimit !== undefined && limiter.limitAction === 'prompt') {
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'defer', denialLimit, durationMs, ...diagnostics })

        return { kind: 'defer' }
      }
      if (denialLimit !== undefined) {
        interruptTurn(limiter.refusal() ?? result.reason)
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', denialLimit, durationMs, ...diagnostics })

        return { kind: 'deny', reason: result.reason }
      }
      log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', durationMs, ...diagnostics })

      return { kind: 'deny', reason: result.reason }
    } catch {
      // The chain does not isolate a link that throws, so every internal failure has to leave as a verdict
      conversation = undefined
      limiter.recordNonDenial()
      logFailure({ ...entryBase, outcome: 'defer', errorCategory: 'internal-error', durationMs: elapsed() })

      return { kind: 'defer' }
    }
  }

  return { authorize, resetTurn: () => limiter.resetTurn() }
}
