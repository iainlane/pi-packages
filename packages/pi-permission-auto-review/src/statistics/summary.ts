import * as v from 'valibot'

export const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const

export const MANUAL_STAGES = [
  'requested',
  'prompted',
  'approved',
  'rejected',
  'cancelled',
  'unavailable',
  'dispatched',
  'executed',
  'completed',
  'failed',
  'blocked',
] as const

/** A step of a manual approval request; approval and running the action are counted separately */
export type ManualStage = (typeof MANUAL_STAGES)[number]

export type TokenCounts = Record<(typeof TOKEN_FIELDS)[number], number>

export interface ModelStatistics {
  provider: string
  model: string
  calls: number
  reportedCalls: number
  tokens: TokenCounts
  estimatedCostUsd: number
  /** Calls priced from another model's catalogue entry, as the derived `codex-auto-review` descriptor is */
  assumedPriceCalls: number
  unpricedCalls: number
}

/**
 * Totals for a session or for every session of the Pi profile. A delta has the same shape, and only
 * `unreportedCalls` can be negative in one: late usage reports a call that a review recorded as unreported
 */
export interface StatisticsSummary {
  /** When the first of these statistics was recorded */
  since: number | null
  reviews: Record<'allow' | 'deny' | 'defer', number>
  failures: Record<string, number>
  circuitTrips: number
  reviewMs: number
  investigationCalls: number
  /** Investigation commands that failed because the sandbox refused them */
  investigationRefusals: number
  calls: number
  retries: number
  continuations: number
  failedCalls: number
  unreportedCalls: number
  tokens: TokenCounts
  estimatedCostUsd: number
  assumedPriceCalls: number
  unpricedCalls: number
  prompts: number
  human: { approved: number; rejected: number; unavailable: number; waitMs: number }
  /** How pi-permission-system resolved the asks that a review deferred, by its resolution name */
  resolutions: Record<string, number>
  /** Manual approval requests by stage, their waiting and running time, and why they failed */
  manual: Record<ManualStage, number> & { waitMs: number; executionMs: number; failures: Record<string, number> }
  models: ModelStatistics[]
  /** Problems that make the totals incomplete, with how often each occurred */
  issues: Record<string, number>
}

const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const quantity = v.pipe(v.number(), v.minValue(0))
const category = v.pipe(v.string(), v.regex(/^[a-z][a-z_-]{0,79}$/))
const categories = v.record(category, count)

export const tokenCountsSchema: v.GenericSchema<TokenCounts> = v.pipe(
  v.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count, cacheWrite1h: count }),
  v.check(tokens => tokens.cacheWrite1h <= tokens.cacheWrite),
)

const modelSchema = v.strictObject({
  provider: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  calls: count,
  reportedCalls: count,
  tokens: tokenCountsSchema,
  estimatedCostUsd: quantity,
  assumedPriceCalls: count,
  unpricedCalls: count,
})

export const statisticsSummarySchema: v.GenericSchema<StatisticsSummary> = v.strictObject({
  since: v.nullable(count),
  reviews: v.strictObject({ allow: count, deny: count, defer: count }),
  failures: categories,
  circuitTrips: count,
  reviewMs: quantity,
  investigationCalls: count,
  investigationRefusals: count,
  calls: count,
  retries: count,
  continuations: count,
  failedCalls: count,
  unreportedCalls: count,
  tokens: tokenCountsSchema,
  estimatedCostUsd: quantity,
  assumedPriceCalls: count,
  unpricedCalls: count,
  prompts: count,
  human: v.strictObject({ approved: count, rejected: count, unavailable: count, waitMs: quantity }),
  resolutions: categories,
  manual: v.strictObject({
    requested: count,
    prompted: count,
    approved: count,
    rejected: count,
    cancelled: count,
    unavailable: count,
    dispatched: count,
    executed: count,
    completed: count,
    failed: count,
    blocked: count,
    waitMs: quantity,
    executionMs: quantity,
    failures: categories,
  }),
  models: v.array(modelSchema),
  issues: categories,
})

const SCALARS = [
  'circuitTrips',
  'reviewMs',
  'investigationCalls',
  'investigationRefusals',
  'calls',
  'retries',
  'continuations',
  'failedCalls',
  'unreportedCalls',
  'estimatedCostUsd',
  'assumedPriceCalls',
  'unpricedCalls',
  'prompts',
] as const
const MODEL_SCALARS = ['calls', 'reportedCalls', 'estimatedCostUsd', 'assumedPriceCalls', 'unpricedCalls'] as const

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }
}

export function emptySummary(): StatisticsSummary {
  return {
    since: null,
    reviews: { allow: 0, deny: 0, defer: 0 },
    failures: {},
    circuitTrips: 0,
    reviewMs: 0,
    investigationCalls: 0,
    investigationRefusals: 0,
    calls: 0,
    retries: 0,
    continuations: 0,
    failedCalls: 0,
    unreportedCalls: 0,
    tokens: emptyTokens(),
    estimatedCostUsd: 0,
    assumedPriceCalls: 0,
    unpricedCalls: 0,
    prompts: 0,
    human: { approved: 0, rejected: 0, unavailable: 0, waitMs: 0 },
    resolutions: {},
    manual: {
      requested: 0,
      prompted: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      unavailable: 0,
      dispatched: 0,
      executed: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      waitMs: 0,
      executionMs: 0,
      failures: {},
    },
    models: [],
    issues: {},
  }
}

export function emptyModel(provider: string, model: string): ModelStatistics {
  return {
    provider,
    model,
    calls: 0,
    reportedCalls: 0,
    tokens: emptyTokens(),
    estimatedCostUsd: 0,
    assumedPriceCalls: 0,
    unpricedCalls: 0,
  }
}

function addTokens(total: TokenCounts, delta: TokenCounts): void {
  for (const field of TOKEN_FIELDS) {
    total[field] += delta[field]
  }
}

function addCategories(total: Record<string, number>, delta: Record<string, number>): void {
  for (const [key, value] of Object.entries(delta)) {
    total[key] = (total[key] ?? 0) + value
  }
}

/** Adds `delta` to `total` in place */
export function addSummary(total: StatisticsSummary, delta: StatisticsSummary): void {
  if (delta.since !== null) {
    total.since = total.since === null ? delta.since : Math.min(total.since, delta.since)
  }
  for (const field of SCALARS) {
    total[field] += delta[field]
  }
  for (const outcome of ['allow', 'deny', 'defer'] as const) {
    total.reviews[outcome] += delta.reviews[outcome]
  }
  for (const field of ['approved', 'rejected', 'unavailable', 'waitMs'] as const) {
    total.human[field] += delta.human[field]
  }
  for (const field of [...MANUAL_STAGES, 'waitMs', 'executionMs'] as const) {
    total.manual[field] += delta.manual[field]
  }
  addCategories(total.manual.failures, delta.manual.failures)
  addTokens(total.tokens, delta.tokens)
  addCategories(total.failures, delta.failures)
  addCategories(total.resolutions, delta.resolutions)
  addCategories(total.issues, delta.issues)
  for (const model of delta.models) {
    let existing = total.models.find(entry => entry.provider === model.provider && entry.model === model.model)
    if (existing === undefined) {
      existing = emptyModel(model.provider, model.model)
      total.models.push(existing)
      total.models.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
    }
    for (const field of MODEL_SCALARS) {
      existing[field] += model[field]
    }
    addTokens(existing.tokens, model.tokens)
  }
}

/** Issues that leave the cost complete: a result after its session ended is still in the global totals */
export const ORDINARY_ISSUES: ReadonlySet<string> = new Set(['recorded-after-session'])

/** Whether the estimated cost covers every call: reported usage with a usable price, and no missing records */
export function costComplete(summary: StatisticsSummary): boolean {
  return (
    summary.unreportedCalls === 0 &&
    summary.unpricedCalls === 0 &&
    Object.keys(summary.issues).every(issue => ORDINARY_ISSUES.has(issue))
  )
}
