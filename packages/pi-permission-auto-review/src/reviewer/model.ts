import type { AutoReviewConfig } from '../config/config.js'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import { CODEX_AUTO_REVIEW_MODEL, CODEX_PROVIDER } from '../config/config.js'

/** The parts of Pi's model registry that a review uses */
export interface ReviewModelRegistry {
  getProvider: (
    provider: string,
  ) => Pick<NonNullable<ReturnType<ModelRegistry['getProvider']>>, 'getModels'> | undefined
  getAll: ModelRegistry['getAll']
  find: ModelRegistry['find']
  streamSimple: ModelRegistry['streamSimple']
}

export type ResolveReviewModelResult =
  | { ok: true; value: Model<Api> }
  | { ok: false; category: 'provider-unresolved' | 'model-unresolved' }

const CODEX_API = 'openai-codex-responses'

/** `codex-auto-review` is hidden from the registry, so it is derived from another model of the Codex provider */
export function resolveReviewModel(
  registry: Pick<ReviewModelRegistry, 'getProvider' | 'getAll' | 'find'>,
  config: AutoReviewConfig,
): ResolveReviewModelResult {
  const provider = registry.getProvider(config.provider)
  if (provider === undefined) {
    return { ok: false, category: 'provider-unresolved' }
  }
  const registered = registry.find(config.provider, config.model)
  if (registered !== undefined) {
    return { ok: true, value: registered }
  }
  if (config.provider !== CODEX_PROVIDER || config.model !== CODEX_AUTO_REVIEW_MODEL) {
    return { ok: false, category: 'model-unresolved' }
  }

  const template =
    registry.getAll().find(model => model.provider === CODEX_PROVIDER && model.api === CODEX_API) ??
    provider.getModels().find(model => model.api === CODEX_API)

  return template === undefined
    ? { ok: false, category: 'model-unresolved' }
    : {
        ok: true,
        value: {
          ...template,
          id: CODEX_AUTO_REVIEW_MODEL,
          name: 'Codex Auto Review',
          reasoning: true,
          input: ['text'],
        },
      }
}
