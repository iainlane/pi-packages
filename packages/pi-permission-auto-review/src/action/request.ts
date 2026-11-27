import type { CapturedInvocation } from './capture.js'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'

export interface DirectEscalationRequest {
  source: 'byos_escalation'
  toolName: 'bash' | 'powershell'
  toolCallId: string
  forwarding?: never
}

export type ReviewRequest = PromptPermissionDetails | DirectEscalationRequest

export function escalationCall(capture: CapturedInvocation | undefined): DirectEscalationRequest | undefined {
  if (capture === undefined || capture.digest === undefined || capture.input?.['escalate'] === undefined) return

  const { toolName, toolCallId } = capture
  if (toolName !== 'bash' && toolName !== 'powershell') return undefined

  return { source: 'byos_escalation', toolName, toolCallId }
}
