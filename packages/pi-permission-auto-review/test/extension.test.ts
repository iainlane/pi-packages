import type { ExtensionAPI, ModelRegistry, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  AuthorizerLog,
  PermissionQuery,
  PermissionsReadyEvent,
  PermissionsService,
} from '@gotgenes/pi-permission-system'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildSessionProjection, getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  PERMISSIONS_READY_CHANNEL,
  publishPermissionsService,
  unpublishPermissionsService,
} from '@gotgenes/pi-permission-system'
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_ID } from '../src/config/config.js'
import { configPath } from '../src/config/store.js'
import permissionAutoReview from '../src/index.js'
import { STATISTICS_ENTRY_TYPE } from '../src/statistics/records.js'
import { GlobalStatisticsStore } from '../src/statistics/store.js'
import { permissionDetails, useWorkspace, writeFile } from './helpers.js'

const sandbox = vi.hoisted(() => ({ negotiation: undefined as unknown }))
vi.mock('pi-bring-your-own-sandbox/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  negotiateSandbox: async () =>
    sandbox.negotiation ?? {
      ok: true,
      policy: { workspaceAccess: 'read-only', filesystemScope: 'workspace-only', networkAccess: 'denied' },
    },
}))

type Handler = (...arguments_: unknown[]) => unknown
type Authorize = Authorizer['authorize']

const SESSION_ID = 'session-root'
const DENY = '{"outcome":"deny","rationale":"Not authorized."}'

describe('permission auto-review extension', () => {
  const workspace = useWorkspace()
  const published: [string, PermissionsService][] = []

  afterEach(() => {
    sandbox.negotiation = undefined
    for (const [sessionId, service] of published.splice(0)) {
      unpublishPermissionsService(sessionId, service)
    }
  })

  function publish(registerAuthorizer: PermissionsService['registerAuthorizer'], sessionId = SESSION_ID) {
    const service = { registerAuthorizer } as PermissionsService
    publishPermissionsService(sessionId, service)
    published.push([sessionId, service])
  }

  /** A registry whose every model answers `reply`, so a reviewer's decisions are observable */
  function reviewRegistry(reply: string) {
    const streamSimple = vi.fn((_model: unknown, _context: { systemPrompt: string }) => ({
      result: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0 },
      }),
    }))
    const registry = {
      getProvider: (id: string) => ({ id, getModels: () => [] }),
      find: (provider: string, id: string) => ({
        id,
        provider,
        api: 'openai-responses',
        reasoning: false,
        contextWindow: 200_000,
      }),
      getAll: () => [],
      streamSimple,
    } as unknown as ModelRegistry

    return { registry, streamSimple }
  }

  function start(registry: ModelRegistry = reviewRegistry(DENY).registry, projectTrusted = true) {
    const handlers = new Map<string, Handler[]>()
    const eventHandlers = new Map<string, Handler[]>()
    const commands = new Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>()
    const appendEntry = vi.fn<(type: string, data: unknown) => void>()
    const add = (target: Map<string, Handler[]>, name: string, handler: Handler): void => {
      target.set(name, [...(target.get(name) ?? []), handler])
    }
    const pi = {
      on: (name: string, handler: Handler) => add(handlers, name, handler),
      getAllTools: () => [],
      events: { on: (name: string, handler: Handler) => add(eventHandlers, name, handler) },
      registerCommand: (name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
        commands.set(name, options)
      },
      appendEntry,
      registerTool: vi.fn(),
    }
    permissionAutoReview(pi as unknown as ExtensionAPI)

    const emit = (name: string, ...arguments_: unknown[]): void => {
      for (const handler of handlers.get(name) ?? []) {
        handler(...arguments_)
      }
    }
    const setStatus = vi.fn()
    const context = {
      cwd: workspace.cwd,
      modelRegistry: registry,
      sessionManager: {
        getBranch: () => [],
        buildSessionProjection: () => buildSessionProjection([]),
        getSessionId: () => SESSION_ID,
        getLeafId: () => null,
        getEntries: () => [],
      },
      ui: { setStatus, notify: vi.fn() },
      hasUI: true,
      abort: vi.fn(),
      isProjectTrusted: () => projectTrusted,
    }
    const notify = vi.fn()

    return {
      emit,
      start: () => {
        emit('session_start', {}, context)
        emit(
          'tool_call',
          { type: 'tool_call', toolName: 'bash', toolCallId: 'call-1', input: { command: 'pnpm publish' } },
          context,
        )
      },
      shutdown: () => emit('session_shutdown', {}, context),
      /** Waits for the shutdown handlers, which let reviews in progress record their verdicts */
      shutdownAndWait: async () => {
        await Promise.all((handlers.get('session_shutdown') ?? []).map(handler => handler({}, context)))
      },
      appendEntry,
      setStatus,
      ready(sessionId: string | null = SESSION_ID) {
        for (const handler of eventHandlers.get(PERMISSIONS_READY_CHANNEL) ?? []) {
          handler({ sessionId, adjudicatesLocally: true } satisfies PermissionsReadyEvent)
        }
      },
      notify,
      async run(args: string) {
        await commands.get('permission-auto-review')?.handler(args, {
          ...context,
          mode: 'tui',
          hasUI: true,
          ui: { confirm: async () => true, notify },
          waitForIdle: async () => {},
        } as never)
      },
    }
  }

  async function review(authorize: Authorize | undefined) {
    const reviewLog = vi.fn<AuthorizerLog['review']>()
    const verdict = await authorize?.(permissionDetails({ toolCallId: 'call-1' }), {} as PermissionQuery, {
      review: reviewLog,
      debug: vi.fn(),
    })

    return { verdict, entry: reviewLog.mock.calls[0] }
  }

  it('registers once even though permissions:ready repeats', () => {
    const dispose = vi.fn()
    const registerAuthorizer = vi.fn(() => dispose)
    publish(registerAuthorizer)
    const harness = start()

    harness.start()
    expect(registerAuthorizer).not.toHaveBeenCalled()

    // Ready fires at session_start and again at the first before_agent_start
    harness.ready()
    harness.ready()
    expect(registerAuthorizer).toHaveBeenCalledExactlyOnceWith('auto-review', expect.any(Function))

    harness.shutdown()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('registers on the repeat emission when ready precedes session_start', () => {
    const registerAuthorizer = vi.fn(() => vi.fn())
    publish(registerAuthorizer)
    const harness = start()

    harness.ready()
    harness.start()
    expect(registerAuthorizer).not.toHaveBeenCalled()

    harness.ready()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
  })

  it('registers each node into the service keyed by its own session id', () => {
    const rootDispose = vi.fn()
    const childDispose = vi.fn()
    const rootRegister = vi.fn(() => rootDispose)
    const childRegister = vi.fn(() => childDispose)
    publish(rootRegister)
    publish(childRegister, 'session-subagent')
    const root = start()
    const child = start()
    root.start()
    child.start()

    root.ready()
    child.ready('session-subagent')
    expect(rootRegister).toHaveBeenCalledOnce()
    expect(childRegister).toHaveBeenCalledOnce()

    // Each instance holds its own handle, so a shutdown never disposes another node's registration
    child.shutdown()
    expect(childDispose).toHaveBeenCalledOnce()
    expect(rootDispose).not.toHaveBeenCalled()
  })

  it('warns once and stays unregistered when the node published no keyed service', () => {
    const registerAuthorizer = vi.fn(() => vi.fn())
    publish(registerAuthorizer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = start()

    harness.start()
    harness.ready(null)
    harness.ready(null)

    expect(registerAuthorizer).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('published no keyed service'))
    warn.mockRestore()
  })

  it('registers a defer-only reviewer when config is invalid', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { apiKey: 'not-allowed' })
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = start()

    harness.start()
    harness.ready()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config issue at'))
    warn.mockRestore()

    const { verdict, entry } = await review(registerAuthorizer.mock.calls[0]?.[1])
    expect(verdict).toEqual({ kind: 'defer' })
    expect(entry).toEqual(['auto_review.decision', expect.objectContaining({ errorCategory: 'config-invalid' })])
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review inactive: invalid config')
  })

  it('ignores the config of a project Pi does not trust, and warns that it does', async () => {
    writeFile(configPath(workspace.cwd, 'project'), { model: 'project-model' })
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = start(reviewRegistry(DENY).registry, false)

    harness.start()
    harness.ready()
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('is ignored until Pi trusts this project'))
    warn.mockRestore()

    expect((await review(registerAuthorizer.mock.calls[0]?.[1])).entry?.[1]).toMatchObject({
      model: 'codex-auto-review',
    })
  })

  it('shows in the footer whether the reviewer is registered and how it has decided', async () => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const harness = start()

    harness.start()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review inactive')
    harness.ready()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review ready')

    await review(registerAuthorizer.mock.calls[0]?.[1])
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review ready · 1 denied')

    harness.shutdown()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined)
  })

  it.each(['session_tree', 'session_compact', 'session_before_switch', 'session_before_fork'])(
    'cancels a review in progress on %s, then reviews the next ask',
    async event => {
      const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
      publish(registerAuthorizer)
      const { registry, streamSimple } = reviewRegistry(DENY)
      const { promise: requested, resolve: markRequested } = Promise.withResolvers<void>()
      streamSimple.mockImplementationOnce(() => {
        markRequested()
        return { result: async () => new Promise(() => {}) }
      })
      const harness = start(registry)
      harness.start()
      harness.ready()
      const authorize = registerAuthorizer.mock.calls[0]?.[1]

      const stalled = review(authorize)
      await requested
      harness.emit(event, {}, {})
      const cancelled = await stalled
      const next = await review(authorize)

      expect({
        cancelled: [cancelled.verdict?.kind, cancelled.entry?.[1]?.['errorCategory']],
        next: next.verdict?.kind,
      }).toStrictEqual({ cancelled: ['deny', 'cancelled'], next: 'deny' })
    },
  )

  it('resets the circuit when the next agent run starts or the run settles, not at each turn', async () => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const harness = start()
    harness.start()
    harness.ready()
    const authorize = registerAuthorizer.mock.calls[0]?.[1]
    const trip = async (): Promise<void> => {
      for (let denial = 0; denial < 3; denial += 1) {
        await review(authorize)
      }
    }
    const event = async (): Promise<unknown> => (await review(authorize)).entry?.[0]

    await trip()
    harness.emit('turn_start', {}, {})
    const afterTurn = await event()
    harness.emit('before_agent_start', { systemPromptOptions: {} }, { isProjectTrusted: () => true })
    const afterRun = await event()
    await trip()
    harness.emit('agent_settled', {}, {})
    const afterSettled = await event()

    expect([afterTurn, afterRun, afterSettled]).toStrictEqual([
      'auto_review.circuit_open',
      'auto_review.decision',
      'auto_review.decision',
    ])
  })

  it.each([
    {
      preset: 'codex',
      status: 'auto-review ready · no investigation: the selected sandbox cannot satisfy the requested policy',
      warnings: [
        [
          `[${EXTENSION_ID}] the reviewer cannot investigate local state: the selected sandbox cannot satisfy the requested policy`,
        ],
      ],
    },
    { preset: 'claude-code', status: 'auto-review ready', warnings: [] },
  ])('shows in the footer when the $preset reviewer cannot investigate', async ({ preset, status, warnings }) => {
    writeFile(configPath(workspace.cwd, 'global'), { preset })
    sandbox.negotiation = { ok: false, error: new UnsupportedSandboxPolicyError({ operation: 'acquire' }) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    publish(vi.fn(() => vi.fn()))
    const harness = start()
    harness.start()
    harness.ready()

    await vi.waitFor(() => expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, status))
    expect(warn.mock.calls).toStrictEqual(warnings)
  })

  it('records a review that shutdown cancels in the session, and its late result only globally', async () => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const { registry, streamSimple } = reviewRegistry(DENY)
    const late = Promise.withResolvers<unknown>()
    const requested = Promise.withResolvers<void>()
    streamSimple.mockImplementationOnce(() => {
      requested.resolve()

      return { result: async () => late.promise as never }
    })
    const harness = start(registry)
    harness.start()
    harness.ready()
    const verdict = review(registerAuthorizer.mock.calls[0]?.[1])
    await requested.promise
    const written = (): unknown[][] =>
      harness.appendEntry.mock.calls.map(([type, data]) => [type, (data as { outcome?: string }).outcome])

    await harness.shutdownAndWait()
    const atShutdown = written()
    late.resolve({
      role: 'assistant',
      content: [{ type: 'text', text: DENY }],
      stopReason: 'stop',
      usage: { input: 70, output: 7, cacheRead: 0, cacheWrite: 0 },
    })
    const directory = join(getAgentDir(), 'extensions', EXTENSION_ID, 'statistics')
    const global = await vi.waitFor(
      () => {
        const store = GlobalStatisticsStore.open(directory, 0)
        const { summary } = store.snapshot()
        store.close()
        expect(summary.tokens.input).toBe(70)

        return summary
      },
      { timeout: 3_000 },
    )

    expect({
      verdict: (await verdict).verdict?.kind,
      atShutdown,
      afterLateResult: written(),
      global: { reviews: global.reviews, unreported: global.unreportedCalls, issues: global.issues },
    }).toStrictEqual({
      verdict: 'deny',
      atShutdown: [[STATISTICS_ENTRY_TYPE, 'deny']],
      afterLateResult: [[STATISTICS_ENTRY_TYPE, 'deny']],
      global: { reviews: { allow: 0, deny: 1, defer: 0 }, unreported: 0, issues: { 'recorded-after-session': 1 } },
    })
  })

  it.each([
    { failure: 'logging', verdict: 'deny' },
    { failure: 'statistics', verdict: 'deny' },
    { failure: 'footer', verdict: 'deny' },
    { failure: 'model registry', verdict: 'defer' },
  ])('answers once with the right verdict when the $failure throws', async ({ failure, verdict }) => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const { registry } = reviewRegistry(DENY)
    if (failure === 'model registry') {
      Object.assign(registry, {
        getProvider: () => {
          throw new Error('registry failed')
        },
      })
    }
    const harness = start(registry)
    harness.start()
    harness.ready()
    if (failure === 'statistics') {
      harness.appendEntry.mockImplementation(() => {
        throw new Error('append failed')
      })
    }
    if (failure === 'footer') {
      harness.setStatus.mockImplementation(() => {
        throw new Error('footer failed')
      })
    }
    const authorize = registerAuthorizer.mock.calls[0]?.[1]
    const broken = (): never => {
      throw new Error('log failed')
    }
    const log =
      failure === 'logging' ? { review: vi.fn(broken), debug: vi.fn(broken) } : { review: vi.fn(), debug: vi.fn() }
    const answer = await authorize?.(permissionDetails({ toolCallId: 'call-1' }), {} as PermissionQuery, log)

    expect(answer?.kind).toBe(verdict)
  })

  it('hot-swaps the reviewer generation after a config reset, closing the circuit', async () => {
    const global = configPath(workspace.cwd, 'global')
    writeFile(global, { model: 'old-review-model' })
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const registerAuthorizer = vi
      .fn<(name: string, authorize: Authorize) => () => void>()
      .mockReturnValueOnce(firstDispose)
      .mockReturnValueOnce(secondDispose)
    publish(registerAuthorizer)
    const { registry, streamSimple } = reviewRegistry(DENY)
    const harness = start(registry)
    harness.start()
    harness.ready()

    const first = registerAuthorizer.mock.calls[0]?.[1]
    for (let denial = 0; denial < 3; denial += 1) {
      expect((await review(first)).entry?.[1]).toMatchObject({ model: 'old-review-model', outcome: 'deny' })
    }
    expect((await review(first)).entry?.[0]).toBe('auto_review.circuit_open')
    expect(streamSimple).toHaveBeenCalledTimes(3)

    await harness.run('reset global')

    expect(existsSync(global)).toBe(false)
    expect(firstDispose).toHaveBeenCalledOnce()
    const second = registerAuthorizer.mock.calls[1]?.[1]
    expect((await review(second)).entry?.[1]).toMatchObject({ model: 'codex-auto-review', outcome: 'deny' })
    expect(streamSimple).toHaveBeenCalledTimes(4)

    harness.shutdown()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  // Pi loads a project's context files even before it trusts the project
  it('shows the claude-code reviewer the global context file, and project ones only once Pi trusts the project', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { preset: 'claude-code' })
    const { registry, streamSimple } = reviewRegistry('<block>no</block>')
    const registerAuthorizer = vi.fn<PermissionsService['registerAuthorizer']>(() => vi.fn())
    publish(registerAuthorizer)
    const harness = start(registry)
    harness.start()
    harness.ready()
    const authorize = registerAuthorizer.mock.calls[0]?.[1]
    const contextFiles = [
      { path: join(getAgentDir(), 'AGENTS.md'), content: 'Global conventions.' },
      { path: join(workspace.cwd, 'AGENTS.md'), content: 'Project conventions.' },
    ]
    for (const projectTrusted of [false, true]) {
      harness.emit(
        'before_agent_start',
        { systemPromptOptions: { contextFiles } },
        { isProjectTrusted: () => projectTrusted },
      )
      await review(authorize)
    }
    const [untrusted, trusted] = streamSimple.mock.calls.map(([, context]) => context.systemPrompt)

    expect(untrusted).toContain('Global conventions.')
    expect(untrusted).not.toContain('Project conventions.')
    expect(trusted).toContain('Project conventions.')
  })

  it('preserves the old reviewer when reset leaves the merged config invalid', async () => {
    const global = configPath(workspace.cwd, 'global')
    const project = configPath(workspace.cwd, 'project')
    writeFile(global, { reasoning: 'high' })
    writeFile(project, { followUpReviews: 'off' })
    const firstDispose = vi.fn()
    const registerAuthorizer = vi.fn(() => firstDispose)
    publish(registerAuthorizer)
    const harness = start()
    harness.start()
    harness.ready()
    writeFile(project, { reasoning: 'loud' })

    await harness.run('reset global')

    expect(existsSync(global)).toBe(false)
    expect(firstDispose).not.toHaveBeenCalled()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('the merged config is invalid; the previous reviewer remains active'),
      'error',
    )
  })

  it('reports a failed swap and retries the new generation at the next ready', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { reasoning: 'high' })
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const registerAuthorizer = vi
      .fn<(name: string, authorize: Authorize) => () => void>()
      .mockReturnValueOnce(firstDispose)
      .mockImplementationOnce(() => {
        throw new Error('candidate rejected')
      })
      .mockReturnValueOnce(secondDispose)
    publish(registerAuthorizer)
    const harness = start()
    harness.start()
    harness.ready()

    await harness.run('reset global')

    // The old link is released before the new one is offered, so a rejected registration leaves no link at
    // all rather than a reviewer running the superseded config
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('could not be registered'), 'error')

    harness.ready()
    const [first, rejected, retried] = registerAuthorizer.mock.calls.map(([, authorize]) => authorize)
    expect(retried).toBe(rejected)
    expect(retried).not.toBe(first)

    harness.shutdown()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('keeps a saved generation pending until permission-system becomes ready', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { model: 'old-review-model' })
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    const harness = start()
    harness.start()

    await harness.run('reset global')
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('will activate when pi-permission-system is ready'),
      'warning',
    )

    publish(registerAuthorizer)
    harness.ready()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect((await review(registerAuthorizer.mock.calls[0]?.[1])).entry?.[1]).toMatchObject({
      model: 'codex-auto-review',
    })
  })
})
