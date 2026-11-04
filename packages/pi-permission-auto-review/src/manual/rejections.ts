import type { ExtensionAPI, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { EXTENSION_ID } from '../config/config.js'

export const MANUAL_REJECTION_ENTRY_TYPE: string = `${EXTENSION_ID}:manual-rejection.v1`

const MAX_FACTS = 128

/** The entry after which new direction from the person counts, or unknown when that cannot be established */
type Barrier = { kind: 'unknown' } | { kind: 'recorded'; entryId: string | null }

type RejectionReason = 'human-rejected' | 'manual-wrapper-blocked'

const rejectionSchema: v.GenericSchema<{ id: string; fingerprint: string; reason: RejectionReason }> = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  fingerprint: v.pipe(v.string(), v.regex(/^[\da-f]{64}$/)),
  reason: v.picklist(['human-rejected', 'manual-wrapper-blocked']),
})

interface LedgerOptions {
  pi: Pick<ExtensionAPI, 'appendEntry'>
  session: Pick<SessionManager, 'getSessionId' | 'getEntries'>
  onIssue: (issue: string) => void
}

/**
 * Actions that the person rejected, which stay refused until the person gives new direction. Rejections are
 * restored from the session's entries, and only ever restrict
 */
export class RejectionLedger {
  private readonly options: LedgerOptions
  private readonly facts = new Map<string, Barrier>()
  /** Covers every rejected action and every appeal when individual facts could not be read or kept */
  private barrier: Barrier | undefined
  private active = true

  constructor(options: LedgerOptions) {
    this.options = options
    try {
      for (const entry of options.session.getEntries()) {
        if (entry.type !== 'custom' || entry.customType !== MANUAL_REJECTION_ENTRY_TYPE) {
          continue
        }
        const parsed = v.safeParse(rejectionSchema, entry.data)
        if (parsed.success) {
          this.add(parsed.output.fingerprint, { kind: 'recorded', entryId: entry.id })
        } else {
          this.barrier = { kind: 'recorded', entryId: entry.id }
          options.onIssue('manual-rejection-invalid-record')
        }
      }
    } catch {
      this.barrier = { kind: 'unknown' }
      options.onIssue('manual-rejection-read-failed')
    }
  }

  get empty(): boolean {
    return this.facts.size === 0 && this.barrier === undefined
  }

  reject(fingerprint: string, reason: RejectionReason): void {
    // Restricts at once, before the write that might fail
    this.add(fingerprint, { kind: 'unknown' })
    if (!this.active) {
      this.options.onIssue('manual-rejection-after-session')
      return
    }
    const data = { id: randomUUID(), fingerprint, reason }
    try {
      this.options.pi.appendEntry(MANUAL_REJECTION_ENTRY_TYPE, data)
      const marker = this.options.session
        .getEntries()
        .findLast(
          entry =>
            entry.type === 'custom' &&
            entry.customType === MANUAL_REJECTION_ENTRY_TYPE &&
            v.is(rejectionSchema, entry.data) &&
            entry.data.id === data.id,
        )
      if (marker === undefined) {
        this.options.onIssue('manual-rejection-write-failed')
        return
      }
      this.add(fingerprint, { kind: 'recorded', entryId: marker.id })
    } catch {
      this.options.onIssue('manual-rejection-write-failed')
    }
  }

  /**
   * Whether the action stays refused: it was rejected, or it is being appealed while rejections could not all be read,
   * and no direction from the person has arrived since
   */
  blocks(fingerprint: string, direction: ReadonlySet<string>, appeal: boolean): boolean {
    const fact = this.facts.get(fingerprint)
    const barriers = [fact, fact !== undefined || appeal ? this.barrier : undefined].filter(
      (barrier): barrier is Barrier => barrier !== undefined,
    )
    if (barriers.length === 0) {
      return false
    }
    try {
      const entries = this.options.session.getEntries()

      return barriers.some(barrier => !this.directedSince(barrier, entries, direction))
    } catch {
      this.options.onIssue('manual-rejection-read-failed')

      return true
    }
  }

  stop(): void {
    this.active = false
  }

  private add(fingerprint: string, barrier: Barrier): void {
    if (this.facts.size >= MAX_FACTS && !this.facts.has(fingerprint)) {
      this.barrier = barrier
      return
    }
    this.facts.set(fingerprint, barrier)
  }

  private directedSince(barrier: Barrier, entries: readonly SessionEntry[], direction: ReadonlySet<string>): boolean {
    if (barrier.kind === 'unknown') {
      return false
    }
    const index = barrier.entryId === null ? -1 : entries.findIndex(entry => entry.id === barrier.entryId)
    if (barrier.entryId !== null && index < 0) {
      return false
    }

    return entries.slice(index + 1).some(entry => direction.has(entry.id))
  }
}
