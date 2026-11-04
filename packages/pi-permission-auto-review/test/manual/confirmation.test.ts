import type { ConfirmationContext } from '../../src/manual/confirmation.js'
import { initTheme } from '@earendil-works/pi-coding-agent'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { confirmCapturedAction, formatManualPrompt, ManualApprovalView } from '../../src/manual/confirmation.js'
import { denial } from './fixtures.js'

const REASON = 'Needed for the requested task.'

function rpc(confirm: ConfirmationContext['ui']['confirm']): ConfirmationContext {
  return {
    mode: 'rpc',
    hasUI: true,
    ui: {
      confirm,
      custom: async () => {
        throw new Error('Unexpected terminal component')
      },
    },
  }
}

describe('manual approval confirmation', () => {
  beforeAll(() => initTheme('dark', false))

  it('shows what would run first and the model reason last, labelled as the model', () => {
    expect(formatManualPrompt(denial('printf one\nprintf two'), REASON)).toBe(
      [
        'Tool: bash',
        'Working directory: /workspace/project',
        'Command:',
        '  printf one',
        '  printf two',
        'Other arguments:',
        '  {',
        '    "timeout": 10,',
        '    "extra": {',
        '      "mode": "captured"',
        '    }',
        '  }',
        'Automatic refusal:',
        '  Not authorized.',
        "The model's reason, which is not your approval:",
        `  ${REASON}`,
        'Approving runs this exact invocation once.',
      ].join('\n'),
    )
  })

  it.each([
    { character: '\u001B', escaped: '\\u001b' },
    { character: '\r', escaped: '\\u000d' },
    { character: '‮', escaped: '\\u202e' },
  ])('escapes $escaped in the command for display', ({ character, escaped }) => {
    const output = formatManualPrompt(denial(`printf ${character}captured`), REASON)

    expect({ raw: output.includes(character), escaped: output.includes(`printf ${escaped}captured`) }).toStrictEqual({
      raw: false,
      escaped: true,
    })
  })

  it('keeps the command on the first page under a long reason, and approves only after the last page', () => {
    const decisions: boolean[] = []
    const view = new ManualApprovalView({
      body: formatManualPrompt(denial(), 'x'.repeat(2_000)),
      height: () => 20,
      requestRender: () => {},
      done: answer => decisions.push(answer),
    })
    const first = view.render(80)
    const choose = (moves: string): void => {
      for (const key of moves) {
        view.handleInput(key === 'v' ? '\u001B[B' : key === '^' ? '\u001B[A' : '\r')
      }
    }
    choose('vvv.')
    const beforeLastPage = [...decisions]
    choose('^^.')
    view.render(80)
    for (let page = 0; page < 10; page += 1) {
      choose('v.')
      view.render(80)
    }
    choose('vvv.')

    expect({
      command: first.some(line => line.includes('printf captured')),
      reason: first.some(line => line.includes('xxxxxxxx')),
      beforeLastPage,
      decisions,
    }).toStrictEqual({ command: true, reason: false, beforeLastPage: [], decisions: [true] })
  })

  it('needs an explicit yes from the host', async () => {
    const ask = async (answer: unknown) =>
      confirmCapturedAction(
        denial(),
        REASON,
        rpc(async () => answer),
        new AbortController().signal,
        vi.fn(),
      )

    expect([await ask(true), await ask(false), await ask('true')]).toStrictEqual([
      'approved',
      'rejected',
      'unavailable',
    ])
  })

  it('cannot be shown without an interactive or RPC UI', async () => {
    const outcome = await confirmCapturedAction(
      denial(),
      REASON,
      { ...rpc(async () => true), mode: 'print', hasUI: false },
      new AbortController().signal,
      vi.fn(),
    )

    expect(outcome).toBe('unavailable')
  })

  it('stops waiting after five minutes', async () => {
    vi.useFakeTimers()
    try {
      const pending = confirmCapturedAction(
        denial(),
        REASON,
        rpc(async () => new Promise(() => {})),
        new AbortController().signal,
        vi.fn(),
      )
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      expect(await pending).toBe('timed-out')
    } finally {
      vi.useRealTimers()
    }
  })
})
