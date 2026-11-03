import { describe, expect, it } from 'vitest'
import { INTERACTION_ADAPTERS } from '../../../src/presets/codex/interactions.js'
import { INTERACTION_CASES } from './interaction-fixtures.js'

describe('interaction adapters', () => {
  it.each(INTERACTION_CASES)('$toolName: $description', ({ toolName, details, evidence }) => {
    const adapter = INTERACTION_ADAPTERS.find(candidate => candidate.toolName === toolName)

    expect({ toolName: adapter?.toolName, evidence: adapter?.render(details) }).toStrictEqual({ toolName, evidence })
  })
})
