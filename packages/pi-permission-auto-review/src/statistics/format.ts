import type { AutoReviewConfig } from '../config/config.js'
import type { InvestigationAvailability } from '../investigation/investigation.js'
import type { GlobalTotals } from './recorder.js'
import type { StatisticsSummary } from './summary.js'
import type { StatusRow } from './table.js'
import { PRESETS } from '../presets/presets.js'
import { costComplete, ORDINARY_ISSUES } from './summary.js'
import { statusComparison, statusTable } from './table.js'

const DETAIL_LIMIT = 20

/** What the report says about the reviewer beside its statistics */
export interface AutoStatusState {
  registered: boolean
  config: AutoReviewConfig | undefined
  /** Undefined until the sandbox provider has answered */
  investigation: InvestigationAvailability | undefined
  /** Whether the denial limit refuses every ask without review until the next run */
  circuitOpen: boolean
}

export interface StatusData {
  session: StatisticsSummary
  global: GlobalTotals
}

type StatisticsScope = 'session' | 'global'

export const STATISTICS_SECTIONS = {
  activity: 'Activity',
  usage: 'Tokens and cost',
  human: 'Human approvals',
  models: 'Models',
  coverage: 'Recording problems',
} as const

export type StatisticsSection = keyof typeof STATISTICS_SECTIONS

export function isStatisticsSection(value: string): value is StatisticsSection {
  return Object.hasOwn(STATISTICS_SECTIONS, value)
}

export interface StatisticsSectionView {
  scope: StatisticsScope
  section: StatisticsSection
}

export interface StatusFormatOptions {
  columns?: number
  view?: StatisticsSectionView | 'text'
}

/** A summary as the report shows it: each breakdown limited, with how much was left out */
interface SummaryView extends StatisticsSummary {
  issueList: string[]
  omitted: Record<'models' | 'failures' | 'resolutions' | 'manualFailures' | 'issues', number>
}

const SCOPE_TITLES = { session: 'This session', global: 'Global' } satisfies Record<StatisticsScope, string>
const count = new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 21 })
const date = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
})
const STORAGE_PROBLEMS: Readonly<Record<string, string>> = {
  unsafe: 'the statistics directory or database is not private to you, or this platform cannot check that.',
  invalid: 'the statistics database could not be read or written.',
  'commit-unknown': 'a write failed in a way that might have saved it, so writing stopped to avoid counting it twice.',
}
const RECORDING_PROBLEMS: Readonly<Record<string, string>> = {
  'malformed-record': 'Some statistics records in the session could not be read.',
  'unmatched-late-usage': 'Usage arrived for a model call that no review recorded.',
  'recording-failed': 'Some statistics could not be recorded.',
  'recorded-after-session': 'Some results arrived after their session ended and are counted only globally.',
}
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

/** A model or provider name as text that cannot move the cursor or hide characters on a terminal */
function identifier(value: string): string {
  if (!CONTROL_CHARACTER.test(value)) {
    return value
  }

  return JSON.stringify(value).replace(CONTROL_CHARACTERS, character =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`,
    ).join(''),
  )
}

function money(value: number): string {
  const fixed = value.toFixed(6)

  return `USD ${value > 0 && Number(fixed) === 0 ? value.toExponential(2) : fixed}`
}

function limited(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).slice(0, DETAIL_LIMIT))
}

/** Limits each breakdown to 20 entries, listing the issues that make the cost incomplete first */
function view(summary: StatisticsSummary): SummaryView {
  const issues = Object.keys(summary.issues).toSorted(
    (left, right) => Number(ORDINARY_ISSUES.has(left)) - Number(ORDINARY_ISSUES.has(right)),
  )

  return {
    ...summary,
    failures: limited(summary.failures),
    resolutions: limited(summary.resolutions),
    manual: { ...summary.manual, failures: limited(summary.manual.failures) },
    models: summary.models.slice(0, DETAIL_LIMIT),
    issueList: issues.slice(0, DETAIL_LIMIT),
    omitted: {
      models: Math.max(0, summary.models.length - DETAIL_LIMIT),
      failures: Math.max(0, Object.keys(summary.failures).length - DETAIL_LIMIT),
      resolutions: Math.max(0, Object.keys(summary.resolutions).length - DETAIL_LIMIT),
      manualFailures: Math.max(0, Object.keys(summary.manual.failures).length - DETAIL_LIMIT),
      issues: Math.max(0, issues.length - DETAIL_LIMIT),
    },
  }
}

function estimate(summary: SummaryView): string {
  return costComplete(summary) ? money(summary.estimatedCostUsd) : 'Incomplete'
}

function scopeSummary(data: StatusData, scope: StatisticsScope): SummaryView | undefined {
  if (scope === 'session') {
    return view(data.session)
  }

  return 'unavailable' in data.global ? undefined : view(data.global.summary)
}

function issueText(issue: string): string {
  return RECORDING_PROBLEMS[issue] ?? `A recording problem was reported: ${identifier(issue)}.`
}

function calls(value: number): string {
  return `${count.format(value)} model ${value === 1 ? 'call' : 'calls'}`
}

function scopeProblems(summary: SummaryView, scope: StatisticsScope): string[] {
  const prefix = `${SCOPE_TITLES[scope]}: `
  const problems: string[] = []
  if (summary.unreportedCalls > 0) {
    problems.push(
      `${prefix}token usage was not reported for ${calls(summary.unreportedCalls)}. Known estimate: ${money(summary.estimatedCostUsd)}.`,
    )
  }
  if (summary.unpricedCalls > 0) {
    problems.push(
      `${prefix}prices were unavailable for ${calls(summary.unpricedCalls)}. Known estimate: ${money(summary.estimatedCostUsd)}.`,
    )
  }
  for (const issue of summary.issueList) {
    if (!ORDINARY_ISSUES.has(issue)) {
      problems.push(`${prefix}${issueText(issue)}`)
    }
  }
  if (summary.omitted.issues > 0) {
    problems.push(`${prefix}${count.format(summary.omitted.issues)} additional recording problems omitted.`)
  }

  return problems
}

function storageProblem(global: Extract<GlobalTotals, { unavailable: string }>): string {
  return `Global: ${STORAGE_PROBLEMS[global.unavailable] ?? 'the statistics database is unavailable.'}`
}

function notices(state: AutoStatusState, data: StatusData): string[] {
  const problems: string[] = []
  if (state.config === undefined) {
    problems.push('Reviewer configuration is unavailable.')
  }
  if (!state.registered) {
    problems.push('The reviewer is not registered with the permission service.')
  }
  if (state.circuitOpen) {
    problems.push('Automatic reviews are being refused because the denial limit was reached.')
  }
  problems.push(...scopeProblems(view(data.session), 'session'))
  problems.push(
    ...('unavailable' in data.global
      ? [storageProblem(data.global)]
      : scopeProblems(view(data.global.summary), 'global')),
  )

  return problems
}

/** Whether the report contains a problem, which shows it as a warning */
export function hasStatusProblems(state: AutoStatusState, data: StatusData): boolean {
  return notices(state, data).length > 0
}

function investigationLine(state: AutoStatusState): string[] {
  if (state.config === undefined || !PRESETS[state.config.preset].investigates) {
    return []
  }
  const { investigation } = state
  if (investigation === undefined) {
    return ['Investigation: checking the sandbox']
  }

  return [investigation.available ? 'Investigation: available' : `Investigation: unavailable, ${investigation.reason}`]
}

function overview(state: AutoStatusState, data: StatusData, columns: number): string[] {
  const values = (scope: StatisticsScope): string[] => {
    const summary = scopeSummary(data, scope)
    if (summary === undefined) {
      return ['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']
    }

    return [
      count.format(summary.reviews.allow),
      count.format(summary.reviews.deny),
      count.format(summary.reviews.defer),
      estimate(summary),
    ]
  }
  const labels = ['Allowed', 'Refused', 'No automatic decision', 'Estimated cost']
  const session = values('session')
  const global = values('global')
  const comparison = statusComparison(
    ['', 'This session', 'Global'],
    labels.map((label, index) => [label, session[index] ?? 'Unavailable', global[index] ?? 'Unavailable']),
  )
  // Too wide for the terminal, so each scope gets its own table
  const table =
    Math.max(...comparison.map(line => line.length)) <= columns
      ? comparison
      : [
          'This session',
          ...statusTable(
            labels.map((label, index) => [label, session[index] ?? 'Unavailable']),
            columns,
          ),
          '',
          'Global',
          ...statusTable(
            labels.map((label, index) => [label, global[index] ?? 'Unavailable']),
            columns,
          ),
        ]
  const problems = notices(state, data)

  return [
    'Auto-review',
    `Model: ${state.config === undefined ? 'Unavailable' : identifier(`${state.config.provider}/${state.config.model}`)}`,
    ...investigationLine(state),
    '',
    ...table,
    ...('unavailable' in data.global ? [] : ['', `Global totals started ${date.format(data.global.periodStart)}`]),
    ...(problems.length > 0 ? ['', ...problems] : []),
    '',
    'Details: /auto-stats details',
  ]
}

function categoryRows(values: Record<string, number>): StatusRow[] {
  return Object.entries(values).map(([key, value]) => [identifier(key), count.format(value)])
}

function omitted(label: string, value: number): string[] {
  return value > 0 ? [`Additional ${label} omitted: ${count.format(value)}`] : []
}

function activity(summary: SummaryView, columns: number): string[] {
  const reviews = summary.reviews.allow + summary.reviews.deny + summary.reviews.defer

  return [
    ...statusTable(
      [
        ['Automatic reviews', count.format(reviews)],
        ['Allowed', count.format(summary.reviews.allow)],
        ['Refused', count.format(summary.reviews.deny)],
        ['No automatic decision', count.format(summary.reviews.defer)],
        ['Inspection requests', count.format(summary.investigationCalls)],
        ['Inspection refusals', count.format(summary.investigationRefusals)],
        ['Total review time', `${count.format(summary.reviewMs)} ms`],
        ['Average review time', reviews === 0 ? 'Not applicable' : `${count.format(summary.reviewMs / reviews)} ms`],
        ['Denial-limit trips', count.format(summary.circuitTrips)],
      ],
      columns,
    ),
    ...(Object.keys(summary.failures).length > 0
      ? ['', 'Why reviews did not decide', ...statusTable(categoryRows(summary.failures), columns)]
      : []),
    ...omitted('review failure categories', summary.omitted.failures),
  ]
}

function usage(summary: SummaryView, columns: number): string[] {
  const { tokens } = summary

  return statusTable(
    [
      ['Model calls', count.format(summary.calls)],
      ['  Initial calls', count.format(summary.calls - summary.retries - summary.continuations)],
      ['  Retries', count.format(summary.retries)],
      ['  Inspection follow-ups', count.format(summary.continuations)],
      ['Input tokens', count.format(tokens.input)],
      ['Output tokens', count.format(tokens.output)],
      ['Cache-read tokens', count.format(tokens.cacheRead)],
      ['Cache-write tokens', count.format(tokens.cacheWrite)],
      ['  Of which 1-hour writes', count.format(tokens.cacheWrite1h)],
      ['Estimated cost', estimate(summary)],
      ...(costComplete(summary) ? [] : [['Known estimate', money(summary.estimatedCostUsd)] as const]),
      ['Calls using fallback prices', count.format(summary.assumedPriceCalls)],
      ['Failed calls', count.format(summary.failedCalls)],
      ['Calls without reported usage', count.format(summary.unreportedCalls)],
      ['Calls without prices', count.format(summary.unpricedCalls)],
    ],
    columns,
  )
}

function human(summary: SummaryView, columns: number): string[] {
  const { manual } = summary

  return [
    'Permission confirmations',
    ...statusTable(
      [
        ['Prompts shown', count.format(summary.prompts)],
        ['Approved', count.format(summary.human.approved)],
        ['Refused or dismissed', count.format(summary.human.rejected)],
        ['Confirmation unavailable', count.format(summary.human.unavailable)],
        ['Waiting time', `${count.format(summary.human.waitMs)} ms`],
      ],
      columns,
    ),
    '',
    'Manual approval requests',
    ...statusTable(
      [
        ['Requests', count.format(manual.requested)],
        ['Prompts shown', count.format(manual.prompted)],
        ['Approved', count.format(manual.approved)],
        ['Rejected', count.format(manual.rejected)],
        ['Cancelled', count.format(manual.cancelled)],
        ['Confirmation unavailable', count.format(manual.unavailable)],
        ['Waiting time', `${count.format(manual.waitMs)} ms`],
      ],
      columns,
    ),
    '',
    'Manually approved commands',
    ...statusTable(
      [
        ['Dispatched', count.format(manual.dispatched)],
        ['Ran', count.format(manual.executed)],
        ['Completed', count.format(manual.completed)],
        ['Failed', count.format(manual.failed)],
        ['Blocked', count.format(manual.blocked)],
        ['Running time', `${count.format(manual.executionMs)} ms`],
      ],
      columns,
    ),
    ...(Object.keys(summary.resolutions).length > 0
      ? ['', 'Permission resolution categories', ...statusTable(categoryRows(summary.resolutions), columns)]
      : []),
    ...omitted('permission resolution categories', summary.omitted.resolutions),
    ...(Object.keys(manual.failures).length > 0
      ? ['', 'Why manual approvals did not complete', ...statusTable(categoryRows(manual.failures), columns)]
      : []),
    ...omitted('manual approval failure categories', summary.omitted.manualFailures),
  ]
}

function models(summary: SummaryView, columns: number): string[] {
  const lines = summary.models.flatMap(model => [
    identifier(`${model.provider}/${model.model}`),
    ...statusTable(
      [
        ['Model calls', count.format(model.calls)],
        ['Calls with reported usage', count.format(model.reportedCalls)],
        ['Input tokens', count.format(model.tokens.input)],
        ['Output tokens', count.format(model.tokens.output)],
        ['Cache-read tokens', count.format(model.tokens.cacheRead)],
        ['Cache-write tokens', count.format(model.tokens.cacheWrite)],
        ['  Of which 1-hour writes', count.format(model.tokens.cacheWrite1h)],
        ['Estimated cost', model.unpricedCalls > 0 ? 'Incomplete' : money(model.estimatedCostUsd)],
        ['Calls using fallback prices', count.format(model.assumedPriceCalls)],
        ['Calls without prices', count.format(model.unpricedCalls)],
      ],
      columns,
    ),
    '',
  ])
  if (lines.length === 0) {
    lines.push('No model details recorded.')
  }
  if (lines.at(-1) === '') {
    lines.pop()
  }

  return [...lines, ...omitted('models', summary.omitted.models)]
}

function coverage(data: StatusData, summary: SummaryView, scope: StatisticsScope, columns: number): string[] {
  const rows: StatusRow[] = [['First recorded', summary.since === null ? 'Not recorded' : date.format(summary.since)]]
  if (scope === 'global' && !('unavailable' in data.global)) {
    rows.unshift(['Global totals started', date.format(data.global.periodStart)])
  }
  const details = [
    ...scopeProblems(summary, scope),
    ...summary.issueList.filter(issue => ORDINARY_ISSUES.has(issue)).map(issueText),
  ]

  return [...statusTable(rows, columns), '', ...(details.length > 0 ? details : ['No recording problems observed.'])]
}

function section(data: StatusData, selected: StatisticsSectionView, columns: number): string[] {
  const header = [`Auto-review: ${SCOPE_TITLES[selected.scope]} / ${STATISTICS_SECTIONS[selected.section]}`, '']
  if (selected.scope === 'global' && 'unavailable' in data.global) {
    return [...header, storageProblem(data.global)]
  }
  const summary = view(
    selected.scope === 'session' || 'unavailable' in data.global ? data.session : data.global.summary,
  )
  switch (selected.section) {
    case 'activity':
      return [...header, ...activity(summary, columns)]
    case 'usage':
      return [...header, ...usage(summary, columns)]
    case 'human':
      return [...header, ...human(summary, columns)]
    case 'models':
      return [...header, ...models(summary, columns)]
    case 'coverage':
      return [...header, ...coverage(data, summary, selected.scope, columns)]
  }
}

/** The overview, one section, or every section of both scopes as plain text */
export function formatAutoStatus(state: AutoStatusState, data: StatusData, options: StatusFormatOptions = {}): string {
  const columns = Math.max(20, options.columns ?? 80)
  if (options.view === 'text') {
    const scopes: StatisticsScope[] = ['session', 'global']

    return [
      ...overview(state, data, columns),
      ...scopes.flatMap(scope =>
        Object.keys(STATISTICS_SECTIONS)
          .filter(isStatisticsSection)
          .flatMap(item => ['', ...section(data, { scope, section: item }, columns)]),
      ),
    ].join('\n')
  }
  if (options.view !== undefined) {
    return section(data, options.view, columns).join('\n')
  }

  return overview(state, data, columns).join('\n')
}
