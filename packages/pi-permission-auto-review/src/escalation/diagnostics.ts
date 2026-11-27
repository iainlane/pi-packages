import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AuthorizerLog } from '@gotgenes/pi-permission-system'
import * as v from 'valibot'
import { EXTENSION_ID } from '../config/config.js'

const ENTRY_TYPE = `${EXTENSION_ID}:direct-escalation-diagnostic.v1`

interface Diagnostic {
  toolCallId: string
  event: string
  details?: Record<string, unknown> | undefined
}

const entrySchema: v.GenericSchema<Diagnostic> = v.strictObject({
  toolCallId: v.pipe(v.string(), v.minLength(1)),
  event: v.pipe(v.string(), v.startsWith('auto_review.')),
  details: v.optional(v.record(v.string(), v.unknown())),
})

export function directEscalationLog(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  toolCallId: string,
  isCurrentSession: () => boolean,
): AuthorizerLog {
  return {
    review(event, details) {
      if (!isCurrentSession()) return

      pi.appendEntry(ENTRY_TYPE, v.parse(entrySchema, { toolCallId, event, details }))
    },
    debug: () => {},
  }
}

export function readDirectEscalationDiagnostics(entries: readonly SessionEntry[]): Diagnostic[] {
  return entries.flatMap(entry => {
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) return []

    const parsed = v.safeParse(entrySchema, entry.data)
    return parsed.success ? [parsed.output] : []
  })
}
