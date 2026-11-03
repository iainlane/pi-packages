import { CODEX_AUTO_REVIEW_MODEL, CODEX_PROVIDER } from '../src/config/config.js'

export interface EvaluationOptions {
  provider: string
  model: string
  maxRequests: number
  timeoutMs: number
}

function integer(value: string | undefined, fallback: number, maximum: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid live-evaluation ${label}: expected an integer from 1 to ${maximum}`)
  }

  return parsed
}

/** Billable requests need an explicit opt-in, checked before any credential or model is touched */
export function evaluationOptions(environment: Readonly<Record<string, string | undefined>>): EvaluationOptions {
  if (environment['PI_AUTO_REVIEW_LIVE'] !== '1') {
    throw new Error('Live inference is disabled. Set PI_AUTO_REVIEW_LIVE=1 to opt in to billable model requests')
  }
  const provider = environment['PI_AUTO_REVIEW_LIVE_PROVIDER']?.trim() ?? CODEX_PROVIDER
  const model = environment['PI_AUTO_REVIEW_LIVE_MODEL']?.trim() ?? CODEX_AUTO_REVIEW_MODEL
  if (provider.length === 0 || model.length === 0) {
    throw new Error('Live evaluation requires a non-empty provider and model')
  }

  return {
    provider,
    model,
    maxRequests: integer(environment['PI_AUTO_REVIEW_LIVE_MAX_REQUESTS'], 12, 30, 'request limit'),
    timeoutMs: integer(environment['PI_AUTO_REVIEW_LIVE_TIMEOUT_MS'], 90_000, 300_000, 'timeout'),
  }
}

/** Counts every streaming request, retries included, across the whole run */
export class InferenceBudget {
  private count = 0
  private readonly maximum: number

  constructor(maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 30) {
      throw new Error('Invalid inference request budget')
    }
    this.maximum = maximum
  }

  get used(): number {
    return this.count
  }

  take(): void {
    if (this.count >= this.maximum) {
      throw new Error('Inference request budget exhausted')
    }
    this.count += 1
  }
}
