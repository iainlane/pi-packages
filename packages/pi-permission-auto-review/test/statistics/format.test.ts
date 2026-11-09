import type { AutoStatusState, StatusData } from '../../src/statistics/format.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { formatAutoStatus } from '../../src/statistics/format.js'
import { emptyModel, emptySummary } from '../../src/statistics/summary.js'

const state: AutoStatusState = {
  registered: true,
  config: DEFAULT_CONFIG,
  investigation: { available: true },
  circuitOpen: false,
}

function sample(): StatusData & { global: { summary: ReturnType<typeof emptySummary> } } {
  const session = { ...emptySummary(), reviews: { allow: 12, deny: 2, defer: 1 }, estimatedCostUsd: 0.012345 }
  const summary = { ...emptySummary(), reviews: { allow: 5, deny: 0, defer: 0 }, estimatedCostUsd: 0.0041 }

  return { session, global: { periodStart: Date.UTC(2026, 10, 3, 9), summary, pending: false } }
}

function overviewRows(sessionCost = 'USD 0.012345', globalCost = 'USD 0.004100'): string[] {
  return [
    ['', 'This session', 'Global'],
    ['Allowed', '12', '5'],
    ['Refused', '2', '0'],
    ['No automatic decision', '1', '0'],
    ['Estimated cost', sessionCost, globalCost],
  ].map(([label = '', session = '', global = '']) =>
    `${label.padEnd(21)}  ${session.padStart(12)}  ${global.padStart(12)}`.trimEnd(),
  )
}

const HEADER = ['Auto-review', 'Model: openai/codex-auto-review', 'Investigation: available', '']
const STARTED = ['', 'Global totals started 3 Nov 2026, 09:00 UTC']
const FOOTER = ['', 'Details: /auto-stats details']

describe('statistics presentation', () => {
  it.each([80, 120])('shows the compact comparison at %s columns', columns => {
    expect(formatAutoStatus(state, sample(), { columns })).toBe(
      [...HEADER, ...overviewRows(), ...STARTED, ...FOOTER].join('\n'),
    )
  })

  it('stacks the scopes at 40 columns without clipping labels or estimates', () => {
    expect(formatAutoStatus(state, sample(), { columns: 40 })).toBe(
      [
        ...HEADER,
        'This session',
        'Allowed                          12',
        'Refused                           2',
        'No automatic decision             1',
        'Estimated cost         USD 0.012345',
        '',
        'Global',
        'Allowed                           5',
        'Refused                           0',
        'No automatic decision             0',
        'Estimated cost         USD 0.004100',
        ...STARTED,
        ...FOOTER,
      ].join('\n'),
    )
  })

  it('leads with an incomplete cost and gives the number of calls without usage', () => {
    const data = sample()
    data.session.unreportedCalls = 2

    expect(formatAutoStatus(state, data)).toBe(
      [
        ...HEADER,
        ...overviewRows('Incomplete'),
        ...STARTED,
        '',
        'This session: token usage was not reported for 2 model calls. Known estimate: USD 0.012345.',
        ...FOOTER,
      ].join('\n'),
    )
  })

  it('keeps a failed call out of the incomplete cost', () => {
    const data = sample()
    data.session.failedCalls = 1

    expect(formatAutoStatus(state, data)).toBe([...HEADER, ...overviewRows(), ...STARTED, ...FOOTER].join('\n'))
  })

  it('keeps the session totals and says why when the global totals are unavailable', () => {
    const data: StatusData = { session: sample().session, global: { unavailable: 'commit-unknown' } }

    expect(formatAutoStatus(state, data)).toBe(
      [
        ...HEADER,
        ...[
          ['', 'This session', 'Global'],
          ['Allowed', '12', 'Unavailable'],
          ['Refused', '2', 'Unavailable'],
          ['No automatic decision', '1', 'Unavailable'],
          ['Estimated cost', 'USD 0.012345', 'Unavailable'],
        ].map(([label = '', local = '', global = '']) =>
          `${label.padEnd(21)}  ${local.padStart(12)}  ${global.padStart(11)}`.trimEnd(),
        ),
        '',
        'Global: a write failed in a way that might have saved it, so writing stopped to avoid counting it twice.',
        ...FOOTER,
      ].join('\n'),
    )
  })

  it('says when investigation is unavailable, and why', () => {
    const output = formatAutoStatus(
      {
        ...state,
        investigation: { available: false, reason: 'the selected sandbox cannot satisfy the requested policy' },
      },
      sample(),
    )

    expect(output.split('\n')[2]).toBe(
      'Investigation: unavailable, the selected sandbox cannot satisfy the requested policy',
    )
  })

  it('keeps cache writes, retries, failed calls and fallback prices distinct', () => {
    const data = sample()
    Object.assign(data.session, {
      calls: 4,
      retries: 1,
      continuations: 1,
      failedCalls: 1,
      tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 20, cacheWrite1h: 8 },
      assumedPriceCalls: 1,
    })

    expect(formatAutoStatus(state, data, { view: { scope: 'session', section: 'usage' } })).toBe(
      [
        'Auto-review: This session / Tokens and cost',
        '',
        'Model calls                              4',
        '  Initial calls                          2',
        '  Retries                                1',
        '  Inspection follow-ups                  1',
        'Input tokens                            10',
        'Output tokens                            5',
        'Cache-read tokens                        3',
        'Cache-write tokens                      20',
        '  Of which 1-hour writes                 8',
        'Estimated cost                USD 0.012345',
        'Calls using fallback prices              1',
        'Failed calls                             1',
        'Calls without reported usage             0',
        'Calls without prices                     0',
      ].join('\n'),
    )
  })

  it.each([0.000_000_01, 0.000_000_000_001])('does not round a positive estimate of %s to zero', cost => {
    const data = sample()
    data.session.estimatedCostUsd = cost

    expect(
      formatAutoStatus(state, data)
        .split('\n')
        .filter(line => line.startsWith('Estimated cost')),
    ).toStrictEqual([`${'Estimated cost'.padEnd(21)}  ${`USD ${cost.toExponential(2)}`.padStart(12)}  USD 0.004100`])
  })

  it('keeps permission prompts, manual approvals and the outcome of approved commands separate', () => {
    const data = sample()
    Object.assign(data.session, {
      prompts: 2,
      human: { approved: 1, rejected: 1, unavailable: 0, waitMs: 4_000 },
      resolutions: { user_approved: 1, user_denied: 1 },
    })
    Object.assign(data.session.manual, {
      requested: 2,
      prompted: 2,
      approved: 1,
      cancelled: 1,
      dispatched: 1,
      executed: 1,
      failed: 1,
      failures: { 'confirmation-timeout': 1, 'execution-error': 1 },
    })
    /** Rows aligned as the report aligns them: labels padded to the longest, values right-aligned */
    const block = (rows: [string, string][]): string[] => {
      const labels = Math.max(...rows.map(([label]) => label.length))
      const values = Math.max(...rows.map(([, value]) => value.length))

      return rows.map(([label, value]) => `${label.padEnd(labels)}  ${value.padStart(values)}`)
    }

    expect(formatAutoStatus(state, data, { view: { scope: 'session', section: 'human' } })).toBe(
      [
        'Auto-review: This session / Human approvals',
        '',
        'Permission confirmations',
        ...block([
          ['Prompts shown', '2'],
          ['Approved', '1'],
          ['Refused or dismissed', '1'],
          ['Confirmation unavailable', '0'],
          ['Waiting time', '4,000 ms'],
        ]),
        '',
        'Manual approval requests',
        ...block([
          ['Requests', '2'],
          ['Prompts shown', '2'],
          ['Approved', '1'],
          ['Rejected', '0'],
          ['Cancelled', '1'],
          ['Confirmation unavailable', '0'],
          ['Waiting time', '0 ms'],
        ]),
        '',
        'Manually approved commands',
        ...block([
          ['Dispatched', '1'],
          ['Ran', '1'],
          ['Completed', '0'],
          ['Failed', '1'],
          ['Blocked', '0'],
          ['Running time', '0 ms'],
        ]),
        '',
        'Permission resolution categories',
        ...block([
          ['user_approved', '1'],
          ['user_denied', '1'],
        ]),
        '',
        'Why manual approvals did not complete',
        ...block([
          ['confirmation-timeout', '1'],
          ['execution-error', '1'],
        ]),
      ].join('\n'),
    )
  })

  it('shows investigation refusals and does not invent an average without reviews', () => {
    const data = sample()
    Object.assign(data.session, {
      reviews: { allow: 0, deny: 0, defer: 0 },
      investigationCalls: 2,
      investigationRefusals: 1,
    })

    expect(formatAutoStatus(state, data, { view: { scope: 'session', section: 'activity' } })).toBe(
      [
        'Auto-review: This session / Activity',
        '',
        ...[
          ['Automatic reviews', '0'],
          ['Allowed', '0'],
          ['Refused', '0'],
          ['No automatic decision', '0'],
          ['Inspection requests', '2'],
          ['Inspection refusals', '1'],
          ['Total review time', '0 ms'],
          ['Average review time', 'Not applicable'],
          ['Denial-limit trips', '0'],
        ].map(([label = '', value = '']) => `${label.padEnd(21)}  ${value.padStart(14)}`),
      ].join('\n'),
    )
  })

  it('limits the model details to 20 and says how many it left out, without reducing the totals', () => {
    const data = sample()
    data.session.estimatedCostUsd = 25
    data.session.models = Array.from({ length: 25 }, (_, index) => ({
      ...emptyModel('test', `model-${String(index).padStart(2, '0')}`),
      calls: 1,
      reportedCalls: 1,
      estimatedCostUsd: 1,
    }))
    const output = formatAutoStatus(state, data, { view: { scope: 'session', section: 'models' } }).split('\n')

    expect({
      models: output.filter(line => line.startsWith('test/model-')).length,
      last: output.at(-1),
      estimate: formatAutoStatus(state, data)
        .split('\n')
        .find(line => line.startsWith('Estimated cost')),
    }).toStrictEqual({
      models: 20,
      last: 'Additional models omitted: 5',
      estimate: `${'Estimated cost'.padEnd(21)}  USD 25.000000  USD 0.004100`,
    })
  })

  it('reports an unregistered reviewer, a missing config and the denial limit', () => {
    const output = formatAutoStatus(
      { registered: false, config: undefined, investigation: undefined, circuitOpen: true },
      sample(),
    )

    expect(
      output
        .split('\n')
        .filter(line => ['Model', 'The', 'Reviewer', 'Automatic'].some(start => line.startsWith(start))),
    ).toStrictEqual([
      'Model: Unavailable',
      'Reviewer configuration is unavailable.',
      'The reviewer is not registered with the permission service.',
      'Automatic reviews are being refused because the denial limit was reached.',
    ])
  })

  it('does not warn about results that arrived after their session, which the global totals include', () => {
    const data = sample()
    data.global.summary.issues = { 'recorded-after-session': 1 }

    expect({
      overview: formatAutoStatus(state, data),
      coverage: formatAutoStatus(state, data, { view: { scope: 'global', section: 'coverage' } })
        .split('\n')
        .at(-1),
    }).toStrictEqual({
      overview: formatAutoStatus(state, sample()),
      coverage: 'Some results arrived after their session ended and are counted only globally.',
    })
  })

  it('includes every section of both scopes in the text report', () => {
    const output = formatAutoStatus(state, sample(), { view: 'text', columns: 40 })

    expect(output.split('\n').filter(line => line.startsWith('Auto-review:'))).toStrictEqual([
      'Auto-review: This session / Activity',
      'Auto-review: This session / Tokens and cost',
      'Auto-review: This session / Human approvals',
      'Auto-review: This session / Models',
      'Auto-review: This session / Recording problems',
      'Auto-review: Global / Activity',
      'Auto-review: Global / Tokens and cost',
      'Auto-review: Global / Human approvals',
      'Auto-review: Global / Models',
      'Auto-review: Global / Recording problems',
    ])
  })

  it.each(['\u0085', '‮', '\u{E0001}'])('escapes the terminal formatting character %j reversibly', character => {
    const config = { ...DEFAULT_CONFIG, model: `model${character}value` }
    const line = formatAutoStatus({ ...state, config }, sample()).split('\n')[1] ?? ''

    expect(JSON.parse(line.slice('Model: '.length))).toBe(`${config.provider}/${config.model}`)
  })
})
