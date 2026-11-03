import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionCapture } from '../../src/action/capture.js'
import { inputDigest, parseJsonValue, projectSdkJson } from '../../src/action/json.js'
import { permissionDetails, useWorkspace } from '../helpers.js'

function harness(cwd = '/workspace') {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const parameters = { type: 'object', properties: { value: { type: 'string' } } }
  const sourceInfo = { path: 'builtin:fixture', source: 'builtin', scope: 'user', origin: 'top-level' }
  const capture = new ActionCapture({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    getAllTools: () => [{ name: 'fixture', parameters, sourceInfo }],
  } as unknown as ExtensionAPI)
  const context = { cwd, sessionManager: { getSessionId: () => 'session-1' } } as ExtensionContext
  const emit = (name: string, event: unknown = {}): unknown => handlers.get(name)?.(event, context)

  return {
    capture,
    emit,
    registration: { sourceInfo, parametersDigest: inputDigest(projectSdkJson(parameters)) },
    call(toolName: string, input: Record<string, unknown>, toolCallId = 'parent/1') {
      const event: ToolCallEvent = {
        type: 'tool_call',
        toolCallId,
        parentToolCallId: 'parent',
        toolName,
        input,
      }
      emit('tool_call', event)

      return permissionDetails({ toolCallId: event.toolCallId, toolName })
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('action capture', () => {
  it('does not approve a live input change hidden by JSON stringification', () => {
    const h = harness()
    const input: Record<string, unknown> = { value: null }
    const details = h.call('fixture', input)
    input['value'] = Number.NaN
    expect(h.capture.resolve(details, 'session-1')).toStrictEqual({ kind: 'action-changed' })
  })

  it.each([
    { toolName: 'bash', input: { command: 'printf  exact  ', timeout: 10 }, action: { kind: 'shell' } },
    {
      toolName: 'write',
      input: { path: '../notes.md', content: 'full\ncontent\n' },
      action: { kind: 'file-write', resolvedPath: '/notes.md' },
    },
    {
      toolName: 'edit',
      input: {
        path: 'notes.md',
        edits: [
          { oldText: 'one', newText: 'two' },
          { oldText: 'three', newText: '' },
        ],
      },
      action: { kind: 'file-edit', resolvedPath: '/workspace/notes.md' },
    },
    {
      toolName: 'mcp__server__lookup',
      input: { nested: { value: ['all', 'arguments'] } },
      action: {
        kind: 'mcp',
        server: 'server',
        tool: 'lookup',
        connectorMetadata: 'unavailable',
        accountMetadata: 'unavailable',
      },
    },
    {
      toolName: 'mcp__trusted__other__delete_record',
      input: { recordId: 'record-1' },
      action: { kind: 'tool' },
    },
    {
      toolName: 'mcp__trusted___delete_record',
      input: { recordId: 'record-1' },
      action: { kind: 'tool' },
    },
    { toolName: 'fixture', input: { value: 'custom' }, action: { kind: 'tool' } },
    {
      toolName: 'fixture',
      input: Object.fromEntries([['__proto__', { nested: 'complete' }]]),
      action: { kind: 'tool' },
    },
  ])('decodes $toolName without losing input', ({ toolName, input, action }) => {
    const h = harness()
    const original = structuredClone(input)
    const details = h.call(toolName, input)
    const result = h.capture.resolve(details, 'session-1')

    expect(result).toStrictEqual({
      kind: 'eligible',
      action: {
        ...action,
        toolName,
        toolCallId: 'parent/1',
        parentToolCallId: 'parent',
        input,
        digest: inputDigest(input),
        cwd: '/workspace',
        sessionId: 'session-1',
        ...(toolName === 'fixture' ? { registration: h.registration } : {}),
      },
    })
    if (result.kind !== 'eligible' || result.action.kind === 'skill') {
      throw new Error('Expected a captured tool action')
    }
    expect(Object.isFrozen(result.action.input)).toBe(true)
    expect(result.action.input).not.toBe(input)
    for (const value of Object.values(result.action.input)) {
      if (value !== null && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true)
      }
    }
    expect(input).toStrictEqual(original)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it.each([
    { path: '~//notes.md', resolvedPath: join(homedir(), 'notes.md') },
    { path: '~///notes.md', resolvedPath: join(homedir(), 'notes.md') },
    { path: '~', resolvedPath: homedir() },
    { path: '~/x', resolvedPath: join(homedir(), 'x') },
    { path: 'dir//notes.md', resolvedPath: '/workspace/dir/notes.md' },
    { path: '//notes.md', resolvedPath: '/notes.md' },
    { path: '@notes.md', resolvedPath: '/workspace/notes.md' },
    { path: '@@notes.md', resolvedPath: '/workspace/@notes.md' },
    { path: '@~//notes.md', resolvedPath: join(homedir(), 'notes.md') },
    { path: '@~/notes\u2003one.md', resolvedPath: join(homedir(), 'notes one.md') },
    { path: 'notes\u00A0one\u202Fcopy.md', resolvedPath: '/workspace/notes one copy.md' },
    { path: ' notes.md ', resolvedPath: '/workspace/ notes.md ' },
    { path: 'file:///workspace/notes%20one.md', resolvedPath: '/workspace/notes one.md' },
    { path: 'file:///workspace/dir//notes.md/', resolvedPath: '/workspace/dir/notes.md' },
    { path: '@file:///workspace/dir/../notes.md', resolvedPath: '/workspace/notes.md' },
    { path: 'file://localhost/workspace/notes.md', resolvedPath: '/workspace/notes.md' },
    { path: 'file:///workspace/notes%2520.md', resolvedPath: '/workspace/notes%20.md' },
    { path: 'file:///workspace/%40notes.md', resolvedPath: '/workspace/@notes.md' },
    { path: 'file:///~/notes.md', resolvedPath: '/~/notes.md' },
    { path: 'notes.md', cwd: '~//workspace', resolvedPath: join(homedir(), 'workspace/notes.md') },
    { path: 'notes.md', cwd: 'file:///workspace/base', resolvedPath: '/workspace/base/notes.md' },
    { path: 'notes.md', cwd: '/workspace/dir\u2003space', resolvedPath: '/workspace/dir\u2003space/notes.md' },
  ])('resolves $path as Pi does', ({ path, cwd = '/workspace', resolvedPath }) => {
    const h = harness(cwd)
    const input = { path, content: 'notes' }
    const details = h.call('write', input)

    expect(h.capture.resolve(details, 'session-1')).toStrictEqual({
      kind: 'eligible',
      action: {
        kind: 'file-write',
        toolName: 'write',
        toolCallId: 'parent/1',
        parentToolCallId: 'parent',
        input,
        digest: inputDigest(input),
        cwd,
        sessionId: 'session-1',
        resolvedPath,
      },
    })
  })

  it.each(['skill_input', 'skill_read'] as const)('decodes %s from permission details alone', source => {
    const { capture } = harness()
    const details = permissionDetails({ source, skillName: 'deploy', path: '/skills/deploy/SKILL.md' })
    const skill = {
      source,
      skillName: 'deploy',
      path: '/skills/deploy/SKILL.md',
      payload: parseJsonValue(details.payload),
    }

    expect(capture.resolve(details, 'session-1')).toStrictEqual({
      kind: 'eligible',
      action: { kind: 'skill', ...skill, digest: inputDigest(skill) },
    })
    expect(Object.isFrozen(details.payload)).toBe(false)
  })

  it('hashes canonical JSON recursively regardless of object key order', () => {
    expect(inputDigest({ b: [{ z: 1, a: 2 }], a: 0 })).toBe(inputDigest({ a: 0, b: [{ a: 2, z: 1 }] }))
    expect(inputDigest({ a: [1, 2] })).not.toBe(inputDigest({ a: [2, 1] }))
    expect(inputDigest({ a: 1 })).toMatch(/^[a-f0-9]{64}$/)
  })

  it('sorts numeric object keys lexically in the canonical JSON', () => {
    expect(inputDigest({ '2': 'two', '10': 'ten' })).toBe(
      'b71e124675fc80e7314688bffdb68e83515851fb51474125db9a0c4c8aca3808',
    )
  })

  it('warns only once until the next session starts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness()
    for (const toolCallId of ['missing-1', 'missing-2']) {
      expect(h.capture.resolve(permissionDetails({ toolCallId }), 'session-1')).toStrictEqual({
        kind: 'action-unavailable',
      })
    }
    expect(warn.mock.calls).toStrictEqual([
      [
        '[pi-permission-auto-review] this extension must load before @gotgenes/pi-permission-system to capture complete tool actions',
      ],
    ])
    h.emit('session_start')
    h.capture.resolve(permissionDetails(), 'session-2')
    expect(warn.mock.calls).toStrictEqual(
      Array.from({ length: 2 }, () => [
        '[pi-permission-auto-review] this extension must load before @gotgenes/pi-permission-system to capture complete tool actions',
      ]),
    )
  })

  it.each(['tool_execution_end', 'session_start', 'session_shutdown'])('prunes captures on %s', event => {
    const h = harness()
    const details = h.call('bash', { command: 'true' })
    const other = h.call('bash', { command: 'false' }, 'parent/2')
    const retained = h.capture.resolve(other, 'session-1')
    h.emit('tool_execution_end', { toolCallId: 'unrelated' })
    expect(h.capture.resolve(details, 'session-1').kind).toBe('eligible')
    h.emit(event, { toolCallId: 'parent/1' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(h.capture.resolve(details, 'session-1')).toStrictEqual({ kind: 'action-unavailable' })
    expect(h.capture.resolve(other, 'session-1')).toStrictEqual(
      event === 'tool_execution_end' ? retained : { kind: 'action-unavailable' },
    )
  })

  it.each([
    { kind: 'forwarded', overrides: { forwarding: { requesterAgentName: 'child', requesterSessionId: 'child-1' } } },
    { kind: 'action-unavailable', overrides: { toolCallId: 'absent' } },
    { kind: 'action-unavailable', noToolCallId: true },
    { kind: 'action-mismatch', overrides: { toolName: 'write' } },
    { kind: 'action-mismatch', session: 'other-session' },
    { kind: 'action-changed', mutate: true },
    { kind: 'unsupported-input', input: { command: 12 } },
    { kind: 'unsupported-input', toolName: 'write', input: { path: 'file' } },
    { kind: 'unsupported-input', toolName: 'edit', input: { path: 'file', oldText: 'a', newText: 'b' } },
  ] satisfies {
    kind: string
    overrides?: Partial<PromptPermissionDetails>
    session?: string
    noToolCallId?: boolean
    mutate?: boolean
    toolName?: string
    input?: Record<string, unknown>
  }[])('returns $kind without throwing', test => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness()
    const input = test.input ?? { command: 'true' }
    const details = h.call(test.toolName ?? 'bash', input)
    if (test.mutate) {
      input.command = 'false'
    }

    if (test.noToolCallId) {
      delete details.toolCallId
    }

    expect(h.capture.resolve({ ...details, ...test.overrides }, test.session ?? 'session-1')).toStrictEqual({
      kind: test.kind,
    })
  })
})

describe('writes to configuration that governs the agent or this review', () => {
  const workspace = useWorkspace()

  function target(path: string): string {
    return path.replace('<agent>', getAgentDir()).replace('<cwd>', workspace.cwd)
  }

  it.each([
    '<cwd>/.pi/extensions/pi-permission-auto-review/config.json',
    '<agent>/extensions/pi-permission-auto-review/config.json',
    '<cwd>/.pi/extensions/pi-permission-system/config.json',
    '<agent>/extensions/pi-permission-system/config.json',
    '<cwd>/.pi/settings.json',
    '<agent>/settings.json',
    '<agent>/byos.json',
  ])('defers a write or edit to %s', path => {
    const h = harness(workspace.cwd)
    const resolved = ['write', 'edit'].map(toolName =>
      h.capture.resolve(
        h.call(
          toolName,
          toolName === 'write'
            ? { path: target(path), content: '{}' }
            : { path: target(path), edits: [{ oldText: 'a', newText: 'b' }] },
        ),
        'session-1',
      ),
    )

    expect(resolved).toStrictEqual([{ kind: 'protected-target' }, { kind: 'protected-target' }])
  })

  it('defers a write through a symlinked directory', () => {
    const configDirectory = join(getAgentDir(), 'extensions', 'pi-permission-auto-review')
    mkdirSync(configDirectory, { recursive: true })
    mkdirSync(workspace.cwd, { recursive: true })
    symlinkSync(configDirectory, join(workspace.cwd, 'notes'))
    const h = harness(workspace.cwd)

    expect(h.capture.resolve(h.call('write', { path: 'notes/config.json', content: '{}' }), 'session-1')).toStrictEqual(
      { kind: 'protected-target' },
    )
  })

  it('reviews a write to another extension directory', () => {
    const h = harness(workspace.cwd)
    const result = h.capture.resolve(
      h.call('write', { path: '.pi/extensions/other/config.json', content: '{}' }),
      'session-1',
    )

    expect(result.kind).toBe('eligible')
  })
})
