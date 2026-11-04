import type { CapturedInvocation } from '../../src/action/capture.js'
import type { ManualRuntime } from '../../src/manual/controller.js'
import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { describe, expect, it, vi } from 'vitest'
import { inputDigest, projectSdkJson } from '../../src/action/json.js'
import { EXTENSION_ID } from '../../src/config/config.js'
import { MANUAL_APPROVAL_TOOL, MANUAL_AUDIT_ENTRY_TYPE, ManualApprovalController } from '../../src/manual/controller.js'
import { appealableAction, snapshot } from './fixtures.js'

const ACTION = appealableAction()
const REGISTRATION = inputDigest(projectSdkJson(ACTION.registration))

function setup(options: { mode?: 'tui' | 'rpc' | 'print'; confirm?: () => Promise<unknown> } = {}) {
  const handlers = new Map<string, ((event: { message?: { role: string }; toolCallId?: string }) => void)[]>()
  /** The entries written to the session, which include the audit trail */
  const entries: [string, unknown][] = []
  const appendEntry = (type: string, data: unknown): void => {
    entries.push([type, data])
  }
  const invocations = new Map<string, CapturedInvocation>()
  let observer: ((invocation: CapturedInvocation) => ToolCallEventResult | undefined) | undefined
  /** The manual approval stages recorded in the statistics, with their failure category */
  const stages: string[] = []
  /** The calls that the controller dispatched, as tool name and input */
  const ran: [string, unknown][] = []
  const context = {
    cwd: ACTION.cwd,
    mode: options.mode ?? 'rpc',
    hasUI: options.mode !== 'print',
    signal: undefined,
    sessionManager: { getSessionId: () => 'session-1', getEntries: () => [] },
  }
  const runtime: ManualRuntime = {
    context: context as never,
    sessionSignal: new AbortController().signal,
    circuitOpen: () => false,
    snapshot: () => snapshot(),
    statistics: {
      review: () => {},
      late: () => {},
      manual: (stage, details) => stages.push(details?.category === undefined ? stage : `${stage}:${details.category}`),
    },
  }
  const controller = new ManualApprovalController(
    {
      appendEntry,
      on: (name: string, handler: never) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    } as never,
    {
      invocation: id => invocations.get(id),
      onCaptured: next => {
        observer = next as typeof observer
      },
    },
    () => runtime,
  )
  controller.start(context as never)

  /** Captures a call as Pi's `tool_call` handler would, returning what the observer answered */
  const capture = (
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    parentToolCallId?: string,
    registrationDigest = REGISTRATION,
  ) => {
    const invocation: CapturedInvocation = {
      toolName,
      toolCallId,
      parentToolCallId,
      cwd: ACTION.cwd,
      sessionId: 'session-1',
      input: input as never,
      digest: inputDigest(input as never),
      registrationDigest,
    }
    invocations.set(toolCallId, invocation)

    return observer?.(invocation)
  }
  const ask = (fields: Partial<PromptPermissionDetails>) =>
    controller.authorize({ requestId: 'request', ...fields } as PromptPermissionDetails)
  /** A tool context whose `executeTool` records the call, then answers with `run` */
  const toolContext = (run: (name: string, args: unknown) => Promise<unknown> = async () => ({})) =>
    ({
      ...context,
      tools: [{ name: 'bash' }],
      ui: { confirm: options.confirm ?? (async () => true), custom: vi.fn() },
      executeTool: async (name: string, args: unknown) => {
        ran.push([name, args])

        return run(name, args)
      },
    }) as never
  const audits = () =>
    entries.flatMap(([type, data]) =>
      type === MANUAL_AUDIT_ENTRY_TYPE
        ? [[(data as { event: string }).event, (data as { source: string }).source]]
        : [],
    )

  return { controller, capture, ask, toolContext, audits, stages, ran }
}

describe('manual approval controller', () => {
  it('offers a reference with a refusal only when the person can be asked', () => {
    expect({
      rpc: setup({ mode: 'rpc' }).controller.refuse(ACTION, 'No.', snapshot()),
      print: setup({ mode: 'print' }).controller.refuse(ACTION, 'No.', snapshot()),
    }).toStrictEqual({ rpc: expect.any(String) as unknown, print: undefined })
  })

  it('leaves an ask without a tool call id to the reviewer, even while a request awaits confirmation', () => {
    const { controller, capture, ask } = setup()
    const reference = controller.refuse(ACTION, 'No.', snapshot())
    capture('wrapper', MANUAL_APPROVAL_TOOL, { denial_id: reference, reason: 'Needed.' })

    expect(ask({ toolName: 'bash', forwarding: {} as never })).toBeUndefined()
  })

  it('claims a reference once, before any prompt for the request', () => {
    const { controller, capture } = setup()
    const reference = controller.refuse(ACTION, 'No.', snapshot())

    expect({
      first: capture('wrapper-1', MANUAL_APPROVAL_TOOL, { denial_id: reference, reason: 'Needed.' }),
      again: capture('wrapper-2', MANUAL_APPROVAL_TOOL, { denial_id: reference, reason: 'Needed.' }),
      unknown: capture('wrapper-3', MANUAL_APPROVAL_TOOL, { denial_id: 'invented', reason: 'Needed.' }),
      blank: capture('wrapper-4', MANUAL_APPROVAL_TOOL, { denial_id: reference, reason: '   ' }),
    }).toMatchObject({ first: undefined, again: { block: true }, unknown: { block: true }, blank: { block: true } })
  })

  it('records one terminal audit entry when no confirmation can be shown', async () => {
    const { controller, capture, toolContext, audits, stages, ran } = setup({ confirm: async () => 'no answer' })
    const reference = controller.refuse(ACTION, 'No.', snapshot())
    const input = { denial_id: reference, reason: 'Needed.' }
    capture('wrapper', MANUAL_APPROVAL_TOOL, input)

    await expect(controller.execute('wrapper', input, undefined, toolContext())).rejects.toThrow('unavailable')
    expect({ audits: audits(), stages, ran }).toStrictEqual({
      audits: [['unavailable', 'execution']],
      stages: ['requested', 'prompted', 'unavailable'],
      ran: [],
    })
  })

  it('runs the captured action once after approval, allowing only its own nested call', async () => {
    const { controller, capture, ask, toolContext, audits, stages, ran } = setup()
    const reference = controller.refuse(ACTION, 'No.', snapshot())
    const input = { denial_id: reference, reason: 'Needed.' }
    capture('wrapper', MANUAL_APPROVAL_TOOL, input)
    const answers: unknown[] = []
    const run = async (name: string, args: unknown) => {
      answers.push(capture('wrapper/1', name, args as never, 'wrapper'))
      answers.push(ask({ toolName: 'bash', toolCallId: 'wrapper/1', requestId: 'child-request' }))
      answers.push(ask({ toolName: 'bash', toolCallId: 'unrelated' }))

      return {
        toolCall: { id: 'wrapper/1' },
        isError: false,
        durationMs: 5,
        result: { content: [{ type: 'resource', uri: 'x' }], details: {} },
      }
    }
    const result = await controller.execute('wrapper', input, undefined, toolContext(run))

    expect({ ran, answers, result, audits: audits(), stages }).toStrictEqual({
      ran: [['bash', ACTION.input]],
      answers: [undefined, { kind: 'allow' }, undefined],
      result: { content: [{ type: 'resource', uri: 'x' }], details: {} },
      audits: [
        ['approved', 'host-ui'],
        ['dispatching', 'execution'],
        ['bound', 'execution'],
        ['link_allowed', EXTENSION_ID],
        ['completed', 'execution'],
      ],
      stages: ['requested', 'prompted', 'approved', 'dispatched', 'executed', 'completed'],
    })
  })

  it('blocks a direct retry of an action that the person rejected, and leaves other commands alone', async () => {
    const { controller, capture, toolContext } = setup({ confirm: async () => false })
    const untouched = capture('first', 'bash', { command: 'ls' })
    const reference = controller.refuse(ACTION, 'No.', snapshot())
    const input = { denial_id: reference, reason: 'Needed.' }
    capture('wrapper', MANUAL_APPROVAL_TOOL, input)
    await expect(controller.execute('wrapper', input, undefined, toolContext())).rejects.toThrow('rejected')

    expect({
      untouched,
      retry: capture('retry', 'bash', ACTION.input),
      other: capture('other', 'bash', { command: 'ls' }),
    }).toStrictEqual({
      untouched: undefined,
      retry: {
        block: true,
        reason: 'The person rejected this action, or is deciding on it; new direction from them is needed first',
      },
      other: undefined,
    })
  })
})
