import type { FauxProviderHandle } from '@earendil-works/pi-ai'
import type { AgentSession, ExtensionAPI, ExtensionFactory, InputEvent } from '@earendil-works/pi-coding-agent'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  submittedTexts,
  uncertainUserEntries,
  UserMessageProvenance,
  USER_PROVENANCE_TYPE,
  verifiedUserEntries,
} from '../../src/provenance/provenance.js'
import { useWorkspace } from '../helpers.js'

function harness(manager = SessionManager.inMemory('/workspace')) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
  const queued: Record<'steer' | 'followUp', string[]> = { steer: [], followUp: [] }
  let idle = true
  const context = {
    sessionManager: manager,
    isIdle: () => idle,
    hasPendingMessages: () => queued.steer.length + queued.followUp.length > 0,
  }
  const provenance = new UserMessageProvenance({
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
  } as unknown as ExtensionAPI)
  const emit = (type: string, event: object = {}): void => handlers.get(type)?.({ type, ...event }, context)
  const input = (
    source: InputEvent['source'],
    text = 'Please proceed.',
    streamingBehavior?: InputEvent['streamingBehavior'],
  ): void => {
    emit('input', { source, text, streamingBehavior })
    if (streamingBehavior !== undefined) {
      queued[streamingBehavior].push(text)
    }
  }
  const start = (prompt = 'Please proceed.'): void => {
    emit('before_agent_start', { messageType: 'user', prompt })
    idle = false
  }
  const end = (text = 'Please proceed.', options: { beforeAppend?: () => void; replacement?: string } = {}): string => {
    const message = { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: 1 }
    for (const behavior of ['steer', 'followUp'] as const) {
      const index = queued[behavior].indexOf(text)
      if (index !== -1) {
        queued[behavior].splice(index, 1)
        break
      }
    }
    emit('message_start', { message })
    const replacement =
      options.replacement === undefined
        ? message
        : { ...message, content: [{ type: 'text' as const, text: options.replacement }] }
    emit('message_end', { message: replacement })
    options.beforeAppend?.()
    Object.assign(message, replacement)
    return manager.appendMessage(message)
  }
  const clearQueue = (): void => {
    queued.steer.length = 0
    queued.followUp.length = 0
  }
  const withdraw = (text: string, behavior: 'steer' | 'followUp'): void => {
    const index = queued[behavior].indexOf(text)
    if (index !== -1) {
      queued[behavior].splice(index, 1)
    }
  }
  const records = (): unknown[] =>
    manager
      .getBranch()
      .flatMap(entry => (entry.type === 'custom' ? [{ customType: entry.customType, data: entry.data }] : []))

  return { manager, context, emit, input, start, end, clearQueue, withdraw, records, provenance }
}

describe('user message provenance', () => {
  const workspace = useWorkspace()
  const sessions: AgentSession[] = []
  const initialContent = JSON.stringify([{ type: 'text', text: 'Start' }])
  const approvalContent = JSON.stringify([{ type: 'text', text: 'Deploy the application' }])

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
  })

  async function host(
    install: (
      pi: ExtensionAPI,
      getSession: () => AgentSession,
      provider: FauxProviderHandle,
      getProvenance: () => UserMessageProvenance,
    ) => void,
    position: 'before' | 'after' = 'after',
    options: { prompt?: string; template?: string } = {},
  ): Promise<AgentSession> {
    mkdirSync(workspace.cwd, { recursive: true })
    const provider = fauxProvider({ provider: 'provenance-test', models: [{ id: 'agent' }] })
    provider.setResponses([
      fauxAssistantMessage(fauxText('Done.')),
      fauxAssistantMessage(fauxText('Done.')),
      fauxAssistantMessage(fauxText('Done.')),
    ])
    let session: AgentSession
    let provenance: UserMessageProvenance | undefined
    const track: ExtensionFactory = pi => {
      provenance = new UserMessageProvenance(pi)
    }
    const extension: ExtensionFactory = pi =>
      install(
        pi,
        () => session,
        provider,
        () => {
          if (provenance === undefined) {
            throw new Error('The Pi host did not load the provenance extension')
          }
          return provenance
        },
      )
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.cwd,
      agentDir: workspace.cwd,
      settingsManager,
      extensionFactories: position === 'before' ? [extension, track] : [track, extension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      promptsOverride: base => ({
        ...base,
        prompts:
          options.template === undefined
            ? []
            : [
                {
                  name: 'queued',
                  description: 'Queued prompt fixture',
                  content: options.template,
                  filePath: join(workspace.cwd, 'queued.md'),
                  sourceInfo: createSyntheticSourceInfo('<inline:queued>', { source: 'inline' }),
                },
              ],
      }),
      noThemes: true,
      noContextFiles: true,
    })
    await resourceLoader.reload()
    const modelRuntime = await ModelRuntime.create({
      authPath: join(workspace.cwd, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(workspace.cwd, 'models-cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    modelRuntime.registerNativeProvider(provider.provider)
    const result = await createAgentSession({
      cwd: workspace.cwd,
      agentDir: workspace.cwd,
      modelRuntime,
      model: provider.getModel(),
      thinkingLevel: 'off',
      tools: [],
      resourceLoader,
      sessionManager: SessionManager.inMemory(workspace.cwd),
      settingsManager,
    })
    session = result.session
    sessions.push(session)
    const errors: unknown[] = []
    await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) })
    await session.prompt(options.prompt ?? 'Start', { source: 'interactive', streamingBehavior: 'followUp' })
    await session.waitForIdle()
    expect({ loadErrors: result.extensionsResult.errors, errors }).toStrictEqual({ loadErrors: [], errors: [] })
    if (provenance === undefined) {
      throw new Error('The Pi host did not load the provenance extension')
    }
    const branch = session.sessionManager.getBranch()
    provenance.flush({ sessionManager: session.sessionManager })
    expect(session.sessionManager.getBranch()).toStrictEqual(branch)

    return session
  }

  function hostUsers(session: AgentSession): unknown[] {
    const branch = session.sessionManager.getBranch()
    const verified = verifiedUserEntries(branch)

    return branch.flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'user'
        ? [{ content: entry.message.content, verified: verified.has(entry.id) }]
        : [],
    )
  }

  function hostSources(session: AgentSession): unknown[] {
    return session.sessionManager.getBranch().flatMap(entry => {
      if (entry.type !== 'custom' || entry.customType !== USER_PROVENANCE_TYPE) {
        return []
      }
      const data: unknown = entry.data

      return typeof data === 'object' && data !== null && 'source' in data ? [data.source] : []
    })
  }

  it('marks a template revocation as uncertain after handled extension input in the Pi host', async () => {
    const revocation = 'Do not deploy the application'
    const session = await host(
      pi => {
        pi.on('input', event => {
          if (event.source !== 'extension' || event.text !== revocation) {
            return
          }

          return { action: 'handled' }
        })
      },
      'after',
      { prompt: 'Deploy the application', template: revocation },
    )
    await session.prompt(revocation, { source: 'extension' })
    await session.prompt('/queued', { source: 'interactive' })
    await session.waitForIdle()

    expect({
      users: hostUsers(session),
      sources: hostSources(session),
      provenanceUncertain: uncertainUserEntries(session.sessionManager.getBranch()).size > 0,
    }).toStrictEqual({
      users: [
        { content: [{ type: 'text', text: 'Deploy the application' }], verified: true },
        { content: [{ type: 'text', text: revocation }], verified: false },
      ],
      sources: ['interactive', 'uncertain'],
      provenanceUncertain: true,
    })
  })

  it('records uncertainty after an extension follow-up and an RPC revocation in the Pi host', async () => {
    const session = await host(
      (pi, getSession) => {
        pi.on('message_end', async event => {
          if (event.message.role !== 'user' || JSON.stringify(event.message.content) !== approvalContent) {
            return
          }
          pi.sendUserMessage('Extension follow-up', { deliverAs: 'followUp' })
          await getSession().steer('Do not deploy the application', undefined, { source: 'rpc' })
        })
      },
      'after',
      { prompt: 'Deploy the application' },
    )

    expect({ users: hostUsers(session), sources: hostSources(session) }).toStrictEqual({
      users: [
        { content: [{ type: 'text', text: 'Deploy the application' }], verified: true },
        { content: [{ type: 'text', text: 'Do not deploy the application' }], verified: false },
        { content: [{ type: 'text', text: 'Extension follow-up' }], verified: false },
      ],
      sources: ['interactive', 'uncertain', 'uncertain'],
    })
  })

  it('preserves extension provenance after a queued template expansion in the Pi host', async () => {
    const session = await host(
      pi => {
        pi.on('message_end', event => {
          if (event.message.role === 'user' && JSON.stringify(event.message.content) === initialContent) {
            pi.sendUserMessage('/queued', { deliverAs: 'followUp', expandPromptTemplates: true })
          }
        })
      },
      'after',
      { template: 'Expanded extension follow-up' },
    )

    expect({ users: hostUsers(session), sources: hostSources(session) }).toStrictEqual({
      users: [
        { content: [{ type: 'text', text: 'Start' }], verified: true },
        { content: [{ type: 'text', text: 'Expanded extension follow-up' }], verified: false },
      ],
      sources: ['interactive', 'extension'],
    })
  })

  it('realigns provenance after a queued template expansion in the Pi host', async () => {
    const session = await host(
      (pi, getSession) => {
        pi.on('message_end', async event => {
          if (event.message.role !== 'user' || JSON.stringify(event.message.content) !== approvalContent) {
            return
          }
          await getSession().steer('/queued', undefined, { source: 'rpc' })
          await getSession().steer('Do not deploy the application', undefined, { source: 'rpc' })
        })
      },
      'after',
      { prompt: 'Deploy the application', template: 'Expanded task' },
    )

    expect({ users: hostUsers(session), sources: hostSources(session) }).toStrictEqual({
      users: [
        { content: [{ type: 'text', text: 'Deploy the application' }], verified: true },
        { content: [{ type: 'text', text: 'Expanded task' }], verified: false },
        { content: [{ type: 'text', text: 'Do not deploy the application' }], verified: true },
      ],
      sources: ['interactive', 'uncertain', 'rpc'],
    })
  })

  it('verifies a mixed interactive and RPC queue in the Pi host', async () => {
    const session = await host((pi, getSession) => {
      pi.on('message_end', async event => {
        if (event.message.role !== 'user' || JSON.stringify(event.message.content) !== initialContent) {
          return
        }
        await getSession().steer('Interactive steer', undefined, { source: 'interactive' })
        await getSession().followUp('Do not deploy the application', undefined, { source: 'rpc' })
      })
    })

    expect({ users: hostUsers(session), sources: hostSources(session) }).toStrictEqual({
      users: [
        { content: [{ type: 'text', text: 'Start' }], verified: true },
        { content: [{ type: 'text', text: 'Interactive steer' }], verified: true },
        { content: [{ type: 'text', text: 'Do not deploy the application' }], verified: true },
      ],
      sources: ['interactive', 'interactive', 'rpc'],
    })
  })

  it('does not promote nested extension input in the Pi host', async () => {
    const { promise: nestedSettled, resolve: markNestedSettled } = Promise.withResolvers<void>()
    const session = await host(pi => {
      pi.on('agent_settled', () => markNestedSettled())
      pi.on('input', event => {
        if (event.source === 'interactive') {
          pi.sendUserMessage('Extension request')
        }
      })
      pi.on('before_agent_start', async event => {
        if (event.messageType === 'user' && event.prompt === 'Start') {
          await nestedSettled
        }
      })
    }, 'before')

    expect(hostUsers(session)).toStrictEqual([
      { content: [{ type: 'text', text: 'Extension request' }], verified: false },
      { content: [{ type: 'text', text: 'Start' }], verified: false },
    ])
  })

  it.each(['steer', 'followUp'] as const)(
    'preserves queued RPC %s provenance after a provider error in the Pi host',
    async behavior => {
      const events: string[] = []
      const session = await host((pi, getSession, provider) => {
        provider.setResponses([
          fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Provider failed' }),
          fauxAssistantMessage('Done.'),
        ])
        pi.on('message_end', async event => {
          if (event.message.role === 'assistant' && event.message.stopReason === 'error') {
            await getSession()[behavior]('Do not deploy', undefined, { source: 'rpc' })
          }
        })
        pi.on('message_start', event => {
          if (event.message.role === 'user') {
            events.push(JSON.stringify(event.message.content))
          }
        })
        pi.on('agent_end', () => {
          events.push('agent_end')
        })
        pi.on('agent_settled', () => {
          events.push('agent_settled')
        })
      })

      expect({ users: hostUsers(session), events }).toStrictEqual({
        users: [
          { content: [{ type: 'text', text: 'Start' }], verified: true },
          { content: [{ type: 'text', text: 'Do not deploy' }], verified: true },
        ],
        events: [
          initialContent,
          'agent_end',
          JSON.stringify([{ type: 'text', text: 'Do not deploy' }]),
          'agent_end',
          'agent_settled',
        ],
      })
    },
  )

  it('preserves human input when a preceding startup handler queues a follow-up in the Pi host', async () => {
    const session = await host(pi => {
      pi.on('before_agent_start', () => {
        pi.sendUserMessage('Extension follow-up', { deliverAs: 'followUp' })
      })
    }, 'before')

    expect({ users: hostUsers(session), sources: hostSources(session) }).toStrictEqual({
      users: [
        { content: [{ type: 'text', text: 'Start' }], verified: true },
        { content: [{ type: 'text', text: 'Extension follow-up' }], verified: false },
      ],
      sources: ['interactive', 'extension'],
    })
  })

  it.each(['steer', 'followUp'] as const)('rejects withdrawn %s input in the Pi host', async behavior => {
    const session = await host((pi, getSession) => {
      pi.on('message_end', async event => {
        if (event.message.role !== 'user' || JSON.stringify(event.message.content) !== initialContent) {
          return
        }
        const current = getSession()
        await current[behavior]('Identical')
        current.clearQueue()
        pi.sendUserMessage('Identical', { deliverAs: behavior })
      })
    })

    expect(hostUsers(session)).toStrictEqual([
      { content: [{ type: 'text', text: 'Start' }], verified: true },
      { content: [{ type: 'text', text: 'Identical' }], verified: false },
    ])
  })

  it('preserves the current user source through a reentrant message_end handler in the Pi host', async () => {
    const session = await host(pi => {
      pi.on('message_end', event => {
        if (event.message.role === 'user' && JSON.stringify(event.message.content) === initialContent) {
          pi.sendUserMessage('Follow up', { deliverAs: 'followUp' })
        }
      })
    })

    expect(hostUsers(session)).toStrictEqual([
      { content: [{ type: 'text', text: 'Start' }], verified: true },
      { content: [{ type: 'text', text: 'Follow up' }], verified: false },
    ])
  })

  it('correlates a preceding message_end replacement in the Pi host', async () => {
    const session = await host(pi => {
      pi.on('message_end', event => {
        if (event.message.role !== 'user') {
          return
        }

        return { message: { ...event.message, content: [{ type: 'text', text: 'Replacement' }] } }
      })
    }, 'before')

    expect(hostUsers(session)).toStrictEqual([{ content: [{ type: 'text', text: 'Replacement' }], verified: true }])
  })

  it('does not verify a drained extension follow-up when an identical steer arrives in the Pi host', async () => {
    const session = await host((pi, getSession) => {
      pi.on('message_end', event => {
        if (event.message.role === 'user' && JSON.stringify(event.message.content) === initialContent) {
          pi.sendUserMessage('Identical', { deliverAs: 'followUp' })
        }
      })
      pi.on('turn_start', async event => {
        if (event.turnIndex === 1) {
          await getSession().steer('Identical')
        }
      })
    })

    expect(hostUsers(session)).toStrictEqual([
      { content: [{ type: 'text', text: 'Start' }], verified: true },
      { content: [{ type: 'text', text: 'Identical' }], verified: false },
      { content: [{ type: 'text', text: 'Identical' }], verified: false },
    ])
  })

  it.each([
    { source: 'interactive', verified: true },
    { source: 'rpc', verified: true },
    { source: 'extension', verified: false },
  ] as const)('records $source input after the message is appended', ({ source, verified }) => {
    const h = harness()
    h.input(source)
    h.start()
    const id = h.end()
    expect(h.records()).toStrictEqual([])
    h.emit('context')
    expect(h.records()).toStrictEqual([{ customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source } }])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual(verified ? [id] : [])
    h.emit('tool_call')
    expect(h.records()).toStrictEqual([{ customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source } }])
  })

  it('flushes the appended message when review starts before another lifecycle event', () => {
    const h = harness()
    h.input('interactive')
    h.start()
    const id = h.end()
    h.provenance.flush(h.context)

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'interactive' } },
    ])
  })

  it.each([
    { source: 'interactive', text: 'Original', prompt: 'Transformed' },
    { source: 'rpc', text: 'Original', prompt: 'Transformed' },
    { source: 'interactive', text: '/template task', prompt: 'Expanded task' },
    { source: 'rpc', text: '/skill:fixture task', prompt: 'Expanded skill task' },
  ] as const)(
    'verifies $source idle input after $text becomes $prompt, keeping what was typed',
    ({ source, text, prompt }) => {
      const h = harness()
      h.input(source, text)
      h.start(prompt)
      const id = h.end(prompt)
      h.emit('context')
      const branch = h.manager.getBranch()

      expect({
        records: h.records(),
        verified: [...verifiedUserEntries(branch)],
        submitted: [...submittedTexts(branch)],
      }).toStrictEqual({
        records: [{ customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source, inputText: text } }],
        verified: [id],
        submitted: [[id, text]],
      })
    },
  )

  it.each(['steer', 'followUp'] as const)(
    'keeps the source and typed text of a lone transformed %s input',
    behavior => {
      const h = harness()
      h.input('interactive', 'Start')
      h.start('Start')
      h.end('Start')
      h.input('rpc', '/template task', behavior)
      const id = h.end('Expanded task')
      h.emit('context')

      expect(h.records().at(-1)).toStrictEqual({
        customType: USER_PROVENANCE_TYPE,
        data: { userEntryId: id, source: 'rpc', inputText: '/template task' },
      })
    },
  )

  it('marks a transformed queued input as uncertain while another input is queued', () => {
    const h = harness()
    h.input('interactive', 'Start')
    h.start('Start')
    h.end('Start')
    h.input('interactive', '/template first', 'followUp')
    h.input('interactive', '/template second', 'followUp')
    const id = h.end('Expanded first')
    h.emit('context')

    expect(h.records().at(-1)).toStrictEqual({
      customType: USER_PROVENANCE_TYPE,
      data: { userEntryId: id, source: 'uncertain' },
    })
  })

  it('does not assign handled input to the next extension message, even with identical text', () => {
    const h = harness()
    h.input('interactive')
    h.input('extension')
    h.start()
    const id = h.end()
    h.emit('context')
    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it.each(['Human request', 'Extension request', 'Transformed request'])(
    'marks mixed idle sources as uncertain when the prompt is %s',
    prompt => {
      const h = harness()
      h.input('extension', 'Extension request')
      h.input('interactive', 'Human request')
      h.start(prompt)
      const id = h.end(prompt)
      h.emit('context')

      expect(h.records()).toStrictEqual([
        { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
      ])
      expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
    },
  )

  it.each([
    { sources: ['interactive', 'interactive'], verified: true },
    { sources: ['interactive', 'rpc'], verified: true },
    { sources: ['rpc', 'interactive'], verified: true },
    { sources: ['rpc', 'rpc'], verified: true },
    { sources: ['extension', 'extension'], verified: false },
  ] as const)('uses the common trust class of idle $sources input delivered unchanged', ({ sources, verified }) => {
    const h = harness()
    h.input(sources[0], 'Handled request')
    h.input(sources[1], 'Delivered request')
    h.start('Delivered request')
    const id = h.end('Delivered request')
    h.emit('context')

    expect({ records: h.records(), verified: [...verifiedUserEntries(h.manager.getBranch())] }).toStrictEqual({
      records: [{ customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: sources[0] } }],
      verified: verified ? [id] : [],
    })
  })

  it.each([
    { sources: ['interactive', 'rpc'], source: 'uncertain' },
    { sources: ['extension', 'extension'], source: 'extension' },
  ] as const)(
    'cannot tell which of several $sources submissions a transformed message came from',
    ({ sources, source }) => {
      const h = harness()
      h.input(sources[0], 'Handled request')
      h.input(sources[1], '/queued')
      h.start('Expanded request')
      const id = h.end('Expanded request')
      h.emit('context')

      expect({ records: h.records(), verified: [...verifiedUserEntries(h.manager.getBranch())] }).toStrictEqual({
        records: [{ customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source } }],
        verified: [],
      })
    },
  )

  it.each([
    { behavior: 'steer', source: 'interactive', verified: true },
    { behavior: 'steer', source: 'rpc', verified: true },
    { behavior: 'steer', source: 'extension', verified: false },
    { behavior: 'followUp', source: 'interactive', verified: true },
    { behavior: 'followUp', source: 'rpc', verified: true },
    { behavior: 'followUp', source: 'extension', verified: false },
  ] as const)('records delayed $source $behavior input', ({ behavior, source, verified }) => {
    const h = harness()
    h.input(source, 'Please proceed.', behavior)
    h.emit('context')
    expect(h.records()).toStrictEqual([])
    const id = h.end()
    h.emit('context')

    expect(h.records()).toStrictEqual([{ customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source } }])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual(verified ? [id] : [])
  })

  it.each(['steer', 'followUp'] as const)(
    'preserves extension origin after transformed %s input from an extension-only queue',
    behavior => {
      const h = harness()
      h.input('extension', '/template first', behavior)
      h.input('extension', '/template second', behavior)
      const ids = [h.end('Expanded first'), h.end('Expanded second')]
      h.emit('context')

      expect({
        records: h.records(),
        verified: [...verifiedUserEntries(h.manager.getBranch())],
        uncertain: [...uncertainUserEntries(h.manager.getBranch())],
      }).toStrictEqual({
        records: ids.map(userEntryId => ({
          customType: USER_PROVENANCE_TYPE,
          data: { userEntryId, source: 'extension' },
        })),
        verified: [],
        uncertain: [],
      })
    },
  )

  it.each(['interactive', 'rpc'] as const)(
    'marks a %s steer and an identical extension follow-up as uncertain',
    source => {
      const h = harness()
      h.input('extension', 'Identical', 'followUp')
      h.input(source, 'Identical', 'steer')
      const firstId = h.end('Identical')
      const secondId = h.end('Identical')
      h.emit('context')

      expect(h.records()).toStrictEqual(
        [firstId, secondId].map(userEntryId => ({
          customType: USER_PROVENANCE_TYPE,
          data: { userEntryId, source: 'uncertain' },
        })),
      )
      expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
    },
  )

  it.each(['steer', 'followUp'] as const)(
    'does not transfer withdrawn %s provenance to identical extension input',
    behavior => {
      const h = harness()
      h.input('interactive', 'Identical', behavior)
      h.clearQueue()
      h.input('extension', 'Identical', behavior)
      const id = h.end('Identical')
      h.emit('context')

      expect(h.records()).toStrictEqual([
        { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
      ])
      expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
    },
  )

  it('invalidates queued trust when withdrawal is hidden by another pending message', () => {
    const h = harness()
    h.input('extension', 'Other pending message', 'followUp')
    h.input('interactive', 'Identical', 'steer')
    h.withdraw('Identical', 'steer')
    h.input('extension', 'Before transformation', 'steer')
    const id = h.end('Identical')
    h.emit('context')

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it('marks earlier queued input as uncertain when extension input makes delivery ambiguous', () => {
    const h = harness()
    h.input('interactive', 'Identical', 'steer')
    h.input('extension', 'Identical', 'followUp')
    const firstId = h.end('Identical')
    const secondId = h.end('Identical')
    h.emit('context')

    expect(h.records()).toStrictEqual(
      [firstId, secondId].map(userEntryId => ({
        customType: USER_PROVENANCE_TYPE,
        data: { userEntryId, source: 'uncertain' },
      })),
    )
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it('does not skip an unmatched extension input to verify a later queued input', () => {
    const h = harness()
    h.input('extension', 'Before transformation', 'steer')
    h.input('interactive', 'Identical', 'steer')
    const id = h.end('Identical')
    h.emit('context')

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it.each([
    { behavior: 'steer', source: 'interactive', event: 'agent_settled' },
    { behavior: 'followUp', source: 'rpc', event: 'agent_settled' },
    { behavior: 'steer', source: 'extension', event: 'agent_settled' },
    { behavior: 'followUp', source: 'extension', event: 'agent_settled' },
  ] as const)('expires unused $source $behavior provenance at $event', ({ behavior, source, event }) => {
    const h = harness()
    h.input(source, 'Identical', behavior)
    h.emit(event)
    h.clearQueue()
    const id = h.end('Identical')
    h.emit('context')

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it('consumes an unmatched steer before attributing the next follow-up', () => {
    const h = harness()
    h.input('interactive', 'Follow up', 'followUp')
    h.input('interactive', 'Steer', 'steer')
    const uncertainId = h.end('Transformed steer')
    const followUpId = h.end('Follow up')
    h.emit('context')

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: uncertainId, source: 'uncertain' } },
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: followUpId, source: 'interactive' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([followUpId])
  })

  it('preserves provenance through input raised before the current message is appended', () => {
    const h = harness()
    h.input('interactive')
    h.start()
    const id = h.end('Please proceed.', {
      beforeAppend: () => h.input('extension', 'Follow up', 'followUp'),
    })
    const queuedId = h.end('Follow up')
    h.emit('context')

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'interactive' } },
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: queuedId, source: 'extension' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([id])
  })

  it('correlates replacement fields persisted in the original message object', () => {
    const h = harness()
    h.input('interactive', 'Original')
    h.start('Original')
    const id = h.end('Original', { replacement: 'Replacement' })
    h.emit('context')

    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'interactive', inputText: 'Original' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([id])
  })

  it.each(['steer', 'followUp'] as const)(
    'keeps the starting input separate from identical queued %s input',
    behavior => {
      const h = harness()
      h.input('interactive')
      h.start()
      h.input('extension', 'Please proceed.', behavior)
      const id = h.end()
      const queuedId = h.end()
      h.emit('context')

      expect(h.records()).toStrictEqual([
        { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'interactive' } },
        { customType: USER_PROVENANCE_TYPE, data: { userEntryId: queuedId, source: 'extension' } },
      ])
      expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([id])
    },
  )

  it('marks observed messages without an input record as uncertain', () => {
    const h = harness()
    h.start()
    const id = h.end()
    h.emit('context')
    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
    ])
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it.each(['steer', 'followUp'] as const)(
    'consumes transformed %s input and realigns the next RPC delivery',
    behavior => {
      const h = harness()
      h.input('interactive', '/template original', behavior)
      h.input('rpc', 'Do not deploy the application', behavior)
      const transformedId = h.end('Expanded original')
      const rpcId = h.end('Do not deploy the application')
      h.emit('context')

      expect(h.records()).toStrictEqual([
        { customType: USER_PROVENANCE_TYPE, data: { userEntryId: transformedId, source: 'uncertain' } },
        { customType: USER_PROVENANCE_TYPE, data: { userEntryId: rpcId, source: 'rpc' } },
      ])
      expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([rpcId])
    },
  )

  it('does not verify a message replaced after the message_end handler', () => {
    const h = harness()
    h.input('interactive')
    h.start()
    const id = h.end()
    const entry = h.manager.getLeafEntry()
    if (entry?.type !== 'message' || entry.message.role !== 'user') {
      throw new Error('Expected the appended user message')
    }
    entry.message.content = 'Replaced'
    h.emit('context')
    expect(h.records()).toStrictEqual([
      { customType: USER_PROVENANCE_TYPE, data: { userEntryId: id, source: 'uncertain' } },
    ])
  })

  it.each([
    { customType: USER_PROVENANCE_TYPE, data: null },
    { customType: USER_PROVENANCE_TYPE, data: { userEntryId: 'placeholder', source: 'unknown' } },
    { customType: USER_PROVENANCE_TYPE, data: { source: 'interactive' } },
    { customType: 'foreign', data: { userEntryId: 'placeholder', source: 'interactive' } },
  ])('ignores malformed or foreign custom entries: $customType $data', ({ customType, data }) => {
    const h = harness()
    const id = h.end()
    h.manager.appendCustomEntry(
      customType,
      typeof data === 'object' && data !== null && 'userEntryId' in data ? { ...data, userEntryId: id } : data,
    )
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })

  it('preserves conflicting human and extension provenance as uncertainty', () => {
    const manager = SessionManager.inMemory('/workspace')
    const id = manager.appendMessage({ role: 'user', content: 'Do not publish.', timestamp: 0 })
    for (const source of ['interactive', 'extension']) {
      manager.appendCustomEntry(USER_PROVENANCE_TYPE, { userEntryId: id, source })
    }

    expect({
      verified: [...verifiedUserEntries(manager.getBranch())],
      uncertain: [...uncertainUserEntries(manager.getBranch())],
    }).toStrictEqual({ verified: [], uncertain: [id] })
  })

  it('does not transfer pending provenance to another session', () => {
    const h = harness()
    h.input('interactive')
    h.start()
    h.end()
    h.context.sessionManager = SessionManager.inMemory('/other')
    h.provenance.flush(h.context)

    expect(h.records()).toStrictEqual([])
    expect(h.context.sessionManager.getBranch()).toStrictEqual([])
  })

  it('reads only records on the active branch and restores them after navigation', () => {
    const h = harness()
    h.input('rpc')
    h.start()
    const id = h.end()
    h.emit('context')
    const recordedLeaf = h.manager.getLeafId()
    if (recordedLeaf === null) {
      throw new Error('Expected a provenance entry')
    }
    h.manager.branch(id)
    h.emit('session_tree')
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
    h.manager.appendCustomEntry('other-branch', {})
    h.manager.branch(recordedLeaf)
    h.emit('session_tree')
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([id])
  })

  it('keeps persisted records in a fork without importing another session', () => {
    const manager = SessionManager.create(workspace.cwd, workspace.cwd)
    const h = harness(manager)
    h.input('interactive')
    h.start()
    const id = h.end()
    h.emit('context')
    const leafId = manager.getLeafId()
    if (leafId === null) {
      throw new Error('Expected a provenance entry')
    }
    const forkPath = manager.createBranchedSession(leafId)
    if (forkPath === undefined) {
      throw new Error('Expected a persisted fork')
    }
    const fork = SessionManager.open(forkPath)
    expect([...verifiedUserEntries(fork.getBranch())]).toStrictEqual([id])
    expect([...verifiedUserEntries(SessionManager.inMemory('/other').getBranch())]).toStrictEqual([])
  })

  it.each(['session_start', 'session_shutdown', 'session_tree'])('discards pending input on %s', event => {
    const h = harness()
    h.input('interactive')
    h.input('interactive', 'Steer', 'steer')
    h.input('rpc', 'Follow up', 'followUp')
    h.emit(event)
    h.start()
    const ids = [h.end(), h.end('Steer'), h.end('Follow up')]
    h.emit('context')
    expect(h.records()).toStrictEqual(
      ids.map(userEntryId => ({
        customType: USER_PROVENANCE_TYPE,
        data: { userEntryId, source: 'uncertain' },
      })),
    )
    expect([...verifiedUserEntries(h.manager.getBranch())]).toStrictEqual([])
  })
})
