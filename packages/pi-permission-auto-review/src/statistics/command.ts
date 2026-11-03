import type { AutoStatusState, StatisticsSectionView, StatusFormatOptions } from './format.js'
import type { StatisticsRecorder } from './recorder.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import process from 'node:process'
import { formatAutoStatus, hasStatusProblems, isStatisticsSection, STATISTICS_SECTIONS } from './format.js'

type StatusRequest =
  | { kind: 'overview' }
  | { kind: 'details' }
  | { kind: 'text' }
  | { kind: 'section'; view: StatisticsSectionView }

const USAGE =
  'Usage: /auto-stats [details|text|session [activity|usage|human|models|coverage]|global [activity|usage|human|models|coverage]]'
const DIRECT_DETAILS =
  'Choose a scope and section:\n/auto-stats session activity|usage|human|models|coverage\n/auto-stats global activity|usage|human|models|coverage'
const WHITESPACE = /\s+/u
const COMPLETIONS = ['details', 'text', 'session', 'global']

function parse(args: string): StatusRequest | undefined {
  const words = args.trim().split(WHITESPACE)
  const [first, second] = words
  if (first === '') {
    return { kind: 'overview' }
  }
  if (words.length === 1 && (first === 'details' || first === 'text')) {
    return { kind: first }
  }
  if (words.length > 2 || (first !== 'session' && first !== 'global')) {
    return undefined
  }
  const section = second ?? 'activity'

  return isStatisticsSection(section) ? { kind: 'section', view: { scope: first, section } } : undefined
}

/** Shows text to the person; in print mode stdout carries the agent's answer, so the report goes to stderr */
function display(ctx: ExtensionCommandContext, message: string, severity: 'info' | 'warning'): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, severity)
    return
  }
  process.stderr.write(`${message}\n`)
}

/** Asks for the scope and the section, or returns undefined when the person cancels or the session changes */
async function chooseView(
  ctx: ExtensionCommandContext,
  interaction: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<StatisticsSectionView | undefined> {
  const scope = await ctx.ui.select('Auto-review: scope', ['This session', 'Global'], { signal: interaction.signal })
  if (!interaction.isCurrent() || (scope !== 'This session' && scope !== 'Global')) {
    return undefined
  }
  const section = await ctx.ui.select('Auto-review: details', Object.values(STATISTICS_SECTIONS), {
    signal: interaction.signal,
  })
  const selected = Object.keys(STATISTICS_SECTIONS)
    .filter(isStatisticsSection)
    .find(key => STATISTICS_SECTIONS[key] === section)
  if (!interaction.isCurrent() || selected === undefined) {
    return undefined
  }

  return { scope: scope === 'This session' ? 'session' : 'global', section: selected }
}

/** Registers `/auto-stats`, which shows the statistics without adding them to the session or to any model's context */
export function registerStatisticsCommand(
  pi: ExtensionAPI,
  recorder: Pick<StatisticsRecorder, 'sessionTotals' | 'globalTotals' | 'interaction'>,
  state: () => AutoStatusState,
): void {
  pi.registerCommand('auto-stats', {
    description: 'Show what automatic permission review decided and cost, in this session and this Pi profile',
    getArgumentCompletions(prefix) {
      const matches = COMPLETIONS.filter(value => value.startsWith(prefix.trim())).map(value => ({
        value,
        label: value,
      }))

      return matches.length > 0 ? matches : null
    },
    async handler(args, ctx) {
      const request = parse(args)
      if (request === undefined) {
        display(ctx, USAGE, 'warning')
        return
      }
      if (request.kind === 'details' && (ctx.mode !== 'tui' || !ctx.hasUI)) {
        display(ctx, DIRECT_DETAILS, 'info')
        return
      }
      const interaction = recorder.interaction()
      const options: StatusFormatOptions = { columns: ctx.mode === 'tui' ? (process.stdout.columns ?? 80) : 80 }
      if (request.kind === 'section') {
        options.view = request.view
      }
      if (request.kind === 'text') {
        options.view = 'text'
      }
      if (request.kind === 'details') {
        const selected = await chooseView(ctx, interaction)
        if (selected === undefined) {
          return
        }
        options.view = selected
      }
      const data = { session: recorder.sessionTotals(), global: recorder.globalTotals() }
      const current = state()
      display(ctx, formatAutoStatus(current, data, options), hasStatusProblems(current, data) ? 'warning' : 'info')
    },
  })
}
