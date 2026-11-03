import type { ActionResolution } from '../src/action/capture.js'
import type { ReviewAction } from '../src/action/schema.js'
import type { AutoReviewConfig } from '../src/config/config.js'
import type { AssistantMessage, Context, SimpleStreamOptions, ThinkingLevelMap, Usage } from '@earendil-works/pi-ai'
import type { ModelRegistry, SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionQuery,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import type { Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildSessionProjection } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, vi } from 'vitest'
import { inputDigest } from '../src/action/json.js'
import { mergeConfig } from '../src/config/config.js'
import { USER_PROVENANCE_TYPE } from '../src/provenance/provenance.js'
import { createPermissionReviewer } from '../src/reviewer/reviewer.js'

/** A throwaway project and agent dir, with `PI_CODING_AGENT_DIR` pointed at the latter */
export function useWorkspace(): { cwd: string } {
  const workspace = { cwd: '' }
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-permission-auto-review-'))
    workspace.cwd = join(root, 'project')
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  return workspace
}

export function writeFile(path: string, contents: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

export function permissionDetails(overrides: Partial<PromptPermissionDetails> = {}): PromptPermissionDetails {
  return {
    requestId: 'request-1',
    source: 'tool_call',
    agentName: null,
    payload: {
      kind: 'bash',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: 'bash',
        toolName: 'bash',
        invokedToolName: null,
        value: 'pnpm publish',
        matchedPattern: 'pnpm publish*',
        matchedSpelling: null,
        commandContext: null,
        executedUnit: null,
        decidingPath: null,
      },
      evidence: [{ label: 'command', text: 'pnpm publish', detail: null }],
      annotations: [],
    },
    toolName: 'bash',
    command: 'pnpm publish',
    surface: 'bash',
    ...overrides,
  }
}

/** A captured bash call, as `ActionCapture.resolve` returns it for an ask about `command` */
export function shellAction(command = 'pnpm publish', toolCallId = 'call-1'): Extract<ReviewAction, { kind: 'shell' }> {
  const input = { command }

  return {
    kind: 'shell',
    toolName: 'bash',
    toolCallId,
    cwd: '/workspace',
    sessionId: 'session-1',
    input,
    digest: inputDigest(input),
  }
}

/** A captured write call, as `ActionCapture.resolve` returns it */
export function writeAction(
  path: string,
  content: string,
  toolCallId = 'call-1',
): Extract<ReviewAction, { kind: 'file-write' }> {
  const input = { path, content }

  return {
    kind: 'file-write',
    toolName: 'write',
    toolCallId,
    cwd: '/workspace',
    sessionId: 'session-1',
    input,
    digest: inputDigest(input),
    resolvedPath: `/workspace/${path}`,
  }
}

/** The capture that Pi would have produced for the branch's call with the ask's id, or a bash call it names */
function capturedAction(branch: SessionEntry[], details: PromptPermissionDetails): ReviewAction {
  for (const entry of branch.toReversed()) {
    const content = entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content : []
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type !== 'toolCall' || block.id !== details.toolCallId) continue
      const input = block.arguments as Record<string, string>
      if (block.name === 'write') return writeAction(input['path'] ?? '', input['content'] ?? '', block.id)
      if (block.name === 'bash') return shellAction(input['command'], block.id)
    }
  }

  return shellAction(details.command, details.toolCallId)
}

export const STALLED_REPLY: Promise<AssistantMessage> = new Promise(() => {})

export const USER_ENTRY: SessionEntry = {
  type: 'message',
  id: 'user-1',
  parentId: null,
  timestamp: '2026-07-23T00:00:00.000Z',
  message: { role: 'user', content: 'Please run the requested operation.', timestamp: 0 },
}

/** The record that attributes a user message entry to `source`, as the provenance tracker writes it */
export function provenanceEntry(
  userEntryId: string,
  source: 'interactive' | 'rpc' | 'extension' | 'uncertain' = 'interactive',
  inputText?: string,
): SessionEntry {
  return {
    type: 'custom',
    id: `provenance-${userEntryId}`,
    parentId: userEntryId,
    timestamp: '2026-07-23T00:00:00.000Z',
    customType: USER_PROVENANCE_TYPE,
    data: { userEntryId, source, ...(inputText === undefined ? {} : { inputText }) },
  }
}

export function reply(
  text: string,
  stopReason: AssistantMessage['stopReason'] = 'stop',
  usage: Partial<Usage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 0, totalTokens: 150, ...usage },
  } as AssistantMessage
}

export function toolCallEntry(input: Record<string, unknown>, callId = 'call-1'): SessionEntry {
  return {
    type: 'message',
    id: `assistant-${callId}`,
    parentId: 'user-1',
    timestamp: '2026-07-23T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'write', arguments: input }],
      timestamp: 0,
    },
  } as SessionEntry
}

type StreamSimple = (
  model: unknown,
  context: Required<Pick<Context, 'systemPrompt' | 'messages'>>,
  options: SimpleStreamOptions,
) => { result: () => Promise<AssistantMessage> }

type ReviewStart = (
  requestId?: string,
  details?: Partial<PromptPermissionDetails>,
) => { verdict: Promise<AuthorizerVerdict>; entries: Parameters<AuthorizerLog['review']>[] }

interface ReviewerHarness {
  /** The session's active branch, which a test may grow or replace between reviews */
  branch: SessionEntry[]
  resetTurn: () => void
  streamSimple: Mock<StreamSimple>
  callTimes: number[]
  start: ReviewStart
  /** Runs the retry delays and the review timeout on the fake clock */
  authorize: (
    requestId?: string,
    details?: Partial<PromptPermissionDetails>,
  ) => Promise<{ verdict: AuthorizerVerdict; entries: Parameters<AuthorizerLog['review']>[] }>
}

interface ReviewerHarnessOptions {
  /** Every reply the model gives, in order */
  replies: (AssistantMessage | Promise<AssistantMessage>)[]
  config?: Partial<AutoReviewConfig>
  getProvider?: () => unknown
  entries?: SessionEntry[]
  turnSignal?: AbortSignal
  contextWindow?: number
  thinkingLevelMap?: ThinkingLevelMap
  /** What the action capture answers for each ask; by default the bash command that the ask names */
  resolve?: (details: PromptPermissionDetails) => ActionResolution
}

export function createReviewerHarness(options: ReviewerHarnessOptions): ReviewerHarness {
  const replies = [...options.replies]
  const callTimes: number[] = []
  const branch = [...(options.entries ?? [USER_ENTRY, provenanceEntry(USER_ENTRY.id)])]
  const streamSimple = vi.fn<StreamSimple>(() => ({
    result: async () => {
      callTimes.push(Date.now())
      const next = replies.shift()
      if (next === undefined) {
        throw new Error('no scripted reply')
      }

      return next
    },
  }))
  const model = {
    id: 'review-model',
    provider: 'custom-review',
    api: 'openai-responses',
    reasoning: true,
    contextWindow: options.contextWindow ?? 200_000,
    thinkingLevelMap: options.thinkingLevelMap,
  }
  const registry = {
    find: () => model,
    getProvider: options.getProvider ?? (() => ({ id: 'custom-review' })),
    streamSimple,
  } as unknown as ModelRegistry
  const reviewer = createPermissionReviewer({
    config: mergeConfig({}, { provider: 'custom-review', model: 'review-model', ...options.config }),
    actions: {
      resolve: options.resolve ?? (details => ({ kind: 'eligible', action: capturedAction(branch, details) })),
    },
    context: {
      modelRegistry: registry,
      sessionManager: {
        getBranch: () => [...branch],
        // The fixture entries are not chained, so the projection follows the branch order rather than parent links
        buildSessionProjection: () =>
          buildSessionProjection(branch.map((entry, index) => ({ ...entry, parentId: branch[index - 1]?.id ?? null }))),
        getSessionId: () => 'session-1',
      },
      signal: options.turnSignal,
    } as never,
    provenance: { flush: () => {} },
    contextFiles: () => [],
    sessionSignal: new AbortController().signal,
  })

  const start: ReviewStart = (requestId = 'request-1', details = {}) => {
    const review = vi.fn<AuthorizerLog['review']>()
    const verdict = reviewer.authorize(permissionDetails({ requestId, ...details }), {} as PermissionQuery, {
      review,
      debug: vi.fn(),
    })

    return { verdict, entries: review.mock.calls }
  }

  return {
    branch,
    resetTurn: reviewer.resetTurn,
    streamSimple,
    callTimes,
    start,
    async authorize(requestId = 'request-1', details = {}) {
      const { verdict, entries } = start(requestId, details)
      await vi.runAllTimersAsync()

      return { verdict: await verdict, entries }
    },
  }
}
