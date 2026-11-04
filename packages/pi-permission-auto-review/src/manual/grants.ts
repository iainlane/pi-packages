import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { AuthorizerVerdict } from '@gotgenes/pi-permission-system'

/** What a manual approval approves: one tool, in one working directory and session, with one input and registration */
export interface InvocationIdentity {
  readonly toolName: string
  readonly cwd: string
  readonly sessionId: string
  readonly digest: string
  readonly registrationDigest: string
}

interface Grant {
  wrapperToolCallId: string
  identity: InvocationIdentity
  isCurrent: () => boolean
  childToolCallId: string | undefined
  revoked: boolean
}

export interface GrantHandle {
  readonly childToolCallId: string | undefined
  revoke: () => void
}

function sameIdentity(expected: InvocationIdentity, actual: InvocationIdentity): boolean {
  return (Object.keys(expected) as (keyof InvocationIdentity)[]).every(key => expected[key] === actual[key])
}

const BLOCKED: ToolCallEventResult = { block: true, reason: 'Manual approval does not match this invocation' }

/**
 * Single-use approvals for the nested call that a `request_manual_approval` call dispatches. A grant binds to the
 * first child of its wrapper with the approved identity, and allows that child only
 */
export class InvocationGrants {
  private readonly wrappers = new Map<string, Grant>()
  private readonly children = new Map<string, Grant>()

  arm(wrapperToolCallId: string, identity: InvocationIdentity, isCurrent: () => boolean): GrantHandle {
    if (this.wrappers.has(wrapperToolCallId)) {
      throw new Error('A manual approval is already armed for this call')
    }
    const grant: Grant = { wrapperToolCallId, identity, isCurrent, childToolCallId: undefined, revoked: false }
    this.wrappers.set(wrapperToolCallId, grant)

    return {
      get childToolCallId() {
        return grant.childToolCallId
      },
      revoke: () => this.revoke(grant),
    }
  }

  /** Binds the wrapper's child to its grant at capture, or blocks a child that does not match */
  observe(
    toolCallId: string,
    parentToolCallId: string | undefined,
    identity: InvocationIdentity | undefined,
  ): ToolCallEventResult | undefined {
    const grant = parentToolCallId === undefined ? undefined : this.wrappers.get(parentToolCallId)
    if (grant === undefined) {
      return undefined
    }
    if (
      grant.childToolCallId !== undefined ||
      this.children.has(toolCallId) ||
      !this.current(grant) ||
      identity === undefined ||
      !sameIdentity(grant.identity, identity)
    ) {
      this.revoke(grant)
      return BLOCKED
    }
    grant.childToolCallId = toolCallId
    this.children.set(toolCallId, grant)

    return undefined
  }

  /** The verdict for an ask of a bound child, or undefined for any other call */
  authorize(
    toolCallId: string,
    identity: InvocationIdentity | undefined,
  ): Exclude<AuthorizerVerdict, { kind: 'defer' }> | undefined {
    const grant = this.children.get(toolCallId)
    if (grant === undefined) {
      return undefined
    }
    if (!this.current(grant) || identity === undefined || !sameIdentity(grant.identity, identity)) {
      this.revoke(grant)
      return { kind: 'deny', reason: 'Manual approval is no longer valid for this invocation' }
    }

    return { kind: 'allow' }
  }

  revokeAll(): void {
    for (const grant of this.wrappers.values()) {
      grant.revoked = true
    }
    this.wrappers.clear()
    this.children.clear()
  }

  private current(grant: Grant): boolean {
    if (!grant.revoked && !grant.isCurrent()) {
      grant.revoked = true
    }

    return !grant.revoked
  }

  private revoke(grant: Grant): void {
    grant.revoked = true
    if (this.wrappers.get(grant.wrapperToolCallId) === grant) {
      this.wrappers.delete(grant.wrapperToolCallId)
    }
    if (grant.childToolCallId !== undefined && this.children.get(grant.childToolCallId) === grant) {
      this.children.delete(grant.childToolCallId)
    }
  }
}
