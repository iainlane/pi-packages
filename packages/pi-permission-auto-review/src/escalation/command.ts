import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { displayCommandOutput, escapeTerminalText } from '../terminal.js'
import { readEscalationDecisions } from './decisions.js'

const WHITESPACE = /\s/u

export function registerEscalationCommand(pi: ExtensionAPI): void {
  pi.registerCommand('auto-escalations', {
    description: 'List the automatic escalation decisions for this session',
    handler: async (args, context) => {
      const filter = args.trim()
      if (WHITESPACE.test(filter)) {
        displayCommandOutput(context, 'Usage: /auto-escalations [tool-call-id]', 'warning')
        return
      }

      const decisions = readEscalationDecisions(context.sessionManager.getEntries(), filter || undefined)
      const lines = decisions.map(
        ({ toolCallId, verdict, rationale }) =>
          `${escapeTerminalText(toolCallId)} · ${verdict} · ${escapeTerminalText(rationale)}`,
      )
      displayCommandOutput(
        context,
        lines.join('\n') || 'No matching auto-review escalation decisions in this session.',
        'info',
      )
    },
  })
}
