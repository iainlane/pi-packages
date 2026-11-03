import type { StatisticsSummary } from './summary.js'
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import * as v from 'valibot'
import { addSummary, emptySummary, statisticsSummarySchema } from './summary.js'

export const DATABASE_FILE = 'statistics.sqlite'
const APPLICATION_ID = 1_347_573_075
const SCHEMA_VERSION = 1

const metadataRow = v.strictObject({
  version: v.literal(SCHEMA_VERSION),
  period_start: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
const totalsRow = v.strictObject({ value: v.string() })
const applicationRow = v.strictObject({ application_id: v.literal(APPLICATION_ID) })

export interface GlobalSnapshot {
  /** When this profile started recording */
  periodStart: number
  summary: StatisticsSummary
}

/** `retry` means that nothing was written and the same deltas can be applied again later */
export type ApplyResult = 'committed' | 'retry'

export class StatisticsStoreError extends Error {
  readonly reason: 'unsafe' | 'invalid' | 'commit-unknown'

  constructor(reason: StatisticsStoreError['reason'], cause?: unknown) {
    super(`Global statistics are unavailable: ${reason}`, { cause })
    this.name = 'StatisticsStoreError'
    this.reason = reason
  }
}

function busy(error: unknown): boolean {
  // SQLITE_BUSY and SQLITE_LOCKED, in the primary result code
  return (
    typeof error === 'object' && error !== null && 'errcode' in error && [5, 6].includes(Number(error.errcode) & 255)
  )
}

/** Requires the path to be owned by this user and not a symbolic link, and removes access for anyone else */
function makePrivate(path: string, kind: 'directory' | 'file'): void {
  const uid = process.getuid?.()
  // The ownership and mode checks need POSIX
  if (uid === undefined) {
    throw new StatisticsStoreError('unsafe')
  }
  const stat = lstatSync(path)
  const right = kind === 'directory' ? stat.isDirectory() : stat.isFile()
  if (!right || stat.isSymbolicLink() || stat.uid !== uid) {
    throw new StatisticsStoreError('unsafe')
  }
  const mode = kind === 'directory' ? 0o700 : 0o600
  if ((stat.mode & 0o777) !== mode) {
    chmodSync(path, mode)
  }
}

/** The profile's global totals, in a SQLite database that every Pi process of the profile updates */
export class GlobalStatisticsStore {
  private readonly database: DatabaseSync

  private constructor(database: DatabaseSync) {
    this.database = database
  }

  /** Opens the database in `directory`, creating both, readable only by this user, when they are absent */
  static open(directory: string, periodStart: number): GlobalStatisticsStore {
    let database: DatabaseSync | undefined
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      makePrivate(directory, 'directory')
      const file = join(directory, DATABASE_FILE)
      try {
        closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          throw error
        }
      }
      makePrivate(file, 'file')
      database = new DatabaseSync(file, { timeout: 0, allowExtension: false })
      database.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL')
      const store = new GlobalStatisticsStore(database)
      store.initialize(periodStart)

      return store
    } catch (error) {
      database?.close()
      throw error instanceof StatisticsStoreError ? error : new StatisticsStoreError('invalid', error)
    }
  }

  /** Adds `deltas` to the totals in one transaction */
  apply(deltas: readonly StatisticsSummary[]): ApplyResult {
    try {
      this.database.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if (busy(error)) {
        return 'retry'
      }
      throw new StatisticsStoreError('invalid', error)
    }
    try {
      const totals = this.readTotals()
      for (const delta of deltas) {
        addSummary(totals, delta)
      }
      const checked = v.parse(statisticsSummarySchema, totals)
      this.database.prepare('UPDATE totals SET value=? WHERE id=1').run(JSON.stringify(checked))
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw new StatisticsStoreError('invalid', error)
    }

    return this.commit()
  }

  snapshot(): GlobalSnapshot {
    this.database.exec('BEGIN')
    try {
      const metadata = v.parse(
        metadataRow,
        this.database.prepare('SELECT version, period_start FROM metadata WHERE id=1').get(),
      )

      return { periodStart: metadata.period_start, summary: this.readTotals() }
    } catch (error) {
      throw new StatisticsStoreError('invalid', error)
    } finally {
      this.database.exec('COMMIT')
    }
  }

  close(): void {
    this.database.close()
  }

  private initialize(periodStart: number): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const tables = this.database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
      if (tables.length === 0) {
        this.database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};
          CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, period_start INTEGER NOT NULL) STRICT;
          CREATE TABLE totals(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL) STRICT;`)
        this.database.prepare('INSERT INTO metadata VALUES(1, ?, ?)').run(SCHEMA_VERSION, periodStart)
        this.database.prepare('INSERT INTO totals VALUES(1, ?)').run(JSON.stringify(emptySummary()))
      }
      // A database of another schema is left untouched, since a newer release may own it
      v.parse(applicationRow, this.database.prepare('PRAGMA application_id').get())
      v.parse(metadataRow, this.database.prepare('SELECT version, period_start FROM metadata WHERE id=1').get())
      this.readTotals()
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    this.database.exec('COMMIT')
  }

  private readTotals(): StatisticsSummary {
    const row = v.parse(totalsRow, this.database.prepare('SELECT value FROM totals WHERE id=1').get())

    return v.parse(statisticsSummarySchema, JSON.parse(row.value))
  }

  /** A rejected `COMMIT` that rolls back cleanly wrote nothing; one that cannot roll back might have written */
  private commit(): ApplyResult {
    try {
      this.database.exec('COMMIT')

      return 'committed'
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch (rollback) {
        throw new StatisticsStoreError(
          'commit-unknown',
          new AggregateError([error, rollback], 'COMMIT and ROLLBACK both failed'),
        )
      }

      return 'retry'
    }
  }
}
