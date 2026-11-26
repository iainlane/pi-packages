import type { ToolCall } from '@earendil-works/pi-ai'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import type { ProcessResult, Sandbox, SandboxCopyOptions, SandboxErrorInfo } from 'pi-bring-your-own-sandbox/consumer'
import { describe, expect, it, vi } from 'vitest'
import { Investigation } from '../../src/investigation/investigation.js'
import { reviewSource, reviewWorkspace } from '../helpers.js'

const CONTEXT = { cwd: '/home/user/repo', sessionManager: {} } as never
const tool = { toolCallId: 'call', toolName: 'bash', source: 'tool_call' } as const
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
type FileStat = Awaited<ReturnType<Sandbox['files']['stat']>>

const policyError: SandboxErrorInfo = Object.assign(
  new Error('The selected sandbox cannot satisfy the requested policy.'),
  {
    name: 'UnsupportedSandboxPolicyError',
    operation: 'acquire',
    providerId: 'fixture',
  } as const,
)

interface FakeSandbox {
  exec?: (request: unknown, options: unknown) => Promise<ProcessResult>
  files?: { stat?: (path: string) => Promise<FileStat>; readFile?: (path: string) => Promise<Uint8Array> }
}

function processResult(stdout: string, stderr = '', code = 0): ProcessResult {
  return {
    exit: { kind: 'code', code },
    stdout: encode(stdout),
    stderr: encode(stderr),
    omittedBytes: { stdout: 0, stderr: 0 },
    durationMs: 1,
  }
}

/**
 * Records each sandbox operation in order, as `copy`, `exec <command>`, `stat <path>` or `read <path>`, and the
 * options passed to each `copy`
 */
function setup(options: { available?: boolean; sandbox?: FakeSandbox; acquire?: () => Promise<Sandbox> }) {
  const operations: string[] = []
  const requests: unknown[][] = []
  const copies: (SandboxCopyOptions | undefined)[] = []
  const fake = options.sandbox ?? {}
  const sandbox = {
    ...reviewWorkspace,
    exec: async (request: { command: string }, execOptions: object) => {
      operations.push(`exec ${request.command}`)
      requests.push([request, { ...execOptions, signal: 'signal' }])
      return (fake.exec ?? (async () => processResult('')))(request, execOptions)
    },
    files: {
      ...reviewWorkspace.files,
      stat: async (path: string) => {
        operations.push(`stat ${path}`)
        return (fake.files?.stat ?? (async (): Promise<FileStat> => ({ kind: 'file', size: 0 })))(path)
      },
      readFile: async (path: string) => {
        operations.push(`read ${path}`)
        return (fake.files?.readFile ?? (async () => encode('')))(path)
      },
    },
  }
  const investigation = new Investigation({
    hasShellReviewRoute: () => options.available !== false,
    findShellReviewSource: () => ({
      ok: true,
      source: reviewSource(async copyOptions => {
        operations.push('copy')
        copies.push(copyOptions)
        return {
          sandbox: await (options.acquire ?? (async () => sandbox as unknown as Sandbox))(),
          close: async () => {
            operations.push('close')
            return { confirmed: true, recoveries: [], failures: [] }
          },
        }
      }),
    }),
  })
  investigation.start(CONTEXT)

  return { investigation, operations, requests, copies }
}

function call(name: string, args: ToolCall['arguments'], id = `call-${name}`): ToolCall {
  return { type: 'toolCall', id, name, arguments: args }
}

async function runOne(investigation: Investigation, toolCall: ToolCall) {
  const run = investigation.forReview(new AbortController().signal, tool)
  const [result] = await run.run([toolCall])

  return {
    run,
    result: {
      text: result?.content[0]?.type === 'text' ? result.content[0].text : undefined,
      isError: result?.isError,
    },
  }
}

describe('investigation', () => {
  it('discovers review routes without opening a copy', async () => {
    const { investigation, operations } = setup({})
    expect({ availability: await investigation.availability(), operations }).toStrictEqual({
      availability: { available: true },
      operations: [],
    })
  })

  it('reports unavailable review routes', async () => {
    const { investigation } = setup({ available: false })
    expect(await investigation.availability()).toStrictEqual({
      available: false,
      reason: 'no tool route provides review copies',
    })
  })

  it('opens and releases a separate copy for each review, stating the investigation requirements', async () => {
    const { investigation, operations, copies } = setup({})
    const first = investigation.forReview(new AbortController().signal, tool)
    const second = investigation.forReview(new AbortController().signal, tool)
    await first.run([call('shell', { command: 'first' })])
    await second.run([call('shell', { command: 'second' })])
    await first.close()
    await second.run([call('shell', { command: 'still open' })])
    await second.close()
    const requirements = {
      access: { network: 'prevented', hostUserData: 'prevented', hostWorkspaceWrites: 'prevented' },
      capabilities: ['exec', 'files.read'],
      shells: ['sh'],
      processKinds: ['shell'],
      exitStatus: 'guaranteed',
      terminationScope: 'process-group',
      signal: expect.any(AbortSignal) as unknown,
    }
    expect({ operations, copies }).toStrictEqual({
      operations: ['copy', 'exec first', 'copy', 'exec second', 'close', 'exec still open', 'close'],
      copies: [requirements, requirements],
    })
  })

  it('runs a shell command in the sandbox once, with bounded time and output, and counts the raw output', async () => {
    const { investigation, operations, requests } = setup({
      sandbox: { exec: async () => processResult('main\n', 'warning: é\n', 0) },
    })
    const run = investigation.forReview(new AbortController().signal, tool)
    const results = await run.run([call('shell', { command: 'git branch --show-current' }, 'a')])
    await run.run([call('shell', { command: 'git status' }, 'b')])

    expect({
      results,
      operations,
      requests,
      bytes: run.bytes,
    }).toStrictEqual({
      results: [
        {
          role: 'toolResult',
          toolCallId: 'a',
          toolName: 'shell',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ exit: { kind: 'code', code: 0 }, stdout: 'main\n', stderr: 'warning: é\n' }),
            },
          ],
          isError: false,
          timestamp: expect.any(Number) as unknown,
        },
      ],
      operations: ['copy', 'exec git branch --show-current', 'exec git status'],
      requests: ['git branch --show-current', 'git status'].map(command => [
        { kind: 'shell', command, dialect: 'sh' },
        { timeoutMs: 10_000, maxCaptureBytes: 32 * 1024, signal: 'signal' },
      ]),
      bytes: 2 * (5 + 12),
    })
  })

  it.each([
    { output: ['', 'rm: cannot remove: Permission denied', 1], refused: true },
    { output: ['touch: read-only file system', '', 1], refused: true },
    { output: ['', 'error: sandbox not configured', 1], refused: false },
    { output: ['', 'Operation not permitted while starting the shell', 0], refused: false },
  ] as const)('classifies a refusal by exit status and the command output: %o', async ({ output, refused }) => {
    const [stdout, stderr, code] = output
    const { investigation } = setup({ sandbox: { exec: async () => processResult(stdout, stderr, code) } })
    const { run, result } = await runOne(investigation, call('shell', { command: 'probe' }))

    expect({
      refused: (JSON.parse(result.text ?? '{}') as { refused?: boolean }).refused ?? false,
      counted: run.refusals,
    }).toStrictEqual({ refused, counted: refused ? 1 : 0 })
  })

  it.each([
    { path: '/home/user/repo/src/a.ts', target: '/project/src/a.ts' },
    { path: '/home/user/repo/..notes', target: '/project/..notes' },
    { path: '/home/user/notes', target: '/home/user/notes' },
  ])('reads selected lines of a UTF-8 file at $path', async ({ path, target }) => {
    const { investigation, operations } = setup({
      sandbox: {
        files: {
          stat: async () => ({ kind: 'file', size: 20 }),
          readFile: async () => encode('one\ntwo\nthree\nfour\n'),
        },
      },
    })
    const { result } = await runOne(investigation, call('read', { path, offset: 2, limit: 2 }))

    expect({ result, operations }).toStrictEqual({
      result: { text: 'two\nthree', isError: false },
      operations: ['copy', `stat ${target}`, `read ${target}`],
    })
  })

  it.each(['é', '€', '🧪'])('truncates UTF-8 output before a partial %s', async character => {
    const suffix = '\n[truncated]'
    const prefix = 'a'.repeat(32 * 1024 - encode(suffix).length - 1)
    const data = encode(`${prefix}${character}tail that exceeds the limit`)
    const { investigation } = setup({
      sandbox: {
        files: {
          stat: async () => ({ kind: 'file', size: data.length }),
          readFile: async () => data,
        },
      },
    })
    const { result } = await runOne(investigation, call('read', { path: 'utf8.txt' }))

    expect(result).toStrictEqual({ text: `${prefix}${suffix}`, isError: false })
  })

  it.each([
    {
      description: 'a directory',
      stat: { kind: 'directory', size: 0 },
      bytes: [],
      message: 'not a regular file',
      read: false,
    },
    {
      description: 'a file over 8 MiB',
      stat: { kind: 'file', size: 9 * 1024 * 1024 },
      bytes: [],
      message: '8 MiB',
      read: false,
    },
    { description: 'a binary file', stat: { kind: 'file', size: 2 }, bytes: [255, 254], message: 'UTF-8', read: true },
  ] as const)('refuses to read $description', async ({ stat, bytes: content, message, read }) => {
    const bytes = new Uint8Array(content)
    const { investigation, operations } = setup({
      sandbox: { files: { stat: async () => stat, readFile: async () => bytes } },
    })
    const { result } = await runOne(investigation, call('read', { path: 'data.bin' }))

    expect({
      isError: result.isError,
      mentions: result.text?.includes(message),
      operations,
    }).toStrictEqual({
      isError: true,
      mentions: true,
      operations: ['copy', 'stat data.bin', ...(read ? ['read data.bin'] : [])],
    })
  })

  it('stops running calls once the review has made eight, and reports the budget as exhausted', async () => {
    const { investigation, operations } = setup({})
    const run = investigation.forReview(new AbortController().signal, tool)
    const results = await run.run(
      Array.from({ length: 9 }, (_, index) => call('shell', { command: `echo ${index}` }, `${index}`)),
    )

    expect({ operations, last: results.at(-1)?.content, exhausted: run.exhausted }).toStrictEqual({
      operations: ['copy', ...Array.from({ length: 8 }, (_, index) => `exec echo ${index}`)],
      last: [{ type: 'text', text: 'Not run: the investigation budget for this review is exhausted.' }],
      exhausted: true,
    })
  })

  it('stops once the raw output reaches 64 KiB', async () => {
    const { investigation, operations } = setup({
      sandbox: { exec: async () => processResult('x'.repeat(32 * 1024)) },
    })
    const run = investigation.forReview(new AbortController().signal, tool)
    await run.run([0, 1, 2].map(index => call('shell', { command: 'cat big' }, `${index}`)))

    expect({ operations, bytes: run.bytes, exhausted: run.exhausted }).toStrictEqual({
      operations: ['copy', 'exec cat big', 'exec cat big'],
      bytes: 64 * 1024,
      exhausted: true,
    })
  })

  it.each([policyError, new Error('provider start failed')])(
    'retries acquisition on the next review after %s',
    async error => {
      const { investigation, operations } = setup({
        acquire: async () => {
          throw error
        },
      })
      const first = await runOne(investigation, call('shell', { command: 'ls' }))
      await runOne(investigation, call('shell', { command: 'ls' }))

      expect({
        refused: first.result.isError,
        exhausted: first.run.exhausted,
        availability: (await investigation.availability()).available,
        operations,
      }).toStrictEqual({ refused: true, exhausted: true, availability: true, operations: ['copy', 'copy'] })
    },
  )

  it('closes a copy that arrives after the review is cancelled', async () => {
    const opened = Promise.withResolvers<Sandbox>()
    const { investigation, operations } = setup({ acquire: async () => opened.promise })
    const controller = new AbortController()
    const run = investigation.forReview(controller.signal, tool)
    const pending = run.run([call('shell', { command: 'ls' })])
    const rejected = expect(pending).rejects.toThrow('cancelled during open')
    controller.abort(new Error('cancelled during open'))
    const closing = run.close()
    opened.resolve(reviewWorkspace)
    await Promise.all([rejected, closing])
    expect(operations).toStrictEqual(['copy', 'close'])
  })

  it.each(['confirmed', 'open failed'] as const)('reports late cleanup after a pending open: %s', async outcome => {
    vi.useFakeTimers()
    try {
      const opened = Promise.withResolvers<Sandbox>()
      const { investigation, operations } = setup({ acquire: async () => opened.promise })
      const run = investigation.forReview(new AbortController().signal, tool)
      const running = run.run([call('shell', { command: 'ls' })])
      const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
      const closing = run.close()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(await Promise.race([closing, Promise.resolve('pending')])).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      const result = await closing
      if (result?.failure !== 'timed-out') throw new Error('Expected a cleanup timeout.')
      if (outcome === 'confirmed') opened.resolve(reviewWorkspace)
      else opened.reject(new Error('The open failed.'))
      await rejected
      expect({ late: await result.late, operations }).toStrictEqual(
        outcome === 'confirmed'
          ? { late: 'confirmed', operations: ['copy', 'close'] }
          : { late: 'not-opened', operations: ['copy'] },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    {
      error: policyError,
      reason: 'the selected sandbox cannot satisfy the requested policy',
    },
    {
      error: Object.assign(new Error('The selected sandbox does not support the required capability.'), {
        name: 'UnsupportedSandboxCapabilityError',
        operation: 'acquire',
        providerId: 'fixture',
      } as const),
      reason: 'the selected sandbox does not support the required capability',
    },
    {
      error: Object.assign(new Error('The sandbox operation exceeded its deadline.'), {
        name: 'SandboxTimeoutError',
        operation: 'acquire',
        completion: 'confirmed',
        reason: 'deadline',
      }),
      reason: 'the sandbox operation exceeded its deadline',
    },
  ])('reports a copy that BYOS rejects as unavailable: $error.name', async ({ error, reason }) => {
    const { investigation, operations } = setup({
      acquire: async () => {
        throw error
      },
    })
    const { run, result } = await runOne(investigation, call('shell', { command: 'ls' }))
    expect({ operations, result, unavailableReason: run.unavailableReason, exhausted: run.exhausted }).toStrictEqual({
      operations: ['copy'],
      result: { isError: true, text: `Investigation is unavailable: ${reason}` },
      unavailableReason: reason,
      exhausted: true,
    })
  })

  it('answers malformed arguments without running anything', async () => {
    const { investigation, operations } = setup({})
    const { result } = await runOne(investigation, call('shell', { command: '' }))

    expect({ result, operations }).toStrictEqual({
      result: { text: 'Invalid arguments for shell.', isError: true },
      operations: [],
    })
  })
})

const source = reviewSource(async () => {
  throw new Error('The route opened a copy.')
})

it.each([
  { query: tool, lookedUp: true },
  { query: { ...tool, forwarding: {} as NonNullable<PromptPermissionDetails['forwarding']> }, lookedUp: false },
  { query: { ...tool, source: 'skill_read' as const }, lookedUp: false },
  { query: { ...tool, toolCallId: '' }, lookedUp: false },
])('resolves only direct tool calls ($query.source, expected lookup: $lookedUp)', ({ query, lookedUp }) => {
  const findShellReviewSource = vi.fn(() => ({ ok: true, source }) as const)
  const investigation = new Investigation({ hasShellReviewRoute: () => true, findShellReviewSource })
  investigation.start(CONTEXT)
  const run = investigation.forReview(new AbortController().signal, query)

  expect({ queries: findShellReviewSource.mock.calls, outcome: run.outcome }).toStrictEqual({
    queries: lookedUp ? [[CONTEXT, { toolName: 'bash', toolCallId: 'call' }]] : [],
    outcome: lookedUp ? { kind: 'unused' } : { kind: 'unavailable', reason: 'no-call-route' },
  })
})
