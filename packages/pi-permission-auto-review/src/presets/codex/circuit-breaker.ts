import type { DenialLimit, DenialLimiter } from '../presets.js'

const MAX_CONSECUTIVE_DENIALS = 3
const RECENT_WINDOW_SIZE = 50
const MAX_RECENT_DENIALS = 10
const REFUSAL =
  'Too many denials this turn; further requests are refused unreviewed until the next turn. Ask the user for explicit approval before retrying'

/** Codex's circuit: once a turn reaches either limit, the turn is interrupted and every later ask in it refused */
export class DenialCircuitBreaker implements DenialLimiter {
  readonly limitAction = 'interrupt'
  private consecutiveDenials = 0
  private recentDenials: boolean[] = []
  private tripped = false

  refusal(): string | undefined {
    return this.tripped ? REFUSAL : undefined
  }

  /** The limit that this denial reached, reported only for the denial that trips the circuit */
  recordDenial(): DenialLimit | undefined {
    this.consecutiveDenials += 1
    this.recordRecent(true)
    if (this.tripped) {
      return undefined
    }
    const limit =
      this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS
        ? 'consecutive'
        : this.recentDenials.filter(Boolean).length >= MAX_RECENT_DENIALS
          ? 'total'
          : undefined
    this.tripped = limit !== undefined

    return limit
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0
    this.recordRecent(false)
  }

  resetTurn(): void {
    this.tripped = false
    this.consecutiveDenials = 0
    this.recentDenials = []
  }

  private recordRecent(denied: boolean): void {
    this.recentDenials.push(denied)
    if (this.recentDenials.length > RECENT_WINDOW_SIZE) {
      this.recentDenials.shift()
    }
  }
}
