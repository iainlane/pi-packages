import type { ExtensionAPI, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { registerStatisticsCommand } from '../../src/statistics/command.js'
import { emptySummary } from '../../src/statistics/summary.js'

type Command = Omit<RegisteredCommand, 'name' | 'sourceInfo'>

const USAGE =
  'Usage: /auto-stats [details|text|session [activity|usage|human|models|coverage]|global [activity|usage|human|models|coverage]]'

/** Runs `/auto-stats` with scripted dialog answers, collecting what the person is shown */
function setup(mode: 'tui' | 'rpc' | 'print', answers: (string | undefined)[] = []) {
  const commands = new Map<string, Command>()
  let interaction = new AbortController()
  const shown: [string, string][] = []
  const endSession = (): void => {
    interaction.abort()
    interaction = new AbortController()
  }
  registerStatisticsCommand(
    { registerCommand: (name: string, options: Command) => commands.set(name, options) } as unknown as ExtensionAPI,
    {
      sessionTotals: () => emptySummary(),
      globalTotals: () => ({ periodStart: Date.UTC(2026, 10, 3), summary: emptySummary(), pending: false }),
      interaction: () => {
        const { signal } = interaction

        return { signal, isCurrent: () => !signal.aborted }
      },
    },
    () => ({ registered: true, config: DEFAULT_CONFIG, investigation: { available: true }, circuitOpen: false }),
  )
  const context = {
    mode,
    hasUI: mode !== 'print',
    ui: {
      notify: (message: string, level: string) => shown.push([message, level]),
      select: async () => {
        const answer = answers.shift()
        if (answer === 'end session') {
          endSession()
          return 'Global'
        }

        return answer
      },
    },
  }

  return {
    names: [...commands.keys()],
    shown,
    /** The first line of each message shown, which identifies the report or text */
    headings: () => shown.map(([message, level]) => [message.split('\n')[0], level]),
    run: async (args: string) => commands.get('auto-stats')?.handler(args, context as never),
  }
}

describe('/auto-stats', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers only /auto-stats and shows the overview', async () => {
    const harness = setup('tui')
    await harness.run('')

    expect({ names: harness.names, shown: harness.headings() }).toStrictEqual({
      names: ['auto-stats'],
      shown: [['Auto-review', 'info']],
    })
  })

  it.each(['details extra', 'session unknown', 'global usage extra', 'text extra'])(
    'shows the usage for %j instead of a report',
    async args => {
      const harness = setup('tui')
      await harness.run(args)

      expect(harness.shown).toStrictEqual([[USAGE, 'warning']])
    },
  )

  it('asks for the scope and section in the terminal, then shows that section', async () => {
    const harness = setup('tui', ['Global', 'Tokens and cost'])
    await harness.run('details')

    expect(harness.headings()).toStrictEqual([['Auto-review: Global / Tokens and cost', 'info']])
  })

  it.each([
    { stage: 'scope', answers: [undefined] },
    { stage: 'section', answers: ['Global', undefined] },
    { stage: 'session', answers: ['end session', 'Tokens and cost'] },
  ])('shows nothing when the $stage dialog is cancelled or the session ends during it', async ({ answers }) => {
    const harness = setup('tui', answers)
    await harness.run('details')

    expect(harness.shown).toStrictEqual([])
  })

  it('lists the direct section commands over RPC, where the dialogs are unavailable', async () => {
    const harness = setup('rpc', ['Global', 'Tokens and cost'])
    await harness.run('details')

    expect(harness.shown).toStrictEqual([
      [
        'Choose a scope and section:\n/auto-stats session activity|usage|human|models|coverage\n/auto-stats global activity|usage|human|models|coverage',
        'info',
      ],
    ])
  })

  it('writes the report to stderr in print mode, leaving stdout to the agent', async () => {
    const written: Record<'stdout' | 'stderr', string[]> = { stdout: [], stderr: [] }
    for (const stream of ['stdout', 'stderr'] as const) {
      vi.spyOn(process[stream], 'write').mockImplementation(text => {
        written[stream].push(String(text).split('\n')[0] ?? '')

        return true
      })
    }
    await setup('print').run('session usage')

    expect(written).toStrictEqual({ stdout: [], stderr: ['Auto-review: This session / Tokens and cost'] })
  })
})
