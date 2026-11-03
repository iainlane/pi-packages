import { createHash } from 'node:crypto'
import * as v from 'valibot'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface JsonObject {
  [key: string]: JsonValue
}

export const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.string(),
    v.array(jsonValueSchema),
    v.record(v.string(), jsonValueSchema),
  ]),
)
export const jsonObjectSchema: v.GenericSchema<JsonObject> = v.record(v.string(), jsonValueSchema)

export class JsonValueError extends Error {
  constructor() {
    super('Expected JSON data matching the schema')
    this.name = 'JsonValueError'
  }
}

// Schema validation alone accepts accessors, sparse arrays and class instances such as Date, whose JSON form differs
// from the object that a tool would receive
function isJsonData(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false

  const array = Array.isArray(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return false

  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== value.length + 1) return false

  ancestors.add(value)
  try {
    for (const key of keys) {
      if (typeof key !== 'string') return false
      if (array && key === 'length') continue
      if (array && (String(Number(key)) !== key || !Number.isInteger(Number(key)) || Number(key) < 0)) return false

      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false
      if (!isJsonData(descriptor.value, ancestors)) return false
    }

    return true
  } finally {
    ancestors.delete(value)
  }
}

export function checkJson<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
): value is v.InferOutput<TSchema> {
  try {
    return isJsonData(value, new WeakSet()) && v.is(schema, value)
  } catch {
    return false
  }
}

export function parseJsonValue(value: unknown): JsonValue {
  if (!checkJson(jsonValueSchema, value)) throw new JsonValueError()

  return value
}

export function parseJsonObject(value: unknown): JsonObject {
  if (!checkJson(jsonObjectSchema, value)) throw new JsonValueError()

  return value
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const fields = Object.entries(value)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)

  return `{${fields.join(',')}}`
}

/** A digest that is equal for equal JSON data, whatever the order of object keys */
export function inputDigest(input: JsonValue): string {
  return createHash('sha256')
    .update(canonicalJson(parseJsonValue(input)))
    .digest('hex')
}

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeDeep(child)
    }
    Object.freeze(value)
  }

  return value
}

function project(value: unknown, ancestors: WeakSet<object>): JsonValue | undefined {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value)) throw new JsonValueError()

  const array = Array.isArray(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new JsonValueError()

  ancestors.add(value)
  try {
    if (array) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new JsonValueError()

      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new JsonValueError()

        const projected = project(descriptor.value, ancestors)
        if (projected === undefined) throw new JsonValueError()

        return projected
      })
    }

    const fields: [string, JsonValue][] = []
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue
      if (!('value' in descriptor)) throw new JsonValueError()

      const projected = project(descriptor.value, ancestors)
      if (projected !== undefined) fields.push([key, projected])
    }

    return Object.fromEntries(fields)
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Projects SDK metadata, such as a tool's TypeBox parameters, to its JSON wire form: symbol-keyed annotations and
 * absent optional fields are dropped, as `JSON.stringify` drops them. Never applied to tool arguments, which must
 * already be JSON data
 */
export function projectSdkJson(value: unknown): JsonValue {
  return parseJsonValue(project(value, new WeakSet()))
}
