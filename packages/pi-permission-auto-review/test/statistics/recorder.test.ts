import type { ReviewReport } from '../../src/statistics/recorder.js'
import type { GlobalStatisticsStore } from '../../src/statistics/store.js'
import type { StatisticsSummary } from '../../src/statistics/summary.js'
import { PERMISSIONS_DECISION_CHANNEL, PERMISSIONS_UI_PROMPT_CHANNEL } from '@gotgenes/pi-permission-system'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsRecorder } from '../../src/statistics/recorder.js'
import { STATISTICS_ENTRY_TYPE } from '../../src/statistics/records.js'
import { StatisticsStoreError } from '../../src/statistics/store.js'
import { addSummary, emptySummary } from '../../src/statistics/summary.js'

const REPORT: ReviewReport = {
  outcome: 'allow',
  durationMs: 10,
  investigationCalls: 0,
  investigationRefusals: 0,
  calls: [],
}

/** A store whose `apply` answers in turn from `results`, counting what it commits */
function fakeStore(results: ('committed' | 'retry' | Error)[]) {
  const totals = emptySummary()
  const store = {
    apply: vi.fn((deltas: readonly StatisticsSummary[]) => {
      const result = results.shift() ?? 'committed'
      if (result instanceof Error) {
        throw result
      }
      if (result === 'committed') {
        deltas.forEach(delta => addSummary(totals, delta))
      }

      return result
    }),
    snapshot: () => ({ periodStart: 0, summary: structuredClone(totals) }),
    close: vi.fn(),
  }

  return { store, totals }
}

function setup(results: ('committed' | 'retry' | Error)[] = [], now = (): number => 1_000) {
  const handlers = new Map<string, (data: unknown) => void>()
  /** What the recorder wrote to the session, as entry type and record kind */
  const entries: [string, string][] = []
  const appendEntry = (type: string, data: unknown): void => {
    entries.push([type, (data as { kind: string }).kind])
  }
  const { store, totals } = fakeStore(results)
  const recorder = new StatisticsRecorder(
    {
      appendEntry,
      events: { on: (channel: string, handler: (data: unknown) => void) => handlers.set(channel, handler) },
    } as never,
    { directory: () => '/unused', now, openStore: () => store as unknown as GlobalStatisticsStore },
  )
  recorder.start({ getSessionId: () => 'session-1', getEntries: () => [] })

  return {
    recorder,
    entries,
    totals,
    emit: (channel: string, data: unknown) => handlers.get(channel)?.(data),
  }
}

describe('statistics recorder', () => {
  it('records a review in the session and adds it to the global totals', () => {
    const { recorder, entries } = setup()
    recorder.sink().review('request-1', REPORT)
    const global = recorder.globalTotals()

    expect({
      entries,
      session: recorder.sessionTotals().reviews,
      global: 'summary' in global ? global.summary.reviews : global,
    }).toStrictEqual({
      entries: [[STATISTICS_ENTRY_TYPE, 'review']],
      session: { allow: 1, deny: 0, defer: 0 },
      global: { allow: 1, deny: 0, defer: 0 },
    })
  })

  it('keeps the deltas while another process writes, and counts them once when the write succeeds', () => {
    const { recorder, totals } = setup(['retry'])
    recorder.sink().review('request-1', REPORT)
    const whileBusy = recorder.globalTotals()
    const afterwards = recorder.globalTotals()

    expect({
      whileBusy: 'pending' in whileBusy ? [whileBusy.pending, whileBusy.summary.reviews.allow] : whileBusy,
      afterwards: 'pending' in afterwards ? [afterwards.pending, afterwards.summary.reviews.allow] : afterwards,
      committed: totals.reviews.allow,
    }).toStrictEqual({ whileBusy: [true, 1], afterwards: [false, 1], committed: 1 })
  })

  it('stops writing after a write whose commit state is unknown', () => {
    const { recorder } = setup([new StatisticsStoreError('commit-unknown')])
    recorder.sink().review('request-1', REPORT)

    expect(recorder.globalTotals()).toStrictEqual({ unavailable: 'commit-unknown' })
  })

  it('records the human decision on an ask that a review deferred, with the time spent waiting', () => {
    let now = 1_000
    const { recorder, emit } = setup([], () => now)
    recorder.sink().review('deferred', { ...REPORT, outcome: 'defer' })
    emit(PERMISSIONS_UI_PROMPT_CHANNEL, { requestId: 'deferred' })
    now += 4_000
    emit(PERMISSIONS_DECISION_CHANNEL, { requestId: 'deferred', resolution: 'user_approved' })
    emit(PERMISSIONS_DECISION_CHANNEL, { requestId: 'another', resolution: 'user_denied' })

    expect({ prompts: recorder.sessionTotals().prompts, human: recorder.sessionTotals().human }).toStrictEqual({
      prompts: 1,
      human: { approved: 1, rejected: 0, unavailable: 0, waitMs: 4_000 },
    })
  })

  it('adds a result that arrives after the session ended only to the global totals, and says so', () => {
    const { recorder, entries, totals } = setup()
    const sink = recorder.sink()
    recorder.retire()
    sink.review('late', REPORT)
    recorder.close()

    expect({
      entries,
      reviews: totals.reviews.allow,
      issues: totals.issues,
    }).toStrictEqual({
      entries: [],
      reviews: 1,
      issues: { 'recorded-after-session': 1 },
    })
  })
})
