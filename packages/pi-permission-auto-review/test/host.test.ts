import type { AssistantMessage, Context, ToolCall } from '@earendil-works/pi-ai'
import type { AgentSession, ExtensionFactory, ToolInfo } from '@earendil-works/pi-coding-agent'
import type { PermissionState, PermissionsReadyEvent, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import type { ProcessRequest, SandboxPolicy, SandboxProvider } from 'pi-bring-your-own-sandbox/api'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  isToolCallEventType,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { getPermissionsService, PERMISSIONS_READY_CHANNEL } from '@gotgenes/pi-permission-system'
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inputDigest, projectSdkJson } from '../src/action/json.js'
import { configPath } from '../src/config/store.js'
import permissionAutoReview from '../src/index.js'
import { useWorkspace, writeFile } from './helpers.js'

// pi-permission-system ships TypeScript with extensionless imports, which only Pi's jiti loader resolves.
const permissionModulePath = fileURLToPath(
  new URL('../node_modules/@gotgenes/pi-permission-system/src/index.ts', import.meta.url),
)
const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = hostRequire('jiti') as {
  createJiti: (
    id: string,
    options: { moduleCache: boolean; fsCache: boolean },
  ) => {
    import: (path: string, options: { default: true }) => Promise<ExtensionFactory>
  }
}
const permissionSystem = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(
  permissionModulePath,
  {
    default: true,
  },
)

interface HostOptions {
  call: ToolCall
  deny?: boolean
  extensionFactory?: ExtensionFactory
  permission?: Record<string, PermissionState | Record<string, PermissionState>>
  probePosition?: 'before' | 'after'
  reviewPosition?: 'before' | 'after'
  prompt?: string
  /** Further calls, each in its own model response after the first */
  successiveCalls?: ToolCall[]
  /** The reviewer's reply to each review in turn; an allow by default */
  verdicts?: string[]
  /** Whether the agent's turn ends early, after the model response with the last call */
  interrupted?: boolean
  /** The reviewer's replies in turn, given each request; overrides `verdicts` */
  reviewerReplies?: ((context: Context) => AssistantMessage)[]
  /** Receives a copy of every request that the reviewer model gets */
  reviewerRequests?: Context[]
  sandbox?: { provider: SandboxProvider<unknown>; policy: SandboxPolicy }
}

/** A provider that runs nothing and records what it was asked to open and run */
function recordingProvider(record: {
  policies: SandboxPolicy[]
  requests: ProcessRequest[]
}): SandboxProvider<unknown> {
  const capabilities = {
    processKinds: ['shell'],
    terminationScope: 'process-group',
    exitStatus: 'guaranteed',
    operations: ['exec'],
    shells: ['sh'],
  } as const

  return {
    id: 'fixture.recording',
    label: 'Recording fixture',
    protocolVersion: 1,
    capabilities: { ...capabilities, operations: ['exec', 'files.read'] },
    policies: {
      workspaceAccess: ['read-only', 'read-write'],
      filesystemScope: ['workspace-only'],
      networkAccess: ['denied'],
    },
    validateConfig: () => undefined,
    async open(request, context) {
      context.reportRecovery({ kind: 'none' })
      record.policies.push(request.policy)
      const files = {
        read: {
          readFile: async () => new Uint8Array(),
          access: async () => {},
          stat: async () => ({ kind: 'file', size: 0 }) as const,
        },
      }

      return {
        id: `backend-${record.policies.length}`,
        workspace: { root: '/workspace', pathFlavor: 'posix', relationship: 'remote', description: 'Fixture.' },
        capabilities: { ...capabilities, operations: ['exec', 'files.read'] },
        policy: request.policy,
        policyDescription: 'Fixture only; no isolation.',
        recovery: { kind: 'none' },
        files,
        exec: async (processRequest, operation) => {
          record.requests.push(processRequest)
          operation.onOutput({ stream: 'stdout', data: new TextEncoder().encode('fixture output\n') })

          return { kind: 'exited', exit: { kind: 'code', code: 0 } }
        },
        dispose: async () => {},
      }
    },
  }
}

interface ReviewEvidence {
  request: unknown
  transcript: unknown[]
}

function promptEvidence(prompt: string): ReviewEvidence {
  const transcript = prompt.match(/>>> TRANSCRIPT JSONL START\n(.*?)\n>>> TRANSCRIPT JSONL END/s)?.[1]
  const request = prompt.match(/>>> PERMISSION REQUEST START\n(.*?)\n>>> PERMISSION REQUEST END/s)?.[1]
  if (transcript === undefined || request === undefined) {
    throw new Error('The reviewer prompt has no transcript or permission request')
  }

  return { request: JSON.parse(request), transcript: transcript.split('\n').map((line): unknown => JSON.parse(line)) }
}

function expectedPrompt(request: unknown, call: ToolCall): ReviewEvidence {
  return {
    request,
    transcript: [
      { index: 3, source: 'user', label: 'user', content: 'Perform the scripted action.' },
      { index: 5, source: 'tool', label: `tool:${call.name}`, content: JSON.stringify(call.arguments) },
    ],
  }
}

function bashRequest(toolCallId: string) {
  return {
    requestId: '<request-id>',
    source: 'tool_call',
    agentName: null,
    toolCallId,
    toolName: 'bash',
    command: 'printf original',
    payload: {
      kind: 'bash',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: 'bash',
        toolName: 'bash',
        invokedToolName: null,
        value: 'printf original',
        matchedPattern: '*',
        matchedSpelling: null,
        commandContext: null,
        executedUnit: null,
        decidingPath: null,
      },
      evidence: [{ label: 'full command', text: 'printf original > executed.txt', detail: null }],
      annotations: [],
    },
    sessionLabel: 'Yes, allow bash "printf *" for this session',
    sessionApproval: { grants: [{ surface: 'bash', pattern: 'printf *' }] },
    accessIntent: {
      surface: 'bash',
      matchValues: ['printf original'],
      boundaryValue: null,
      askingUnits: [{ command: 'printf original' }],
    },
  }
}

function writeRequest(toolCallId: string, path: string, summary: string) {
  return {
    requestId: '<request-id>',
    source: 'tool_call',
    agentName: null,
    toolCallId,
    toolName: 'write',
    toolInputPreview: summary,
    payload: {
      kind: 'tool',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: 'write',
        toolName: 'write',
        invokedToolName: null,
        value: 'write',
        matchedPattern: '*',
        matchedSpelling: null,
        commandContext: null,
        executedUnit: null,
        decidingPath: null,
      },
      evidence: [{ label: 'input', text: summary, detail: null }],
      annotations: [],
    },
    sessionLabel: 'Yes, allow write "<cwd>/*" for this session',
    sessionApproval: { grants: [{ surface: 'write', pattern: '<cwd>/*' }] },
    accessIntent: { surface: 'write', matchValues: [`<cwd>/${path}`, path], boundaryValue: `<cwd>/${path}` },
  }
}

describe('auto-review in the Pi host', () => {
  const sessions: AgentSession[] = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
    vi.restoreAllMocks()
  })

  const workspace = useWorkspace()
  let registrations: ToolInfo[] = []

  function action(toolName: string, input: Record<string, unknown>, toolCallId: string, parentToolCallId?: string) {
    const tool = registrations.find(entry => entry.name === toolName)
    if (tool === undefined) {
      throw new Error(`No registration for ${toolName}`)
    }
    const kind =
      toolName === 'bash'
        ? 'shell'
        : toolName === 'write'
          ? 'file-write'
          : toolName.startsWith('mcp__')
            ? 'mcp'
            : 'tool'

    return {
      kind,
      toolName,
      toolCallId,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      input,
      cwd: '<cwd>',
      registration: {
        sourceInfo: Object.fromEntries(Object.entries(tool.sourceInfo).filter(([, value]) => value !== undefined)),
        parametersDigest: inputDigest(projectSdkJson(tool.parameters)),
      },
      ...(toolName === 'write' ? { resolvedPath: `<cwd>/${String(input['path'])}` } : {}),
      ...(kind === 'mcp'
        ? { server: 'fixture', tool: 'lookup', connectorMetadata: 'unavailable', accountMetadata: 'unavailable' }
        : {}),
    }
  }

  async function runHost({
    call,
    deny = false,
    extensionFactory,
    permission,
    probePosition,
    reviewPosition = 'before',
    prompt = 'Perform the scripted action.',
    successiveCalls = [],
    verdicts = ['{"outcome":"allow"}'],
    interrupted = false,
    reviewerReplies,
    reviewerRequests = [],
    sandbox,
  }: HostOptions) {
    mkdirSync(workspace.cwd, { recursive: true })
    workspace.cwd = realpathSync(workspace.cwd)
    const agentDir = getAgentDir()
    writeFile(join(agentDir, 'extensions/pi-permission-system/config.json'), {
      authorizerChain: ['auto-review'],
      permission: {
        '*': 'allow',
        path: 'allow',
        external_directory: 'allow',
        bash: deny ? { '*': 'ask', 'printf denied*': 'deny' } : 'ask',
        write: 'ask',
        ...permission,
      },
    })
    const main = fauxProvider({ provider: 'host-main', models: [{ id: 'agent' }] })
    const reviewer = fauxProvider({ provider: 'host-reviewer', models: [{ id: 'reviewer' }] })
    writeFile(configPath(workspace.cwd, 'global'), {
      provider: reviewer.getModel().provider,
      model: reviewer.getModel().id,
      reasoning: 'off',
    })
    const details: PromptPermissionDetails[] = []
    const prompts: string[] = []
    const events: unknown[] = []
    const errors: unknown[] = []
    const calls = [call, ...successiveCalls]
    main.setResponses([
      ...calls.map(toolCall => fauxAssistantMessage(toolCall, { stopReason: 'toolUse' })),
      fauxAssistantMessage(fauxText('Done.')),
    ])
    reviewer.setResponses(
      (reviewerReplies ?? verdicts.map(verdict => () => fauxAssistantMessage(fauxText(verdict)))).map(
        answer => context => {
          reviewerRequests.push(structuredClone(context))
          for (const message of context.messages) {
            if (message.role === 'user' && typeof message.content === 'string') {
              prompts.push(message.content)
            }
          }

          return answer(context)
        },
      ),
    )
    const observedServices = new Set<string>()
    const spyRegistration: ExtensionFactory = pi => {
      pi.events.on(PERMISSIONS_READY_CHANNEL, data => {
        const ready = data as PermissionsReadyEvent
        if (ready.sessionId === null) {
          return
        }
        const service = getPermissionsService(ready.sessionId)
        if (service === undefined) {
          throw new Error('The permission service was not published')
        }
        if (observedServices.has(ready.sessionId)) {
          return
        }
        observedServices.add(ready.sessionId)
        const register = service.registerAuthorizer.bind(service)
        vi.spyOn(service, 'registerAuthorizer').mockImplementation((name, authorize) =>
          register(name, async (request, query, log) => {
            details.push(structuredClone(request))
            events.push({ authorizer: request.toolCallId })

            return authorize(request, query, log)
          }),
        )
      })
    }
    const observe: ExtensionFactory = pi => {
      pi.on('session_start', () => {
        registrations = pi.getAllTools()
      })
      pi.on('tool_call', event => {
        if (event.parentToolCallId !== undefined) {
          events.push({ nested: structuredClone(event) })
        }
      })
    }
    const probe: ExtensionFactory = pi => {
      pi.on('tool_call', event => {
        events.push({ probe: structuredClone(event) })
        if (probePosition === 'after' && isToolCallEventType('bash', event)) {
          event.input.command = 'printf rewritten > executed.txt'
        }
      })
    }
    const extensionFactories =
      reviewPosition === 'before'
        ? [spyRegistration, permissionAutoReview, permissionSystem, observe, createCodemodeExtension()]
        : [spyRegistration, permissionSystem, observe, permissionAutoReview, createCodemodeExtension()]
    if (extensionFactory !== undefined) {
      extensionFactories.push(extensionFactory)
    }
    if (sandbox !== undefined) {
      extensionFactories.push(pi =>
        registerSandboxProvider(pi, sandbox.provider, {
          configure: () => ({ configuration: {}, policy: sandbox.policy }),
        }),
      )
    }
    if (probePosition === 'before') {
      extensionFactories.unshift(probe)
    }
    if (probePosition === 'after') {
      extensionFactories.push(probe)
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.cwd,
      agentDir,
      settingsManager,
      extensionFactories,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await resourceLoader.reload()
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(agentDir, 'models-cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    for (const provider of [main, reviewer]) {
      modelRuntime.registerNativeProvider(provider.provider)
    }
    const { session, extensionsResult } = await createAgentSession({
      cwd: workspace.cwd,
      agentDir,
      modelRuntime,
      model: main.getModel(),
      thinkingLevel: 'off',
      tools: ['bash', 'write', 'codemode', ...(extensionFactory === undefined ? [] : [call.name])],
      resourceLoader,
      sessionManager: SessionManager.inMemory(workspace.cwd),
      settingsManager,
    })
    sessions.push(session)
    await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) })
    await session.prompt(prompt)
    expect({ errors, loadErrors: extensionsResult.errors, mainCalls: main.state.callCount }).toStrictEqual({
      errors: [],
      loadErrors: [],
      mainCalls: calls.length + (interrupted ? 0 : 1),
    })
    const refused = deny || interrupted || reviewPosition === 'after'
    expect(
      session.messages
        .filter(message => message.role === 'toolResult')
        .map(message => ({ toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError })),
    ).toStrictEqual(calls.map(toolCall => ({ toolCallId: toolCall.id, toolName: toolCall.name, isError: refused })))

    return { details, prompts, events, reviewerCalls: reviewer.state.callCount }
  }

  function normalise(value: unknown): unknown {
    if (typeof value === 'string') {
      return value
        .replaceAll(workspace.cwd, '<cwd>')
        .replace(/perm-[\da-f-]{36}/g, '<request-id>')
        .replace(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/g, '<session-id>')
    }
    if (Array.isArray(value)) {
      return value.map(normalise)
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, normalise(field)]))
    }

    return value
  }

  it('reviews a direct bash call before executing the command', async () => {
    const call = fauxToolCall('bash', { command: 'printf original > executed.txt', timeout: 10 }, { id: 'direct-bash' })
    const result = await runHost({ call })
    const request = bashRequest(call.id)

    expect(
      normalise({
        ...result,
        prompts: result.prompts.map(promptEvidence),
        executed: readFileSync(join(workspace.cwd, 'executed.txt'), 'utf8'),
      }),
    ).toStrictEqual({
      details: [{ ...request, origin: 'global', target: undefined, toolInputPreview: undefined }],
      prompts: [expectedPrompt({ ...request, action: action(call.name, call.arguments, call.id) }, call)],
      events: [{ authorizer: call.id }],
      reviewerCalls: 1,
      executed: 'original',
    })
  })

  it('captures the full direct write input', async () => {
    const content = 'first line\nsecond line\n'
    const call = fauxToolCall('write', { path: 'written.txt', content }, { id: 'direct-write' })
    const result = await runHost({ call })
    const request = writeRequest(call.id, 'written.txt', "for 'written.txt' (3 lines, 23 characters)")

    expect(
      normalise({
        ...result,
        prompts: result.prompts.map(promptEvidence),
        written: readFileSync(join(workspace.cwd, 'written.txt'), 'utf8'),
      }),
    ).toStrictEqual({
      details: [{ ...request, origin: 'global', command: undefined, target: undefined }],
      prompts: [expectedPrompt({ ...request, action: action(call.name, call.arguments, call.id) }, call)],
      events: [{ authorizer: call.id }],
      reviewerCalls: 1,
      written: content,
    })
  })

  it.each([
    {
      toolName: 'fixture_lookup',
      surface: 'fixture_lookup',
      kind: 'tool',
      target: undefined,
      pattern: '*',
      sessionLabel: 'Yes, allow tool "fixture_lookup" for this session',
    },
    {
      toolName: 'mcp__fixture__lookup',
      surface: 'mcp',
      kind: 'mcp',
      target: 'mcp__fixture__lookup',
      pattern: 'mcp__fixture__lookup',
      sessionLabel: 'Yes, allow mcp tool "mcp__fixture__lookup" for this session',
    },
  ])('reviews the full input of $toolName', async ({ toolName, surface, kind, target, pattern, sessionLabel }) => {
    const input = { apiKey: 'fixture-secret', query: 'x'.repeat(1000) }
    const call = fauxToolCall(toolName, input, { id: 'direct-lookup' })
    const executed: unknown[] = []
    const extensionFactory: ExtensionFactory = pi => {
      pi.registerTool({
        name: toolName,
        label: 'Fixture lookup',
        description: 'Record the lookup input',
        parameters: Type.Object({ apiKey: Type.String(), query: Type.String() }),
        async execute(_toolCallId, params) {
          executed.push(structuredClone(params))

          return { content: [{ type: 'text', text: 'Executed.' }], details: {} }
        },
      })
    }
    const result = await runHost({
      call,
      extensionFactory,
      permission: { [surface]: surface === toolName ? 'ask' : { [toolName]: 'ask' } },
    })
    const request = {
      requestId: '<request-id>',
      source: 'tool_call',
      agentName: null,
      toolCallId: call.id,
      toolName,
      ...(target === undefined ? {} : { target }),
      toolInputPreview: `input ${JSON.stringify({ ...input, apiKey: '[redacted]' })}`,
      payload: {
        kind,
        request: {
          requester: { agentName: null, forwarded: false, sessionId: null },
          surface,
          toolName,
          invokedToolName: null,
          value: target ?? toolName,
          matchedPattern: pattern,
          matchedSpelling: null,
          commandContext: null,
          executedUnit: null,
          decidingPath: null,
        },
        evidence: [{ label: 'input', text: `with input ${JSON.stringify(input).slice(0, 200)}…`, detail: null }],
        annotations: [],
      },
      sessionLabel,
      sessionApproval: { grants: [{ surface, pattern }] },
      accessIntent: { surface, matchValues: [target ?? toolName], boundaryValue: null },
    }

    expect(
      normalise({
        ...result,
        prompts: result.prompts.map(promptEvidence),
        executed,
      }),
    ).toStrictEqual({
      details: [{ ...request, origin: 'global', command: undefined, target }],
      prompts: [expectedPrompt({ ...request, action: action(toolName, input, call.id) }, call)],
      events: [{ authorizer: call.id }],
      reviewerCalls: 1,
      executed: [input],
    })
  })

  it('reviews a nested codemode write', async () => {
    const content = 'nested first\nnested second\n'
    const call = fauxToolCall(
      'codemode',
      {
        code: 'await tools.write({ path: "nested.txt", content: ["nested first", "nested second", ""].join("\\n") })',
      },
      { id: 'parent' },
    )
    const result = await runHost({ call })
    const request = writeRequest('parent/1', 'nested.txt', "for 'nested.txt' (3 lines, 27 characters)")

    expect(
      normalise({
        ...result,
        prompts: result.prompts.map(promptEvidence),
        written: readFileSync(join(workspace.cwd, 'nested.txt'), 'utf8'),
      }),
    ).toStrictEqual({
      details: [{ ...request, origin: 'global', command: undefined, target: undefined }],
      prompts: [
        expectedPrompt(
          { ...request, action: action('write', { path: 'nested.txt', content }, 'parent/1', 'parent') },
          call,
        ),
      ],
      events: [
        { authorizer: 'parent/1' },
        {
          nested: {
            type: 'tool_call',
            toolName: 'write',
            toolCallId: 'parent/1',
            parentToolCallId: 'parent',
            input: { path: 'nested.txt', content },
          },
        },
      ],
      reviewerCalls: 1,
      written: content,
    })
  })

  it('defers without reviewing or executing when loaded after permission-system', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const call = fauxToolCall('write', { path: 'late.txt', content: 'must not execute' }, { id: 'late-write' })
    const result = await runHost({ call, reviewPosition: 'after' })
    const request = writeRequest(call.id, 'late.txt', "for 'late.txt' (1 line, 16 characters)")

    expect(normalise({ ...result, written: existsSync(join(workspace.cwd, 'late.txt')) })).toStrictEqual({
      details: [{ ...request, origin: 'global', command: undefined, target: undefined }],
      prompts: [],
      events: [{ authorizer: call.id }],
      reviewerCalls: 0,
      written: false,
    })
  })

  it('defers edited user evidence without review or execution through the real host projection', async () => {
    const editUser: ExtensionFactory = pi => {
      pi.on('context', (_event, ctx) => {
        const user = ctx.sessionManager
          .getBranch()
          .find(entry => entry.type === 'message' && entry.message.role === 'user')
        const session = sessions.at(-1)
        if (user === undefined || session === undefined) {
          throw new Error('The host did not append the user message')
        }
        session.sessionManager.appendContextEdit(user.id, { content: 'Edited request evidence' })
      })
    }
    const call = fauxToolCall('bash', { command: 'printf original > executed.txt' }, { id: 'edited' })
    const result = await runHost({
      call,
      deny: true,
      permission: { bash: 'ask' },
      extensionFactory: editUser,
      prompt: 'Original user restriction',
    })
    const logPath = join(
      getAgentDir(),
      'extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl',
    )
    const decisions = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; outcome?: string; errorCategory?: string })
      .filter(entry => entry.event === 'auto_review.decision')
      .map(({ event, outcome, errorCategory }) => ({ event, outcome, errorCategory }))

    expect(
      normalise({ ...result, decisions, executed: existsSync(join(workspace.cwd, 'executed.txt')) }),
    ).toStrictEqual({
      details: [{ ...bashRequest(call.id), origin: 'global', target: undefined, toolInputPreview: undefined }],
      prompts: [],
      events: [{ authorizer: call.id }],
      reviewerCalls: 0,
      decisions: [{ event: 'auto_review.decision', outcome: 'defer', errorCategory: 'authority-edited' }],
      executed: false,
    })
  })

  it('investigates through a read-only backend of the configured sandbox, whose own policy allows writes', async () => {
    const record = { policies: [] as SandboxPolicy[], requests: [] as ProcessRequest[] }
    const reviewerRequests: Context[] = []
    await runHost({
      reviewerRequests,
      call: fauxToolCall('bash', { command: 'printf ok > executed.txt' }, { id: 'investigated' }),
      sandbox: {
        provider: recordingProvider(record),
        policy: { workspaceAccess: 'read-write', filesystemScope: 'workspace-only', networkAccess: 'denied' },
      },
      reviewerReplies: [
        () => fauxAssistantMessage([fauxToolCall('shell', { command: 'git remote -v' })], { stopReason: 'toolUse' }),
        () => fauxAssistantMessage(fauxText('{"outcome":"allow"}')),
      ],
    })

    expect({
      policies: record.policies,
      requests: record.requests,
      tools: reviewerRequests.map(context => getCurrentTools(context.messages).map(tool => tool.name)),
      output: JSON.stringify(reviewerRequests[1]?.messages.at(-1)),
    }).toStrictEqual({
      policies: [{ workspaceAccess: 'read-only', filesystemScope: 'workspace-only', networkAccess: 'denied' }],
      requests: [{ kind: 'shell', command: 'git remote -v', dialect: 'sh' }],
      tools: [
        ['shell', 'read'],
        ['shell', 'read'],
      ],
      output: expect.stringContaining('fixture output') as unknown,
    })
  })

  it('offers the reviewer no tools when the session uses the default host passthrough', async () => {
    const reviewerRequests: Context[] = []
    await runHost({
      call: fauxToolCall('bash', { command: 'printf ok > executed.txt' }, { id: 'plain' }),
      reviewerRequests,
    })

    expect(reviewerRequests.map(context => getCurrentTools(context.messages))).toStrictEqual([[]])
  })

  it('interrupts the turn on the third denial in a row, before the denied call runs', async () => {
    const calls = Array.from({ length: 3 }, (_, index) =>
      fauxToolCall('write', { path: 'denied.txt', content: 'must not execute' }, { id: `denied-${index}` }),
    )
    const deny = '{"outcome":"deny","rationale":"Not authorized."}'
    const result = await runHost({
      call: calls[0]!,
      successiveCalls: calls.slice(1),
      verdicts: [deny, deny, deny],
      interrupted: true,
    })

    expect({
      requests: result.details.map(request => request.toolCallId),
      reviews: result.reviewerCalls,
      written: existsSync(join(workspace.cwd, 'denied.txt')),
    }).toStrictEqual({ requests: calls.map(toolCall => toolCall.id), reviews: 3, written: false })
  })

  it('does not review or execute a deterministically denied command', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0)
    const result = await runHost({
      call: fauxToolCall('bash', { command: 'printf denied > executed.txt' }, { id: 'denied' }),
      deny: true,
    })
    expect({
      ...result,
      toolResults: sessions.at(-1)?.messages.filter(message => message.role === 'toolResult'),
      executed: existsSync(join(workspace.cwd, 'executed.txt')),
    }).toStrictEqual({
      details: [],
      prompts: [],
      events: [],
      reviewerCalls: 0,
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: 'denied',
          toolName: 'bash',
          content: [{ type: 'text', text: "[pi-permission-system] Denied by policy: 'bash' (rule 'printf denied*')." }],
          details: {},
          isError: true,
          timestamp: 0,
          usage: undefined,
        },
      ],
      executed: false,
    })
  })

  it.each(['before', 'after'] as const)('runs a probe %s the permission extension', async probePosition => {
    const call = fauxToolCall(
      'bash',
      { command: 'printf original > executed.txt', timeout: '10' },
      { id: 'ordered-bash' },
    )
    const result = await runHost({ call, probePosition })
    const request = bashRequest(call.id)
    const probe = {
      probe: {
        type: 'tool_call',
        toolName: 'bash',
        toolCallId: call.id,
        input: { command: 'printf original > executed.txt', timeout: 10 },
      },
    }
    const authorizer = { authorizer: call.id }

    expect(
      normalise({
        ...result,
        prompts: result.prompts.map(promptEvidence),
        executed: readFileSync(join(workspace.cwd, 'executed.txt'), 'utf8'),
      }),
    ).toStrictEqual({
      details: [{ ...request, origin: 'global', target: undefined, toolInputPreview: undefined }],
      prompts: [
        expectedPrompt({ ...request, action: action(call.name, { ...call.arguments, timeout: 10 }, call.id) }, call),
      ],
      events: probePosition === 'before' ? [probe, authorizer] : [authorizer, probe],
      reviewerCalls: 1,
      executed: probePosition === 'before' ? 'original' : 'rewritten',
    })
  })
})
