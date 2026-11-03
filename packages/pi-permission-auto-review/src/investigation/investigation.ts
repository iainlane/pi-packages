import type { Tool, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type {
  ProcessResult,
  Sandbox,
  SandboxAcquireOptions,
  SandboxContext,
  SandboxHost,
  SandboxNegotiation,
} from 'pi-bring-your-own-sandbox/api'
import { Buffer } from 'node:buffer'
import { isAbsolute, posix, relative, sep } from 'node:path'
import {
  getSandbox,
  isSandboxError,
  negotiateSandbox,
  UnsupportedSandboxCapabilityError,
  UnsupportedSandboxPolicyError,
} from 'pi-bring-your-own-sandbox/api'
import { Type } from 'typebox'
import * as v from 'valibot'

const CALL_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT_BYTES = 32 * 1024
const READ_LIMIT_BYTES = 8 * 1024 * 1024
const MAX_CALLS = 8
const MAX_OUTPUT_BYTES = 64 * 1024
const TRUNCATED = '\n[truncated]'
const FINAL_STOP = /\.$/
const BUDGET_EXHAUSTED = 'Not run: the investigation budget for this review is exhausted.'
// Codex infers a refusal from a failed command whose own output reports a denial. The word "sandbox" alone also
// appears in ordinary errors, so it does not count
const REFUSAL = /operation not permitted|permission denied|read-only file system/i

/** What the reviewer needs from the user's sandbox: no writes, no network, and nothing outside the workspace */
export const INVESTIGATION_REQUIREMENTS: SandboxAcquireOptions = {
  policy: { workspaceAccess: 'read-only', filesystemScope: 'workspace-only', networkAccess: 'denied' },
  capabilities: ['exec', 'files.read'],
  processKinds: ['shell'],
  shells: ['sh'],
  exitStatus: 'guaranteed',
  terminationScope: 'process-group',
}

/** The BYOS client functions that investigation calls */
export interface SandboxAccess {
  negotiateSandbox: (
    pi: SandboxHost,
    context: SandboxContext,
    options: SandboxAcquireOptions,
  ) => Promise<SandboxNegotiation>
  getSandbox: (pi: SandboxHost, context: SandboxContext, options: SandboxAcquireOptions) => Promise<Sandbox>
}

export type InvestigationAvailability = { available: true } | { available: false; reason: string }

const lineNumber = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))
const callSchema = v.variant('name', [
  v.object({ name: v.literal('shell'), arguments: v.strictObject({ command: v.pipe(v.string(), v.minLength(1)) }) }),
  v.object({
    name: v.literal('read'),
    arguments: v.strictObject({ path: v.pipe(v.string(), v.minLength(1)), offset: lineNumber, limit: lineNumber }),
  }),
])

const TOOLS: Tool[] = [
  {
    name: 'shell',
    description:
      'Inspect local state with one POSIX shell command in a read-only sandbox without network access. It runs in the workspace root. Never execute or simulate the proposed action.',
    parameters: Type.Object({ command: Type.String() }),
  },
  {
    name: 'read',
    description:
      'Read a UTF-8 text file of up to 8 MiB through the sandbox. Use offset (the first line, from 1) and limit (a line count) to select lines; output beyond 32 KiB is truncated.',
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
]

interface CallOutcome {
  text: string
  isError: boolean
  /** Command output or file content, which counts against the review's budget */
  bytes: number
}

/** A short reason for the footer and the log, such as "the selected sandbox cannot satisfy the requested policy" */
function describeError(error: unknown): string {
  const message = isSandboxError(error) || error instanceof Error ? error.message : 'unknown error'

  return message.charAt(0).toLowerCase() + message.slice(1).replace(FINAL_STOP, '')
}

function truncate(text: string): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= OUTPUT_LIMIT_BYTES) {
    return text
  }

  return new TextDecoder().decode(bytes.subarray(0, OUTPUT_LIMIT_BYTES - Buffer.byteLength(TRUNCATED))) + TRUNCATED
}

function shellOutcome(result: ProcessResult): CallOutcome {
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  const failed = result.exit.kind !== 'code' || result.exit.code !== 0
  const omitted = result.omittedBytes.stdout + result.omittedBytes.stderr
  const refused = failed && (REFUSAL.test(stdout) || REFUSAL.test(stderr))

  return {
    text: JSON.stringify({
      exit: result.exit,
      stdout,
      stderr,
      ...(omitted > 0 ? { omittedBytes: result.omittedBytes } : {}),
      ...(refused ? { refused } : {}),
    }),
    isError: failed,
    bytes: result.stdout.length + result.stderr.length,
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const onAbort = (): void => reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** The model reads host paths in the transcript; one inside the host workspace refers to the target's workspace */
function targetPath(sandbox: Sandbox, cwd: string, path: string): string {
  if (!isAbsolute(path)) {
    return path
  }
  const inside = relative(cwd, path)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return path
  }

  return posix.join(sandbox.workspace.root, ...inside.split(sep))
}

async function readText(
  sandbox: Sandbox,
  path: string,
  range: { offset?: number | undefined; limit?: number | undefined },
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<CallOutcome> {
  const refuse = (text: string): CallOutcome => ({ text, isError: true, bytes: 0 })
  const stat = await sandbox.files.stat(path, options)
  if (stat.kind !== 'file') {
    return refuse(`${path} is not a regular file.`)
  }
  if (stat.size > READ_LIMIT_BYTES) {
    return refuse(`${path} is larger than 8 MiB.`)
  }
  // The file can grow between the two calls
  const data = await sandbox.files.readFile(path, options)
  if (data.length > READ_LIMIT_BYTES) {
    return refuse(`${path} is larger than 8 MiB.`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return refuse(`${path} is not UTF-8 text.`)
  }

  const start = (range.offset ?? 1) - 1
  const lines = text.split('\n').slice(start, range.limit === undefined ? undefined : start + range.limit)
  const selected = truncate(lines.join('\n'))

  return { text: selected, isError: false, bytes: Buffer.byteLength(selected) }
}

/**
 * Investigation for one session: whether the user's sandbox can meet the requirements, and the sandbox itself, which
 * opens at the first tool call
 */
export class Investigation {
  private readonly pi: SandboxHost
  private readonly access: SandboxAccess
  private context: SandboxContext | undefined
  private negotiation: Promise<InvestigationAvailability> = Promise.resolve({
    available: false,
    reason: 'the session has not started',
  })
  private sandbox: Promise<Sandbox> | undefined
  private disabled: string | undefined

  constructor(pi: SandboxHost, access: SandboxAccess = { negotiateSandbox, getSandbox }) {
    this.pi = pi
    this.access = access
  }

  /** Negotiates with the session's sandbox provider; nothing is opened until a review calls a tool */
  start(context: SandboxContext): void {
    this.context = context
    this.sandbox = undefined
    this.disabled = undefined
    this.negotiation = this.access.negotiateSandbox(this.pi, context, INVESTIGATION_REQUIREMENTS).then(
      (negotiation): InvestigationAvailability =>
        negotiation.ok ? { available: true } : { available: false, reason: describeError(negotiation.error) },
      (error: unknown): InvestigationAvailability => ({ available: false, reason: describeError(error) }),
    )
  }

  async availability(): Promise<InvestigationAvailability> {
    if (this.disabled !== undefined) {
      return { available: false, reason: this.disabled }
    }

    return this.negotiation
  }

  forReview(signal: AbortSignal): InvestigationRun {
    return new InvestigationRun(signal, async () => this.acquire(signal))
  }

  /** The session's sandbox, or why this review, or every later one, cannot use it */
  private async acquire(signal: AbortSignal): Promise<{ sandbox: Sandbox; cwd: string } | { unavailable: string }> {
    const context = this.context
    if (context === undefined || this.disabled !== undefined) {
      return { unavailable: this.disabled ?? 'the session has not started' }
    }
    // Shared by every review, so a review's cancellation stops waiting without ending the acquisition
    this.sandbox ??= this.access.getSandbox(this.pi, context, INVESTIGATION_REQUIREMENTS)
    try {
      return { sandbox: await raceAbort(this.sandbox, signal), cwd: context.cwd }
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      this.sandbox = undefined
      const reason = describeError(error)
      if (
        isSandboxError(error, UnsupportedSandboxPolicyError) ||
        isSandboxError(error, UnsupportedSandboxCapabilityError)
      ) {
        this.disabled = reason
      }

      return { unavailable: reason }
    }
  }
}

/** One review's tool calls, within its budget of calls and output */
export class InvestigationRun {
  readonly tools: Tool[] = TOOLS
  private readonly signal: AbortSignal
  private readonly acquire: () => Promise<{ sandbox: Sandbox; cwd: string } | { unavailable: string }>
  private callCount = 0
  private outputBytes = 0
  private unavailable = false

  constructor(signal: AbortSignal, acquire: InvestigationRun['acquire']) {
    this.signal = signal
    this.acquire = acquire
  }

  get calls(): number {
    return this.callCount
  }

  get bytes(): number {
    return this.outputBytes
  }

  /** Whether the review has used its budget or lost its sandbox, so the reviewer must decide without more calls */
  get exhausted(): boolean {
    return this.unavailable || this.callCount >= MAX_CALLS || this.outputBytes >= MAX_OUTPUT_BYTES
  }

  /** Answers every call, since a provider rejects a request that leaves a tool call unanswered */
  async run(calls: readonly ToolCall[]): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = []
    for (const call of calls) {
      const outcome = this.exhausted ? { text: BUDGET_EXHAUSTED, isError: true, bytes: 0 } : await this.execute(call)
      results.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError,
        timestamp: Date.now(),
      })
    }

    return results
  }

  private async execute(call: ToolCall): Promise<CallOutcome> {
    const parsed = v.safeParse(callSchema, call)
    if (!parsed.success) {
      return { text: `Invalid arguments for ${call.name}.`, isError: true, bytes: 0 }
    }
    this.callCount += 1
    const acquired = await this.acquire()
    if ('unavailable' in acquired) {
      this.unavailable = true

      return { text: `Investigation is unavailable: ${acquired.unavailable}`, isError: true, bytes: 0 }
    }

    const { sandbox, cwd } = acquired
    const options = { signal: this.signal, timeoutMs: CALL_TIMEOUT_MS }
    let outcome: CallOutcome
    try {
      const { output } = parsed
      if (output.name === 'shell') {
        const request = { kind: 'shell', command: output.arguments.command, dialect: 'sh' } as const
        outcome = shellOutcome(await sandbox.exec(request, { ...options, maxCaptureBytes: OUTPUT_LIMIT_BYTES }))
      } else {
        const range = output.arguments
        outcome = await readText(sandbox, targetPath(sandbox, cwd, range.path), range, options)
      }
    } catch (error) {
      if (this.signal.aborted) {
        throw error
      }
      outcome = { text: `The ${call.name} call failed: ${describeError(error)}`, isError: true, bytes: 0 }
    }
    this.outputBytes += outcome.bytes

    return outcome
  }
}
