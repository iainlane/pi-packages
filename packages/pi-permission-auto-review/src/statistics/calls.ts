import type { CallRecord, UsageReport } from './records.js'
import type { TokenCounts } from './summary.js'
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import { calculateCost } from '@earendil-works/pi-ai'
import { TOKEN_FIELDS } from './summary.js'

/** Usage for a call that was still pending when its review finished */
export interface LateUsage extends UsageReport {
  call: string
  provider: string
  model: string
}

type CallState = { kind: 'pending' } | { kind: 'failed' } | { kind: 'reported'; report: UsageReport }

interface TrackedCall {
  id: string
  provider: string
  model: string
  phase: CallRecord['phase']
  state: CallState
}

export interface CallHandle {
  settle: (reply: AssistantMessage) => void
  fail: () => void
}

function tokens(reply: AssistantMessage): TokenCounts {
  const { usage } = reply

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheWrite1h: usage.cacheWrite1h ?? 0,
  }
}

/** The model calls of one review, including results that arrive after the review has finished */
export class CallLog {
  private readonly calls: TrackedCall[] = []
  private readonly onLate: (usage: LateUsage) => void
  /** Whether the model descriptor borrows another model's prices, as the derived `codex-auto-review` does */
  private readonly assumedPrices: boolean
  private finished = false

  constructor(onLate: (usage: LateUsage) => void, assumedPrices: boolean) {
    this.onLate = onLate
    this.assumedPrices = assumedPrices
  }

  /** Records a call to `model`; the handle records its result whenever that arrives */
  start(model: Model<Api>, retry: boolean): CallHandle {
    const call: TrackedCall = {
      id: randomUUID(),
      provider: model.provider,
      model: model.id,
      phase: this.calls.length === 0 ? 'initial' : retry ? 'retry' : 'continuation',
      state: { kind: 'pending' },
    }
    this.calls.push(call)
    const complete = (state: Exclude<CallState, { kind: 'pending' }>): void => {
      if (call.state.kind !== 'pending') {
        return
      }
      call.state = state
      if (this.finished) {
        const report = state.kind === 'reported' ? state.report : this.price(model, undefined)
        this.onLate({ call: call.id, provider: call.provider, model: call.model, ...report })
      }
    }

    return {
      // Runs in a promise callback, where a throw would go unhandled
      settle: reply => {
        let state: Exclude<CallState, { kind: 'pending' }>
        try {
          const usage = tokens(reply)
          const empty = TOKEN_FIELDS.every(field => usage[field] === 0)
          // An error or abort without usage cost nothing that the provider reported
          const failed = empty && (reply.stopReason === 'error' || reply.stopReason === 'aborted')
          state = failed ? { kind: 'failed' } : { kind: 'reported', report: this.price(model, reply) }
        } catch {
          state = { kind: 'failed' }
        }
        complete(state)
      },
      fail: () => complete({ kind: 'failed' }),
    }
  }

  /** The calls as the review's record lists them. A call that settles afterwards is reported as late usage */
  finish(): CallRecord[] {
    this.finished = true

    return this.calls.map(({ id, provider, model, phase, state }): CallRecord =>
      state.kind === 'reported'
        ? { outcome: 'reported', provider, model, phase, ...state.report }
        : { outcome: state.kind, id, provider, model, phase },
    )
  }

  private price(model: Model<Api>, reply: AssistantMessage | undefined): UsageReport {
    const pricing = this.assumedPrices ? 'assumed' : 'catalogue'
    if (reply === undefined) {
      return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, costUsd: 0, pricing }
    }
    const usage = tokens(reply)
    // A descriptor from a custom provider may have no prices at all
    const cost: Partial<Model<Api>['cost']> = model.cost ?? {}
    const priced = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(price => (price ?? 0) > 0)

    // calculateCost fills in the cost object that it is given
    const cost_ = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

    return { usage, costUsd: priced ? calculateCost(model, { ...reply.usage, cost: cost_ }).total : null, pricing }
  }
}
