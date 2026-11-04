import type { JsonObject } from './json.js'
import type { ReviewAction, ToolRegistration } from './schema.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolInfo,
} from '@earendil-works/pi-coding-agent'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { platform } from 'node:process'
import { fileURLToPath } from 'node:url'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { EXTENSION_ID } from '../config/config.js'
import { freezeDeep, inputDigest, JsonValueError, parseJsonObject, parseJsonValue, projectSdkJson } from './json.js'
import { isReviewAction, isToolRegistration } from './schema.js'

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const AT_PREFIX = /^@/
const WINDOWS_DRIVE_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i

type Ineligibility =
  | 'forwarded'
  | 'action-unavailable'
  | 'action-mismatch'
  | 'action-changed'
  | 'unsupported-input'
  | 'protected-target'

export type ActionResolution = { kind: 'eligible'; action: ReviewAction } | { kind: Ineligibility }

interface CapturedAction {
  toolName: string
  parentToolCallId: string | undefined
  input?: JsonObject | undefined
  digest?: string | undefined
  liveInput: unknown
  cwd: string
  sessionId: string
  registration?: ToolRegistration | undefined
}

/** A captured call as manual approval binds to it; `digest` is undefined once the live input differs from the capture */
export interface CapturedInvocation {
  readonly toolName: string
  readonly toolCallId: string
  readonly parentToolCallId: string | undefined
  readonly cwd: string
  readonly sessionId: string
  readonly input: Readonly<JsonObject> | undefined
  readonly digest: string | undefined
  readonly registrationDigest: string | undefined
}

/** Runs in the capture's `tool_call` handler and can block the call */
type CaptureObserver = (invocation: CapturedInvocation, ctx: ExtensionContext) => ToolCallEventResult | undefined

interface McpToolName {
  server: string
  tool: string
}

function parseMcpToolName(name: string): McpToolName | undefined {
  if (!name.startsWith('mcp__')) {
    return undefined
  }
  const separator = name.indexOf('__', 5)
  if (separator <= 5 || separator + 2 >= name.length || name.includes('__', separator + 1)) {
    return undefined
  }

  return { server: name.slice(5, separator), tool: name.slice(separator + 2) }
}

function actionKind(name: string, mcp: McpToolName | undefined): ReviewAction['kind'] {
  if (name === 'bash') {
    return 'shell'
  }
  if (name === 'write') {
    return 'file-write'
  }
  if (name === 'edit') {
    return 'file-edit'
  }

  return mcp === undefined ? 'tool' : 'mcp'
}

function toolRegistration(tool: ToolInfo): ToolRegistration {
  const registration = projectSdkJson({
    sourceInfo: tool.sourceInfo,
    parametersDigest: inputDigest(projectSdkJson(tool.parameters)),
  })
  if (!isToolRegistration(registration)) throw new JsonValueError()

  return registration
}

// Mirrors how Pi's file tools resolve a path argument, so the reviewer sees the file that the tool would change
function normalisePath(path: string): string {
  let normalised = path
  if (platform === 'win32' && !normalised.startsWith('//') && !normalised.includes('\\')) {
    const drive = normalised.match(WINDOWS_DRIVE_PATH)
    if (drive?.[1] !== undefined) {
      normalised = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll('/', '\\') ?? ''}`
    }
  }
  if (normalised === '~') {
    return homedir()
  }
  if (normalised.startsWith('~/') || (platform === 'win32' && normalised.startsWith('~\\'))) {
    return join(homedir(), normalised.slice(2))
  }
  if (normalised.startsWith('file://')) {
    return fileURLToPath(normalised)
  }

  return normalised
}

function resolveToolPath(path: string, cwd: string): string {
  const normalised = normalisePath(path.replace(UNICODE_SPACES, ' ').replace(AT_PREFIX, ''))

  return isAbsolute(normalised) ? resolve(normalised) : resolve(normalisePath(cwd), normalised)
}

/** Resolves symlinks in the longest existing prefix, so an alias cannot hide which file a path refers to */
function canonicalPath(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.toReversed())
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return resolve(path)
      }
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Files and directories whose contents decide which extensions run, what this reviewer and the permission system
 * allow, and which sandbox the reviewer investigates in
 */
function protectedTargets(cwd: string): string[] {
  const agentDir = getAgentDir()

  return [
    join(agentDir, 'extensions', EXTENSION_ID),
    join(cwd, '.pi', 'extensions', EXTENSION_ID),
    join(agentDir, 'extensions', 'pi-permission-system'),
    join(cwd, '.pi', 'extensions', 'pi-permission-system'),
    join(agentDir, 'settings.json'),
    join(cwd, '.pi', 'settings.json'),
    join(agentDir, 'byos.json'),
  ].map(canonicalPath)
}

function isProtectedTarget(path: string, cwd: string): boolean {
  const target = canonicalPath(path)

  return protectedTargets(cwd).some(root => target === root || target.startsWith(`${root}${sep}`))
}

/**
 * Captures the validated input of every tool call from a `tool_call` handler. Pi runs those handlers in extension
 * load order and then executes the object that they saw, so this extension must load before pi-permission-system
 */
export class ActionCapture {
  private readonly pi: ExtensionAPI
  private readonly entries = new Map<string, CapturedAction>()
  private readonly observers = new Set<CaptureObserver>()
  private warnedUnavailable = false

  constructor(pi: ExtensionAPI) {
    this.pi = pi
    pi.on('tool_call', (event, ctx) => {
      this.capture(event, ctx)
      const invocation = this.invocation(event.toolCallId)
      if (invocation === undefined) {
        return undefined
      }
      for (const observer of this.observers) {
        const result = observer(invocation, ctx)
        if (result?.block === true) {
          return result
        }
      }

      return undefined
    })
    pi.on('tool_execution_end', event => {
      this.entries.delete(event.toolCallId)
    })
    const clear = (): void => {
      this.entries.clear()
      this.warnedUnavailable = false
    }
    pi.on('session_start', clear)
    pi.on('session_shutdown', clear)
  }

  /** Observes every captured call, after its capture and before any later extension's handler */
  onCaptured(observer: CaptureObserver): void {
    this.observers.add(observer)
  }

  invocation(toolCallId: string): CapturedInvocation | undefined {
    const entry = this.entries.get(toolCallId)
    if (entry === undefined) {
      return undefined
    }
    let digest = entry.digest
    try {
      if (digest !== undefined && digest !== inputDigest(parseJsonValue(entry.liveInput))) {
        digest = undefined
      }
    } catch {
      digest = undefined
    }

    return Object.freeze({
      toolName: entry.toolName,
      toolCallId,
      parentToolCallId: entry.parentToolCallId,
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      input: entry.input,
      digest,
      registrationDigest:
        entry.registration === undefined ? undefined : inputDigest(projectSdkJson(entry.registration)),
    })
  }

  private capture(event: ToolCallEvent, ctx: ExtensionContext): void {
    const entry: CapturedAction = {
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
      liveInput: event.input,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    }
    this.entries.set(event.toolCallId, entry)
    try {
      const input = structuredClone(parseJsonObject(event.input))
      entry.input = freezeDeep(input)
      entry.digest = inputDigest(input)
      const tool = this.pi.getAllTools().find(candidate => candidate.name === event.toolName)
      if (tool !== undefined) entry.registration = freezeDeep(structuredClone(toolRegistration(tool)))
    } catch {
      entry.digest = undefined
    }
  }

  /** A digest of every registered tool's source and parameters, which changes when a tool is replaced */
  registryDigest(): string {
    const registrations = this.pi.getAllTools().map(tool => ({ name: tool.name, ...toolRegistration(tool) }))

    return inputDigest(registrations.toSorted((a, b) => a.name.localeCompare(b.name)))
  }

  resolve(details: PromptPermissionDetails, sessionId: string): ActionResolution {
    if (details.forwarding !== undefined) {
      return { kind: 'forwarded' }
    }
    if (details.source === 'skill_input' || details.source === 'skill_read') {
      try {
        const skill = structuredClone({
          source: details.source,
          ...(details.skillName === undefined ? {} : { skillName: details.skillName }),
          ...(details.path === undefined ? {} : { path: details.path }),
          payload: parseJsonValue(details.payload),
        })
        const action = { ...skill, kind: 'skill', digest: inputDigest(skill) }

        return isReviewAction(action) ? { kind: 'eligible', action: freezeDeep(action) } : { kind: 'unsupported-input' }
      } catch {
        return { kind: 'unsupported-input' }
      }
    }
    const entry = details.toolCallId === undefined ? undefined : this.entries.get(details.toolCallId)
    if (entry === undefined) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true
        console.warn(
          `[${EXTENSION_ID}] this extension must load before @gotgenes/pi-permission-system to capture complete tool actions`,
        )
      }

      return { kind: 'action-unavailable' }
    }
    if (entry.toolName !== details.toolName || entry.sessionId !== sessionId) {
      return { kind: 'action-mismatch' }
    }
    if (entry.digest === undefined) {
      return { kind: 'unsupported-input' }
    }
    try {
      if (entry.digest !== inputDigest(parseJsonValue(entry.liveInput))) {
        return { kind: 'action-changed' }
      }
    } catch {
      return { kind: 'action-changed' }
    }
    try {
      const mcp = parseMcpToolName(entry.toolName)
      const kind = actionKind(entry.toolName, mcp)
      const path = entry.input?.['path']
      const resolvedPath =
        (kind === 'file-write' || kind === 'file-edit') && typeof path === 'string'
          ? resolveToolPath(path, entry.cwd)
          : undefined
      if (resolvedPath !== undefined && isProtectedTarget(resolvedPath, entry.cwd)) {
        return { kind: 'protected-target' }
      }
      const action = {
        toolName: entry.toolName,
        toolCallId: details.toolCallId,
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        ...(entry.parentToolCallId === undefined ? {} : { parentToolCallId: entry.parentToolCallId }),
        ...(entry.registration === undefined ? {} : { registration: entry.registration }),
        input: entry.input,
        digest: entry.digest,
        kind,
        ...(resolvedPath === undefined ? {} : { resolvedPath }),
        ...(mcp === undefined ? {} : { ...mcp, connectorMetadata: 'unavailable', accountMetadata: 'unavailable' }),
      }

      return isReviewAction(action) ? { kind: 'eligible', action: freezeDeep(action) } : { kind: 'unsupported-input' }
    } catch {
      return { kind: 'unsupported-input' }
    }
  }
}
