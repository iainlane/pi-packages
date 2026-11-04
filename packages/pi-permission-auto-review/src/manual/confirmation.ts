import type { DeniedAction } from './history.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { ExtensionSelectorComponent, truncateToVisualLines } from '@earendil-works/pi-coding-agent'

const CONFIRMATION_TIMEOUT_MS = 5 * 60_000
const FORMAT_CHARACTER = /^\p{Cf}$/u
const REJECT = 'Reject'
const NEXT = 'Next page'
const PREVIOUS = 'Previous page'
const APPROVE = 'Approve once'

export type ConfirmationOutcome = 'approved' | 'rejected' | 'cancelled' | 'unavailable' | 'timed-out'

export type ConfirmationContext = Pick<ExtensionContext, 'mode' | 'hasUI'> & {
  ui: Pick<ExtensionContext['ui'], 'custom'> & {
    confirm: (...args: Parameters<ExtensionContext['ui']['confirm']>) => Promise<unknown>
  }
}

/** Whether a confirmation can be shown at all, which decides whether a refusal offers a manual appeal */
export function canConfirm(ctx: Pick<ExtensionContext, 'mode' | 'hasUI'>): boolean {
  return ctx.hasUI && (ctx.mode === 'tui' || ctx.mode === 'rpc')
}

/** Whether a character could hide or reorder text on a terminal. Newlines are kept, since the prompt splits on them */
function hidden(character: string): boolean {
  const code = character.codePointAt(0) ?? 0

  return (
    (code < 32 && code !== 10) ||
    (code >= 127 && code < 160) ||
    code === 8232 ||
    code === 8233 ||
    FORMAT_CHARACTER.test(character)
  )
}

function escapeControls(text: string): string {
  return [...text]
    .map(character => {
      if (!hidden(character)) {
        return character
      }
      const code = (character.codePointAt(0) ?? 0).toString(16)

      return code.length <= 4 ? `\\u${code.padStart(4, '0')}` : `\\u{${code}}`
    })
    .join('')
}

function indented(text: string): string[] {
  return text.split('\n').map(line => `  ${escapeControls(line)}`)
}

/**
 * The confirmation text: what would run first, then the automatic refusal, and the model's reason last, so a long
 * reason cannot push the command off the first page
 */
export function formatManualPrompt(denial: Pick<DeniedAction, 'action' | 'refusal'>, reason: string): string {
  const { command, ...others } = denial.action.input

  return [
    `Tool: ${escapeControls(denial.action.toolName)}`,
    `Working directory: ${escapeControls(denial.action.cwd)}`,
    'Command:',
    ...indented(command),
    ...(Object.keys(others).length > 0 ? ['Other arguments:', ...indented(JSON.stringify(others, null, 2))] : []),
    'Automatic refusal:',
    ...indented(denial.refusal),
    "The model's reason, which is not your approval:",
    ...indented(reason),
    'Approving runs this exact invocation once.',
  ].join('\n')
}

interface ViewOptions {
  body: string
  height: () => number
  requestRender: () => void
  done: (answer: boolean) => void
}

/** A paged view of the whole prompt. Approval takes effect only once the last page has been shown */
export class ManualApprovalView {
  private readonly options: ViewOptions
  private selector: ExtensionSelectorComponent
  private width: number | undefined
  private lines: string[] = []
  private offset = 0
  private pageHeight = 1
  private sawEnd = false
  private closed = false

  constructor(options: ViewOptions) {
    this.options = options
    this.selector = this.createSelector()
  }

  render(width: number): string[] {
    const height = Math.max(1, this.options.height())
    if (this.width !== width) {
      this.width = width
      this.lines = truncateToVisualLines(
        this.options.body,
        Number.MAX_SAFE_INTEGER,
        Math.max(1, width),
        0,
        'start',
      ).visualLines
    }
    const selector = this.selector.render(width)
    this.pageHeight = height - selector.length - 1
    if (width < 20 || this.pageHeight < 1) {
      return truncateToVisualLines(
        'Enlarge the terminal to review the action. Escape rejects.',
        height,
        Math.max(1, width),
        0,
        'start',
      ).visualLines
    }
    this.offset = Math.min(this.offset, Math.max(0, this.lines.length - 1))
    const last = Math.min(this.lines.length, this.offset + this.pageHeight)
    this.sawEnd ||= last === this.lines.length
    const status = this.sawEnd ? '' : ' · read to the end to approve'

    return [
      `Lines ${this.offset + 1}–${last} of ${this.lines.length}${status}`,
      ...this.lines.slice(this.offset, last),
      ...selector,
    ]
  }

  handleInput(data: string): void {
    if (!this.closed) {
      this.selector.handleInput(data)
    }
  }

  invalidate(): void {
    this.width = undefined
    this.selector.invalidate()
  }

  dispose(): void {
    this.closed = true
    this.selector.dispose()
  }

  private createSelector(): ExtensionSelectorComponent {
    return new ExtensionSelectorComponent(
      'Run this refused action?',
      [REJECT, NEXT, PREVIOUS, APPROVE],
      choice => this.choose(choice),
      () => this.decide(false),
    )
  }

  private choose(choice: string): void {
    if (choice === REJECT || (choice === APPROVE && this.sawEnd)) {
      this.decide(choice === APPROVE)
      return
    }
    if (choice !== NEXT && choice !== PREVIOUS) {
      return
    }
    const delta = choice === NEXT ? this.pageHeight : -this.pageHeight
    this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.lines.length - 1)))
    this.selector.dispose()
    this.selector = this.createSelector()
    this.options.requestRender()
  }

  private decide(answer: boolean): void {
    if (!this.closed) {
      this.closed = true
      this.options.done(answer)
    }
  }
}

async function answer(pending: Promise<unknown>, signal: AbortSignal): Promise<ConfirmationOutcome> {
  const { promise, resolve } = Promise.withResolvers<ConfirmationOutcome>()
  const cancel = (): void => resolve('cancelled')
  signal.addEventListener('abort', cancel, { once: true })
  pending.then(
    value => resolve(value === true ? 'approved' : value === false ? 'rejected' : 'unavailable'),
    () => resolve('unavailable'),
  )
  if (signal.aborted) {
    cancel()
  }
  try {
    return await promise
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Asks the person, defaulting to rejection; only an affirmative answer within five minutes approves */
export async function confirmCapturedAction(
  denial: Pick<DeniedAction, 'action' | 'refusal'>,
  reason: string,
  ctx: ConfirmationContext,
  signal: AbortSignal,
  onShown: () => void,
): Promise<ConfirmationOutcome> {
  if (signal.aborted) {
    return 'cancelled'
  }
  if (!canConfirm(ctx)) {
    return 'unavailable'
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), CONFIRMATION_TIMEOUT_MS)
  timer.unref()
  const combined = AbortSignal.any([signal, deadline.signal])
  const body = formatManualPrompt(denial, reason)
  let outcome: ConfirmationOutcome
  try {
    if (ctx.mode === 'rpc') {
      const pending = ctx.ui.confirm('Run this refused action once?', body, { signal: combined })
      onShown()
      outcome = await answer(pending, combined)
    } else {
      const pending = ctx.ui.custom<unknown>(
        (tui, _theme, _keybindings, done) => {
          const view = new ManualApprovalView({
            body,
            height: () => Math.max(1, Math.floor(tui.terminal.rows * 0.7)),
            requestRender: () => tui.requestRender(),
            done: approved => done(approved && !combined.aborted),
          })
          const cancel = (): void => done(false)
          combined.addEventListener('abort', cancel, { once: true })
          onShown()

          return {
            render: width => view.render(width),
            handleInput: data => view.handleInput(data),
            invalidate: () => view.invalidate(),
            dispose: () => {
              combined.removeEventListener('abort', cancel)
              view.dispose()
            },
          }
        },
        { overlay: true, overlayOptions: { width: '90%', maxHeight: '90%', anchor: 'center' } },
      )
      outcome = await answer(pending, combined)
    }
  } catch {
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }
  if (signal.aborted) {
    return 'cancelled'
  }

  return deadline.signal.aborted ? 'timed-out' : outcome
}
