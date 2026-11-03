import type { Credential } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { createLiveEvaluation, EvaluationCredentials } from '../../test-live/runtime.js'

describe('live evaluation authentication', () => {
  it('requires opt-in before model or credential setup', async () => {
    await expect(createLiveEvaluation({})).rejects.toThrow('PI_AUTO_REVIEW_LIVE=1')
  })

  it('only exposes a copy of the selected provider credential', async () => {
    const credential: Credential = { type: 'api_key', key: 'not-a-real-key' }
    const storage = new EvaluationCredentials('selected', credential)
    const returned = await storage.read('selected')
    if (returned?.type !== 'api_key') throw new Error('Expected the selected test credential')
    returned.key = 'changed-copy'
    expect({
      selected: await storage.read('selected'),
      other: await storage.read('other'),
      metadata: await storage.list(),
    }).toStrictEqual({
      selected: credential,
      other: undefined,
      metadata: [{ providerId: 'selected', type: 'api_key' }],
    })
  })

  it('refuses credential updates before invoking a refresh callback', async () => {
    const storage = new EvaluationCredentials('selected', undefined)
    const refresh = vi.fn(async (): Promise<Credential | undefined> => undefined)
    await expect(storage.modify('selected', refresh)).rejects.toThrow('cannot refresh or modify')
    await expect(storage.delete('selected')).rejects.toThrow('cannot delete')
    expect(refresh.mock.calls).toStrictEqual([])
  })

  it.each(['!read-from-password-manager', '$TOKEN_FROM_ENV'])('does not execute credential expressions (%s)', key => {
    expect(() => new EvaluationCredentials('selected', { type: 'api_key', key })).toThrow('key commands and templates')
  })

  it('rejects an OAuth credential before it needs refresh', () => {
    expect(
      () =>
        new EvaluationCredentials('selected', {
          type: 'oauth',
          access: 'not-a-real-token',
          refresh: 'not-a-real-refresh-token',
          expires: Date.now(),
        }),
    ).toThrow('credentials need refresh')
  })
})
