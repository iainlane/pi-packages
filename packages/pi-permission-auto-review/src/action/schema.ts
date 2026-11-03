import type { JsonObject, JsonValue } from './json.js'
import * as v from 'valibot'
import { checkJson, jsonObjectSchema, jsonValueSchema } from './json.js'

const sourceInfoSchema = v.objectWithRest(
  {
    path: v.string(),
    source: v.string(),
    scope: v.picklist(['user', 'project', 'temporary']),
    origin: v.picklist(['package', 'top-level']),
    baseDir: v.optional(v.string()),
  },
  jsonValueSchema,
)

const registrationSchema = v.strictObject({ sourceInfo: sourceInfoSchema, parametersDigest: v.string() })

export interface ToolRegistration {
  sourceInfo: {
    path: string
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin: 'package' | 'top-level'
    baseDir?: string
    [key: string]: JsonValue
  }
  parametersDigest: string
}

const toolFields = {
  toolName: v.string(),
  toolCallId: v.string(),
  parentToolCallId: v.optional(v.string()),
  cwd: v.string(),
  sessionId: v.string(),
  digest: v.string(),
  registration: v.optional(registrationSchema),
}

const shellInput = v.objectWithRest({ command: v.string(), timeout: v.optional(v.number()) }, jsonValueSchema)
const writeInput = v.objectWithRest({ path: v.string(), content: v.string() }, jsonValueSchema)
const editInput = v.objectWithRest(
  { path: v.string(), edits: v.array(v.objectWithRest({ oldText: v.string(), newText: v.string() }, jsonValueSchema)) },
  jsonValueSchema,
)

const actionSchema = v.variant('kind', [
  v.strictObject({ ...toolFields, kind: v.literal('shell'), input: shellInput }),
  v.strictObject({ ...toolFields, kind: v.literal('file-write'), input: writeInput, resolvedPath: v.string() }),
  v.strictObject({ ...toolFields, kind: v.literal('file-edit'), input: editInput, resolvedPath: v.string() }),
  v.strictObject({
    ...toolFields,
    kind: v.literal('mcp'),
    input: jsonObjectSchema,
    server: v.pipe(v.string(), v.minLength(1)),
    tool: v.pipe(v.string(), v.minLength(1)),
    connectorMetadata: v.literal('unavailable'),
    accountMetadata: v.literal('unavailable'),
  }),
  v.strictObject({ ...toolFields, kind: v.literal('tool'), input: jsonObjectSchema }),
  v.strictObject({
    kind: v.literal('skill'),
    source: v.picklist(['skill_input', 'skill_read']),
    skillName: v.optional(v.string()),
    path: v.optional(v.string()),
    payload: jsonValueSchema,
    digest: v.string(),
  }),
])

interface ToolFields {
  toolName: string
  toolCallId: string
  parentToolCallId?: string | undefined
  cwd: string
  sessionId: string
  digest: string
  registration?: ToolRegistration | undefined
}

/** The complete input of a call, captured before pi-permission-system asked about it, typed by the kind of action */
export type ReviewAction =
  | (ToolFields & { kind: 'shell'; input: JsonObject & { command: string; timeout?: number | undefined } })
  | (ToolFields & { kind: 'file-write'; input: JsonObject & { path: string; content: string }; resolvedPath: string })
  | (ToolFields & {
      kind: 'file-edit'
      input: JsonObject & { path: string; edits: (JsonObject & { oldText: string; newText: string })[] }
      resolvedPath: string
    })
  | (ToolFields & {
      kind: 'mcp'
      input: JsonObject
      server: string
      tool: string
      connectorMetadata: 'unavailable'
      accountMetadata: 'unavailable'
    })
  | (ToolFields & { kind: 'tool'; input: JsonObject })
  | {
      kind: 'skill'
      source: 'skill_input' | 'skill_read'
      skillName?: string | undefined
      path?: string | undefined
      payload: JsonValue
      digest: string
    }

export function isToolRegistration(value: unknown): value is ToolRegistration {
  return checkJson(registrationSchema, value)
}

export function isReviewAction(value: unknown): value is ReviewAction {
  return checkJson(actionSchema, value)
}
