import type { ReviewModelRegistry } from '../../src/reviewer/model.js'
import type { Api, Model } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { resolveReviewModel } from '../../src/reviewer/model.js'

const PROVIDERS = [
  { provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
]

function template(provider: string, api: Api, baseUrl: string): Model<Api> {
  return {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    provider,
    api,
    baseUrl,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_000,
  }
}

it.each(PROVIDERS.flatMap(provider => ['registry', 'provider'].map(source => ({ ...provider, source }))))(
  'derives the hidden reviewer for $provider from the $source catalogue',
  ({ provider, api, baseUrl, source }) => {
    const model = template(provider, api, baseUrl)
    const registry: Pick<ReviewModelRegistry, 'getProvider' | 'getAll' | 'find'> = {
      getProvider: () => ({ getModels: () => (source === 'provider' ? [model] : []) }),
      find: () => undefined,
      getAll: () => (source === 'registry' ? [model] : []),
    }

    expect(resolveReviewModel(registry, { ...DEFAULT_CONFIG, provider })).toStrictEqual({
      ok: true,
      value: { ...model, id: 'codex-auto-review', name: 'Codex Auto Review', reasoning: true, input: ['text'] },
      derived: true,
    })
  },
)

it.each([
  { provider: 'custom', model: 'codex-auto-review' },
  { provider: 'openai', model: 'unknown-model' },
  { provider: 'openai', model: 'codex-auto-review' },
])('does not derive $provider/$model from another provider', ({ provider, model }) => {
  const other = template('openai-codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api')

  expect(
    resolveReviewModel(
      { getProvider: () => ({ getModels: () => [] }), find: () => undefined, getAll: () => [other] },
      { ...DEFAULT_CONFIG, provider, model },
    ),
  ).toStrictEqual({ ok: false, category: 'model-unresolved' })
})

it('uses a registered reviewer model without deriving it', () => {
  const model = template('openai', 'openai-responses', 'https://api.openai.com/v1')
  model.id = 'codex-auto-review'

  expect(
    resolveReviewModel(
      { getProvider: () => ({ getModels: () => [] }), find: () => model, getAll: () => [] },
      { ...DEFAULT_CONFIG, provider: 'openai' },
    ),
  ).toStrictEqual({ ok: true, value: model, derived: false })
})

it('reports a missing provider', () => {
  expect(
    resolveReviewModel({ getProvider: () => undefined, find: () => undefined, getAll: () => [] }, DEFAULT_CONFIG),
  ).toStrictEqual({ ok: false, category: 'provider-unresolved' })
})
