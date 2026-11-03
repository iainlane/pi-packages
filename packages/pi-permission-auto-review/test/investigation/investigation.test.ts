import type { ToolCall } from '@earendil-works/pi-ai'
import type { FileStat, ProcessResult, Sandbox, SandboxNegotiation } from 'pi-bring-your-own-sandbox/api'
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/api'
import { describe, expect, it } from 'vitest'
import { Investigation, INVESTIGATION_REQUIREMENTS } from '../../src/investigation/investigation.js'

const CONTEXT = { cwd: '/home/user/repo', sessionManager: {} } as never
const RESTRICTED = { workspaceAccess: 'read-only', filesystemScope: 'workspace-only', networkAccess: 'denied' } as const
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

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

/** Records each sandbox operation in order, as `open`, `exec <command>`, `stat <path>` or `read <path>` */
function setup(options: { negotiation?: SandboxNegotiation; sandbox?: FakeSandbox; acquire?: () => Promise<Sandbox> }) {
  const operations: string[] = []
  const negotiated: unknown[][] = []
  const requests: unknown[][] = []
  const fake = options.sandbox ?? {}
  const sandbox = {
    workspace: { root: '/project', pathFlavor: 'posix' },
    exec: async (request: { command: string }, execOptions: object) => {
      operations.push(`exec ${request.command}`)
      requests.push([request, { ...execOptions, signal: 'signal' }])
      return (fake.exec ?? (async () => processResult('')))(request, execOptions)
    },
    files: {
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
  const investigation = new Investigation({} as never, {
    negotiateSandbox: async (...args: unknown[]) => {
      negotiated.push(args)
      return options.negotiation ?? { ok: true as const, policy: RESTRICTED }
    },
    getSandbox: async () => {
      operations.push('open')
      return (options.acquire ?? (async () => sandbox as unknown as Sandbox))()
    },
  })
  investigation.start(CONTEXT)

  return { investigation, operations, negotiated, requests }
}

function call(name: string, args: ToolCall['arguments'], id = `call-${name}`): ToolCall {
  return { type: 'toolCall', id, name, arguments: args }
}

async function runOne(investigation: Investigation, toolCall: ToolCall) {
  const run = investigation.forReview(new AbortController().signal)
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
  it('negotiates the restricted sandbox at session start without opening one', async () => {
    const { investigation, operations, negotiated } = setup({})

    expect({ availability: await investigation.availability(), negotiated, operations }).toStrictEqual({
      availability: { available: true },
      negotiated: [[{}, CONTEXT, INVESTIGATION_REQUIREMENTS]],
      operations: [],
    })
  })

  it('reports why investigation is unavailable when the configured sandbox cannot meet the requirements', async () => {
    const { investigation } = setup({
      negotiation: {
        ok: false,
        error: new UnsupportedSandboxPolicyError({ operation: 'acquire', providerId: 'passthrough' }),
      },
    })

    expect(await investigation.availability()).toStrictEqual({
      available: false,
      reason: 'the selected sandbox cannot satisfy the requested policy',
    })
  })

  it('runs a shell command in the sandbox once, with bounded time and output, and counts the raw output', async () => {
    const { investigation, operations, requests } = setup({
      sandbox: { exec: async () => processResult('main\n', 'warning: é\n', 0) },
    })
    const run = investigation.forReview(new AbortController().signal)
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
      operations: ['open', 'exec git branch --show-current', 'exec git status'],
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

  it('reads the selected lines of a UTF-8 file, mapping a path in the host workspace to the target', async () => {
    const { investigation, operations } = setup({
      sandbox: {
        files: {
          stat: async () => ({ kind: 'file', size: 20 }),
          readFile: async () => encode('one\ntwo\nthree\nfour\n'),
        },
      },
    })
    const { result } = await runOne(
      investigation,
      call('read', { path: '/home/user/repo/src/a.ts', offset: 2, limit: 2 }),
    )

    expect({ result, operations }).toStrictEqual({
      result: { text: 'two\nthree', isError: false },
      operations: ['open', 'stat /project/src/a.ts', 'read /project/src/a.ts'],
    })
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
      operations: ['open', 'stat data.bin', ...(read ? ['read data.bin'] : [])],
    })
  })

  it('stops running calls once the review has made eight, and reports the budget as exhausted', async () => {
    const { investigation, operations } = setup({})
    const run = investigation.forReview(new AbortController().signal)
    const results = await run.run(
      Array.from({ length: 9 }, (_, index) => call('shell', { command: `echo ${index}` }, `${index}`)),
    )

    expect({ operations, last: results.at(-1)?.content, exhausted: run.exhausted }).toStrictEqual({
      operations: ['open', ...Array.from({ length: 8 }, (_, index) => `exec echo ${index}`)],
      last: [{ type: 'text', text: 'Not run: the investigation budget for this review is exhausted.' }],
      exhausted: true,
    })
  })

  it('stops once the raw output reaches 64 KiB', async () => {
    const { investigation, operations } = setup({
      sandbox: { exec: async () => processResult('x'.repeat(32 * 1024)) },
    })
    const run = investigation.forReview(new AbortController().signal)
    await run.run([0, 1, 2].map(index => call('shell', { command: 'cat big' }, `${index}`)))

    expect({ operations, bytes: run.bytes, exhausted: run.exhausted }).toStrictEqual({
      operations: ['open', 'exec cat big', 'exec cat big'],
      bytes: 64 * 1024,
      exhausted: true,
    })
  })

  it('disables investigation for the session when the opened sandbox cannot meet the requirements', async () => {
    const { investigation, operations } = setup({
      acquire: async () => {
        throw new UnsupportedSandboxPolicyError({ operation: 'acquire', providerId: 'fixture' })
      },
    })
    const { run, result } = await runOne(investigation, call('shell', { command: 'ls' }))

    expect({
      result: result.isError,
      exhausted: run.exhausted,
      availability: (await investigation.availability()).available,
      operations,
    }).toStrictEqual({ result: true, exhausted: true, availability: false, operations: ['open'] })
  })

  it('disables investigation for the review only when acquisition fails otherwise', async () => {
    const { investigation, operations } = setup({
      acquire: async () => {
        throw new Error('provider start failed')
      },
    })
    const first = await runOne(investigation, call('shell', { command: 'ls' }))
    await runOne(investigation, call('shell', { command: 'ls' }))

    expect({
      exhausted: first.run.exhausted,
      availability: (await investigation.availability()).available,
      operations,
    }).toStrictEqual({ exhausted: true, availability: true, operations: ['open', 'open'] })
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
