import type { LateUsage } from '../../src/statistics/calls.js'
import type { ReviewReport } from '../../src/statistics/recorder.js'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLICY_REVISION } from '../../src/presets/codex/policy.js'
import {
  createReviewerHarness,
  fakeInvestigation,
  investigationReply,
  provenanceEntry,
  reply,
  shellAction,
  STALLED_REPLY,
  toolCallEntry,
  USER_ENTRY,
  writeAction,
} from '../helpers.js'

const ALLOW = '{"outcome":"allow"}'
const DENY =
  '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"Publishing was not authorized."}'

// A failure Pi itself would retry
const overloaded = (): AssistantMessage => ({ ...reply('', 'error'), errorMessage: '529 overloaded_error: Overloaded' })

function createHarness(options: Partial<Parameters<typeof createReviewerHarness>[0]> = {}) {
  return createReviewerHarness({ replies: [reply(ALLOW)], ...options })
}

describe('permission reviewer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks a tool-free model call and logs where its evidence came from', async () => {
    const harness = createHarness()
    const { verdict, entries } = await harness.authorize()
    const [, context, options] = harness.streamSimple.mock.calls[0] ?? []

    expect(verdict).toEqual({ kind: 'allow' })
    expect(context).not.toHaveProperty('tools')
    // Retries stay inside the review's own budget, reasoning is not starved by an output cap, and the review keeps a
    // session key apart from the main conversation's
    expect(options).toMatchObject({ maxRetries: 0, sessionId: 'auto-review:session-1' })
    expect(options).not.toHaveProperty('maxTokens')
    expect(entries[0]?.[1]).toMatchObject({
      policyRevision: POLICY_REVISION,
      contextSource: 'active-branch',
      actionKind: 'shell',
      actionDigest: shellAction().digest,
      'user.retainedFull': 1,
      authorityFits: true,
      authorityEdited: false,
      provenanceUncertain: false,
      usage: { input: 100, cacheRead: 40, output: 10 },
    })
  })

  it.each([
    { preset: 'codex', reply: ALLOW, format: true },
    { preset: 'claude-code', reply: '<block>no</block>', format: false },
  ] as const)(
    'asks the provider for a JSON verdict natively only with the codex preset: $preset',
    async ({ preset, reply: text, format }) => {
      const harness = createHarness({ config: { preset }, replies: [reply(text)] })
      await harness.authorize()
      const [, , options] = harness.streamSimple.mock.calls[0] ?? []
      const payload = (await options?.onPayload?.({}, {} as never)) as { text?: { format?: { required?: unknown } } }

      expect(payload?.text?.format).toStrictEqual(
        format
          ? {
              type: 'json_schema',
              name: 'codex_output_schema',
              strict: true,
              schema: expect.objectContaining({
                required: ['risk_level', 'user_authorization', 'outcome', 'rationale'],
                additionalProperties: false,
              }) as unknown,
            }
          : undefined,
      )
    },
  )

  it('returns a denial that teaches and forbids workarounds, without writing the rationale to the log', async () => {
    const { verdict, entries } = await createHarness({ replies: [reply(DENY)] }).authorize()

    expect(verdict.kind === 'deny' ? verdict.reason : undefined).toMatch(
      /^Publishing was not authorized\. \(risk: high, user authorization: unknown\)\. The agent must not attempt to achieve the same outcome via workaround/,
    )
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'deny', riskLevel: 'high', userApproval: 'unknown' })
    expect(entries[0]?.[1]).not.toHaveProperty('rationale')
  })

  it("shortens a long rationale in the denial to Codex's 900 tokens, keeping its start and end", async () => {
    const rationale = `Start. ${'x'.repeat(3_980)} End.`
    const deny = JSON.stringify({ risk_level: 'high', user_authorization: 'unknown', outcome: 'deny', rationale })
    const { verdict } = await createHarness({ replies: [reply(deny)] }).authorize()
    const reason = verdict.kind === 'deny' ? (verdict.reason ?? '') : ''
    const shown = reason.slice(0, reason.indexOf(' (risk: high'))

    expect({ length: shown.length, start: shown.startsWith('Start.'), end: shown.endsWith('End.') }).toStrictEqual({
      length: 3_600,
      start: true,
      end: true,
    })
  })

  it('shows the reviewer the complete captured input of the call that raised the ask', async () => {
    const action = writeAction('notes.md', 'x'.repeat(50_000))
    const harness = createHarness({ resolve: () => ({ kind: 'eligible', action }) })
    const { entries } = await harness.authorize('request-1', { toolCallId: 'call-1', toolName: 'write' })
    const [, context] = harness.streamSimple.mock.calls[0] ?? []

    expect(context?.messages[0]?.content).toContain(action.input.content)
    expect(entries[0]?.[1]).toMatchObject({ actionKind: 'file-write', actionDigest: action.digest })
  })

  it.each([
    { resolution: 'forwarded', category: 'forwarded-ineligible' },
    { resolution: 'action-unavailable', category: 'action-unavailable' },
    { resolution: 'action-mismatch', category: 'action-mismatch' },
    { resolution: 'action-changed', category: 'action-changed' },
    { resolution: 'unsupported-input', category: 'unsupported-input' },
    { resolution: 'protected-target', category: 'protected-target' },
  ] as const)('defers without a model call when the capture is $resolution', async ({ resolution, category }) => {
    const harness = createHarness({ resolve: () => ({ kind: resolution }) })
    const { verdict, entries } = await harness.authorize()

    // A review that called the model would log its usage
    expect({ verdict, entry: entries[0]?.[1] }).toStrictEqual({
      verdict: { kind: 'defer' },
      entry: {
        requestId: 'request-1',
        provider: 'custom-review',
        model: 'review-model',
        outcome: 'defer',
        errorCategory: category,
        durationMs: 0,
      },
    })
  })

  it('reviews a branch with an uncertain message, showing it as a restriction-only record', async () => {
    const revocation = {
      ...USER_ENTRY,
      id: 'revocation',
      message: { role: 'user', content: 'Do not publish.', timestamp: 0 },
    }
    const harness = createHarness({
      entries: [
        USER_ENTRY,
        provenanceEntry(USER_ENTRY.id),
        revocation,
        provenanceEntry('revocation', 'uncertain'),
      ] as never,
    })
    const { verdict, entries } = await harness.authorize()
    const [, context] = harness.streamSimple.mock.calls[0] ?? []

    expect({
      verdict,
      entry: entries[0]?.[1],
      record: String(context?.messages[0]?.content).includes(
        '{"index":2,"source":"uncertain_user","label":"uncertain_user","content":"Do not publish."}',
      ),
    }).toMatchObject({
      verdict: { kind: 'allow' },
      entry: { outcome: 'allow', 'uncertain_user.retainedFull': 1, provenanceUncertain: true },
      record: true,
    })
  })

  describe('user evidence', () => {
    function userMessages(lengths: number[]): SessionEntry[] {
      return lengths.flatMap((length, index) => [
        {
          ...USER_ENTRY,
          id: `user-${index}`,
          message: { role: 'user', content: `${index}:${'x'.repeat(length)}`, timestamp: 0 },
        },
        provenanceEntry(`user-${index}`),
      ]) as SessionEntry[]
    }
    const prompt = (harness: ReturnType<typeof createHarness>): string =>
      String(harness.streamSimple.mock.calls[0]?.[1].messages[0]?.content ?? '')

    it('reviews a session whose user messages exceed the 20,000-token allowance', async () => {
      const harness = createHarness({ entries: userMessages([60_000, 60_000]) })
      const { verdict } = await harness.authorize()

      expect({ verdict, truncated: prompt(harness).includes('[truncated]') }).toStrictEqual({
        verdict: { kind: 'allow' },
        truncated: false,
      })
    })

    it.each([
      { description: 'the oldest long user messages', lengths: [80_000, 80_000, 20_000], newestWhole: true },
      { description: 'a newest user message that alone does not fit', lengths: [1_000, 200_000], newestWhole: false },
    ])('shortens $description to fit a small context window', async ({ lengths, newestWhole }) => {
      const newest = `${lengths.length - 1}:${'x'.repeat(lengths.at(-1) ?? 0)}`
      const harness = createHarness({ contextWindow: 60_000, entries: userMessages(lengths) })
      const { verdict, entries } = await harness.authorize()

      expect({
        verdict,
        newestWhole: prompt(harness).includes(JSON.stringify(newest).slice(1, -1)),
        truncated: prompt(harness).includes('[truncated]'),
        entry: entries[0]?.[1],
      }).toMatchObject({ verdict: { kind: 'allow' }, newestWhole, truncated: true, entry: { authorityFits: true } })
    })

    it('defers without a model call when user messages too short to shorten do not fit', async () => {
      const harness = createHarness({
        contextWindow: 40_000,
        entries: userMessages(Array.from<number>({ length: 60 }).fill(3_000)),
      })
      const { verdict, entries } = await harness.authorize()

      expect({ verdict, entry: entries[0]?.[1] }).toMatchObject({
        verdict: { kind: 'defer' },
        // No tokens used, because no model call was made
        entry: { errorCategory: 'authority-over-budget', authorityFits: false, usage: { input: 0, output: 0 } },
      })
    })

    it('defers without a model call when a context edit removed user evidence', async () => {
      const edit = {
        type: 'context_edit',
        id: 'edit',
        parentId: 'provenance-user-1',
        timestamp: USER_ENTRY.timestamp,
        targetId: USER_ENTRY.id,
        replacement: null,
      } as SessionEntry
      const harness = createHarness({ entries: [USER_ENTRY, provenanceEntry(USER_ENTRY.id), edit] })
      const { verdict, entries } = await harness.authorize()

      expect({ verdict, entry: entries[0]?.[1] }).toMatchObject({
        verdict: { kind: 'defer' },
        entry: { errorCategory: 'authority-edited', authorityEdited: true, usage: { input: 0, output: 0 } },
      })
    })
  })

  it('defers an action too large for the reviewer to see whole, without calling it', async () => {
    const action = writeAction('dump.json', 'x'.repeat(1_000_000))
    const harness = createHarness({ resolve: () => ({ kind: 'eligible', action }) })
    const { verdict, entries } = await harness.authorize('request-1', { toolCallId: 'call-1' })

    expect(verdict).toEqual({ kind: 'defer' })
    expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'input-budget-exceeded' })
    expect(harness.streamSimple).not.toHaveBeenCalled()
  })

  it('retries a transient provider failure within the same review', async () => {
    const harness = createHarness({ replies: [overloaded(), reply(ALLOW)] })

    expect((await harness.authorize()).verdict).toEqual({ kind: 'allow' })
    expect(harness.streamSimple).toHaveBeenCalledTimes(2)
  })

  it('never resends a refused request, or another a retry cannot change, and defers it to the human prompt', async () => {
    const failures = [
      // The explanation a refusal carries could read like a transient error
      {
        ...reply('', 'error'),
        rawStopReason: 'refusal',
        errorMessage: 'This request was declined; you can retry your request with different content.',
      },
      // A gateway that relays the refusal as an error of its own
      {
        ...reply('', 'error'),
        errorMessage: 'claude-sonnet-5-5 refused this request (safety filter: content_filter)',
      },
      // Request-time authentication fails inside the registry stream, which reports an unusable login the same way
      { ...reply('', 'error'), errorMessage: 'No API key found for custom-review' },
    ]
    for (const failure of failures) {
      const harness = createHarness({ replies: [failure, reply(ALLOW)] })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    }
  })

  it('retries a malformed reply, and defers to the human prompt once every attempt has failed', async () => {
    expect((await createHarness({ replies: [reply('not json'), reply(ALLOW)] }).authorize()).verdict).toEqual({
      kind: 'allow',
    })

    const malformed = await createHarness({
      replies: [reply('not json'), reply('not json'), reply('not json')],
    }).authorize()
    expect(malformed.verdict).toEqual({ kind: 'defer' })
    // Every reply is paid for, including the ones that were retried
    expect(malformed.entries[0]?.[1]).toMatchObject({ errorCategory: 'invalid-response', usage: { input: 300 } })
  })

  // The authorizer chain does not isolate a link that throws
  it('defers rather than throw when the reviewer provider is missing or its lookup throws', async () => {
    const missing = await createHarness({ getProvider: () => undefined }).authorize()
    const throwing = await createHarness({
      getProvider: () => {
        throw new Error('provider lookup failed')
      },
    }).authorize()

    expect(missing).toMatchObject({ verdict: { kind: 'defer' } })
    expect(missing.entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-unresolved' })
    expect(throwing).toMatchObject({ verdict: { kind: 'defer' } })
    expect(throwing.entries[0]?.[1]).toMatchObject({ errorCategory: 'internal-error' })
  })

  it('denies the third consecutive denial with its reason, warns once and interrupts the turn', async () => {
    const harness = createHarness({ replies: [reply(DENY), reply(DENY), reply(DENY)] })
    const results = []
    for (let index = 0; index < 4; index += 1) {
      results.push(await harness.authorize(`request-${index}`))
    }

    expect({
      verdicts: results.map(({ verdict }) => (verdict.kind === 'deny' ? verdict.reason?.split('.')[0] : verdict.kind)),
      events: results.map(({ entries }) => [entries[0]?.[0], entries[0]?.[1]?.['denialLimit']]),
      notified: harness.notified,
      turnAborted: harness.turnAborted,
    }).toStrictEqual({
      verdicts: [
        'Publishing was not authorized',
        'Publishing was not authorized',
        'Publishing was not authorized',
        'Too many denials this turn; further requests are refused unreviewed until the next turn',
      ],
      events: [
        ['auto_review.decision', undefined],
        ['auto_review.decision', undefined],
        ['auto_review.decision', 'consecutive'],
        ['auto_review.circuit_open', undefined],
      ],
      notified: [
        [
          'Too many denials this turn; further requests are refused unreviewed until the next turn. Ask the user for explicit approval before retrying',
          'warning',
        ],
      ],
      turnAborted: true,
    })
  })

  it('logs the warning instead when the session has no UI', async () => {
    const harness = createHarness({ hasUI: false, replies: [reply(DENY), reply(DENY), reply(DENY)] })
    const results = []
    for (let index = 0; index < 3; index += 1) {
      results.push(await harness.authorize(`request-${index}`))
    }

    expect({
      tripped: results[2]?.entries.map(([event]) => event),
      notified: harness.notified,
      turnAborted: harness.turnAborted,
    }).toStrictEqual({
      tripped: ['auto_review.circuit_tripped', 'auto_review.decision'],
      notified: [],
      turnAborted: true,
    })
  })

  it('denies a review that finishes with an allow after the circuit tripped', async () => {
    const pending = Promise.withResolvers<AssistantMessage>()
    const harness = createHarness({ replies: [pending.promise, reply(DENY), reply(DENY), reply(DENY)] })
    const slow = harness.start('request-slow')
    for (let index = 0; index < 3; index += 1) {
      await harness.start(`request-${index}`).verdict
    }
    pending.resolve(reply(ALLOW))

    expect({ verdict: (await slow.verdict).kind, event: slow.entries[0]?.[0] }).toStrictEqual({
      verdict: 'deny',
      event: 'auto_review.circuit_open',
    })
  })

  it('refuses after ten denials in the recent window too, until the next turn', async () => {
    const harness = createHarness({ replies: Array.from({ length: 10 }, () => [reply(DENY), reply(ALLOW)]).flat() })
    for (let index = 0; index < 19; index += 1) {
      await harness.authorize(`request-${index}`)
    }

    expect((await harness.authorize('request-19')).verdict).toMatchObject({ kind: 'deny' })
    expect(harness.streamSimple).toHaveBeenCalledTimes(19)

    harness.resetTurn()
    expect((await harness.authorize('request-20')).verdict).toEqual({ kind: 'allow' })
  })

  it('aborts at the total timeout and defers', async () => {
    const { verdict, entries } = await createHarness({
      config: { timeoutMs: 5 },
      replies: [STALLED_REPLY],
    }).authorize()

    expect(verdict).toEqual({ kind: 'defer' })
    expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout' })
  })

  it('denies at once when the turn is interrupted, and spends no call on an ask raised after it', async () => {
    const turn = new AbortController()
    const harness = createHarness({ turnSignal: turn.signal, replies: [STALLED_REPLY] })
    const { verdict, entries } = harness.start()
    turn.abort()

    expect(await verdict).toMatchObject({ kind: 'deny' })
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'deny', errorCategory: 'cancelled' })

    expect((await harness.authorize('request-2')).verdict).toMatchObject({ kind: 'deny' })
    expect(harness.streamSimple).toHaveBeenCalledOnce()
  })

  describe('retries', () => {
    const failures = (count: number): AssistantMessage[] => Array.from({ length: count }, overloaded)

    it('retries maxRetries times, backing off to at most 30 s between calls', async () => {
      const harness = createHarness({
        config: { maxRetries: 7, timeoutMs: 300_000 },
        replies: [...failures(7), reply(ALLOW)],
      })

      expect((await harness.authorize()).verdict).toEqual({ kind: 'allow' })
      expect(harness.callTimes).toEqual([0, 250, 1_250, 5_250, 21_250, 51_250, 81_250, 111_250])
    })

    it('makes a single call when maxRetries is 0', async () => {
      const harness = createHarness({ config: { maxRetries: 0 }, replies: [...failures(1), reply(ALLOW)] })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('abandons a call at attemptTimeoutMs and retries it, even if the provider ignores the abort', async () => {
      const lateDenial = new Promise<AssistantMessage>(resolve => setTimeout(resolve, 1_100, reply(DENY)))
      const harness = createHarness({ config: { attemptTimeoutMs: 1_000 }, replies: [lateDenial, reply(ALLOW)] })
      const { verdict } = await harness.authorize()
      const [, , options] = harness.streamSimple.mock.calls[0] ?? []

      expect(verdict).toEqual({ kind: 'allow' })
      expect(options).toMatchObject({ timeoutMs: 1_000 })
      expect(options?.signal?.aborted).toBe(true)
    })

    it('gives a call another transport key while an earlier call of the session is still unfinished', async () => {
      const unfinished = Promise.withResolvers<AssistantMessage>()
      // Calls that other tests leave unfinished keep their keys, so this test has a session of its own
      const harness = createHarness({
        sessionId: 'session-keys',
        config: { attemptTimeoutMs: 1_000 },
        replies: [unfinished.promise, reply(ALLOW), reply(ALLOW)],
      })
      await harness.authorize('request-1')
      unfinished.resolve(reply(DENY))
      await vi.runAllTimersAsync()
      await harness.authorize('request-2')

      expect(harness.streamSimple.mock.calls.map(([, , options]) => options?.sessionId)).toStrictEqual([
        'auto-review:session-keys',
        'auto-review:session-keys:1',
        'auto-review:session-keys',
      ])
    })

    it('defers with attempt-timeout once every attempt has timed out', async () => {
      const harness = createHarness({
        config: { maxRetries: 1, attemptTimeoutMs: 1_000 },
        replies: [STALLED_REPLY, STALLED_REPLY],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'attempt-timeout' })
      expect(harness.streamSimple).toHaveBeenCalledTimes(2)
    })

    it('keeps every call and backoff within timeoutMs, however long attemptTimeoutMs is', async () => {
      const harness = createHarness({
        config: { timeoutMs: 1_000, maxRetries: 5, attemptTimeoutMs: 60_000 },
        replies: [...failures(2), reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout', durationMs: 1_000 })
      expect(harness.callTimes).toEqual([0, 250])
      expect(harness.streamSimple.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([1_000, 750])
    })

    it('denies at once when the turn is interrupted during a backoff, leaving no call or timer behind', async () => {
      const turn = new AbortController()
      const harness = createHarness({ turnSignal: turn.signal, replies: [...failures(1), reply(ALLOW)] })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(100)
      turn.abort()

      expect(await verdict).toMatchObject({ kind: 'deny' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'cancelled', durationMs: 100 })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('statistics', () => {
    function sink() {
      const reports: [string, ReviewReport][] = []
      const late: LateUsage[] = []

      return {
        reports,
        late,
        statistics: {
          review: (id: string, report: ReviewReport) => reports.push([id, report]),
          late: (usage: LateUsage) => late.push(usage),
          manual: () => {},
        },
      }
    }

    it('reports each verdict with its calls, their usage and an estimated cost', async () => {
      const recorded = sink()
      const failed = { ...overloaded(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }
      const harness = createHarness({
        statistics: recorded.statistics,
        replies: [failed as AssistantMessage, reply(ALLOW)],
      })
      await harness.authorize()

      expect(recorded.reports).toStrictEqual([
        [
          'request-1',
          {
            outcome: 'allow',
            failure: undefined,
            circuitTripped: undefined,
            durationMs: expect.any(Number) as unknown,
            investigationCalls: 0,
            investigationRefusals: 0,
            calls: [
              {
                outcome: 'failed',
                id: expect.any(String) as unknown,
                provider: 'custom-review',
                model: 'review-model',
                phase: 'initial',
              },
              {
                outcome: 'reported',
                provider: 'custom-review',
                model: 'review-model',
                phase: 'retry',
                usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 0, cacheWrite1h: 0 },
                costUsd: (100 * 1 + 10 * 2 + 40 * 0.5) / 1_000_000,
                pricing: 'catalogue',
              },
            ],
          },
        ],
      ])
    })

    it('keeps the usage of a call abandoned at its timeout when its result arrives before the review ends', async () => {
      const recorded = sink()
      const lateDenial = new Promise<AssistantMessage>(resolve => setTimeout(resolve, 1_100, reply(DENY)))
      const harness = createHarness({
        statistics: recorded.statistics,
        config: { attemptTimeoutMs: 1_000 },
        replies: [lateDenial, reply(ALLOW)],
      })
      await harness.authorize()

      expect(recorded.reports[0]?.[1].calls.map(call => call.outcome)).toStrictEqual(['reported', 'reported'])
    })

    it('reports an ask that it did not review with the reason', async () => {
      const recorded = sink()
      const harness = createHarness({ statistics: recorded.statistics, resolve: () => ({ kind: 'forwarded' }) })
      await harness.authorize()

      expect(recorded.reports.map(([, report]) => [report.outcome, report.failure, report.calls])).toStrictEqual([
        ['defer', 'forwarded-ineligible', []],
      ])
    })

    it('reports usage that arrives after an interrupted review as late usage of its pending call', async () => {
      const recorded = sink()
      const turn = new AbortController()
      const pending = Promise.withResolvers<AssistantMessage>()
      const requested = Promise.withResolvers<void>()
      const harness = createHarness({
        statistics: recorded.statistics,
        turnSignal: turn.signal,
        replies: [
          async () => {
            requested.resolve()
            return pending.promise
          },
        ],
      })
      const { verdict } = harness.start()
      await requested.promise
      turn.abort()
      await verdict
      pending.resolve(reply(ALLOW))
      await vi.waitFor(() => expect(recorded.late).toHaveLength(1))
      const [, report] = recorded.reports[0] ?? []
      const [call] = report?.calls ?? []

      expect({ call, late: recorded.late }).toStrictEqual({
        call: {
          outcome: 'pending',
          id: expect.any(String) as unknown,
          provider: 'custom-review',
          model: 'review-model',
          phase: 'initial',
        },
        late: [
          {
            call: call?.outcome === 'pending' ? call.id : undefined,
            provider: 'custom-review',
            model: 'review-model',
            usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 0, cacheWrite1h: 0 },
            costUsd: (100 * 1 + 10 * 2 + 40 * 0.5) / 1_000_000,
            pricing: 'catalogue',
          },
        ],
      })
    })
  })

  describe('investigation', () => {
    const toolNames = (harness: ReturnType<typeof createHarness>): (string[] | undefined)[] =>
      harness.streamSimple.mock.calls.map(([, context]) =>
        (context as { tools?: { name: string }[] }).tools?.map(tool => tool.name),
      )
    const toolChoices = (harness: ReturnType<typeof createHarness>): unknown[] =>
      harness.streamSimple.mock.calls.map(([, , options]) => (options as { toolChoice?: string }).toolChoice)

    it('lets the codex reviewer inspect local state in the sandbox before it decides', async () => {
      const harness = createHarness({
        investigation: fakeInvestigation({ stdout: 'origin git@example.com:private/repo.git\n' }),
        replies: [investigationReply('shell', { command: 'git remote -v' }), reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()
      const [, first] = harness.streamSimple.mock.calls[0] ?? []
      const [, second] = harness.streamSimple.mock.calls[1] ?? []

      expect({
        verdict,
        tools: toolNames(harness),
        guidelines: first?.systemPrompt.includes('Only call tools when they would flip an allow/deny decision'),
        exchange: second?.messages.slice(1).map(message => message.role),
        result: JSON.stringify(second?.messages[2]),
        fields: [entries[0]?.[1]?.['investigationCalls'], entries[0]?.[1]?.['investigationBytes']],
      }).toStrictEqual({
        verdict: { kind: 'allow' },
        tools: [
          ['shell', 'read'],
          ['shell', 'read'],
        ],
        guidelines: true,
        exchange: ['assistant', 'toolResult'],
        result: expect.stringContaining('private/repo.git') as unknown,
        fields: [1, 40],
      })
    })

    it('asks for the verdict without further calls once the budget is exhausted', async () => {
      const calls = Array.from({ length: 8 }, (_, index) =>
        investigationReply('shell', { command: `echo ${index}` }, `call-${index}`),
      )
      const harness = createHarness({
        investigation: fakeInvestigation({ stdout: 'ok' }),
        replies: [...calls, reply(DENY)],
      })
      const { verdict } = await harness.authorize()

      expect({ verdict: verdict.kind, choices: toolChoices(harness) }).toStrictEqual({
        verdict: 'deny',
        choices: [...Array.from({ length: 8 }).fill(undefined), 'none'],
      })
    })

    it('defers when the reviewer still calls a tool after the budget is exhausted', async () => {
      const calls = Array.from({ length: 9 }, (_, index) =>
        investigationReply('shell', { command: `echo ${index}` }, `call-${index}`),
      )
      const harness = createHarness({
        config: { maxRetries: 0 },
        investigation: fakeInvestigation({ stdout: 'ok' }),
        replies: calls,
      })
      const { verdict, entries } = await harness.authorize()

      expect({ verdict, category: entries[0]?.[1]?.['errorCategory'] }).toStrictEqual({
        verdict: { kind: 'defer' },
        category: 'invalid-response',
      })
    })

    it.each([
      { description: 'no sandbox can meet the requirements', preset: 'codex', sandbox: 'unavailable' },
      { description: 'the preset is claude-code', preset: 'claude-code', sandbox: { stdout: 'ok' } },
    ] as const)('offers no tools when $description', async ({ preset, sandbox }) => {
      const harness = createHarness({
        config: { preset },
        investigation: fakeInvestigation(sandbox),
        replies: preset === 'codex' ? [reply(ALLOW)] : [reply('<block>no</block>')],
      })
      await harness.authorize()

      expect(toolNames(harness)).toStrictEqual([undefined])
    })

    it('continues the conversation after a review that investigated, offering the tools again', async () => {
      const harness = createHarness({
        config: { followUpReviews: 'always' },
        investigation: fakeInvestigation({ stdout: 'ok' }),
        replies: [investigationReply('shell', { command: 'ls' }), reply(ALLOW), reply(ALLOW)],
      })
      await harness.authorize('request-1')
      await harness.authorize('request-2')

      expect({
        roles: harness.streamSimple.mock.calls.map(([, context]) => context.messages.map(message => message.role)),
        tools: toolNames(harness),
      }).toStrictEqual({
        roles: [
          ['user'],
          ['user', 'assistant', 'toolResult'],
          ['user', 'assistant', 'toolResult', 'assistant', 'user'],
        ],
        tools: [
          ['shell', 'read'],
          ['shell', 'read'],
          ['shell', 'read'],
        ],
      })
    })

    it.each([
      {
        description: 'the tools are withdrawn after a review that used them',
        before: true,
        replies: [investigationReply('shell', { command: 'ls' }), reply(ALLOW), reply(ALLOW)],
        roles: [['user'], ['user', 'assistant', 'toolResult'], ['user']],
        tools: [['shell', 'read'], ['shell', 'read'], undefined],
      },
      {
        description: 'the tools become available after a review without them',
        before: false,
        replies: [reply(ALLOW), reply(ALLOW)],
        roles: [['user'], ['user']],
        tools: [undefined, ['shell', 'read']],
      },
    ])('starts over when $description', async ({ before, replies, roles, tools }) => {
      const sandbox = fakeInvestigation({ stdout: 'ok' })
      let available = before
      const harness = createHarness({
        config: { followUpReviews: 'always' },
        investigation: {
          availability: async () => (available ? sandbox.availability() : { available: false, reason: 'gone' }),
          forReview: signal => sandbox.forReview(signal),
        },
        replies,
      })
      await harness.authorize('request-1')
      available = !before
      await harness.authorize('request-2')

      expect({
        roles: harness.streamSimple.mock.calls.map(([, context]) => context.messages.map(message => message.role)),
        tools: toolNames(harness),
      }).toStrictEqual({ roles, tools })
    })
  })

  describe('freshness', () => {
    function userMessage(id: string, content: string): SessionEntry[] {
      return [
        { ...USER_ENTRY, id, message: { role: 'user', content, timestamp: 0 } } as SessionEntry,
        provenanceEntry(id),
      ]
    }

    const prompts = (harness: ReturnType<typeof createHarness>): string[] =>
      harness.streamSimple.mock.calls.map(([, context]) => String(context.messages.at(-1)?.content))

    it('reviews again with the new evidence when the person adds a message during the review', async () => {
      const harness = createHarness({
        replies: [
          () => {
            harness.branch.push(...userMessage('user-2', 'Do not publish anything.'))

            return reply(ALLOW)
          },
          reply(DENY),
        ],
      })
      const { verdict, entries } = await harness.authorize()

      expect({
        verdict: verdict.kind,
        sawRestriction: prompts(harness).map(prompt => prompt.includes('Do not publish anything.')),
        log: entries.map(([, entry]) => ({ outcome: entry?.['outcome'], attempts: entry?.['attempts'] })),
      }).toStrictEqual({ verdict: 'deny', sawRestriction: [false, true], log: [{ outcome: 'deny', attempts: 2 }] })
    })

    it('defers when the user evidence changes during each of three attempts', async () => {
      const harness = createHarness({
        replies: [0, 1, 2].map(index => () => {
          harness.branch.push(...userMessage(`user-${index + 2}`, `Message ${index}`))

          return reply(ALLOW)
        }),
      })
      const { verdict, entries } = await harness.authorize()

      expect({ verdict, entry: entries[0]?.[1] }).toMatchObject({
        verdict: { kind: 'defer' },
        entry: { outcome: 'defer', errorCategory: 'stale-authorization-exhausted', attempts: 3 },
      })
    })

    it.each([
      {
        change: 'the branch moves to another path',
        apply: (harness: ReturnType<typeof createHarness>) =>
          harness.branch.splice(0, Infinity, ...userMessage('user-other', 'Please run the requested operation.')),
      },
      {
        change: 'a context edit lands',
        apply: (harness: ReturnType<typeof createHarness>) =>
          harness.branch.push({
            type: 'context_edit',
            id: 'edit-1',
            parentId: 'provenance-user-1',
            timestamp: USER_ENTRY.timestamp,
            targetId: 'missing',
            replacement: null,
          }),
      },
      {
        change: 'the registered tools change',
        apply: (harness: ReturnType<typeof createHarness>) => {
          harness.registryDigest = 'registry-2'
        },
      },
    ])('defers without another attempt when $change during the review', async ({ apply }) => {
      const harness = createHarness({
        replies: [
          () => {
            apply(harness)

            return reply(ALLOW)
          },
        ],
      })
      const { verdict, entries } = await harness.authorize()

      expect({ verdict, entry: entries[0]?.[1] }).toMatchObject({
        verdict: { kind: 'defer' },
        entry: { outcome: 'defer', errorCategory: 'stale-snapshot', attempts: 1 },
      })
    })

    it('applies the verdict when the session only gained an assistant message during the review', async () => {
      const harness = createHarness({
        replies: [
          () => {
            harness.branch.push(toolCallEntry({ path: 'notes.md', content: 'unrelated' }, 'call-2'))

            return reply(ALLOW)
          },
        ],
      })
      const { verdict, entries } = await harness.authorize()

      expect({ verdict, entry: entries[0]?.[1] }).toMatchObject({
        verdict: { kind: 'allow' },
        entry: { outcome: 'allow', attempts: 1 },
      })
    })

    it('starts the second attempt over in full instead of continuing the conversation', async () => {
      const harness = createHarness({
        config: { followUpReviews: 'always' },
        replies: [
          reply(ALLOW),
          () => {
            harness.branch.push(...userMessage('user-2', 'Only the staging registry.'))

            return reply(ALLOW)
          },
          reply(ALLOW),
        ],
      })
      await harness.authorize('request-1')
      await harness.authorize('request-2')

      expect(harness.streamSimple.mock.calls.map(([, context]) => context.messages.length)).toStrictEqual([1, 3, 1])
    })
  })

  describe('follow-up reviews', () => {
    const uncached = (): AssistantMessage => reply(ALLOW, 'stop', { cacheRead: 0 })
    const messageCounts = (harness: ReturnType<typeof createHarness>): number[] =>
      harness.streamSimple.mock.calls.map(([, context]) => context.messages.length)

    async function authorizeEach(harness: ReturnType<typeof createHarness>, count: number): Promise<void> {
      for (let index = 1; index <= count; index += 1) {
        await harness.authorize(`request-${index}`)
      }
    }

    it('continues the conversation with only what the session added since the last review', async () => {
      const first = reply(ALLOW)
      const harness = createHarness({ replies: [first, reply(ALLOW)] })
      await harness.authorize('request-1')
      harness.branch.push(toolCallEntry({ path: 'notes.md', content: 'the second change' }))
      const { entries } = await harness.authorize('request-2')
      const [, initial] = harness.streamSimple.mock.calls[0] ?? []
      const [, followUp] = harness.streamSimple.mock.calls[1] ?? []

      expect(followUp?.systemPrompt).toBe(initial?.systemPrompt)
      expect(followUp?.messages.slice(0, 2)).toEqual([initial?.messages[0], first])
      expect(followUp?.messages[2]?.content).toContain('>>> TRANSCRIPT DELTA JSONL START')
      expect(followUp?.messages[2]?.content).toContain('the second change')
      expect(followUp?.messages[2]?.content).not.toContain('Please run the requested operation.')
      expect(entries[0]?.[1]).toMatchObject({ priorReviews: 1 })
    })

    it.each(['context_edit', 'compaction'] as const)(
      'starts over in full after a %s, which can change what the earlier reviews saw',
      async type => {
        const harness = createHarness({ replies: [reply(ALLOW), reply(ALLOW)] })
        await harness.authorize('request-1')
        harness.branch.push({
          type,
          id: 'change',
          parentId: 'provenance-user-1',
          timestamp: USER_ENTRY.timestamp,
          ...(type === 'context_edit'
            ? { targetId: 'missing', replacement: null }
            : { summary: 'Summary', firstKeptEntryId: USER_ENTRY.id, tokensBefore: 10 }),
        } as SessionEntry)
        await harness.authorize('request-2')

        expect(harness.streamSimple.mock.calls.map(([, context]) => context.messages.length)).toStrictEqual([1, 1])
      },
    )

    it('starts over in full once the reviewed entries leave the branch, or the conversation would not fit', async () => {
      const moved = createHarness({ replies: [reply(ALLOW), reply(ALLOW)] })
      await moved.authorize('request-1')
      moved.branch.splice(0, 2, { ...USER_ENTRY, id: 'user-2' }, provenanceEntry('user-2'))
      await moved.authorize('request-2')

      const crowded = createHarness({ replies: [reply(ALLOW, 'stop', { totalTokens: 190_000 }), reply(ALLOW)] })
      await authorizeEach(crowded, 2)

      // Every review rereads the whole conversation, so a large window does not let it grow past 256k tokens
      const capped = createHarness({
        contextWindow: 1_000_000,
        replies: [reply(ALLOW, 'stop', { totalTokens: 250_000 }), reply(ALLOW)],
      })
      await authorizeEach(capped, 2)

      expect(messageCounts(moved)).toEqual([1, 1])
      expect(messageCounts(crowded)).toEqual([1, 1])
      expect(messageCounts(capped)).toEqual([1, 1])
    })

    it('starts over after a follow-up the provider served without a cache hit, unless told to always follow up', async () => {
      const modes = [
        ['auto', [1, 3, 1]],
        ['always', [1, 3, 5]],
        ['off', [1, 1, 1]],
      ] as const
      for (const [followUpReviews, counts] of modes) {
        const harness = createHarness({ config: { followUpReviews }, replies: [uncached(), uncached(), uncached()] })
        await authorizeEach(harness, 3)

        expect(messageCounts(harness)).toEqual(counts)
      }
    })

    it('starts over after a review that failed', async () => {
      const overflow = { ...reply('', 'error'), errorMessage: 'context length exceeded' }
      const harness = createHarness({ replies: [reply(ALLOW), overflow, reply(ALLOW)] })
      await authorizeEach(harness, 3)

      expect(messageCounts(harness)).toEqual([1, 3, 1])
    })
  })
})
