import { describe, expect, it } from 'vitest'
import { outputFormatHook } from '../../src/reviewer/output-format.js'

const SCHEMA = {
  type: 'object',
  properties: { outcome: { enum: ['allow', 'deny'] }, rationale: { type: 'string' } },
  required: ['outcome'],
  additionalProperties: false,
}
const STRICT = { ...SCHEMA, required: ['outcome', 'rationale'] }

describe('native output formats', () => {
  it.each([
    {
      api: 'openai-codex-responses',
      payload: { text: { verbosity: 'low' } },
      sent: {
        text: {
          verbosity: 'low',
          format: { type: 'json_schema', name: 'codex_output_schema', strict: false, schema: SCHEMA },
        },
      },
    },
    {
      api: 'openai-responses',
      payload: {},
      sent: { text: { format: { type: 'json_schema', name: 'codex_output_schema', strict: true, schema: STRICT } } },
    },
    {
      api: 'azure-openai-responses',
      payload: {},
      sent: {
        parallel_tool_calls: false,
        text: { format: { type: 'json_schema', name: 'codex_output_schema', strict: true, schema: STRICT } },
      },
    },
    {
      api: 'openai-completions',
      payload: {},
      sent: {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'codex_output_schema', strict: true, schema: STRICT },
        },
      },
    },
    {
      api: 'anthropic-messages',
      payload: { output_config: { effort: 'low' } },
      sent: { output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } },
    },
    {
      api: 'google-generative-ai',
      payload: { config: { responseSchema: {}, temperature: 0 } },
      sent: { config: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: SCHEMA } },
    },
  ])('asks $api for JSON in its own request field', async ({ api, payload, sent }) => {
    const hook = outputFormatHook(api, SCHEMA)

    expect(await hook?.(payload, {} as never)).toStrictEqual(sent)
  })

  it.each(['bedrock-converse-stream', 'mistral-conversations', 'pi-messages', 'custom-api'])(
    'leaves %s to the prompt alone',
    api => {
      expect(outputFormatHook(api, SCHEMA)).toBeUndefined()
    },
  )
})
