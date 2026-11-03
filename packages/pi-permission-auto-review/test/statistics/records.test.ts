import type { CallRecord, StatisticsRecord } from '../../src/statistics/records.js'
import type { StatisticsSummary } from '../../src/statistics/summary.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { SessionStatistics, sessionDigest, STATISTICS_ENTRY_TYPE } from '../../src/statistics/records.js'
import { costComplete, emptySummary } from '../../src/statistics/summary.js'

const SESSION = sessionDigest('session-1')
const PENDING = '00000000-0000-4000-8000-000000000001'
const usage = { input: 100, output: 10, cacheRead: 40, cacheWrite: 20, cacheWrite1h: 5 }
const reported: CallRecord = {
  outcome: 'reported',
  provider: 'openai-codex',
  model: 'codex-auto-review',
  phase: 'initial',
  usage,
  costUsd: 0.5,
  pricing: 'assumed',
}

function review(calls: CallRecord[], extra: Partial<Extract<StatisticsRecord, { kind: 'review' }>> = {}) {
  return {
    kind: 'review',
    session: SESSION,
    outcome: 'allow',
    durationMs: 900,
    investigationCalls: 0,
    investigationRefusals: 0,
    calls,
    ...extra,
  } as const
}

function entry(data: unknown, id = 'entry', customType = STATISTICS_ENTRY_TYPE): SessionEntry {
  return { type: 'custom', id, parentId: null, timestamp: '2026-11-03T09:00:00.000Z', customType, data }
}

function summary(fields: Partial<StatisticsSummary>): StatisticsSummary {
  return { ...emptySummary(), ...fields }
}

describe('session statistics', () => {
  it('counts a review, its calls and their usage per model', () => {
    const statistics = new SessionStatistics('session-1')
    statistics.add(
      review(
        [
          reported,
          { outcome: 'pending', id: PENDING, provider: 'openai-codex', model: 'codex-auto-review', phase: 'retry' },
        ],
        { outcome: 'deny', failure: undefined, circuitTripped: true, investigationCalls: 2, investigationRefusals: 1 },
      ),
      5_000,
    )

    expect(statistics.summary).toStrictEqual(
      summary({
        since: 5_000,
        reviews: { allow: 0, deny: 1, defer: 0 },
        circuitTrips: 1,
        reviewMs: 900,
        investigationCalls: 2,
        investigationRefusals: 1,
        calls: 2,
        retries: 1,
        unreportedCalls: 1,
        tokens: usage,
        estimatedCostUsd: 0.5,
        assumedPriceCalls: 1,
        models: [
          {
            provider: 'openai-codex',
            model: 'codex-auto-review',
            calls: 2,
            reportedCalls: 1,
            tokens: usage,
            estimatedCostUsd: 0.5,
            assumedPriceCalls: 1,
            unpricedCalls: 0,
          },
        ],
      }),
    )
  })

  it('counts a call that failed without usage as failed, which leaves the cost complete', () => {
    const statistics = new SessionStatistics('session-1')
    statistics.add(
      review([{ outcome: 'failed', id: PENDING, provider: 'p', model: 'm', phase: 'initial' }], {
        outcome: 'defer',
        failure: 'provider-error',
      }),
    )

    expect({
      counts: [statistics.summary.failedCalls, statistics.summary.unreportedCalls],
      complete: costComplete(statistics.summary),
    }).toStrictEqual({ counts: [1, 0], complete: true })
  })

  it.each([
    { call: PENDING, unreported: 0, issues: {} },
    { call: '00000000-0000-4000-8000-000000000002', unreported: 1, issues: { 'unmatched-late-usage': 1 } },
  ])('applies late usage to the pending call it reports: $call', ({ call, unreported, issues }) => {
    const statistics = new SessionStatistics('session-1')
    statistics.add(review([{ outcome: 'pending', id: PENDING, provider: 'p', model: 'm', phase: 'initial' }]))
    statistics.add({
      kind: 'late-usage',
      session: SESSION,
      call,
      provider: 'p',
      model: 'm',
      usage,
      costUsd: null,
      pricing: 'catalogue',
    })

    expect({
      unreported: statistics.summary.unreportedCalls,
      unpriced: statistics.summary.unpricedCalls,
      issues: statistics.summary.issues,
    }).toStrictEqual({ unreported, unpriced: 1, issues })
  })

  it('restores only its own records, and reports malformed ones', () => {
    const statistics = new SessionStatistics('session-1')
    statistics.restore([
      entry(review([reported]), 'own'),
      entry({ ...review([reported]), session: sessionDigest('copied-from') }, 'copied'),
      entry({ kind: 'review', session: SESSION }, 'malformed'),
      entry(review([reported]), 'other', 'other-extension'),
    ])

    expect({
      reviews: statistics.summary.reviews,
      issues: statistics.summary.issues,
      since: statistics.summary.since,
    }).toStrictEqual({
      reviews: { allow: 1, deny: 0, defer: 0 },
      issues: { 'malformed-record': 1 },
      since: Date.UTC(2026, 10, 3, 9),
    })
  })

  it.each([
    { resolution: 'user_approved', human: { approved: 1, rejected: 0, unavailable: 0, waitMs: 3000 } },
    { resolution: 'user_denied', human: { approved: 0, rejected: 1, unavailable: 0, waitMs: 3000 } },
    { resolution: 'prompt_unanswered', human: { approved: 0, rejected: 0, unavailable: 1, waitMs: 3000 } },
  ])('counts a human decision on a deferred ask: $resolution', ({ resolution, human }) => {
    const statistics = new SessionStatistics('session-1')
    statistics.add({ kind: 'human', session: SESSION, prompted: true, resolution, waitMs: 3000 }, 1_000)

    expect(statistics.summary).toStrictEqual(
      summary({ since: 1_000, prompts: 1, human, resolutions: { [resolution]: 1 } }),
    )
  })
})
