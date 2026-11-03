import type { JsonValue } from '../../src/action/json.js'
import { Type } from 'typebox'
import * as v from 'valibot'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  checkJson,
  inputDigest,
  jsonValueSchema,
  parseJsonObject,
  parseJsonValue,
  projectSdkJson,
} from '../../src/action/json.js'

const cycle: Record<string, unknown> = {}
cycle['self'] = cycle
const nonEnumerable = Object.defineProperty({}, 'hidden', { value: 1 })
const extraArray = Object.assign([1], { extra: 2 })
const sparseArray: unknown[] = []
sparseArray.length = 1
const fractionalArray: unknown[] = []
fractionalArray.length = 1
Object.defineProperty(fractionalArray, '0.5', { value: 1, enumerable: true })

describe('strict JSON boundary', () => {
  it('validates JSON without loading the provider SDK', async () => {
    vi.resetModules()
    vi.doMock('@earendil-works/pi-ai', () => {
      throw new Error('JSON validation must not load the provider SDK')
    })
    try {
      const boundary = await import('../../src/action/json.js')
      const input = { count: 3, enabled: false }
      expect(boundary.parseJsonObject(input)).toStrictEqual(input)
    } finally {
      vi.doUnmock('@earendil-works/pi-ai')
      vi.resetModules()
    }
  })

  it.each([
    { name: 'undefined', value: undefined },
    { name: 'non-finite number', value: Number.NaN },
    { name: 'infinity', value: Infinity },
    { name: 'bigint', value: 1n },
    { name: 'function', value: () => 1 },
    { name: 'symbol', value: Symbol('value') },
    { name: 'date', value: new Date(0) },
    { name: 'map', value: new Map([['value', 1]]) },
    { name: 'cycle', value: cycle },
    { name: 'undefined object field', value: { field: undefined } },
    { name: 'symbol field', value: { [Symbol('hidden')]: 1 } },
    { name: 'non-enumerable field', value: nonEnumerable },
    { name: 'sparse array', value: sparseArray },
    { name: 'extra array field', value: extraArray },
    { name: 'fractional array index', value: fractionalArray },
    { name: 'toJSON conversion', value: { toJSON: () => ({ converted: true }) } },
  ])('rejects $name without normalisation', ({ value }) => {
    expect(() => parseJsonValue(value)).toThrow('Expected JSON data')
  })

  it('preserves complete JSON objects and shared values without cloning or dropping keys', () => {
    const shared = { finite: 3, enabled: false, text: 'exact', nil: null, array: [1, '2'] }
    const input = { ['__proto__']: { exact: true }, left: shared, right: shared }
    const parsed = parseJsonObject(input)

    expect({ same: parsed === input, parsed, ownProto: Object.hasOwn(parsed, '__proto__') }).toStrictEqual({
      same: true,
      parsed: input,
      ownProto: true,
    })
  })

  it('does not invoke accessors while deciding whether input is JSON', () => {
    const getter = vi.fn(() => 'changed')
    const input = Object.defineProperty({}, 'command', { get: getter, enumerable: true })

    expect(() => parseJsonObject(input)).toThrow('Expected JSON data')
    expect(getter.mock.calls).toStrictEqual([])
  })

  it('checks schemas without coercion, field removal or optional-null removal', () => {
    const schema = v.strictObject({ count: v.number(), enabled: v.boolean(), note: v.optional(v.string()) })
    const original = { count: '3', enabled: 'false', note: null }

    expect({
      coerced: checkJson(schema, original),
      original,
      extra: checkJson(schema, { count: 3, enabled: false, extra: 'retained' }),
      exact: checkJson(schema, { count: 3, enabled: false }),
      cycle: checkJson(jsonValueSchema, cycle),
    }).toStrictEqual({
      coerced: false,
      original: { count: '3', enabled: 'false', note: null },
      extra: false,
      exact: true,
      cycle: false,
    })
  })
})

describe('json digests', () => {
  it('requires a JSON value at the type boundary', () => {
    expectTypeOf<Parameters<typeof inputDigest>[0]>().toEqualTypeOf<JsonValue>()
  })

  it.each([
    {
      input: { command: 'printf captured', timeout: 17, extra: { exact: 'preserved' } },
      expected: '992cd63cbf36bfaa16b7a0069d6ef2e9143a735cfce501e81bdf45a631d65d6c',
    },
    {
      input: { ['__proto__']: { nested: 'complete' }, '10': 'ten', '2': 'two' },
      expected: 'b4e31ed89e9d1acb5ccda38d346eb7cd1ed4b75e0bf1134a0eca7e26db472d05',
    },
    { input: null, expected: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b' },
  ])('keeps the digest $expected for equal data', ({ input, expected }) => {
    expect(inputDigest(input)).toBe(expected)
  })

  it.each([Number.NaN, Infinity, -Infinity])('rejects non-finite numbers without hashing them as null: %s', value => {
    expect(() => inputDigest({ value })).toThrow('Expected JSON data')
  })

  it('keeps types, extra fields and array order in the identity', () => {
    const inputs = [
      { value: '3' },
      { value: 3 },
      { value: false },
      { value: 'false' },
      { value: 3, extra: true },
      { value: [1, 2] },
      { value: [2, 1] },
    ]

    expect(new Set(inputs.map(input => inputDigest(input))).size).toBe(inputs.length)
  })
})

describe('sdk metadata projection', () => {
  it('projects TypeBox annotations and optional metadata to their JSON form', () => {
    const schema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) })

    expect(
      projectSdkJson({ parameters: schema, baseDir: undefined, nested: { absent: undefined, present: false } }),
    ).toStrictEqual({
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeout: { type: 'number' } },
        required: ['command'],
      },
      nested: { present: false },
    })
  })

  it('keeps a digest of projected tool metadata stable', () => {
    const metadata = {
      sourceInfo: {
        path: 'builtin:fixture',
        source: 'builtin',
        scope: 'user',
        origin: 'top-level',
        baseDir: undefined,
      },
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    }

    expect(inputDigest(projectSdkJson(metadata))).toBe(
      '9a1fbd8ebea3972077278419430c574595c6778ad7ee1e4e84c8d0221ef7f3f0',
    )
  })

  it('does not invoke an array accessor during projection', () => {
    const getter = vi.fn(() => 1)
    const input = [0]
    Object.defineProperty(input, '0', { get: getter, enumerable: true })

    expect(() => projectSdkJson(input)).toThrow('Expected JSON data')
    expect(getter.mock.calls).toStrictEqual([])
  })

  it.each([new Date(0), Number.NaN, { default: () => 'changed' }, [undefined]])(
    'rejects unsupported metadata without coercion: %j',
    value => {
      expect(() => projectSdkJson(value)).toThrow('Expected JSON data')
    },
  )
})
