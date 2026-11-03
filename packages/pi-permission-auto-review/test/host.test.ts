import type { FauxProviderRegistration, ToolCall } from '@earendil-works/pi-ai'
import type { AgentSession, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { PermissionState, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
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
import { getPermissionsService } from '@gotgenes/pi-permission-system'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      { index: 4, source: 'tool', label: `tool:${call.name}`, content: JSON.stringify(call.arguments) },
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
  const providers: FauxProviderRegistration[] = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
    for (const provider of providers.splice(0)) {
      provider.unregister()
    }
    vi.restoreAllMocks()
  })

  const workspace = useWorkspace()

  async function runHost({ call, deny = false, extensionFactory, permission, probePosition }: HostOptions) {
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
    const main = registerFauxProvider({ provider: 'host-main', models: [{ id: 'agent' }] })
    const reviewer = registerFauxProvider({ provider: 'host-reviewer', models: [{ id: 'reviewer' }] })
    providers.push(main, reviewer)
    writeFile(configPath(workspace.cwd, 'global'), {
      provider: reviewer.getModel().provider,
      model: reviewer.getModel().id,
      reasoning: 'off',
    })
    const details: PromptPermissionDetails[] = []
    const prompts: string[] = []
    const events: unknown[] = []
    const errors: unknown[] = []
    main.setResponses([fauxAssistantMessage(call, { stopReason: 'toolUse' }), fauxAssistantMessage(fauxText('Done.'))])
    reviewer.setResponses([
      context => {
        for (const message of context.messages) {
          if (message.role === 'user' && typeof message.content === 'string') {
            prompts.push(message.content)
          }
        }

        return fauxAssistantMessage(fauxText('{"outcome":"allow"}'))
      },
    ])
    const observe: ExtensionFactory = pi => {
      pi.on('session_start', (_event, ctx) => {
        const service = getPermissionsService(ctx.sessionManager.getSessionId())
        if (service === undefined) {
          throw new Error('The permission service was not published')
        }
        const register = service.registerAuthorizer.bind(service)
        vi.spyOn(service, 'registerAuthorizer').mockImplementation((name, authorize) =>
          register(name, async (request, query, log) => {
            details.push(structuredClone(request))
            events.push({ authorizer: request.toolCallId })

            return authorize(request, query, log)
          }),
        )
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
    const extensionFactories = [permissionSystem, observe, permissionAutoReview, createCodemodeExtension()]
    if (extensionFactory !== undefined) {
      extensionFactories.push(extensionFactory)
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
      modelRuntime.registerProvider(provider.getModel().provider, {
        api: provider.api,
        apiKey: 'faux-test-key',
        models: provider.models,
      })
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
    await session.prompt('Perform the scripted action.')
    expect({ errors, loadErrors: extensionsResult.errors, mainCalls: main.state.callCount }).toStrictEqual({
      errors: [],
      loadErrors: [],
      mainCalls: 2,
    })
    expect(
      session.messages
        .filter(message => message.role === 'toolResult')
        .map(message => ({ toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError })),
    ).toStrictEqual([{ toolCallId: call.id, toolName: call.name, isError: deny }])

    return { details, prompts, events, reviewerCalls: reviewer.state.callCount }
  }

  function normalise(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replaceAll(workspace.cwd, '<cwd>').replace(/perm-[\da-f-]{36}/g, '<request-id>')
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
      prompts: [expectedPrompt({ ...request, toolInput: call.arguments }, call)],
      events: [{ authorizer: call.id }],
      reviewerCalls: 1,
      executed: 'original',
    })
  })

  it('recovers the full direct write input from the transcript', async () => {
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
      prompts: [expectedPrompt({ ...request, toolInput: call.arguments }, call)],
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
      prompts: [expectedPrompt({ ...request, toolInput: input }, call)],
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
      prompts: [expectedPrompt(request, call)],
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
      prompts: [expectedPrompt({ ...request, toolInput: call.arguments }, call)],
      events: probePosition === 'before' ? [probe, authorizer] : [authorizer, probe],
      reviewerCalls: 1,
      executed: probePosition === 'before' ? 'original' : 'rewritten',
    })
  })
})
