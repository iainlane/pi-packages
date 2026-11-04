import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { MANUAL_REJECTION_ENTRY_TYPE, RejectionLedger } from '../../src/manual/rejections.js'

const REJECTED = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function session(initial: SessionEntry[] = []) {
  const entries = [...initial]
  const pi = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: 'custom', id: `entry-${entries.length}`, parentId: null, timestamp: '', customType, data })
    }),
  }

  return { entries, pi, session: { getSessionId: () => 'session-1', getEntries: () => entries } }
}

function user(id: string): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '', message: { role: 'user', content: 'go', timestamp: 0 } }
}

describe('rejection ledger', () => {
  it('blocks a rejected action until the person gives new direction, and only that action', () => {
    const { entries, pi, session: manager } = session()
    const ledger = new RejectionLedger({ pi, session: manager, onIssue: vi.fn() })
    ledger.reject(REJECTED, 'human-rejected')
    const before = [ledger.blocks(REJECTED, new Set(), false), ledger.blocks(OTHER, new Set(), false)]
    entries.push(user('direction'))

    expect({ before, after: ledger.blocks(REJECTED, new Set(['direction']), false) }).toStrictEqual({
      before: [true, false],
      after: false,
    })
  })

  it('restores rejections from the session and ignores direction given before them', () => {
    const { pi, session: manager } = session([
      user('earlier'),
      {
        type: 'custom',
        id: 'rejection',
        parentId: null,
        timestamp: '',
        customType: MANUAL_REJECTION_ENTRY_TYPE,
        data: { id: '00000000-0000-4000-8000-000000000001', fingerprint: REJECTED, reason: 'human-rejected' },
      },
    ])
    const ledger = new RejectionLedger({ pi, session: manager, onIssue: vi.fn() })

    expect(ledger.blocks(REJECTED, new Set(['earlier']), false)).toBe(true)
  })

  it('applies an unreadable record to appeals and rejected actions only, never to unrelated commands', () => {
    const issues: string[] = []
    const { pi, session: manager } = session([
      {
        type: 'custom',
        id: 'broken',
        parentId: null,
        timestamp: '',
        customType: MANUAL_REJECTION_ENTRY_TYPE,
        data: { fingerprint: 'nonsense' },
      },
    ])
    const ledger = new RejectionLedger({ pi, session: manager, onIssue: issue => issues.push(issue) })

    expect({
      unrelated: ledger.blocks(OTHER, new Set(), false),
      appeal: ledger.blocks(OTHER, new Set(), true),
      empty: ledger.empty,
      issues,
    }).toStrictEqual({
      unrelated: false,
      appeal: true,
      empty: false,
      issues: ['manual-rejection-invalid-record'],
    })
  })
})
