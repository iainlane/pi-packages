import type { LateUsage } from './calls.js'
import type { StatisticsRecord } from './records.js'
import type { GlobalSnapshot } from './store.js'
import type { StatisticsSummary } from './summary.js'
import type { ExtensionAPI, SessionManager } from '@earendil-works/pi-coding-agent'
import type { PermissionDecisionEvent, PermissionUiPromptEvent } from '@gotgenes/pi-permission-system'
import { PERMISSIONS_DECISION_CHANNEL, PERMISSIONS_UI_PROMPT_CHANNEL } from '@gotgenes/pi-permission-system'
import { SessionStatistics, STATISTICS_ENTRY_TYPE } from './records.js'
import { GlobalStatisticsStore, StatisticsStoreError } from './store.js'
import { addSummary, emptySummary } from './summary.js'

const FLUSH_DELAY_MS = 1_000
// A deferred ask normally reaches its human decision within one prompt; the bound only stops a leak
const MAX_WATCHED_ASKS = 256

/** A completed review, as its session record lists it */
export type ReviewReport = Omit<Extract<StatisticsRecord, { kind: 'review' }>, 'kind' | 'session'>

/** What a session's reviews report; never throws, so recording cannot change a verdict */
export interface ReviewStatistics {
  review: (requestId: string, report: ReviewReport) => void
  late: (usage: LateUsage) => void
}

export interface RecorderOptions {
  /** The directory of the profile's global database */
  directory: () => string
  now?: () => number
  openStore?: (directory: string, periodStart: number) => GlobalStatisticsStore
}

export type GlobalTotals = (GlobalSnapshot & { pending: boolean }) | { unavailable: string }

interface Session {
  statistics: SessionStatistics
  retired: boolean
  /** Deferred asks of this session's reviews, awaiting a human prompt and decision */
  watched: Map<string, { promptedAt: number | undefined }>
}

/** Records review statistics in the session and adds them to the profile's global totals */
export class StatisticsRecorder {
  private readonly pi: Pick<ExtensionAPI, 'appendEntry'>
  private readonly options: RecorderOptions
  private readonly now: () => number
  private session: Session | undefined
  private store: GlobalStatisticsStore | undefined
  private unavailable: string | undefined
  /** Deltas that the global totals do not include yet */
  private queue: StatisticsSummary[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Aborted when the session starts or ends, which dismisses a statistics dialog that belongs to the old one */
  private interactions = new AbortController()

  constructor(pi: Pick<ExtensionAPI, 'appendEntry' | 'events'>, options: RecorderOptions) {
    this.pi = pi
    this.options = options
    this.now = options.now ?? Date.now
    pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, data => this.prompted(data as PermissionUiPromptEvent))
    pi.events.on(PERMISSIONS_DECISION_CHANNEL, data => this.decided(data as PermissionDecisionEvent))
  }

  /** Starts recording for a session, restoring its totals from its entries */
  start(sessionManager: Pick<SessionManager, 'getSessionId' | 'getEntries'>): void {
    this.retire()
    this.interactions = new AbortController()
    const statistics = new SessionStatistics(sessionManager.getSessionId())
    statistics.restore(sessionManager.getEntries())
    this.session = { statistics, retired: false, watched: new Map() }
  }

  /** The sink for the current session's reviews, which stays bound to that session */
  sink(): ReviewStatistics {
    const session = this.session

    return {
      review: (requestId, report) => {
        if (session === undefined) {
          return
        }
        this.record(session, { kind: 'review', session: session.statistics.session, ...report })
        if (report.outcome === 'defer' && !session.retired) {
          this.watch(session, requestId)
        }
      },
      late: usage => {
        if (session === undefined) {
          return
        }
        this.record(session, { kind: 'late-usage', session: session.statistics.session, ...usage })
      },
    }
  }

  /** A signal and check for a command that waits on the person, both of which end with the session */
  interaction(): { signal: AbortSignal; isCurrent: () => boolean } {
    const { signal } = this.interactions

    return { signal, isCurrent: () => !signal.aborted }
  }

  sessionTotals(): StatisticsSummary {
    return structuredClone(this.session?.statistics.summary ?? emptySummary())
  }

  /** The global totals, including this process's deltas that are not written yet */
  globalTotals(): GlobalTotals {
    this.flush()
    const store = this.openStore()
    if (store === undefined) {
      return { unavailable: this.unavailable ?? 'unknown' }
    }
    try {
      const snapshot = store.snapshot()
      for (const delta of this.queue) {
        addSummary(snapshot.summary, delta)
      }

      return { ...snapshot, pending: this.queue.length > 0 }
    } catch (error) {
      return { unavailable: this.fail(error) }
    }
  }

  /**
   * Stops recording in the session. Results that arrive later still reach the global totals, never another
   * session's entries
   */
  retire(): void {
    this.interactions.abort()
    if (this.session !== undefined) {
      this.session.retired = true
      this.session.watched.clear()
    }
  }

  /** Writes the remaining deltas and closes the database */
  close(): void {
    this.retire()
    this.flush()
    clearTimeout(this.timer)
    this.timer = undefined
    this.store?.close()
    this.store = undefined
  }

  private record(session: Session, record: StatisticsRecord): void {
    try {
      const delta = session.statistics.add(record, this.now())
      if (session.retired) {
        // The session can no longer take entries, so only the global totals learn of the result
        addSummary(delta, { ...emptySummary(), issues: { 'recorded-after-session': 1 } })
      } else {
        this.pi.appendEntry(STATISTICS_ENTRY_TYPE, record)
      }
      this.queue.push(delta)
      this.schedule()
    } catch {
      this.queue.push({ ...emptySummary(), issues: { 'recording-failed': 1 } })
      this.schedule()
    }
  }

  private watch(session: Session, requestId: string): void {
    if (session.watched.size >= MAX_WATCHED_ASKS) {
      const [oldest] = session.watched.keys()
      session.watched.delete(oldest!)
    }
    session.watched.set(requestId, { promptedAt: undefined })
  }

  private prompted(event: PermissionUiPromptEvent): void {
    const ask = this.session?.watched.get(event.requestId)
    if (ask !== undefined) {
      ask.promptedAt ??= this.now()
    }
  }

  private decided(event: PermissionDecisionEvent): void {
    const session = this.session
    const ask = session?.watched.get(event.requestId)
    if (session === undefined || ask === undefined) {
      return
    }
    session.watched.delete(event.requestId)
    this.record(session, {
      kind: 'human',
      session: session.statistics.session,
      prompted: ask.promptedAt !== undefined,
      resolution: event.resolution,
      waitMs: ask.promptedAt === undefined ? null : Math.max(0, this.now() - ask.promptedAt),
    })
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, FLUSH_DELAY_MS)
    this.timer.unref()
  }

  private flush(): void {
    if (this.queue.length === 0) {
      return
    }
    const store = this.openStore()
    if (store === undefined) {
      return
    }
    try {
      if (store.apply(this.queue) === 'committed') {
        this.queue = []
        return
      }
      // Another process has the write lock. Nothing was written, so the same deltas go in the next flush
      this.schedule()
    } catch (error) {
      this.fail(error)
    }
  }

  private openStore(): GlobalStatisticsStore | undefined {
    if (this.store !== undefined || this.unavailable !== undefined) {
      return this.store
    }
    try {
      const open =
        this.options.openStore ?? ((directory, periodStart) => GlobalStatisticsStore.open(directory, periodStart))
      this.store = open(this.options.directory(), this.now())
    } catch (error) {
      this.fail(error)
    }

    return this.store
  }

  /**
   * Stops global writes after a failure. A write whose commit state is unknown might have committed, and writing its
   * deltas again could count them twice
   */
  private fail(error: unknown): string {
    this.unavailable = error instanceof StatisticsStoreError ? error.reason : 'invalid'
    this.queue = []
    this.store?.close()
    this.store = undefined

    return this.unavailable
  }
}
