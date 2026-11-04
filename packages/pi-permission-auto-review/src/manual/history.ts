import type { ReviewAction } from '../action/schema.js'
import type { ReviewSnapshot } from '../reviewer/snapshot.js'
import { randomUUID } from 'node:crypto'

const MAX_DENIALS = 20
const DENIAL_TTL_MS = 15 * 60_000

type ShellAction = Extract<ReviewAction, { kind: 'shell' }>
/** A refused shell call whose capture identifies its tool registration, which manual approval binds to */
export type AppealableAction = ShellAction & { registration: NonNullable<ShellAction['registration']> }

export interface DeniedAction {
  readonly id: string
  readonly action: AppealableAction
  /** The session state that the refusing review read */
  readonly snapshot: ReviewSnapshot
  readonly refusal: string
}

interface StoredDenial extends DeniedAction {
  expiresAt: number
  /** The `request_manual_approval` call that claimed the reference */
  claimedBy: string | undefined
}

export class DenialReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DenialReferenceError'
  }
}

/** Recent automatic refusals, each of which one manual approval request can claim once */
export class DenialHistory {
  private readonly denials = new Map<string, StoredDenial>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Returns the reference for a refusal, or undefined when every slot is claimed */
  remember(denial: Omit<DeniedAction, 'id'>): string | undefined {
    for (const [id, stored] of this.denials) {
      if (stored.claimedBy === undefined && stored.expiresAt <= this.now()) {
        this.denials.delete(id)
      }
    }
    if (this.denials.size >= MAX_DENIALS) {
      const oldest = [...this.denials.values()].find(stored => stored.claimedBy === undefined)
      if (oldest === undefined) {
        return undefined
      }
      this.denials.delete(oldest.id)
    }
    const id = randomUUID()
    this.denials.set(id, { ...denial, id, expiresAt: this.now() + DENIAL_TTL_MS, claimedBy: undefined })

    return id
  }

  /** The denial that `id` refers to, if it can still be claimed */
  peek(id: string): DeniedAction | undefined {
    const stored = this.denials.get(id)

    return stored?.claimedBy === undefined && stored !== undefined && stored.expiresAt > this.now() ? stored : undefined
  }

  claim(id: string, wrapperToolCallId: string): DeniedAction {
    const stored = this.denials.get(id)
    if (stored === undefined || stored.expiresAt <= this.now()) {
      throw new DenialReferenceError('Unknown or expired denial reference')
    }
    if (stored.claimedBy !== undefined) {
      throw new DenialReferenceError('The denial reference has already been used')
    }
    stored.claimedBy = wrapperToolCallId

    return stored
  }

  /** Forgets a claimed reference; a reference is used at most once */
  release(wrapperToolCallId: string): void {
    for (const [id, stored] of this.denials) {
      if (stored.claimedBy === wrapperToolCallId) {
        this.denials.delete(id)
      }
    }
  }

  clear(): void {
    this.denials.clear()
  }
}
