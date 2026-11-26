import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import process from 'node:process'

const TERMINAL_CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Shows a command report to the user. In print mode the agent's response goes to stdout, so the report goes to stderr. */
export function displayCommandOutput(
  ctx: ExtensionCommandContext,
  message: string,
  severity: 'info' | 'warning',
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, severity)
    return
  }
  process.stderr.write(`${message}\n`)
}

/** Renders text as a JSON string when it contains characters that can change the terminal layout. */
export function escapeTerminalText(value: string): string {
  if (value.search(TERMINAL_CONTROLS) === -1) {
    return value
  }

  return JSON.stringify(value).replace(TERMINAL_CONTROLS, character =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`,
    ).join(''),
  )
}
