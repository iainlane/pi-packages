import type { AutoReviewConfig } from '../src/config/config.js'
import type { ReviewModelRegistry } from '../src/reviewer/model.js'
import type { EvaluationOptions } from './controls.js'
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { resolveReviewModel } from '../src/reviewer/model.js'
import { evaluationOptions, InferenceBudget } from './controls.js'

/** A read-only copy of one stored credential, which the run can neither refresh nor change */
export class EvaluationCredentials implements CredentialStore {
  private readonly provider: string
  private readonly credential: Credential | undefined

  constructor(provider: string, credential: Credential | undefined) {
    if (credential?.type === 'api_key' && (credential.key?.startsWith('!') || credential.key?.includes('$'))) {
      throw new Error(
        'Live evaluation requires direct credentials; configured key commands and templates are not executed',
      )
    }
    if (credential?.type === 'oauth' && credential.expires <= Date.now() + 300_000) {
      throw new Error(
        'Reviewer credentials need refresh. Refresh them through Pi before opting in; this suite cannot change auth.json',
      )
    }
    this.provider = provider
    this.credential = structuredClone(credential)
  }

  async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted()

    return provider === this.provider ? structuredClone(this.credential) : undefined
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted()

    return this.credential === undefined ? [] : [{ providerId: this.provider, type: this.credential.type }]
  }

  async modify(
    _provider: string,
    _callback: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    throw new Error('Live evaluation cannot refresh or modify stored credentials')
  }

  async delete(_provider: string, _options?: AuthOperationOptions): Promise<void> {
    throw new Error('Live evaluation cannot delete stored credentials')
  }
}

export interface LiveEvaluationRuntime {
  options: EvaluationOptions
  config: AutoReviewConfig
  budget: InferenceBudget
  registry: ReviewModelRegistry
  close: () => void
}

export async function createLiveEvaluation(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<LiveEvaluationRuntime> {
  const options = evaluationOptions(environment)
  const { ModelRegistry, ModelRuntime, readStoredCredential } = await import('@earendil-works/pi-coding-agent')
  const { InMemoryModelsStore, cleanupSessionResources } = await import('@earendil-works/pi-ai')
  let credential: Credential | undefined
  try {
    credential = readStoredCredential(options.provider)
  } catch {
    throw new Error('Cannot read the selected reviewer credential; check Pi authentication before opting in')
  }
  const models = await ModelRuntime.create({
    credentials: new EvaluationCredentials(options.provider, credential),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  const actual = new ModelRegistry(models)
  const config = { ...DEFAULT_CONFIG, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs }
  const selected = resolveReviewModel(actual, config)
  if (!selected.ok) {
    throw new Error(`Live reviewer selection failed: ${selected.category}`)
  }
  try {
    if ((await models.getAuth(selected.value)) === undefined) {
      throw new Error('Missing reviewer credentials')
    }
  } catch {
    throw new Error(
      'Cannot authenticate the selected reviewer; this suite cannot refresh credentials or execute key commands',
    )
  }
  const sessions = new Set<string>()
  const budget = new InferenceBudget(options.maxRequests)
  const registry: ReviewModelRegistry = {
    getProvider: provider => actual.getProvider(provider),
    getAll: () => actual.getAll(),
    find: (provider, model) => actual.find(provider, model),
    streamSimple(model, context, streamOptions) {
      budget.take()
      if (streamOptions?.sessionId !== undefined) {
        sessions.add(streamOptions.sessionId)
      }

      return actual.streamSimple(model, context, streamOptions)
    },
  }

  return {
    options,
    config,
    budget,
    registry,
    close() {
      for (const session of sessions) {
        cleanupSessionResources(session)
      }
      sessions.clear()
    },
  }
}
