import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_FILE, GlobalStatisticsStore } from '../../src/statistics/store.js'
import { emptySummary } from '../../src/statistics/summary.js'

const allowed = { ...emptySummary(), reviews: { allow: 1, deny: 0, defer: 0 }, calls: 1 }

describe('global statistics store', () => {
  let root: string
  let directory: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'auto-review-statistics-'))
    directory = join(root, 'statistics')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a private WAL database and keeps totals and the period start across processes', () => {
    const first = GlobalStatisticsStore.open(directory, 1_000)
    const applied = [first.apply([allowed]), first.apply([allowed, allowed])]
    first.close()
    const second = GlobalStatisticsStore.open(directory, 2_000)
    const snapshot = second.snapshot()
    second.close()
    const raw = new DatabaseSync(join(directory, DATABASE_FILE))
    const journal = { ...raw.prepare('PRAGMA journal_mode').get() }
    raw.close()

    expect({
      applied,
      periodStart: snapshot.periodStart,
      reviews: snapshot.summary.reviews,
      modes: [lstatSync(directory).mode & 0o777, lstatSync(join(directory, DATABASE_FILE)).mode & 0o777],
      journal,
    }).toStrictEqual({
      applied: ['committed', 'committed'],
      periodStart: 1_000,
      reviews: { allow: 3, deny: 0, defer: 0 },
      modes: [0o700, 0o600],
      journal: { journal_mode: 'wal' },
    })
  })

  it('asks for a retry without waiting while another process writes, and applies the deltas afterwards', () => {
    const store = GlobalStatisticsStore.open(directory, 1_000)
    const other = new DatabaseSync(join(directory, DATABASE_FILE))
    other.exec('BEGIN IMMEDIATE')
    const whileBusy = store.apply([allowed])
    other.exec('ROLLBACK')
    other.close()
    const afterwards = store.apply([allowed])
    const reviews = store.snapshot().summary.reviews
    store.close()

    expect({ whileBusy, afterwards, reviews }).toStrictEqual({
      whileBusy: 'retry',
      afterwards: 'committed',
      reviews: { allow: 1, deny: 0, defer: 0 },
    })
  })

  it('tightens a directory that others can read', () => {
    mkdirSync(directory, { mode: 0o755 })
    chmodSync(directory, 0o755)
    GlobalStatisticsStore.open(directory, 1_000).close()

    expect(lstatSync(directory).mode & 0o777).toBe(0o700)
  })

  it('refuses a directory that is a symbolic link', () => {
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), directory)

    expect(() => GlobalStatisticsStore.open(directory, 1_000)).toThrow(expect.objectContaining({ reason: 'unsafe' }))
  })

  it('leaves a database that another application created untouched', () => {
    mkdirSync(directory, { mode: 0o700 })
    const foreign = new DatabaseSync(join(directory, DATABASE_FILE))
    foreign.exec('PRAGMA application_id=7; CREATE TABLE notes(text TEXT)')
    foreign.close()
    chmodSync(join(directory, DATABASE_FILE), 0o600)

    expect(() => GlobalStatisticsStore.open(directory, 1_000)).toThrow(expect.objectContaining({ reason: 'invalid' }))
    const after = new DatabaseSync(join(directory, DATABASE_FILE))
    const tables = after
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map(row => ({ ...row }))
    after.close()
    expect(tables).toStrictEqual([{ name: 'notes' }])
  })
})
