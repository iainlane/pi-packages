import type { CaseEvaluation } from './pipeline.js'
import type { LiveEvaluationRuntime } from './runtime.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { evaluationOptions } from './controls.js'
import { loadReplayFixtures } from './corpus.js'
import { EvaluationFailure, evaluateFixture } from './pipeline.js'
import { createLiveEvaluation } from './runtime.js'

const options = evaluationOptions(process.env)
const fixtures = loadReplayFixtures(fileURLToPath(new URL('./fixtures', import.meta.url)))
const results: CaseEvaluation[] = []
let runtime: LiveEvaluationRuntime | undefined
let infrastructureFailure: { caseId: string | null; category: string } | undefined

beforeAll(async () => {
  try {
    runtime = await createLiveEvaluation(process.env)
  } catch {
    infrastructureFailure = { caseId: null, category: 'reviewer-setup-failed' }
    throw new Error(
      'Live reviewer setup failed. Check the selected model and ready Pi credentials; this suite cannot refresh authentication',
    )
  }
})

afterAll(() => {
  runtime?.close()
  const report = fileURLToPath(new URL('./artifacts/latest.json', import.meta.url))
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(
    report,
    `${JSON.stringify(
      {
        version: 2,
        scope: 'permission-classification',
        requested: options,
        plannedCases: fixtures.length,
        inferenceAttempts: runtime?.budget.used ?? 0,
        infrastructureFailure: infrastructureFailure ?? null,
        results,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
})

it(
  'classifies permission fixtures through the production reviewer',
  async () => {
    if (runtime === undefined) {
      throw new Error('Live reviewer was not initialised')
    }
    for (const fixture of fixtures) {
      try {
        results.push(await evaluateFixture(fixture, runtime.registry, runtime.config))
      } catch (error) {
        infrastructureFailure = {
          caseId: fixture.id,
          category: error instanceof EvaluationFailure ? error.category : 'evaluation-failed',
        }
        throw new Error(
          `Live evaluation stopped at ${fixture.id}: ${infrastructureFailure.category}. This is not a policy denial`,
        )
      }
    }
    expect(
      results
        .filter(result => !result.matched)
        .map(result => ({ caseId: result.caseId, expected: result.expected, actual: result.outcome })),
    ).toStrictEqual([])
  },
  options.timeoutMs * fixtures.length + 30_000,
)
