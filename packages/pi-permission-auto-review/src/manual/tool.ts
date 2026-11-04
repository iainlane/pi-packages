import type { ManualApprovalController } from './controller.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { MANUAL_APPROVAL_TOOL, MAX_REASON_CHARACTERS } from './controller.js'

export function registerManualApprovalTool(pi: ExtensionAPI, controller: ManualApprovalController): void {
  pi.registerTool({
    name: MANUAL_APPROVAL_TOOL,
    label: 'Request manual approval',
    description:
      'Ask the person to run a shell command that automatic review refused, using the denial_id from the refusal. Give a reason why the command is needed. If they approve, the original command runs once, exactly as captured, through the normal permission checks. No other command or arguments are accepted. Needs an interactive session.',
    parameters: Type.Object(
      {
        denial_id: Type.String({ minLength: 1, maxLength: 200 }),
        reason: Type.String({ minLength: 1, maxLength: MAX_REASON_CHARACTERS }),
      },
      { additionalProperties: false },
    ),
    exposure: 'model-only',
    executionMode: 'sequential',
    reachesTools: () => ['bash'],
    execute: async (id, input, signal, _update, ctx) => controller.execute(id, input, signal, ctx),
  })
}
