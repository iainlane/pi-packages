import { describe, expect, it } from 'vitest'
import { InvocationGrants } from '../../src/manual/grants.js'

const IDENTITY = {
  toolName: 'bash',
  cwd: '/workspace',
  sessionId: 'session-1',
  digest: 'digest',
  registrationDigest: 'registration',
}

describe('invocation grants', () => {
  it('allows the asks of the first matching child of the wrapper, and nothing else', () => {
    const grants = new InvocationGrants()
    const handle = grants.arm('wrapper', IDENTITY, () => true)

    expect({
      bound: grants.observe('wrapper/1', 'wrapper', IDENTITY),
      child: grants.authorize('wrapper/1', IDENTITY),
      sibling: grants.observe('wrapper/2', 'wrapper', IDENTITY),
      unrelated: grants.authorize('other', IDENTITY),
      childId: handle.childToolCallId,
    }).toStrictEqual({
      bound: undefined,
      child: { kind: 'allow' },
      sibling: { block: true, reason: 'Manual approval does not match this invocation' },
      unrelated: undefined,
      childId: 'wrapper/1',
    })
  })

  it.each([
    { change: 'the input', identity: { ...IDENTITY, digest: 'other' } },
    { change: 'the working directory', identity: { ...IDENTITY, cwd: '/elsewhere' } },
    { change: 'the tool registration', identity: { ...IDENTITY, registrationDigest: 'other' } },
  ])('blocks a child whose identity differs in $change', ({ identity }) => {
    const grants = new InvocationGrants()
    grants.arm('wrapper', IDENTITY, () => true)

    expect(grants.observe('wrapper/1', 'wrapper', identity)).toStrictEqual({
      block: true,
      reason: 'Manual approval does not match this invocation',
    })
  })

  it('denies once the approval is no longer current or has been revoked', () => {
    let current = true
    const grants = new InvocationGrants()
    const handle = grants.arm('wrapper', IDENTITY, () => current)
    grants.observe('wrapper/1', 'wrapper', IDENTITY)
    current = false
    const stale = grants.authorize('wrapper/1', IDENTITY)
    handle.revoke()

    expect({ stale, revoked: grants.authorize('wrapper/1', IDENTITY) }).toStrictEqual({
      stale: { kind: 'deny', reason: 'Manual approval is no longer valid for this invocation' },
      revoked: undefined,
    })
  })
})
