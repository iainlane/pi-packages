import type { AppealableAction, DeniedAction } from '../../src/manual/history.js'
import type { ReviewSnapshot } from '../../src/reviewer/snapshot.js'
import { inputDigest } from '../../src/action/json.js'

export function appealableAction(command = 'printf captured'): AppealableAction {
  const input = { command, timeout: 10, extra: { mode: 'captured' } }

  return {
    kind: 'shell',
    toolName: 'bash',
    toolCallId: 'call-1',
    cwd: '/workspace/project',
    sessionId: 'session-1',
    input,
    digest: inputDigest(input),
    registration: {
      sourceInfo: { path: '<builtin>', source: 'builtin', scope: 'user', origin: 'top-level' },
      parametersDigest: 'parameters',
    },
  }
}

export function snapshot(fields: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    branch: [],
    projection: { entries: [] } as never,
    action: undefined,
    authorityRevision: 'authority',
    contextEditRevision: 'edits',
    toolRegistryDigest: 'registry',
    sessionId: 'session-1',
    leafId: null,
    ...fields,
  }
}

export function denial(command?: string): Pick<DeniedAction, 'action' | 'refusal'> {
  return { action: appealableAction(command), refusal: 'Not authorized.' }
}
