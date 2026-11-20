import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import type { SandboxContext, SandboxHost, ShellReviewSource } from 'pi-bring-your-own-sandbox/api'
import { findShellReviewSource, hasShellReviewRoute } from 'pi-bring-your-own-sandbox/api'

export type ProposedTool = Pick<PromptPermissionDetails, 'source' | 'toolCallId' | 'toolName' | 'forwarding'>

export interface ReviewRoutes {
  available: (pi: SandboxHost) => boolean
  resolve: (pi: SandboxHost, context: SandboxContext, tool: ProposedTool) => ShellReviewSource | undefined
}

export const reviewRoutes: ReviewRoutes = {
  available: hasShellReviewRoute,
  resolve(pi, context, tool) {
    if (
      tool.forwarding !== undefined ||
      tool.source !== 'tool_call' ||
      tool.toolCallId === undefined ||
      tool.toolCallId === '' ||
      tool.toolName === undefined ||
      tool.toolName === ''
    ) {
      return undefined
    }

    return findShellReviewSource(pi, context, { toolName: tool.toolName, toolCallId: tool.toolCallId })
  },
}
