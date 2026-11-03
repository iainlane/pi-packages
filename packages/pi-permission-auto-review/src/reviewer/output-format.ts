import type { Api, StreamOptions } from '@earendil-works/pi-ai'

export type JsonSchema = Record<string, unknown>

type PayloadHook = NonNullable<StreamOptions['onPayload']>

// The name that Codex's reviewer gives its output schema
const SCHEMA_NAME = 'codex_output_schema'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {}
}

/** OpenAI's strict mode requires every property, so the optional ones become required there */
function strict(schema: JsonSchema): JsonSchema {
  return { ...schema, required: Object.keys(record(schema['properties'])) }
}

/**
 * Adds the API family's native request field for a JSON final answer to each provider payload. Other families
 * receive only the prompt's instructions, and the reply is validated locally either way
 */
export function outputFormatHook(api: Api, schema: JsonSchema): PayloadHook | undefined {
  switch (api) {
    case 'openai-codex-responses':
      // As Codex sends it: not strict, so the optional fields stay optional
      return payload => {
        const request = record(payload)

        return {
          ...request,
          text: {
            ...record(request['text']),
            format: { type: 'json_schema', name: SCHEMA_NAME, strict: false, schema },
          },
        }
      }
    case 'openai-responses':
    case 'azure-openai-responses':
      return payload => {
        const request = record(payload)
        const format = { type: 'json_schema', name: SCHEMA_NAME, strict: true, schema: strict(schema) }

        return {
          ...request,
          // Azure's structured outputs do not support parallel tool calls
          ...(api === 'azure-openai-responses' ? { parallel_tool_calls: false } : {}),
          text: { ...record(request['text']), format },
        }
      }
    case 'openai-completions':
      return payload => ({
        ...record(payload),
        response_format: {
          type: 'json_schema',
          json_schema: { name: SCHEMA_NAME, strict: true, schema: strict(schema) },
        },
      })
    case 'anthropic-messages':
      return payload => {
        const request = record(payload)

        return {
          ...request,
          output_config: { ...record(request['output_config']), format: { type: 'json_schema', schema } },
        }
      }
    case 'google-generative-ai':
    case 'google-vertex':
      return payload => {
        const request = record(payload)
        // The two schema fields of GenerateContent are mutually exclusive
        const { responseSchema: _replaced, ...config } = record(request['config'])

        return { ...request, config: { ...config, responseMimeType: 'application/json', responseJsonSchema: schema } }
      }
    case 'bedrock-converse-stream':
    case 'mistral-conversations':
    case 'pi-messages':
    default:
      return undefined
  }
}
