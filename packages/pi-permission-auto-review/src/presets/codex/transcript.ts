import type { SessionEntry, SessionProjection } from '@earendil-works/pi-coding-agent'
import { sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent'
import { submittedTexts, uncertainUserEntries, verifiedUserEntries } from '../../provenance/provenance.js'
import { approximateTokens, serializeUnknown, truncateToFit } from '../../text.js'
import { INTERACTION_ADAPTERS } from './interactions.js'

// Codex's synchronous profile: user evidence counts first against the message allowance and is never cut per entry
const MAX_RECENT_UNTRUSTED_ENTRIES = 40
const TRANSCRIPT_TOKENS = { message: 20_000, tool: 10_000 }
const ENTRY_TOKENS = { message: 5_000, tool: 1_000 }
const MIN_RECENT_TOOL_ENTRIES = 5
// When the evidence does not fit the model, Codex shortens only user records longer than this, so a short
// restriction survives whole, and keeps at least the second number of tokens of each record that it shortens
const SHORTENABLE_USER_TOKENS = 900
const SHORTENED_MIN_TOKENS = 32
// Codex's limit for one question and its answer, which the review includes whole or leaves out
const INTERACTION_TOKENS = 900
const INTERACTION_TOOLS = new Map(INTERACTION_ADAPTERS.map(adapter => [adapter.toolName, adapter]))

export type TranscriptSource =
  | 'user'
  | 'user_interaction'
  | 'uncertain_user'
  | 'unverified_user'
  | 'edited_user'
  | 'assistant'
  | 'tool'
  | 'summary'
  | 'custom'

type UserSource = Extract<TranscriptSource, 'user' | 'uncertain_user' | 'unverified_user' | 'edited_user'>

interface TranscriptEntry {
  index: number
  kind: TranscriptSource
  label: string
  text: string
  truncated?: boolean
  imagesOmitted?: number
  /**
   * Part of a recognised interaction. The review keeps a question with its answer, and never shortens a pair that is
   * limited in size. An oversized pair is left out
   */
  interaction?: { part: 'question' | 'answer' | 'oversized'; limited: boolean }
}

/** What happened to the records of one source; redacted originals and their replacements are counted separately */
export interface SourceManifest {
  retainedFull: number
  retainedTruncated: number
  omitted: number
  redacted: number
}

export interface EvidenceManifest {
  sources: Record<TranscriptSource, SourceManifest>
  /** Image blocks in the evidence, none of which the reviewer receives */
  imagesOmitted: number
  /** Interaction answers that the review leaves out because the question and answer exceed the size limit */
  answersOmitted: number
  /** Whether the user evidence fits the budget, if one applied, once its long records are shortened */
  authorityFits: boolean
  /** Whether a context edit removed or replaced user evidence */
  authorityEdited: boolean
  /** Whether the branch has a user message that no record attributes with confidence, shown as `uncertain_user` */
  provenanceUncertain: boolean
}

export interface RenderedTranscript {
  entries: string[]
  manifest: EvidenceManifest
  /** The approximate size of the rendered records, which a budget limits */
  tokens: number
}

export interface RenderOptions {
  /** Render only entries from this branch index on, for a follow-up review */
  from?: number
  /**
   * The tokens available for the records. Records other than user evidence leave first, oldest first; if the user
   * evidence alone does not fit, its records longer than 900 tokens are shortened, oldest first
   */
  budget?: number
}

// Persisted session data, so every field is decoded before use; none is assumed to match the current types
interface ContentBlock {
  type?: unknown
  id?: unknown
  text?: unknown
  name?: unknown
  toolName?: unknown
  arguments?: unknown
}

interface MessageLike {
  role?: unknown
  content?: unknown
  command?: unknown
  output?: unknown
  summary?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
  details?: unknown
}

function emptyManifest(): EvidenceManifest {
  const source = (): SourceManifest => ({ retainedFull: 0, retainedTruncated: 0, omitted: 0, redacted: 0 })

  return {
    sources: {
      user: source(),
      user_interaction: source(),
      uncertain_user: source(),
      unverified_user: source(),
      edited_user: source(),
      assistant: source(),
      tool: source(),
      summary: source(),
      custom: source(),
    },
    imagesOmitted: 0,
    answersOmitted: 0,
    authorityFits: true,
    authorityEdited: false,
    provenanceUncertain: false,
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return serializeUnknown(content)
  }

  return content
    .map((block: ContentBlock) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }

      return block.type === 'image' ? '[image omitted]' : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Only a completed, non-cancelled answer to an interaction tool that the assistant called counts. The adapter rebuilds
 * it from the structured details, so free-form tool text is never promoted to user evidence
 */
function interactionRecords(
  message: MessageLike,
  index: number,
  interactionCalls: ReadonlyMap<string, string>,
): TranscriptEntry[] | undefined {
  const { toolName, toolCallId, details } = message
  if (
    typeof toolName !== 'string' ||
    typeof toolCallId !== 'string' ||
    interactionCalls.get(toolCallId) !== toolName ||
    message.isError !== false
  ) {
    return undefined
  }
  const evidence = INTERACTION_TOOLS.get(toolName)?.render(details)
  if (evidence === undefined) {
    return undefined
  }

  const { limited } = evidence
  const question: TranscriptEntry = {
    index,
    kind: 'assistant',
    label: `question:${toolName}`,
    text: evidence.question,
    interaction: { part: 'question', limited },
  }
  const answer: TranscriptEntry = {
    index,
    kind: 'user_interaction',
    label: `user_interaction:${toolName}`,
    text: evidence.answer,
    interaction: { part: 'answer', limited },
  }
  const tokens = approximateTokens(renderEntry(question)) + approximateTokens(renderEntry(answer))
  if (limited && tokens > INTERACTION_TOKENS) {
    return [{ ...answer, text: '', interaction: { part: 'oversized', limited } }]
  }

  return [question, answer]
}

function toolCallName(block: ContentBlock): string {
  return typeof block.name === 'string' ? block.name : typeof block.toolName === 'string' ? block.toolName : 'unknown'
}

function entriesFromMessage(
  message: MessageLike,
  index: number,
  interactionCalls: Map<string, string>,
  userSource: UserSource,
  submitted?: string,
): TranscriptEntry[] {
  const imagesOmitted = Array.isArray(message.content)
    ? message.content.filter((block: ContentBlock) => block.type === 'image').length
    : 0
  const entry = (kind: TranscriptSource, label: string, text: string): TranscriptEntry[] =>
    text ? [{ index, kind, label, text, imagesOmitted }] : []

  switch (message.role) {
    case 'user': {
      const text = textFromContent(message.content)
      // A skill, prompt template or input handler changed what the person typed; only their own words are authority
      if (userSource === 'user' && submitted !== undefined) {
        return [...entry('user', 'user', submitted), ...entry('unverified_user', 'expanded_input', text)]
      }

      return entry(userSource, userSource, text)
    }
    case 'assistant': {
      const toolCalls = (Array.isArray(message.content) ? message.content : []).flatMap((block: ContentBlock) => {
        if (block.type !== 'toolCall') {
          return []
        }
        const name = toolCallName(block)
        if (typeof block.id === 'string' && INTERACTION_TOOLS.has(name)) {
          interactionCalls.set(block.id, name)
        }

        return [{ index, kind: 'tool' as const, label: `tool:${name}`, text: serializeUnknown(block.arguments) }]
      })

      return [...entry('assistant', 'assistant', textFromContent(message.content)), ...toolCalls]
    }
    case 'toolResult': {
      const name = typeof message.toolName === 'string' ? message.toolName : 'unknown'
      const interaction = interactionRecords(message, index, interactionCalls)
      if (interaction !== undefined) {
        return interaction.map((record, position) => (position === 0 ? { ...record, imagesOmitted } : record))
      }

      return entry(
        'tool',
        `tool:${name}${message.isError === true ? ' (error)' : ''}`,
        textFromContent(message.content),
      )
    }
    case 'bashExecution':
      return [
        {
          index,
          kind: 'tool',
          label: 'tool:user-bash',
          text: `${serializeUnknown(message.command)}\n${serializeUnknown(message.output)}`,
        },
      ]
    case 'branchSummary':
    case 'compactionSummary':
      return entry('summary', message.role, serializeUnknown(message.summary))
    case 'custom':
      return entry('custom', 'custom', textFromContent(message.content))
    default:
      return []
  }
}

/**
 * User messages, interaction answers, including answers that are too large to include, and messages that might be the
 * person's and so might restrict the action
 */
function isAuthority(entry: TranscriptEntry): boolean {
  return entry.kind === 'user' || entry.kind === 'user_interaction' || entry.kind === 'uncertain_user'
}

/** The authority that the review includes in full, and the questions that the answers respond to */
function isRequiredEvidence(entry: TranscriptEntry): boolean {
  return entry.interaction?.part !== 'oversized' && (isAuthority(entry) || entry.interaction?.part === 'question')
}

/**
 * Required evidence comes from the raw branch, so compaction never removes it; everything else comes from the
 * projection, the context that the agent's model sees. A context edit takes precedence over both
 */
function collectEntries(
  sessionEntries: SessionEntry[],
  projection: SessionProjection,
  manifest: EvidenceManifest,
  from: number,
): TranscriptEntry[] {
  const interactionCalls = new Map<string, string>()
  const verifiedUsers = verifiedUserEntries(sessionEntries)
  const submitted = submittedTexts(sessionEntries)
  const uncertainUsers = uncertainUserEntries(sessionEntries)
  manifest.provenanceUncertain = uncertainUsers.size > 0
  const projected = new Map(projection.entries.map(entry => [entry.sourceEntry.id, entry.messages]))
  const edits = new Map(
    sessionEntries.flatMap(entry => (entry.type === 'context_edit' ? [[entry.targetId, entry] as const] : [])),
  )
  const restoredEvidence: TranscriptEntry[] = []
  const recordsById = new Map<string, TranscriptEntry[]>()

  for (const [index, entry] of sessionEntries.entries()) {
    // Decoded before the `from` check, so an answer after it to a question asked before it is still recognised
    const raw = sessionEntryToContextMessages(entry).flatMap(message =>
      entriesFromMessage(
        message,
        index,
        interactionCalls,
        verifiedUsers.has(entry.id) ? 'user' : uncertainUsers.has(entry.id) ? 'uncertain_user' : 'unverified_user',
        submitted.get(entry.id),
      ),
    )
    if (index < from) {
      continue
    }
    const edit = edits.get(entry.id)
    if (edit !== undefined) {
      if (raw.some(isAuthority)) {
        manifest.authorityEdited = true
      }
      for (const record of raw) {
        manifest.sources[record.kind].redacted += 1
      }
      if (edit.replacement === null) {
        continue
      }
    }

    if (edit === undefined && raw.some(isAuthority)) {
      if (projected.has(entry.id)) {
        recordsById.set(entry.id, raw)
      } else {
        restoredEvidence.push(...raw.filter(record => isAuthority(record) || record.interaction !== undefined))
      }
      continue
    }

    const messages = projected.get(entry.id) ?? []
    const records = messages.flatMap(message =>
      entriesFromMessage(message, index, new Map(), edit === undefined ? 'unverified_user' : 'edited_user'),
    )
    if (edit === undefined && records.length === 0) {
      for (const record of raw) {
        manifest.sources[record.kind].omitted += 1
      }
    }
    recordsById.set(entry.id, records)
  }

  return [...restoredEvidence, ...projection.entries.flatMap(entry => recordsById.get(entry.sourceEntry.id) ?? [])]
}

function renderEntry(entry: TranscriptEntry): string {
  return JSON.stringify({ index: entry.index, source: entry.kind, label: entry.label, content: entry.text })
}

function pool(entry: TranscriptEntry): 'message' | 'tool' {
  return entry.kind === 'tool' ? 'tool' : 'message'
}

function pretruncate(entry: TranscriptEntry): TranscriptEntry {
  if (isRequiredEvidence(entry)) {
    return entry
  }
  const text = truncateToFit(entry.text, ENTRY_TOKENS[pool(entry)] * 4, candidate =>
    renderEntry({ ...entry, text: candidate }),
  )

  return text === entry.text ? entry : { ...entry, text, truncated: true }
}

/** Shortens long user evidence, oldest first; false when the evidence still does not fit */
function shortenToBudget(required: TranscriptEntry[], budget: number): Map<TranscriptEntry, TranscriptEntry> | false {
  const replacements = new Map<TranscriptEntry, TranscriptEntry>()
  const tokens = (entry: TranscriptEntry): number => approximateTokens(renderEntry(replacements.get(entry) ?? entry))
  let total = required.reduce((sum, entry) => sum + tokens(entry), 0)
  for (const entry of required.filter(candidate => approximateTokens(candidate.text) > SHORTENABLE_USER_TOKENS)) {
    if (total <= budget) {
      break
    }
    const current = tokens(entry)
    const target = Math.max(SHORTENED_MIN_TOKENS, current - (total - budget)) * 4
    const text = truncateToFit(entry.text, target, candidate => renderEntry({ ...entry, text: candidate }))
    replacements.set(entry, { ...entry, text, truncated: true })
    total += tokens(entry) - current
  }

  return total <= budget ? replacements : false
}

/**
 * Renders the review evidence: every user message and recognised answer in full, then the newest other records
 * within Codex's caps, in branch order. Pass the raw branch and its projection from the same session. With a
 * `budget`, `manifest.authorityFits` reports whether the user evidence could be made to fit it
 */
export function renderTranscript(
  sessionEntries: SessionEntry[],
  projection: SessionProjection,
  options: RenderOptions = {},
): RenderedTranscript {
  const manifest = emptyManifest()
  let all = collectEntries(sessionEntries, projection, manifest, options.from ?? 0).map(pretruncate)
  const budget = options.budget ?? Number.POSITIVE_INFINITY
  const requiredTokens = all
    .filter(isRequiredEvidence)
    .reduce((total, entry) => total + approximateTokens(renderEntry(entry)), 0)
  if (requiredTokens > budget) {
    const replacements = shortenToBudget(all.filter(isRequiredEvidence), budget)
    if (replacements === false) {
      manifest.authorityFits = false
    } else {
      all = all.map(entry => replacements.get(entry) ?? entry)
    }
  }

  const selected = new Set(all.filter(isRequiredEvidence))
  const used = {
    message: [...selected].reduce((total, entry) => total + approximateTokens(renderEntry(entry)), 0),
    tool: 0,
  }
  const take = (entry: TranscriptEntry): boolean => {
    const category = pool(entry)
    const cost = approximateTokens(renderEntry(entry))
    if (used[category] + cost > TRANSCRIPT_TOKENS[category] || used.message + used.tool + cost > budget) {
      return false
    }
    used[category] += cost
    selected.add(entry)

    return true
  }

  const recent = all.filter(entry => !isAuthority(entry) && entry.interaction === undefined).toReversed()
  const requiredTools = recent.filter(entry => entry.kind === 'tool').slice(0, MIN_RECENT_TOOL_ENTRIES)
  for (const entry of requiredTools) {
    take(entry)
  }
  let untrustedRetained = requiredTools.length
  for (const entry of recent) {
    if (selected.has(entry) || untrustedRetained >= MAX_RECENT_UNTRUSTED_ENTRIES) {
      continue
    }
    if (take(entry)) {
      untrustedRetained += 1
    }
  }

  for (const entry of all) {
    manifest.imagesOmitted += entry.imagesOmitted ?? 0
    if (entry.interaction?.part === 'oversized') {
      manifest.answersOmitted += 1
    }
    const counts = manifest.sources[entry.kind]
    if (!selected.has(entry)) {
      counts.omitted += 1
    } else if (entry.truncated === true) {
      counts.retainedTruncated += 1
    } else {
      counts.retainedFull += 1
    }
  }
  const entries = all.filter(entry => selected.has(entry)).map(renderEntry)
  const counts = Object.values(manifest.sources)
  const omission = {
    source: 'metadata',
    omittedEntries: counts.reduce((total, source) => total + source.omitted, 0),
    truncatedEntries: counts.reduce((total, source) => total + source.retainedTruncated, 0),
    redactedEntries: counts.reduce((total, source) => total + source.redacted, 0),
    imagesOmitted: manifest.imagesOmitted,
    ...(manifest.answersOmitted > 0 ? { answersOmitted: manifest.answersOmitted } : {}),
  }
  if (omission.omittedEntries + omission.truncatedEntries + omission.redactedEntries + omission.imagesOmitted > 0) {
    entries.push(JSON.stringify(omission))
  }

  return { entries, manifest, tokens: used.message + used.tool }
}

/** The manifest as flat log fields, listing only the counts that are not zero */
export function manifestFields(manifest: EvidenceManifest): Record<string, number | boolean> {
  const counts = Object.entries(manifest.sources).flatMap(([source, outcomes]) =>
    Object.entries(outcomes).flatMap(([outcome, count]): [string, number][] =>
      count === 0 ? [] : [[`${source}.${outcome}`, count]],
    ),
  )

  return {
    ...Object.fromEntries<number>(counts),
    imagesOmitted: manifest.imagesOmitted,
    answersOmitted: manifest.answersOmitted,
    authorityFits: manifest.authorityFits,
    authorityEdited: manifest.authorityEdited,
    provenanceUncertain: manifest.provenanceUncertain,
  }
}

/** Whether a context edit or compaction after branch index `after` changed what the reviewer saw before it */
export function evidenceChangedSince(sessionEntries: SessionEntry[], after: number): boolean {
  return sessionEntries
    .slice(after + 1)
    .some(entry => entry.type === 'context_edit' || entry.type === 'compaction' || entry.type === 'branch_summary')
}
