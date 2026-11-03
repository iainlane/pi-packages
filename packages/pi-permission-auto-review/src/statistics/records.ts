import type { StatisticsSummary, TokenCounts } from './summary.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import * as v from 'valibot'
import { EXTENSION_ID } from '../config/config.js'
import { addSummary, emptyModel, emptySummary, TOKEN_FIELDS, tokenCountsSchema } from './summary.js'

export const STATISTICS_ENTRY_TYPE: string = `${EXTENSION_ID}:statistics.v1`

type CallPhase = 'initial' | 'retry' | 'continuation'

export interface UsageReport {
  usage: TokenCounts
  /** Null when the model has no usable price */
  costUsd: number | null
  pricing: 'catalogue' | 'assumed'
}

interface CallIdentity {
  provider: string
  model: string
  phase: CallPhase
}

/** A model call of a review: reported with its usage, failed without usage, or still waiting for its result */
export type CallRecord =
  | (CallIdentity & UsageReport & { outcome: 'reported' })
  | (CallIdentity & {
      outcome: 'failed' | 'pending'
      /** Identifies a pending call to the late usage that reports it */
      id: string
    })

/** A session entry's data. Records contain counts and model names only, never evidence, actions or identifiers */
export type StatisticsRecord =
  | {
      kind: 'review'
      session: string
      outcome: 'allow' | 'deny' | 'defer'
      failure?: string | undefined
      circuitTripped?: true | undefined
      durationMs: number
      investigationCalls: number
      investigationRefusals: number
      calls: CallRecord[]
    }
  | (UsageReport & { kind: 'late-usage'; session: string; call: string; provider: string; model: string })
  | { kind: 'human'; session: string; prompted: boolean; resolution: string; waitMs: number | null }

const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const quantity = v.pipe(v.number(), v.minValue(0))
const category = v.pipe(v.string(), v.regex(/^[a-z][a-z_-]{0,79}$/))
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(200))
const session = v.pipe(v.string(), v.regex(/^[\da-f]{64}$/))
const phase = v.picklist(['initial', 'retry', 'continuation'])
const price = { costUsd: v.nullable(quantity), pricing: v.picklist(['catalogue', 'assumed']) }

const callSchema = v.variant('outcome', [
  v.strictObject({
    outcome: v.literal('reported'),
    provider: name,
    model: name,
    phase,
    usage: tokenCountsSchema,
    ...price,
  }),
  v.strictObject({
    outcome: v.picklist(['failed', 'pending']),
    id: v.pipe(v.string(), v.uuid()),
    provider: name,
    model: name,
    phase,
  }),
])

const recordSchema: v.GenericSchema<StatisticsRecord> = v.variant('kind', [
  v.strictObject({
    kind: v.literal('review'),
    session,
    outcome: v.picklist(['allow', 'deny', 'defer']),
    failure: v.optional(category),
    circuitTripped: v.optional(v.literal(true)),
    durationMs: quantity,
    investigationCalls: count,
    investigationRefusals: count,
    calls: v.array(callSchema),
  }),
  v.strictObject({
    kind: v.literal('late-usage'),
    session,
    call: v.pipe(v.string(), v.uuid()),
    provider: name,
    model: name,
    usage: tokenCountsSchema,
    ...price,
  }),
  v.strictObject({
    kind: v.literal('human'),
    session,
    prompted: v.boolean(),
    resolution: category,
    waitMs: v.nullable(quantity),
  }),
])

/** Session IDs are kept out of the records; a digest still tells a session's own records from copied ones */
export function sessionDigest(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

function callModel(
  call: { provider: string; model: string },
  report: UsageReport | undefined,
): StatisticsSummary['models'][number] {
  const model = emptyModel(call.provider, call.model)
  if (report === undefined) {
    return model
  }

  return {
    ...model,
    reportedCalls: 1,
    tokens: { ...report.usage },
    estimatedCostUsd: report.costUsd ?? 0,
    assumedPriceCalls: report.pricing === 'assumed' ? 1 : 0,
    unpricedCalls: report.costUsd === null ? 1 : 0,
  }
}

/** A delta whose usage totals are those of its models */
function withModels(delta: StatisticsSummary, models: StatisticsSummary['models']): StatisticsSummary {
  const usage = emptySummary()
  for (const model of models) {
    for (const field of TOKEN_FIELDS) {
      usage.tokens[field] += model.tokens[field]
    }
    usage.estimatedCostUsd += model.estimatedCostUsd
    usage.assumedPriceCalls += model.assumedPriceCalls
    usage.unpricedCalls += model.unpricedCalls
    usage.models = [model]
    addSummary(delta, usage)
    usage.tokens = emptySummary().tokens
    usage.estimatedCostUsd = 0
    usage.assumedPriceCalls = 0
    usage.unpricedCalls = 0
  }

  return delta
}

const HUMAN_RESULTS: Record<string, keyof Omit<StatisticsSummary['human'], 'waitMs'>> = {
  user_approved: 'approved',
  user_approved_for_session: 'approved',
  user_denied: 'rejected',
  confirmation_unavailable: 'unavailable',
  prompt_unanswered: 'unavailable',
}

/** The change that one record makes to the totals, given whether a late report's call was still pending */
function recordDelta(record: StatisticsRecord, pendingCall = true): StatisticsSummary {
  const delta = emptySummary()
  switch (record.kind) {
    case 'review': {
      delta.reviews[record.outcome] = 1
      if (record.failure !== undefined) {
        delta.failures[record.failure] = 1
      }
      delta.circuitTrips = record.circuitTripped === true ? 1 : 0
      delta.reviewMs = record.durationMs
      delta.investigationCalls = record.investigationCalls
      delta.investigationRefusals = record.investigationRefusals
      for (const call of record.calls) {
        delta.calls += 1
        delta.retries += call.phase === 'retry' ? 1 : 0
        delta.continuations += call.phase === 'continuation' ? 1 : 0
        delta.failedCalls += call.outcome === 'failed' ? 1 : 0
        delta.unreportedCalls += call.outcome === 'pending' ? 1 : 0
      }

      return withModels(
        delta,
        record.calls.map(call => ({ ...callModel(call, call.outcome === 'reported' ? call : undefined), calls: 1 })),
      )
    }
    case 'late-usage': {
      if (pendingCall) {
        delta.unreportedCalls = -1
      } else {
        delta.issues['unmatched-late-usage'] = 1
      }

      return withModels(delta, [callModel(record, record)])
    }
    case 'human': {
      delta.prompts = record.prompted ? 1 : 0
      delta.resolutions[record.resolution] = 1
      const result = HUMAN_RESULTS[record.resolution]
      if (result !== undefined) {
        delta.human[result] = 1
      }
      delta.human.waitMs = record.waitMs ?? 0

      return delta
    }
  }
}

/** One session's totals, from its own records only: a fork or clone copies records that it did not produce */
export class SessionStatistics {
  readonly summary: StatisticsSummary = emptySummary()
  private readonly digest: string
  /** Calls that a review recorded as pending, until late usage reports them */
  private readonly pending = new Set<string>()

  constructor(sessionId: string) {
    this.digest = sessionDigest(sessionId)
  }

  get session(): string {
    return this.digest
  }

  /** Restores the totals from every entry of the session file, abandoned branches included */
  restore(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== STATISTICS_ENTRY_TYPE) {
        continue
      }
      const parsed = v.safeParse(recordSchema, entry.data)
      const at = Date.parse(entry.timestamp)
      if (!parsed.success) {
        addSummary(this.summary, { ...emptySummary(), issues: { 'malformed-record': 1 } })
        continue
      }
      if (parsed.output.session === this.digest) {
        this.add(parsed.output, Number.isNaN(at) ? undefined : at)
      }
    }
  }

  /** Adds a record of this session, made at time `at`, and returns its delta */
  add(record: StatisticsRecord, at?: number): StatisticsSummary {
    let pendingCall = true
    if (record.kind === 'review') {
      for (const call of record.calls) {
        if (call.outcome === 'pending') {
          this.pending.add(call.id)
        }
      }
    }
    if (record.kind === 'late-usage') {
      pendingCall = this.pending.delete(record.call)
    }
    const delta = { ...recordDelta(record, pendingCall), since: at ?? null }
    addSummary(this.summary, delta)

    return delta
  }
}
