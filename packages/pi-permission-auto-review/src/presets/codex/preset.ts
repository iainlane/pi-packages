import type { Preset } from '../presets.js'
import { nextConversation, prepareReview } from '../../reviewer/conversation.js'
import { OUTPUT_RESERVE_TOKENS } from '../../reviewer/model-call.js'
import { approximateTokens } from '../../text.js'
import { DenialCircuitBreaker } from './circuit-breaker.js'
import { BUILT_IN_RULES, buildSystemPrompt, POLICY_REVISION } from './policy.js'
import { buildFollowUpPrompt, buildUserPrompt } from './review-prompt.js'
import { evidenceChangedSince, manifestFields, renderTranscript } from './transcript.js'
import { parseReviewAssessment } from './verdict.js'

// Verbatim `REJECTION_INSTRUCTIONS` from openai/codex `codex-rs/prompts/src/model_messages/guardian.rs`
const REJECTION_INSTRUCTIONS =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input'

export const CODEX_PRESET: Preset = {
  policyRevision: POLICY_REVISION,
  builtInRules: BUILT_IN_RULES,
  createLimiter: () => new DenialCircuitBreaker(),
  investigates: true,
  async review(input, complete) {
    const { config, branch, projection, details, action, contextWindow } = input
    const systemPrompt = buildSystemPrompt(config, input.investigation)
    // The earlier reviews saw text that a later context edit or compaction may have removed
    const cursorIndex =
      input.conversation === undefined ? -1 : branch.findIndex(entry => entry.id === input.conversation?.cursor.entryId)
    // Like Codex, which starts a new reviewer session when its tools change. Providers also reject a history with tool
    // calls unless the request defines the tools
    const sameTools = input.conversation?.investigation === input.investigation
    const conversation =
      input.conversation !== undefined && cursorIndex >= 0 && !evidenceChangedSince(branch, cursorIndex) && sameTools
        ? input.conversation
        : undefined
    const { request, transcript, priorReviews } = prepareReview(
      { ...input, conversation },
      { systemPrompt, reasoning: config.reasoning },
      after => {
        if (after !== undefined) {
          const delta = renderTranscript(branch, projection, { from: after.entryIndex + 1 })

          return { content: buildFollowUpPrompt(delta, details, action), transcript: delta }
        }
        const full = renderTranscript(branch, projection)
        const excess = (content: string): number =>
          approximateTokens(systemPrompt + content) + OUTPUT_RESERVE_TOKENS - contextWindow
        let rendered = { content: buildUserPrompt(full, details, action), transcript: full }
        let budget = full.tokens - excess(rendered.content)
        // Like Codex, leave out other records and then shorten long user evidence before giving up on a review that
        // would not fit the model. The estimate of the whole prompt differs a little from the sum of its records, so
        // measure again after each try
        for (let attempt = 0; attempt < 3 && excess(rendered.content) > 0 && budget > 0; attempt += 1) {
          const shortened = renderTranscript(branch, projection, { budget })
          rendered = { content: buildUserPrompt(shortened, details, action), transcript: shortened }
          if (!shortened.manifest.authorityFits) {
            break
          }
          budget -= excess(rendered.content)
        }

        return rendered
      },
    )
    const { manifest } = transcript
    const fields = { ...manifestFields(manifest), priorReviews }
    if (manifest.authorityEdited) {
      return { kind: 'failed', failure: 'authority-edited', fields }
    }
    if (!manifest.authorityFits) {
      return { kind: 'failed', failure: 'authority-over-budget', fields }
    }
    const result = await complete(request, parseReviewAssessment)
    if (!result.ok) {
      return { kind: 'failed', failure: result.failure, fields }
    }

    const assessment = result.value
    const lastEntry = branch.at(-1)
    const next = nextConversation(config, {
      priorReviews,
      request: result.request,
      firstReply: result.reply,
      lastReply: result.reply,
      cursor: lastEntry === undefined ? undefined : { entryId: lastEntry.id },
      investigation: input.investigation,
    })
    // Under a key naming an authorization, the review log would mask the grade
    const graded = { ...fields, riskLevel: assessment.riskLevel, userApproval: assessment.userAuthorization }
    if (assessment.outcome === 'allow') {
      return { kind: 'allow', fields: graded, conversation: next }
    }

    // The host already prefixes its own attribution sentence, so this carries the why, the two grades and upstream's
    // instruction against working around the denial
    return {
      kind: 'deny',
      reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization}). ${REJECTION_INSTRUCTIONS}`,
      fields: graded,
      conversation: next,
    }
  },
}
