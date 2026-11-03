import type { ReviewAction } from '../src/action/schema.js'
import type { AutoReviewConfig } from '../src/config/config.js'
import type { ReviewModelRegistry } from '../src/reviewer/model.js'
import type { ReplayFixture, ReplayMessage } from './corpus.js'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { AuthorizerLog, PermissionQuery, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import * as v from 'valibot'
import { inputDigest } from '../src/action/json.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { USER_PROVENANCE_TYPE } from '../src/provenance/provenance.js'
import { createPermissionReviewer } from '../src/reviewer/reviewer.js'

export interface CaseEvaluation {
  caseId: string
  expected: 'allow' | 'deny'
  outcome: 'allow' | 'deny'
  matched: boolean
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  userAuthorization: 'unknown' | 'low' | 'medium' | 'high'
  policyRevision: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

const tokens = v.pipe(v.number(), v.minValue(0))
const decisionSchema = v.object({
  outcome: v.picklist(['allow', 'deny', 'defer']),
  riskLevel: v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
  userApproval: v.optional(v.picklist(['unknown', 'low', 'medium', 'high'])),
  policyRevision: v.optional(v.string()),
  errorCategory: v.optional(v.string()),
  usage: v.optional(v.object({ input: tokens, cacheRead: tokens, output: tokens })),
})

/** The run could not produce a classification for a case, which is not a policy denial */
export class EvaluationFailure extends Error {
  readonly caseId: string
  readonly category: string

  constructor(caseId: string, category: string) {
    super(`Evaluation ${caseId} failed: ${category}`)
    this.name = 'EvaluationFailure'
    this.caseId = caseId
    this.category = category
  }
}

function assistant(message: Extract<ReplayMessage, { role: 'assistant' }>, timestamp: number): AssistantMessage {
  const calls: ToolCall[] = (message.toolCalls ?? []).map(call => ({ type: 'toolCall', ...call }))

  return {
    role: 'assistant',
    content: [...(message.text.length === 0 ? [] : [{ type: 'text' as const, text: message.text }]), ...calls],
    api: 'openai-responses',
    provider: 'recorded-agent',
    model: 'recorded-agent',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length === 0 ? 'stop' : 'toolUse',
    timestamp,
  }
}

export function replaySession(scenario: ReplayFixture['input']): SessionManager {
  const session = SessionManager.inMemory(scenario.cwd)
  for (const [index, message] of scenario.messages.entries()) {
    const timestamp = index * 1000
    if (message.role === 'user') {
      const id = session.appendMessage({ role: 'user', content: message.text, timestamp })
      session.appendCustomEntry(USER_PROVENANCE_TYPE, { userEntryId: id, source: message.provenance })
      continue
    }
    if (message.role === 'assistant') {
      session.appendMessage(assistant(message, timestamp))
      continue
    }
    session.appendMessage({
      role: 'toolResult',
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      content: [{ type: 'text', text: message.text }],
      isError: message.isError,
      timestamp,
    })
  }

  return session
}

function permissionDetails(command: string): PromptPermissionDetails {
  return {
    requestId: 'evaluation-request',
    source: 'tool_call',
    agentName: null,
    toolCallId: 'pending-call',
    toolName: 'bash',
    command,
    surface: 'bash',
    payload: {
      kind: 'bash',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: 'bash',
        toolName: 'bash',
        invokedToolName: null,
        value: command,
        matchedPattern: null,
        matchedSpelling: null,
        commandContext: null,
        executedUnit: null,
        decidingPath: null,
      },
      evidence: [{ label: 'command', text: command, detail: null }],
      annotations: [],
    },
  }
}

const noExecutionQuery: PermissionQuery = {
  checkPermission() {
    throw new Error('Evaluation must not dispatch tools or query execution permissions')
  },
  getToolPermission() {
    throw new Error('Evaluation must not dispatch tools or query execution permissions')
  },
}

/** Reviews one fixture's action through the production reviewer, in a fresh session with a fresh denial circuit */
export async function evaluateFixture(
  fixture: ReplayFixture,
  modelRegistry: ReviewModelRegistry,
  config: AutoReviewConfig = DEFAULT_CONFIG,
  signal: AbortSignal = new AbortController().signal,
): Promise<CaseEvaluation> {
  const scenario = fixture.input
  const sessionManager = replaySession(scenario)
  const input = { ...scenario.action.extraInput, command: scenario.action.command }
  const action: ReviewAction = {
    kind: 'shell',
    toolName: 'bash',
    toolCallId: 'pending-call',
    cwd: scenario.cwd,
    sessionId: sessionManager.getSessionId(),
    digest: inputDigest(input),
    input,
  }
  let decision: v.InferOutput<typeof decisionSchema> | undefined
  const log: AuthorizerLog = {
    review(event, details) {
      const parsed = v.safeParse(decisionSchema, details)
      if (event === 'auto_review.decision' && parsed.success) {
        decision = parsed.output
      }
    },
    debug() {},
  }
  const reviewer = createPermissionReviewer({
    config,
    actions: { resolve: () => ({ kind: 'eligible', action }), registryDigest: () => inputDigest([]) },
    provenance: { flush() {} },
    context: { modelRegistry, sessionManager, signal, abort() {}, hasUI: false, ui: { notify() {} } },
    contextFiles: () => [],
    sessionSignal: signal,
  })
  const verdict = await reviewer.authorize(permissionDetails(scenario.action.command), noExecutionQuery, log)
  if (decision?.errorCategory !== undefined) {
    throw new EvaluationFailure(fixture.id, decision.errorCategory)
  }
  if (
    decision === undefined ||
    verdict.kind === 'defer' ||
    decision.outcome === 'defer' ||
    decision.riskLevel === undefined ||
    decision.userApproval === undefined ||
    decision.policyRevision === undefined
  ) {
    throw new EvaluationFailure(fixture.id, 'missing-assessment')
  }
  if (decision.usage === undefined) {
    throw new EvaluationFailure(fixture.id, 'missing-usage')
  }

  return {
    caseId: fixture.id,
    expected: fixture.expected,
    outcome: decision.outcome,
    matched: decision.outcome === fixture.expected,
    riskLevel: decision.riskLevel,
    userAuthorization: decision.userApproval,
    policyRevision: decision.policyRevision,
    inputTokens: decision.usage.input,
    cacheReadTokens: decision.usage.cacheRead,
    outputTokens: decision.usage.output,
  }
}
