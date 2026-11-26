import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { EscalationDecision } from 'pi-bring-your-own-sandbox/consumer'
import * as v from 'valibot'
import { EXTENSION_ID } from '../config/config.js'
import { truncateToCharacters } from '../text.js'

const ENTRY_TYPE = `${EXTENSION_ID}:escalation-decision.v1`
export const ESCALATION_RATIONALE_LIMIT = 4_000

export interface EscalationDecisionEntry {
  toolCallId: string
  verdict: EscalationDecision
  rationale: string
}

const entrySchema: v.GenericSchema<EscalationDecisionEntry> = v.strictObject({
  toolCallId: v.pipe(v.string(), v.minLength(1)),
  verdict: v.picklist(['allow', 'deny']),
  rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(ESCALATION_RATIONALE_LIMIT)),
})

export function appendEscalationDecision(pi: Pick<ExtensionAPI, 'appendEntry'>, entry: EscalationDecisionEntry): void {
  const rationale = truncateToCharacters(entry.rationale, ESCALATION_RATIONALE_LIMIT)
  pi.appendEntry(ENTRY_TYPE, v.parse(entrySchema, { ...entry, rationale }))
}

export function readEscalationDecisions(entries: readonly SessionEntry[], filter?: string): EscalationDecisionEntry[] {
  return entries.flatMap(entry => {
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) return []

    const result = v.safeParse(entrySchema, entry.data)
    return result.success && (filter === undefined || result.output.toolCallId === filter) ? [result.output] : []
  })
}
