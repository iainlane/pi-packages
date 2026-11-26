import type { CapturedInvocation } from '../action/capture.js'
import type { PermissionsService } from '@gotgenes/pi-permission-system'
import type { EscalationRequest, SandboxClient, SandboxContext } from 'pi-bring-your-own-sandbox/consumer'
import { escapeTerminalText } from '../terminal.js'

const TOOL_NAME = 'powershell'

function formatEscalation({ destination, access, command, justification }: EscalationRequest): string {
  const restrictions =
    destination.kind === 'host'
      ? 'Destination: host. Effective restrictions: none. The command runs without a sandbox.'
      : `Destination: ${escapeTerminalText(destination.providerId)}. Effective restrictions: ${escapeTerminalText(destination.effectiveRestrictions)}`

  return [
    restrictions,
    `Requested access: ${escapeTerminalText(JSON.stringify(access))}`,
    `Command: ${escapeTerminalText(command)}`,
    `Agent's justification: ${escapeTerminalText(justification)}`,
  ].join('\n')
}

interface FormatterRegistration {
  service: PermissionsService
  dispose: () => void
}

export class PowerShellEscalationPreview {
  private readonly client: Pick<SandboxClient, 'findShellReviewSource'>
  private readonly warn: (message: string) => void
  private requests = new WeakMap<Record<string, unknown>, EscalationRequest>()
  private readonly inputs = new Map<string, Record<string, unknown>>()
  private registration: FormatterRegistration | undefined
  private registrationFailed = false

  constructor(client: Pick<SandboxClient, 'findShellReviewSource'>, warn: (message: string) => void) {
    this.client = client
    this.warn = warn
  }

  start(): void {
    this.stop()
    this.registrationFailed = false
  }

  connect(service: PermissionsService | undefined): void {
    if (this.registration?.service === service) return

    this.stop()
    if (service === undefined || this.registrationFailed) return

    try {
      const dispose = service.registerToolInputFormatter(TOOL_NAME, input => {
        const request = this.requests.get(input)
        return request === undefined ? undefined : formatEscalation(request)
      })
      this.registration = { service, dispose }
    } catch (error) {
      this.registrationFailed = true
      const reason = error instanceof Error ? error.message : 'Unknown error'
      this.warn(`failed to register the PowerShell escalation formatter: ${escapeTerminalText(reason)}`)
    }
  }

  capture(
    { toolName, toolCallId }: Pick<CapturedInvocation, 'toolName' | 'toolCallId'>,
    context: SandboxContext,
    input: Record<string, unknown>,
  ): void {
    if (this.registration === undefined || toolName !== TOOL_NAME || input['escalate'] === undefined) return

    this.end(toolCallId)
    let lookup: ReturnType<SandboxClient['findShellReviewSource']>
    try {
      lookup = this.client.findShellReviewSource(context, { toolName, toolCallId })
    } catch {
      return
    }
    const request = lookup.ok ? lookup.source.escalation : undefined
    if (request?.toolCallId !== toolCallId) return

    this.inputs.set(toolCallId, input)
    this.requests.set(input, request)
  }

  end(toolCallId: string): void {
    const input = this.inputs.get(toolCallId)
    if (input === undefined) return

    this.inputs.delete(toolCallId)
    if (this.requests.get(input)?.toolCallId === toolCallId) {
      this.requests.delete(input)
    }
  }

  stop(): void {
    this.registration?.dispose()
    this.registration = undefined
    this.requests = new WeakMap()
    this.inputs.clear()
  }
}
