import type { ExtensionAPI, ExtensionContext, InputEvent, SessionEntry } from '@earendil-works/pi-coding-agent'
import * as v from 'valibot'
import { EXTENSION_ID } from '../config/config.js'

export const USER_PROVENANCE_TYPE: string = `${EXTENSION_ID}:user-provenance`

const SOURCES = ['interactive', 'rpc', 'extension', 'uncertain'] as const

const provenanceSchema = v.object({
  userEntryId: v.pipe(v.string(), v.minLength(1)),
  source: v.picklist(SOURCES),
  inputText: v.optional(v.string()),
})

type ProvenanceSource = (typeof SOURCES)[number]

type QueuedBehavior = NonNullable<InputEvent['streamingBehavior']>

type UserMessage = Extract<SessionEntry, { type: 'message' }>['message'] & { role: 'user' }

interface PendingInput {
  sessionId: string
  content: string
  source: ProvenanceSource
  /**
   * The submitted texts, before input handlers, skills or prompt templates changed them, that could have produced the
   * message. Pi delivers at most one of them
   */
  submitted: readonly string[]
}

interface QueuedInput extends PendingInput {
  behavior: QueuedBehavior
}

interface PendingMessage extends PendingInput {
  afterEntryId: string | null
}

interface RecordedProvenance {
  source: ProvenanceSource | 'conflicting'
  inputText: string | undefined
}

function userProvenance(entries: SessionEntry[]): ReadonlyMap<string, RecordedProvenance> {
  const users = new Set<string>()
  const recorded = new Map<string, RecordedProvenance>()
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message.role === 'user') {
      users.add(entry.id)
    }
    if (entry.type !== 'custom' || entry.customType !== USER_PROVENANCE_TYPE) {
      continue
    }
    const result = v.safeParse(provenanceSchema, entry.data)
    if (!result.success || !users.has(result.output.userEntryId)) {
      continue
    }
    const { userEntryId, source, inputText } = result.output
    const previous = recorded.get(userEntryId)
    if (previous?.source === 'uncertain' || source === 'uncertain') {
      recorded.set(userEntryId, { source: 'uncertain', inputText: undefined })
      continue
    }
    const agrees = previous === undefined || (previous.source === source && previous.inputText === inputText)
    recorded.set(userEntryId, agrees ? { source, inputText } : { source: 'conflicting', inputText: undefined })
  }

  return recorded
}

/** User message entries that a record attributes to the interactive UI or RPC */
export function verifiedUserEntries(entries: SessionEntry[]): ReadonlySet<string> {
  return new Set(
    [...userProvenance(entries)].flatMap(([id, { source }]) =>
      source === 'interactive' || source === 'rpc' ? [id] : [],
    ),
  )
}

/** User message entries whose attribution is uncertain or contradicted by another record */
export function uncertainUserEntries(entries: SessionEntry[]): ReadonlySet<string> {
  return new Set(
    [...userProvenance(entries)].flatMap(([id, { source }]) =>
      source === 'uncertain' || source === 'conflicting' ? [id] : [],
    ),
  )
}

/** For verified entries that Pi delivered changed, the text that the person submitted */
export function submittedTexts(entries: SessionEntry[]): ReadonlyMap<string, string> {
  return new Map(
    [...userProvenance(entries)].flatMap(([id, { source, inputText }]) =>
      (source === 'interactive' || source === 'rpc') && inputText !== undefined ? [[id, inputText]] : [],
    ),
  )
}

function inputContent(text: string, images: InputEvent['images']): string {
  return JSON.stringify([{ type: 'text', text }, ...(images ?? [])])
}

function deliveredText(content: unknown): string {
  return (Array.isArray(content) ? content : [content])
    .flatMap((block: unknown) =>
      typeof block === 'string'
        ? [block]
        : typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block
          ? [String(block.text)]
          : [],
    )
    .join('')
}

/**
 * Records in a custom session entry whether each user message came from the interactive UI, RPC or an extension.
 * Pi stores no origin on a message entry and reports the source only on the `input` event, before handlers,
 * skills and prompt templates have changed the text
 */
export class UserMessageProvenance {
  private readonly pi: ExtensionAPI
  private readonly inputs: PendingInput[] = []
  private starting: PendingInput | undefined
  private delivering: PendingInput | undefined
  private ended: PendingMessage | undefined
  private queuedSource: 'trusted' | 'extension' | 'mixed' | undefined
  private readonly queued: QueuedInput[] = []

  constructor(pi: ExtensionAPI) {
    this.pi = pi
    const flush = (_event: unknown, ctx: ExtensionContext): void => this.flush(ctx)
    pi.on('input', (event, ctx) => {
      this.flush(ctx)
      const input: PendingInput = {
        sessionId: ctx.sessionManager.getSessionId(),
        content: inputContent(event.text, event.images),
        source: event.source,
        submitted: [event.text],
      }
      if (event.streamingBehavior !== undefined) {
        // Pi can select a follow-up before a later steer is queued. The context
        // exposes no submission IDs, so source ambiguity lasts until the run ends.
        const source = event.source === 'extension' ? 'extension' : 'trusted'
        this.queuedSource = this.queuedSource === undefined || this.queuedSource === source ? source : 'mixed'
        this.queued.push({ ...input, behavior: event.streamingBehavior })
        return
      }
      if (ctx.isIdle()) {
        this.inputs.push(input)
      }
    })
    pi.on('before_agent_start', (event, ctx) => {
      this.flush(ctx)
      const inputs = this.inputs.splice(0)
      this.starting = undefined
      if (event.messageType !== 'user') {
        return
      }
      const input = inputs[0]
      if (input?.sessionId !== ctx.sessionManager.getSessionId()) {
        return
      }
      const sameTrust = inputs.every(
        pending =>
          pending.sessionId === input.sessionId && (pending.source === 'extension') === (input.source === 'extension'),
      )
      this.starting = {
        ...input,
        source: sameTrust ? input.source : 'uncertain',
        submitted: inputs.flatMap(pending => pending.submitted),
      }
    })
    pi.on('message_start', (event, ctx) => {
      this.flush(ctx)
      if (event.message.role !== 'user') {
        return
      }
      const starting = this.starting
      this.starting = undefined
      const sessionId = ctx.sessionManager.getSessionId()
      this.delivering = starting ??
        this.takeQueued(event.message, sessionId) ?? {
          sessionId,
          content: JSON.stringify(event.message.content),
          source: 'uncertain',
          submitted: [],
        }
    })
    pi.on('message_end', (event, ctx) => {
      this.flush(ctx)
      if (event.message.role !== 'user') {
        return
      }
      const input = this.delivering
      this.delivering = undefined
      if (input?.sessionId !== ctx.sessionManager.getSessionId()) {
        return
      }
      this.ended = {
        ...input,
        content: JSON.stringify(event.message.content),
        afterEntryId: ctx.sessionManager.getLeafId(),
      }
    })
    pi.on('context', flush)
    pi.on('tool_call', flush)
    const clearRun = (): void => {
      this.starting = undefined
      this.delivering = undefined
      this.ended = undefined
      this.queuedSource = undefined
      this.queued.length = 0
    }
    const clear = (): void => {
      clearRun()
      this.inputs.length = 0
    }
    const finish = (_event: unknown, ctx: ExtensionContext): void => {
      this.flush(ctx)
      clearRun()
    }
    pi.on('agent_end', flush)
    pi.on('agent_settled', finish)
    pi.on('session_start', clear)
    pi.on('session_shutdown', clear)
    pi.on('session_tree', clear)
  }

  private takeQueued(message: UserMessage, sessionId: string): PendingInput | undefined {
    const content = JSON.stringify(message.content)
    const ambiguous = this.queued.length > 1 || this.queuedSource === 'mixed'
    for (const behavior of ['steer', 'followUp'] as const) {
      const index = this.queued.findIndex(input => input.behavior === behavior)
      if (index === -1) {
        continue
      }
      const input = this.queued.splice(index, 1)[0]!
      const transformed = input.source !== 'extension' && !input.submitted.includes(deliveredText(message.content))
      // Queued input is matched to its message by content, steer before follow-up. A transformed text cannot be
      // matched that way, so it keeps its source only while no other input is queued
      if (input.sessionId !== sessionId || this.queuedSource === 'mixed' || (transformed && ambiguous)) {
        return { ...input, sessionId, content, source: 'uncertain', submitted: [] }
      }
      return { ...input, content }
    }

    return undefined
  }

  /** Writes the record for the user message that Pi appended after the last `message_end`, once it is on the branch */
  flush(ctx: Pick<ExtensionContext, 'sessionManager'>): void {
    const ended = this.ended
    if (ended === undefined) {
      return
    }
    const branch = ctx.sessionManager.getBranch()
    const position = ended.afterEntryId === null ? -1 : branch.findIndex(entry => entry.id === ended.afterEntryId)
    if (ended.sessionId !== ctx.sessionManager.getSessionId() || (ended.afterEntryId !== null && position === -1)) {
      this.ended = undefined
      return
    }
    const entry = branch
      .slice(position + 1)
      .find(candidate => candidate.type === 'message' && candidate.message.role === 'user')
    if (entry === undefined) {
      return
    }
    this.ended = undefined
    if (entry.type !== 'message' || entry.message.role !== 'user') {
      return
    }
    const delivered = deliveredText(entry.message.content)
    const transformed = !ended.submitted.includes(delivered)
    const [inputText] = transformed ? ended.submitted : []
    // A changed text that more than one submission could have produced cannot be attributed to any of them
    const source =
      ended.content !== JSON.stringify(entry.message.content) ||
      (transformed && ended.source !== 'extension' && ended.submitted.length !== 1)
        ? 'uncertain'
        : ended.source
    const trusted = source === 'interactive' || source === 'rpc'
    this.pi.appendEntry(USER_PROVENANCE_TYPE, {
      userEntryId: entry.id,
      source,
      ...(trusted && inputText !== undefined ? { inputText } : {}),
    })
  }
}
