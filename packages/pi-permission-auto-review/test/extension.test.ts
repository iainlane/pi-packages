import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry, RegisteredCommand, SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  AuthorizerLog,
  PermissionQuery,
  PermissionsReadyEvent,
  PermissionsService,
} from '@gotgenes/pi-permission-system'
import type {
  ReviewUnavailableReason,
  EscalationRequest,
  SandboxCopy,
  SandboxClient,
  SandboxErrorInfo,
  ShellReviewLookup,
  ShellReviewSource,
} from 'pi-bring-your-own-sandbox/consumer'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { buildSessionProjection, getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  PERMISSIONS_READY_CHANNEL,
  publishPermissionsService,
  unpublishPermissionsService,
} from '@gotgenes/pi-permission-system'
import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inputDigest } from '../src/action/json.js'
import { EXTENSION_ID } from '../src/config/config.js'
import { configPath } from '../src/config/store.js'
import permissionAutoReview from '../src/index.js'
import { POLICY_REVISION } from '../src/presets/codex/policy.js'
import { PRESETS } from '../src/presets/presets.js'
import { STATISTICS_ENTRY_TYPE } from '../src/statistics/records.js'
import { GlobalStatisticsStore } from '../src/statistics/store.js'
import { truncateToCharacters } from '../src/text.js'
import {
  investigationReply,
  permissionDetails,
  reply,
  reviewSource,
  reviewWorkspace,
  useWorkspace,
  writeFile,
} from './helpers.js'

vi.mock(import('pi-bring-your-own-sandbox/consumer'), async importOriginal => ({
  ...(await importOriginal()),
  createSandboxClient: vi.fn(),
}))

let hasRoute = true

type Handler = (...arguments_: unknown[]) => unknown
type Authorize = Authorizer['authorize']

const SESSION_ID = 'session-root'
const DENY = '{"outcome":"deny","rationale":"Not authorized."}'

describe('permission auto-review extension', () => {
  const workspace = useWorkspace()
  const published: [string, PermissionsService][] = []
  const shutdowns: (() => Promise<void>)[] = []

  afterEach(async () => {
    await Promise.all(shutdowns.splice(0).map(async shutdown => shutdown()))
    hasRoute = true
    for (const [sessionId, service] of published.splice(0)) {
      unpublishPermissionsService(sessionId, service)
    }
  })

  function publish(
    registerAuthorizer: PermissionsService['registerAuthorizer'],
    sessionId = SESSION_ID,
    registerToolInputFormatter: PermissionsService['registerToolInputFormatter'] = () => () => {},
  ) {
    const service = { registerAuthorizer, registerToolInputFormatter } as PermissionsService
    publishPermissionsService(sessionId, service)
    published.push([sessionId, service])
  }

  /** A registry whose every model answers `reply`, so a reviewer's decisions are observable */
  function reviewRegistry(verdict: string) {
    const streamSimple = vi.fn((_model: unknown, _context: { systemPrompt: string; tools?: unknown }) => ({
      result: async (): Promise<AssistantMessage> =>
        reply(verdict, 'stop', { input: 0, output: 0, cacheRead: 0, totalTokens: 0 }),
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

  function start(
    registry: ModelRegistry = reviewRegistry(DENY).registry,
    projectTrusted = true,
    route?: Pick<ShellReviewSource, 'copy'> | ShellReviewLookup,
  ) {
    const handlers = new Map<string, Handler[]>()
    const eventHandlers = new Map<string, Handler[]>()
    const commands = new Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>()
    const appendEntry = vi.fn<(type: string, data: unknown) => void>()
    const recordEscalationDecision = vi.fn<SandboxClient['recordEscalationDecision']>()
    const findShellReviewSource = vi.fn<SandboxClient['findShellReviewSource']>(() =>
      route === undefined
        ? { ok: false, reason: 'unknown-call' }
        : 'ok' in route
          ? route
          : { ok: true, source: reviewSource(route.copy) },
    )
    const add = (target: Map<string, Handler[]>, name: string, handler: Handler): void => {
      target.set(name, [...(target.get(name) ?? []), handler])
    }
    const pi = {
      on: (name: string, handler: Handler) => add(handlers, name, handler),
      getAllTools: () => [],
      events: {
        on: (name: string, handler: Handler) => add(eventHandlers, name, handler),
        emit: vi.fn(),
      },
      registerCommand: (name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
        commands.set(name, options)
      },
      appendEntry,
      registerTool: vi.fn(),
    }
    vi.mocked(createSandboxClient).mockReturnValue({
      get: vi.fn(),
      negotiate: vi.fn(),
      hasShellReviewRoute: () => hasRoute,
      findShellReviewSource,
      recordEscalationDecision,
    })
    permissionAutoReview(pi as unknown as ExtensionAPI)

    const emit = (name: string, ...arguments_: unknown[]): void => {
      for (const handler of handlers.get(name) ?? []) {
        handler(...arguments_)
      }
    }
    const setStatus = vi.fn()
    const sessionEntries: SessionEntry[] = []
    const context = {
      cwd: workspace.cwd,
      modelRegistry: registry,
      sessionManager: {
        getBranch: () => [],
        buildSessionProjection: () => buildSessionProjection([]),
        getSessionId: () => SESSION_ID,
        getLeafId: () => null,
        getEntries: () => sessionEntries,
      },
      ui: { setStatus, notify: vi.fn() },
      hasUI: true,
      abort: vi.fn(),
      isProjectTrusted: () => projectTrusted,
    }
    const notify = vi.fn()
    let ending: Promise<void> | undefined
    const shutdownAndWait = async (): Promise<void> => {
      ending ??= Promise.all((handlers.get('session_shutdown') ?? []).map(handler => handler({}, context))).then(
        () => {},
      )
      return ending
    }
    shutdowns.push(shutdownAndWait)

    return {
      emit,
      start: (input: Record<string, unknown> = { command: 'pnpm publish' }) => {
        emit('session_start', {}, context)
        emit('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 'call-1', input }, context)
      },
      shutdown: () => void shutdownAndWait(),
      shutdownAndWait,
      appendEntry,
      sessionEntries,
      recordEscalationDecision,
      findShellReviewSource,
      setStatus,
      ready(sessionId: string | null = SESSION_ID) {
        for (const handler of eventHandlers.get(PERMISSIONS_READY_CHANNEL) ?? []) {
          handler({ sessionId, adjudicatesLocally: true } satisfies PermissionsReadyEvent)
        }
      },
      notify,
      async run(args: string, command = 'permission-auto-review', hasUI = true) {
        await commands.get(command)?.handler(args, {
          ...context,
          mode: hasUI ? 'tui' : 'print',
          hasUI,
          ui: { confirm: async () => true, notify },
          waitForIdle: async () => {},
        } as never)
      },
    }
  }

  async function review(authorize: Authorize | undefined, toolCallId = 'call-1') {
    const reviewLog = vi.fn<AuthorizerLog['review']>()
    const verdict = await authorize?.(permissionDetails({ toolCallId }), {} as PermissionQuery, {
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

  it('registers the PowerShell formatter once per service and disposes it on replacement and shutdown', () => {
    const disposeFirst = vi.fn()
    const disposeSecond = vi.fn()
    const registerFirst = vi.fn<PermissionsService['registerToolInputFormatter']>(() => disposeFirst)
    const registerSecond = vi.fn<PermissionsService['registerToolInputFormatter']>(() => disposeSecond)
    const registerAuthorizer = vi.fn(() => vi.fn())
    publish(registerAuthorizer, SESSION_ID, registerFirst)
    const harness = start()
    harness.start()
    harness.ready()
    harness.ready()

    const ordinaryPreview = registerFirst.mock.calls[0]?.[1]({ command: 'Write-Output fixture' })
    publish(registerAuthorizer, SESSION_ID, registerSecond)
    harness.ready()
    const disposalsBeforeShutdown = [disposeFirst.mock.calls.length, disposeSecond.mock.calls.length]
    harness.shutdown()

    expect({
      first: registerFirst.mock.calls,
      second: registerSecond.mock.calls,
      ordinaryPreview,
      disposalsBeforeShutdown,
      disposals: [disposeFirst.mock.calls, disposeSecond.mock.calls],
    }).toStrictEqual({
      first: [['powershell', expect.any(Function)]],
      second: [['powershell', expect.any(Function)]],
      ordinaryPreview: undefined,
      disposalsBeforeShutdown: [1, 0],
      disposals: [[[]], [[]]],
    })
  })

  it('reports a conflicting PowerShell formatter once per session', () => {
    const register = vi.fn<PermissionsService['registerToolInputFormatter']>(() => {
      throw new Error('A tool input formatter is already registered.')
    })
    publish(
      vi.fn(() => vi.fn()),
      SESSION_ID,
      register,
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const harness = start()
      harness.start()
      harness.ready()
      harness.ready()

      expect({ registrations: register.mock.calls, warnings: warn.mock.calls }).toStrictEqual({
        registrations: [['powershell', expect.any(Function)]],
        warnings: [
          [
            `[${EXTENSION_ID}] failed to register the PowerShell escalation formatter: A tool input formatter is already registered.`,
          ],
        ],
      })
    } finally {
      warn.mockRestore()
    }
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

  it('reports registration and observed selection in the footer and statistics', async () => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const harness = start()

    harness.start()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review unregistered')
    harness.ready()
    await harness.run('', 'auto-stats')
    const registered = {
      footer: harness.setStatus.mock.lastCall,
      report: String(harness.notify.mock.lastCall?.[0])
        .split('\n')
        .find(line => line.startsWith('The reviewer')),
    }

    await review(registerAuthorizer.mock.calls[0]?.[1])
    await harness.run('', 'auto-stats')
    const selected = {
      footer: harness.setStatus.mock.lastCall,
      report: String(harness.notify.mock.lastCall?.[0])
        .split('\n')
        .find(line => line.startsWith('The permission system')),
    }
    expect({ registered, selected }).toStrictEqual({
      registered: {
        footer: [EXTENSION_ID, 'auto-review registered · no asks observed · check authorizerChain'],
        report:
          'The reviewer is registered. No permission asks have reached it in this session. To review permission asks, add auto-review to authorizerChain.',
      },
      selected: {
        footer: [
          EXTENSION_ID,
          'auto-review selected · ask observed · 1 denied · last review could not find its pending shell call',
        ],
        report: 'The permission system selected the reviewer for an ask in this session.',
      },
    })

    harness.shutdown()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined)
  })

  it('reports the setup action when a local ask arrives without a capture', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(register)
    const harness = start()
    harness.start()
    harness.ready()
    const { verdict } = await review(register.mock.calls[0]?.[1], 'uncaptured')
    await harness.run('', 'auto-stats')

    expect({
      verdict,
      footer: harness.setStatus.mock.lastCall,
      report: String(harness.notify.mock.lastCall?.[0])
        .split('\n')
        .find(line => line.startsWith('A permission ask')),
    }).toStrictEqual({
      verdict: { kind: 'defer' },
      footer: [EXTENSION_ID, 'auto-review selected · ask arrived before capture · load auto-review first · 1 deferred'],
      report:
        'A permission ask reached the reviewer without a tool capture. Load auto-review before pi-permission-system.',
    })
  })

  it('retires the reviewer when clearing the footer throws at shutdown', async () => {
    const dispose = vi.fn()
    publish(vi.fn<PermissionsService['registerAuthorizer']>().mockReturnValue(dispose))
    const harness = start()
    harness.start()
    harness.ready()
    harness.setStatus.mockImplementation((_id: string, status: string | undefined) => {
      if (status === undefined) throw new Error('footer failed')
    })

    const shutdown = await harness.shutdownAndWait().then(
      () => 'finished',
      (error: unknown) => error,
    )

    expect({
      shutdown,
      disposed: dispose.mock.calls,
      footer: harness.setStatus.mock.lastCall,
      footerResult: harness.setStatus.mock.results.at(-1)?.type,
    }).toStrictEqual({
      shutdown: 'finished',
      disposed: [[]],
      footer: [EXTENSION_ID, undefined],
      footerResult: 'throw',
    })
  })

  function reviewCopy(): SandboxCopy {
    return {
      sandbox: {
        ...reviewWorkspace,
        exec: async () => ({
          exit: { kind: 'code', code: 0 },
          stdout: new TextEncoder().encode('ok'),
          stderr: new Uint8Array(),
          omittedBytes: { stdout: 0, stderr: 0 },
          durationMs: 1,
        }),
      },
      close: async () => ({ confirmed: true, recoveries: [], failures: [] }),
    }
  }

  it.each([
    {
      args: '',
      expected:
        'call-1 · allow · The user approved the command.\ncall-2 · deny · "Flagged \\u001b[2J\\n\\u202e"\nSkipped 2 unreadable escalation decisions.',
      severity: 'warning',
    },
    {
      args: 'call-2',
      expected: 'call-2 · deny · "Flagged \\u001b[2J\\n\\u202e"\nSkipped 2 unreadable escalation decisions.',
      severity: 'warning',
    },
    {
      args: 'missing',
      expected:
        'No matching auto-review escalation decisions in this session.\nSkipped 2 unreadable escalation decisions.',
      severity: 'warning',
    },
    { args: 'call-1 call-2', expected: 'Usage: /auto-escalations [tool-call-id]', severity: 'warning' },
  ])('lists session escalation decisions for arguments "$args"', async ({ args, expected, severity }) => {
    const harness = start()
    const customType = 'pi-permission-auto-review:escalation-decision.v1'
    harness.sessionEntries.push(
      ...[
        { customType, data: { toolCallId: 'call-1', verdict: 'allow', rationale: 'The user approved the command.' } },
        { customType, data: { toolCallId: 'call-2', verdict: 'deny', rationale: 'Flagged \u001B[2J\n\u202E' } },
        { customType, data: { toolCallId: 'bad-record', verdict: 'defer', rationale: 'Malformed decision.' } },
        { customType, data: null },
        {
          customType: 'another-extension',
          data: { toolCallId: 'other-call', verdict: 'deny', rationale: 'Different log.' },
        },
        { customType: 'another-extension', data: null },
      ].map(({ customType, data }, index): SessionEntry => ({
        type: 'custom',
        id: `entry-${index}`,
        parentId: null,
        timestamp: '2026-11-26T00:00:00.000Z',
        customType,
        data,
      })),
    )
    await harness.run(args, 'auto-escalations')

    expect(harness.notify.mock.calls).toStrictEqual([[expected, severity]])
  })

  it('prints escalation command output to stderr in print mode', async () => {
    const harness = start()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await harness.run('', 'auto-escalations', false)

      expect({ stderr: stderr.mock.calls, ui: harness.notify.mock.calls }).toStrictEqual({
        stderr: [['No matching auto-review escalation decisions in this session.\n']],
        ui: [],
      })
    } finally {
      stderr.mockRestore()
    }
  })

  function escalationFixture() {
    const input = { command: 'pnpm publish', escalate: ['network'], justification: 'Use the network for upload.' }
    const escalation: EscalationRequest = {
      toolCallId: 'call-1',
      command: input.command,
      access: { network: 'needed' },
      justification: input.justification,
      destination: {
        kind: 'provider',
        providerId: 'fixture',
        effectiveRestrictions: 'Fixture policy',
        policy: reviewWorkspace.policy,
      },
    }
    return { input, escalation, source: { ...reviewSource(async () => reviewCopy()), escalation } }
  }

  it('does not record a denial when the preset asks the user at its limit', async () => {
    const factory = vi.spyOn(PRESETS.codex, 'createLimiter').mockReturnValue({
      limitAction: 'prompt',
      refusal: () => undefined,
      recordDenial: () => 'consecutive',
      recordNonDenial: () => {},
      resetTurn: () => {},
    })
    try {
      const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
      publish(register)
      const { input, source } = escalationFixture()
      const harness = start(undefined, true, { ok: true, source })
      harness.start(input)
      harness.ready()
      const { verdict, entry } = await review(register.mock.calls[0]?.[1])

      expect({
        verdict,
        decisions: harness.recordEscalationDecision.mock.calls,
        denialLimit: entry?.[1]?.['denialLimit'],
      }).toStrictEqual({
        verdict: { kind: 'defer' },
        decisions: [],
        denialLimit: 'consecutive',
      })
    } finally {
      factory.mockRestore()
    }
  })

  it.each(['allow', 'deny'] as const)('logs the rationale and call ID for an escalation %s', async outcome => {
    const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(register)
    const { input, source } = escalationFixture()
    const rationale = 'The review considered the requested network access.'
    const { registry } = reviewRegistry(JSON.stringify({ outcome, rationale }))
    const harness = start(registry, true, { ok: true, source })
    harness.start(input)
    harness.ready()
    const { entry } = await review(register.mock.calls[0]?.[1])

    expect(entry).toStrictEqual([
      'auto_review.decision',
      {
        actionDigest: inputDigest(input),
        actionKind: 'shell',
        answersOmitted: 0,
        attempts: 1,
        authorityEdited: false,
        authorityFits: true,
        contextSource: 'active-branch',
        durationMs: expect.any(Number) as unknown,
        escalationRationale: rationale,
        imagesOmitted: 0,
        model: 'codex-auto-review',
        outcome,
        policyRevision: POLICY_REVISION,
        priorReviews: 0,
        provenanceUncertain: false,
        provider: 'openai',
        requestId: 'request-1',
        riskLevel: outcome === 'allow' ? 'low' : 'high',
        toolCallId: 'call-1',
        usage: { cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, input: 0, output: 0 },
        userApproval: 'unknown',
      },
    ])
  })

  it('keeps a bounded session record when the reviewer sends a long rationale', async () => {
    const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(register)
    const { input, source } = escalationFixture()
    const rationale = `${'a'.repeat(3_000)}${'b'.repeat(3_000)}`
    const { registry } = reviewRegistry(JSON.stringify({ outcome: 'allow', rationale }))
    const harness = start(registry, true, { ok: true, source })
    harness.start(input)
    harness.ready()
    const { verdict } = await review(register.mock.calls[0]?.[1])

    expect({
      verdict,
      ledger: harness.appendEntry.mock.calls.filter(
        ([type]) => type === 'pi-permission-auto-review:escalation-decision.v1',
      ),
    }).toStrictEqual({
      verdict: { kind: 'allow' },
      ledger: [
        [
          'pi-permission-auto-review:escalation-decision.v1',
          { toolCallId: 'call-1', verdict: 'allow', rationale: truncateToCharacters(rationale, 4_000) },
        ],
      ],
    })
  })

  it.each([
    { scenario: 'Claude Code preset', error: 'escalation-preset-deferred', reviews: 0, submissions: 0 },
    { scenario: 'SDK rejects the decision', error: 'escalation-record-failed', reviews: 1, submissions: 1 },
    { scenario: 'missing broker source', error: 'escalation-source-unavailable', reviews: 0, submissions: 0 },
    { scenario: 'session moves during copy cleanup', error: 'escalation-review-stale', reviews: 2, submissions: 0 },
    { scenario: 'the reviewer omits its rationale', error: 'invalid-response', reviews: 3, submissions: 0 },
  ])('defers an escalation when $scenario', async ({ scenario, error, reviews, submissions }) => {
    if (scenario === 'Claude Code preset') {
      writeFile(configPath(workspace.cwd, 'global'), { preset: 'claude-code' })
    }
    const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(register)
    const { registry, streamSimple } = reviewRegistry(
      scenario === 'the reviewer omits its rationale'
        ? '{"outcome":"allow"}'
        : '{"outcome":"allow","rationale":"The user permitted the action."}',
    )
    const input = {
      command: 'pnpm publish',
      escalate: ['network', { read: ['fixture.json'] }],
      justification: 'Use the network for upload.',
    }
    const escalation: EscalationRequest = {
      toolCallId: 'call-1',
      command: input.command,
      access: { network: 'needed', paths: { read: ['fixture.json'] } },
      justification: input.justification,
      destination: { kind: 'host', effectiveRestrictions: 'none', policy: reviewWorkspace.policy },
    }
    const close = vi.fn<SandboxCopy['close']>(reviewCopy().close)
    const copy = async (): Promise<SandboxCopy> => ({ ...reviewCopy(), close })
    const harness = start(
      registry,
      true,
      scenario === 'missing broker source'
        ? { ok: false, reason: 'destination-unavailable' }
        : { ok: true, source: { ...reviewSource(copy), escalation } },
    )
    if (scenario === 'SDK rejects the decision') {
      harness.recordEscalationDecision.mockImplementationOnce(() => {
        throw Object.assign(new Error('The pending call has expired.'), {
          name: 'InvalidSandboxRequestError',
          operation: 'exec',
        })
      })
    }
    if (scenario === 'session moves during copy cleanup') {
      streamSimple.mockReturnValueOnce({ result: async () => investigationReply('shell', { command: 'pwd' }) })
      close.mockImplementationOnce(async () => {
        harness.emit('session_tree', {}, {})
        return { confirmed: true, recoveries: [], failures: [] }
      })
    }
    harness.start(input)
    harness.ready()
    const { verdict, entry } = await review(register.mock.calls[0]?.[1])

    expect({
      verdict,
      modelCalls: streamSimple.mock.calls.length,
      decisions: harness.recordEscalationDecision.mock.calls.map(([, request, choice]) => [request, choice]),
      ledger: harness.appendEntry.mock.calls.filter(
        ([type]) => type === 'pi-permission-auto-review:escalation-decision.v1',
      ),
      diagnostics: [
        entry?.[0],
        entry?.[1]?.['errorCategory'],
        entry?.[1]?.['toolCallId'],
        entry?.[1]?.['escalationError'],
      ],
    }).toStrictEqual({
      verdict: { kind: 'defer' },
      modelCalls: reviews,
      decisions: submissions === 0 ? [] : [[escalation, 'allow']],
      ledger: [],
      diagnostics: [
        'auto_review.decision',
        error,
        'call-1',
        scenario === 'SDK rejects the decision' ? 'InvalidSandboxRequestError' : undefined,
      ],
    })
  })

  it.each([
    ['unknown-call', 'last review could not find its pending shell call'],
    ['unsupported-tool', 'last review used a tool without a shell review route'],
    ['not-selected', 'last review had no selected sandbox for its call'],
    ['destination-unavailable', 'last review could not resolve its execution destination'],
    ['invalid-source', 'last review received an invalid review source'],
    ['incompatible-protocol', 'last review found an incompatible BYOS review route'],
    ['ambiguous', 'last review found multiple matching review sources'],
  ] as const satisfies readonly (readonly [ReviewUnavailableReason, string])[])(
    'reports SDK lookup reason %s',
    async (reason, text) => {
      const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
      publish(register)
      const harness = start(undefined, true, { ok: false, reason })
      harness.start()
      harness.ready()
      const { entry } = await review(register.mock.calls[0]?.[1])
      await harness.run('', 'auto-stats')

      expect({
        footer: harness.setStatus.mock.lastCall,
        log: entry?.[1]?.['investigationUnavailable'],
        stats: String(harness.notify.mock.lastCall?.[0])
          .split('\n')
          .find(line => line.startsWith('Investigation:')),
      }).toStrictEqual({
        footer: [EXTENSION_ID, `auto-review selected · ask observed · 1 denied · ${text}`],
        log: reason,
        stats: `Investigation: ${text}`,
      })
    },
  )

  it.each([
    {
      error: Object.assign(new Error('The sandbox session is closing.'), {
        name: 'SandboxSessionClosingError',
        operation: 'acquire',
      } as const),
      name: 'SandboxSessionClosingError',
      message: 'The sandbox session is closing.',
    },
    { error: new TypeError('Internal provider details.'), name: 'TypeError', message: undefined },
  ])('reviews an ordinary call from the transcript when lookup throws $name', async ({ error, name, message }) => {
    const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(register)
    const { registry, streamSimple } = reviewRegistry(
      '{"outcome":"allow","rationale":"The user permitted the action."}',
    )
    const harness = start(registry)
    harness.findShellReviewSource.mockImplementationOnce(() => {
      throw error
    })
    const input = { command: 'pwd' }
    harness.start(input)
    harness.ready()
    const { verdict, entry } = await review(register.mock.calls[0]?.[1])
    await harness.run('', 'auto-stats')
    const text = 'last review could not look up its shell review source'
    expect({
      verdict,
      modelTools: streamSimple.mock.calls.map(([, context]) => context.tools),
      footer: harness.setStatus.mock.lastCall,
      stats: String(harness.notify.mock.lastCall?.[0])
        .split('\n')
        .find(line => line.startsWith('Investigation:')),
      entry,
    }).toStrictEqual({
      verdict: { kind: 'allow' },
      modelTools: [undefined],
      footer: [EXTENSION_ID, `auto-review selected · ask observed · 1 allowed · ${text}`],
      stats: `Investigation: ${text}`,
      entry: [
        'auto_review.decision',
        {
          actionDigest: inputDigest(input),
          actionKind: 'shell',
          answersOmitted: 0,
          attempts: 1,
          authorityEdited: false,
          authorityFits: true,
          contextSource: 'active-branch',
          durationMs: expect.any(Number) as unknown,
          imagesOmitted: 0,
          investigationUnavailable: 'lookup-failed',
          ...(message === undefined ? {} : { lookupErrorMessage: message }),
          lookupErrorName: name,
          model: 'codex-auto-review',
          outcome: 'allow',
          policyRevision: POLICY_REVISION,
          priorReviews: 0,
          provenanceUncertain: false,
          provider: 'openai',
          requestId: 'request-1',
          riskLevel: 'low',
          usage: { cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, input: 0, output: 0 },
          userApproval: 'unknown',
        },
      ],
    })
  })

  it('defers an escalated call when lookup throws', async () => {
    const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(register)
    const { registry, streamSimple } = reviewRegistry(DENY)
    const harness = start(registry)
    harness.findShellReviewSource.mockImplementationOnce(() => {
      throw new TypeError('Internal provider details.')
    })
    const { input } = escalationFixture()
    harness.start(input)
    harness.ready()
    const { verdict, entry } = await review(register.mock.calls[0]?.[1])

    expect({
      verdict,
      modelCalls: streamSimple.mock.calls,
      decisions: harness.recordEscalationDecision.mock.calls,
      ledger: harness.appendEntry.mock.calls.filter(
        ([type]) => type === 'pi-permission-auto-review:escalation-decision.v1',
      ),
      entry,
    }).toStrictEqual({
      verdict: { kind: 'defer' },
      modelCalls: [],
      decisions: [],
      ledger: [],
      entry: [
        'auto_review.decision',
        {
          actionDigest: inputDigest(input),
          actionKind: 'shell',
          contextSource: 'active-branch',
          durationMs: expect.any(Number) as unknown,
          errorCategory: 'escalation-source-unavailable',
          investigationUnavailable: 'lookup-failed',
          lookupErrorName: 'TypeError',
          model: 'codex-auto-review',
          outcome: 'defer',
          policyRevision: POLICY_REVISION,
          provider: 'openai',
          requestId: 'request-1',
          toolCallId: 'call-1',
        },
      ],
    })
  })

  it.each([
    { failure: 'SDK refusal', name: 'UnsupportedSandboxPolicyError', requirement: 'network=prevented' },
    { failure: 'unexpected error', name: 'TypeError', requirement: undefined },
  ])(
    'reports an unsuitable copy before offering tools when negotiation gives an $failure',
    async ({ failure, name, requirement }) => {
      const register = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
      publish(register)
      const { registry, streamSimple } = reviewRegistry(DENY)
      const copy = vi.fn<ShellReviewSource['copy']>()
      const error: SandboxErrorInfo = Object.assign(new Error('provider message\u001B[2J'), {
        name: 'UnsupportedSandboxPolicyError',
        operation: 'acquire',
        detail: { kind: 'access', property: 'network', value: 'prevented', reason: 'profile' },
      } as const)
      const negotiateCopy = vi.fn<ShellReviewSource['negotiateCopy']>(async () => {
        if (failure === 'unexpected error') throw new TypeError('provider negotiation failed')
        return { ok: false, error }
      })
      const harness = start(registry, true, { ok: true, source: { ...reviewSource(copy), negotiateCopy } })
      harness.start()
      harness.ready()
      const { entry } = await review(register.mock.calls[0]?.[1])
      await harness.run('', 'auto-stats')
      const fields = entry?.[1]
      const reason = 'last review found no suitable copy'

      expect({
        negotiated: negotiateCopy.mock.calls,
        copy: copy.mock.calls,
        tools: (streamSimple.mock.calls[0]?.[1] as { tools?: unknown } | undefined)?.tools,
        footer: harness.setStatus.mock.lastCall,
        stats: String(harness.notify.mock.lastCall?.[0])
          .split('\n')
          .find(line => line.startsWith('Investigation:')),
        log: [
          fields?.['investigationUnavailable'],
          fields?.['copyErrorName'],
          fields?.['copyErrorRequirement'],
          fields?.['copyErrorMessage'],
        ],
      }).toStrictEqual({
        negotiated: [
          [
            {
              access: { network: 'prevented', hostUserData: 'prevented', hostWorkspaceWrites: 'prevented' },
              capabilities: ['exec', 'files.read'],
              shells: ['sh'],
              processKinds: ['shell'],
              exitStatus: 'guaranteed',
              terminationScope: 'process-group',
            },
          ],
        ],
        copy: [],
        tools: undefined,
        footer: [EXTENSION_ID, `auto-review selected · ask observed · 1 denied · ${reason}`],
        stats: `Investigation: ${reason}`,
        log: ['no-suitable-copy', name, requirement, undefined],
      })
    },
  )

  it.each([
    { investigation: 'unused', status: 'last review did not investigate', callsTool: false },
    { investigation: 'inspected', status: 'last review inspected a copy', callsTool: true },
    { investigation: 'failed to open', status: 'last review could not open a copy', callsTool: true },
  ])(
    'shows the last review investigation in the footer and statistics when $investigation',
    async ({ investigation, status, callsTool }) => {
      const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
      publish(registerAuthorizer)
      const { registry, streamSimple } = reviewRegistry(DENY)
      const providerError = 'provider could not open the copy\u001B[2J'
      const copy = vi.fn(async () => {
        if (investigation === 'failed to open') {
          throw Object.assign(new Error(providerError), {
            name: 'UnsupportedSandboxPolicyError',
            operation: 'acquire',
            detail: { kind: 'access', property: 'network', value: 'prevented', reason: 'profile' },
          } as const)
        }

        return reviewCopy()
      })
      if (callsTool) {
        streamSimple.mockReturnValueOnce({
          result: async () => investigationReply('shell', { command: 'pwd' }),
        })
      }
      const harness = start(registry, true, { copy })
      harness.start()
      harness.ready()
      await harness.run('', 'auto-stats')
      const before = harness.setStatus.mock.lastCall
      const beforeStats = String(harness.notify.mock.lastCall?.[0])
        .split('\n')
        .find(line => line.startsWith('Investigation:'))
      const { entry } = await review(registerAuthorizer.mock.calls[0]?.[1])
      await harness.run('', 'auto-stats')

      const observed = {
        before,
        beforeStats,
        footer: harness.setStatus.mock.lastCall,
        stats: String(harness.notify.mock.lastCall?.[0])
          .split('\n')
          .find(line => line.startsWith('Investigation:')),
        copyCalls: copy.mock.calls,
        logReason: entry?.[1]?.['investigationUnavailable'],
      }

      expect(observed).toStrictEqual({
        before: [EXTENSION_ID, 'auto-review registered · no asks observed · check authorizerChain'],
        beforeStats: undefined,
        footer: [EXTENSION_ID, `auto-review selected · ask observed · 1 denied · ${status}`],
        stats: `Investigation: ${status}`,
        copyCalls: callsTool ? [[expect.any(Object)]] : [],
        logReason: investigation === 'failed to open' ? 'copy-open-failed' : undefined,
      })
      if (investigation === 'failed to open') {
        expect(entry).toStrictEqual([
          'auto_review.decision',
          {
            actionDigest: inputDigest({ command: 'pnpm publish' }),
            actionKind: 'shell',
            answersOmitted: 0,
            attempts: 1,
            authorityEdited: false,
            authorityFits: true,
            contextSource: 'active-branch',
            copyErrorMessage: providerError,
            copyErrorName: 'UnsupportedSandboxPolicyError',
            copyErrorRequirement: 'network=prevented',
            durationMs: expect.any(Number) as unknown,
            imagesOmitted: 0,
            investigationBytes: 0,
            investigationCalls: 1,
            investigationUnavailable: 'copy-open-failed',
            model: 'codex-auto-review',
            outcome: 'deny',
            policyRevision: POLICY_REVISION,
            priorReviews: 0,
            provenanceUncertain: false,
            provider: 'openai',
            requestId: 'request-1',
            riskLevel: 'high',
            usage: { cacheRead: 40, cacheWrite: 0, cacheWrite1h: 0, input: 100, output: 10 },
            userApproval: 'unknown',
          },
        ])
      }
    },
  )

  it.each([
    {
      retire: false,
      during: 'auto-review selected · ask observed · 1 denied · last review did not investigate',
      after: 'auto-review selected · ask observed · 2 denied · last review inspected a copy',
    },
    {
      retire: true,
      during: 'auto-review registered · no asks observed · check authorizerChain',
      after: 'auto-review registered · no asks observed · check authorizerChain',
    },
  ])(
    'updates investigation when an overlapping review finishes (retired: $retire)',
    async ({ retire, during, after }) => {
      const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
      publish(registerAuthorizer)
      const { registry, streamSimple } = reviewRegistry(DENY)
      const copying = Promise.withResolvers<void>()
      const opened = Promise.withResolvers<ReturnType<typeof reviewCopy>>()
      streamSimple.mockReturnValueOnce({ result: async () => investigationReply('shell', { command: 'pwd' }) })
      const harness = start(registry, true, {
        copy: async () => {
          copying.resolve()
          return opened.promise
        },
      })
      harness.start()
      harness.ready()
      const authorize = registerAuthorizer.mock.calls[0]?.[1]
      const slow = review(authorize)
      await copying.promise
      await review(authorize)
      if (retire) {
        harness.start()
        harness.ready()
      }
      const beforeOpen = harness.setStatus.mock.lastCall
      opened.resolve(reviewCopy())
      await slow

      const afterOpen = harness.setStatus.mock.lastCall

      expect([beforeOpen, afterOpen]).toStrictEqual([
        [EXTENSION_ID, during],
        [EXTENSION_ID, after],
      ])
    },
  )

  it('keeps the last investigation outcome when a review is cancelled while opening a copy', async () => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const { registry, streamSimple } = reviewRegistry(DENY)
    const copying = Promise.withResolvers<void>()
    const opened = Promise.withResolvers<ReturnType<typeof reviewCopy>>()
    const harness = start(registry, true, {
      copy: async () => {
        copying.resolve()
        return opened.promise
      },
    })
    harness.start()
    harness.ready()
    const authorize = registerAuthorizer.mock.calls[0]?.[1]
    await review(authorize)

    streamSimple.mockReturnValueOnce({ result: async () => investigationReply('shell', { command: 'pwd' }) })
    const pending = review(authorize)
    await copying.promise
    harness.emit('session_tree', {}, {})
    opened.resolve(reviewCopy())
    await pending

    expect(harness.setStatus).toHaveBeenLastCalledWith(
      EXTENSION_ID,
      'auto-review selected · ask observed · 2 denied · last review did not investigate',
    )
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
      status:
        'auto-review registered · no asks observed · check authorizerChain · no tool route provides review copies',
      warnings: [
        [`[${EXTENSION_ID}] the reviewer cannot investigate local state: no tool route provides review copies`],
      ],
    },
    {
      preset: 'claude-code',
      status: 'auto-review registered · no asks observed · check authorizerChain',
      warnings: [],
    },
  ])('shows in the footer when the $preset reviewer cannot investigate', async ({ preset, status, warnings }) => {
    writeFile(configPath(workspace.cwd, 'global'), { preset })
    hasRoute = false
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
      harness.setStatus.mockImplementation((_id: string, status: string | undefined) => {
        if (status?.startsWith('auto-review selected · ask observed · 1 denied') === true) {
          throw new Error('footer failed')
        }
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
