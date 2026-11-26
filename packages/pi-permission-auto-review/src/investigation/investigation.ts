import type { ProposedTool, ReviewRoutes } from './review-route.js'
import type { Tool, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type {
  ProcessResult,
  Sandbox,
  SandboxCloseReport,
  SandboxContext,
  SandboxCopyOptions,
  SandboxHost,
  ShellReviewSource,
} from 'pi-bring-your-own-sandbox/api'
import { Buffer } from 'node:buffer'
import { isAbsolute, posix, relative, sep } from 'node:path'
import { isSandboxError, SandboxCleanupError } from 'pi-bring-your-own-sandbox/api'
import { Type } from 'typebox'
import * as v from 'valibot'
import { reviewRoutes } from './review-route.js'

interface UnconfirmedCleanup {
  readonly failure: 'unconfirmed'
  readonly details: {
    readonly failures: readonly Pick<Error, 'name' | 'message'>[]
    readonly recoveries: SandboxCloseReport['recoveries']
  }
}

type ReleaseOutcome = 'confirmed' | 'not-opened' | UnconfirmedCleanup

type CleanupFailure = UnconfirmedCleanup | { readonly failure: 'timed-out'; readonly late: Promise<ReleaseOutcome> }

const CLEANUP_TIMEOUT_MS = 10_000
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
// Leave out `no-host-system-files`: native providers need system files to start a shell. BYOS still gives the copy the
// strictest filesystem scope that the provider supports
const COPY_REQUIREMENTS = {
  guarantees: ['no-workspace-writes', 'no-network', 'no-host-user-data'],
  capabilities: ['exec', 'files.read'],
  shells: ['sh'],
  processKinds: ['shell'],
  exitStatus: 'guaranteed',
  terminationScope: 'process-group',
} as const satisfies SandboxCopyOptions

export type InvestigationAvailability = { available: true } | { available: false; reason: string }

export type InvestigationOutcome =
  | { kind: 'inspected' }
  | { kind: 'unused' }
  | { kind: 'unavailable'; reason: 'no-session-route' | 'no-call-route' | 'copy-open-failed' }

const UNAVAILABLE_REASONS = {
  'no-session-route': 'no tool route provides review copies',
  'no-call-route': 'last review had no route for its call',
  'copy-open-failed': 'last review could not open a copy',
} satisfies Record<Extract<InvestigationOutcome, { kind: 'unavailable' }>['reason'], string>

export function formatInvestigationOutcome(outcome: InvestigationOutcome): string {
  switch (outcome.kind) {
    case 'inspected':
      return 'last review inspected a copy'
    case 'unused':
      return 'last review did not investigate'
    case 'unavailable':
      return UNAVAILABLE_REASONS[outcome.reason]
  }
}

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
  /** Whether the sandbox refused the command */
  refused?: boolean
}

function unconfirmedCleanup(
  failures: readonly Pick<Error, 'name' | 'message'>[],
  recoveries: SandboxCloseReport['recoveries'] = [],
): UnconfirmedCleanup {
  return {
    failure: 'unconfirmed',
    details: { failures: failures.map(({ name, message }) => ({ name, message })), recoveries },
  }
}

function unconfirmedCleanupError(error: unknown): UnconfirmedCleanup {
  if (isSandboxError(error)) {
    return unconfirmedCleanup([error], error.recovery === undefined ? [] : [error.recovery])
  }
  if (error instanceof Error) {
    return unconfirmedCleanup([error])
  }

  return unconfirmedCleanup([{ name: 'Error', message: typeof error === 'string' ? error : 'Unknown error' }])
}

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
    refused,
  }
}

/** The model reads host paths in the transcript; one inside the host workspace refers to the target's workspace */
function targetPath(sandbox: Sandbox, cwd: string, path: string): string {
  if (!isAbsolute(path)) {
    return path
  }
  const inside = relative(cwd, path)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
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

export class Investigation {
  private context: SandboxContext | undefined

  private readonly pi: SandboxHost
  private readonly routes: ReviewRoutes

  constructor(pi: SandboxHost, routes: ReviewRoutes = reviewRoutes) {
    this.pi = pi
    this.routes = routes
  }

  start(context: SandboxContext): void {
    this.context = context
  }

  async availability(): Promise<InvestigationAvailability> {
    const available = this.context !== undefined && this.routes.available(this.pi)
    return Promise.resolve(
      available ? { available: true } : { available: false, reason: UNAVAILABLE_REASONS['no-session-route'] },
    )
  }

  forReview(signal: AbortSignal, tool: ProposedTool): InvestigationRun {
    const context = this.context
    const source = context === undefined ? undefined : this.routes.resolve(this.pi, context, tool)
    return new InvestigationRun(signal, context?.cwd ?? '', source)
  }
}

/** One review's tool calls, within its budget of calls and output */
export class InvestigationRun {
  readonly tools: Tool[] = TOOLS
  private pending: ReturnType<ShellReviewSource['copy']> | undefined
  private closing: Promise<CleanupFailure | undefined> | undefined
  private usedCopy = false
  private callCount = 0
  private refusalCount = 0
  private outputBytes = 0
  unavailableReason: string | undefined

  private readonly signal: AbortSignal
  private readonly life = new AbortController()
  private readonly cwd: string
  private readonly source: ShellReviewSource | undefined

  constructor(signal: AbortSignal, cwd: string, source: ShellReviewSource | undefined) {
    this.signal = AbortSignal.any([signal, this.life.signal])
    this.cwd = cwd
    this.source = source
    if (source === undefined) {
      this.unavailableReason = 'the proposed execution destination could not be established'
    }
  }

  async close(): Promise<CleanupFailure | undefined> {
    this.life.abort()
    this.closing ??= this.release()
    return this.closing
  }

  private async release(): Promise<CleanupFailure | undefined> {
    if (this.pending === undefined) return undefined

    const release: Promise<ReleaseOutcome> = this.pending
      .then(
        async (copy): Promise<ReleaseOutcome> => {
          const report = await copy.close()
          return report.confirmed ? 'confirmed' : unconfirmedCleanup(report.failures, report.recoveries)
        },
        (error: unknown): ReleaseOutcome =>
          isSandboxError(error, SandboxCleanupError) ? unconfirmedCleanupError(error) : 'not-opened',
      )
      .catch(unconfirmedCleanupError)
    const deadline = Promise.withResolvers<'timed-out'>()
    const timer = setTimeout(() => deadline.resolve('timed-out'), CLEANUP_TIMEOUT_MS)
    try {
      const outcome = await Promise.race([release, deadline.promise])
      if (outcome === 'timed-out') return { failure: outcome, late: release }
      return typeof outcome === 'string' ? undefined : outcome
    } finally {
      clearTimeout(timer)
    }
  }

  get outcome(): InvestigationOutcome | undefined {
    if (this.source === undefined) {
      return { kind: 'unavailable', reason: 'no-call-route' }
    }
    if (this.usedCopy) {
      return { kind: 'inspected' }
    }
    if (this.unavailableReason !== undefined) {
      return { kind: 'unavailable', reason: 'copy-open-failed' }
    }

    return this.pending === undefined ? { kind: 'unused' } : undefined
  }

  get calls(): number {
    return this.callCount
  }

  get bytes(): number {
    return this.outputBytes
  }

  get refusals(): number {
    return this.refusalCount
  }

  /** Whether the review has used its budget or lost its sandbox, so the reviewer must decide without more calls */
  get exhausted(): boolean {
    return this.unavailableReason !== undefined || this.callCount >= MAX_CALLS || this.outputBytes >= MAX_OUTPUT_BYTES
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
    let sandbox: Sandbox
    try {
      this.signal.throwIfAborted()
      if (this.source === undefined) {
        throw new Error('The proposed execution destination is unavailable.')
      }
      this.pending ??= this.source.copy({ ...COPY_REQUIREMENTS, signal: this.signal })
      const copy = await this.pending
      this.signal.throwIfAborted()
      sandbox = copy.sandbox
    } catch (error) {
      this.signal.throwIfAborted()
      this.unavailableReason = describeError(error)
      return { text: `Investigation is unavailable: ${this.unavailableReason}`, isError: true, bytes: 0 }
    }
    this.usedCopy = true
    const options = { signal: this.signal, timeoutMs: CALL_TIMEOUT_MS }
    let outcome: CallOutcome
    try {
      const { output } = parsed
      if (output.name === 'shell') {
        const request = { kind: 'shell', command: output.arguments.command, dialect: 'sh' } as const
        outcome = shellOutcome(await sandbox.exec(request, { ...options, maxCaptureBytes: OUTPUT_LIMIT_BYTES }))
      } else {
        const range = output.arguments
        outcome = await readText(sandbox, targetPath(sandbox, this.cwd, range.path), range, options)
      }
    } catch (error) {
      if (this.signal.aborted) {
        throw error
      }
      outcome = { text: `The ${call.name} call failed: ${describeError(error)}`, isError: true, bytes: 0 }
    }
    this.outputBytes += outcome.bytes
    this.refusalCount += outcome.refused === true ? 1 : 0

    return outcome
  }
}
