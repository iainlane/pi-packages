import type { ActionCapture } from '../action/capture.js'
import type { ReviewAction } from '../action/schema.js'
import type { ExtensionContext, SessionEntry, SessionProjection } from '@earendil-works/pi-coding-agent'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { createHash } from 'node:crypto'
import { INTERACTION_ADAPTERS } from '../presets/codex/interactions.js'
import { USER_PROVENANCE_TYPE, verifiedUserEntries } from '../provenance/provenance.js'

const INTERACTION_TOOLS: ReadonlySet<string> = new Set(INTERACTION_ADAPTERS.map(adapter => adapter.toolName))

/** The session state that a review read, and what its verdict depends on */
export interface ReviewSnapshot {
  branch: SessionEntry[]
  projection: SessionProjection
  /** The captured action, or undefined once the capture no longer resolves */
  action: ReviewAction | undefined
  /** User messages, their provenance records and interaction results, which can authorize or restrict the action */
  authorityRevision: string
  contextEditRevision: string
  toolRegistryDigest: string
  sessionId: string
  leafId: string | null
}

export type SnapshotValidation = 'current' | 'stale-authorization' | 'stale-snapshot'

interface SnapshotSources {
  context: Pick<ExtensionContext, 'sessionManager'>
  actions: Pick<ActionCapture, 'resolve' | 'registryDigest'>
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The reviewer receives only text, so an image counts by its presence, never by its data */
function contentWithoutImages(content: unknown): unknown {
  return Array.isArray(content)
    ? content.map((block: { type?: unknown }) => (block.type === 'image' ? { type: 'image' } : block))
    : content
}

function authorityRecord(entry: SessionEntry): unknown {
  if (entry.type === 'custom') {
    return entry.customType === USER_PROVENANCE_TYPE ? { id: entry.id, data: entry.data } : undefined
  }
  if (entry.type !== 'message') {
    return undefined
  }
  const { message } = entry
  if (message.role === 'user') {
    return { id: entry.id, content: contentWithoutImages(message.content) }
  }
  if (message.role === 'toolResult') {
    return INTERACTION_TOOLS.has(message.toolName)
      ? {
          id: entry.id,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          details: message.details,
        }
      : undefined
  }
  if (message.role !== 'assistant') {
    return undefined
  }
  const calls = message.content.flatMap(block =>
    block.type === 'toolCall' && INTERACTION_TOOLS.has(block.name) ? [{ id: block.id, name: block.name }] : [],
  )

  return calls.length > 0 ? { id: entry.id, calls } : undefined
}

/** Captures the session state, and the ask's action when `details` is given */
export function captureSnapshot(sources: SnapshotSources, details?: PromptPermissionDetails): ReviewSnapshot {
  const { sessionManager } = sources.context
  const sessionId = sessionManager.getSessionId()
  const branch = sessionManager.getBranch()
  const resolved = details === undefined ? undefined : sources.actions.resolve(details, sessionId)

  return {
    branch,
    projection: sessionManager.buildSessionProjection(),
    action: resolved?.kind === 'eligible' ? resolved.action : undefined,
    authorityRevision: digest(branch.flatMap(entry => authorityRecord(entry) ?? [])),
    contextEditRevision: digest(
      branch.flatMap(entry =>
        entry.type === 'context_edit'
          ? [{ id: entry.id, targetId: entry.targetId, replacement: entry.replacement }]
          : [],
      ),
    ),
    toolRegistryDigest: sources.actions.registryDigest(),
    sessionId,
    leafId: sessionManager.getLeafId(),
  }
}

/**
 * Whether a verdict reached on `previous` still applies to `current`. An appended entry leaves the earlier leaf on the
 * branch, but moving to another branch does not. A change to the user evidence calls for a review of the new evidence;
 * any other change defers the ask
 */
export function validateSnapshot(previous: ReviewSnapshot, current: ReviewSnapshot): SnapshotValidation {
  return previous.action?.digest === current.action?.digest ? validateSession(previous, current) : 'stale-snapshot'
}

/** As `validateSnapshot`, for a decision that no longer depends on the ask's capture, such as a manual approval */
export function validateSession(previous: ReviewSnapshot, current: ReviewSnapshot): SnapshotValidation {
  const branchIds = new Set(current.branch.map(entry => entry.id))
  if (
    previous.contextEditRevision !== current.contextEditRevision ||
    previous.toolRegistryDigest !== current.toolRegistryDigest ||
    previous.sessionId !== current.sessionId ||
    (previous.leafId !== null && !branchIds.has(previous.leafId))
  ) {
    return 'stale-snapshot'
  }

  return previous.authorityRevision === current.authorityRevision ? 'current' : 'stale-authorization'
}

/**
 * Branch entries in which the person gave direction: verified user messages and recognised interaction answers.
 * An entry that a context edit replaced or removed does not count
 */
export function genuineDirection(branch: readonly SessionEntry[]): ReadonlySet<string> {
  const verified = verifiedUserEntries([...branch])
  const edited = new Set(branch.flatMap(entry => (entry.type === 'context_edit' ? [entry.targetId] : [])))
  const calls = new Map<string, string>()
  const direction = new Set<string>()
  for (const entry of branch) {
    if (entry.type !== 'message' || edited.has(entry.id)) {
      continue
    }
    const { message } = entry
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall' && INTERACTION_TOOLS.has(block.name)) {
          calls.set(block.id, block.name)
        }
      }
    }
    const answered =
      message.role === 'toolResult' &&
      !message.isError &&
      calls.get(message.toolCallId) === message.toolName &&
      INTERACTION_ADAPTERS.find(adapter => adapter.toolName === message.toolName)?.render(message.details) !== undefined
    if (answered || verified.has(entry.id)) {
      direction.add(entry.id)
    }
  }

  return direction
}
