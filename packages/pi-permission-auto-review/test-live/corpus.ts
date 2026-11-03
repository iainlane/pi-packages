import type { JsonValue } from '../src/action/json.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as v from 'valibot'
import { jsonValueSchema } from '../src/action/json.js'

interface ReplayToolCall {
  id: string
  name: string
  arguments: Record<string, JsonValue>
}

export type ReplayMessage =
  | { role: 'user'; text: string; provenance: 'interactive' | 'rpc' | 'extension' | 'uncertain' }
  | { role: 'assistant'; text: string; toolCalls?: ReplayToolCall[] | undefined }
  | { role: 'tool'; text: string; toolName: string; toolCallId: string; isError: boolean }

interface ReplayInput {
  cwd: string
  messages: ReplayMessage[]
  action: { command: string; extraInput: Record<string, JsonValue> }
}

export interface ReplayFixture {
  id: string
  input: ReplayInput
  expected: 'allow' | 'deny'
  pair?: { id: string; stage: 'before' | 'after' } | undefined
}

const MAC_HOME = /\/Users\//
const PRIVATE_HOME = /\/home\/(?!user[/"\\])/
const SESSION_ID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i
const PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/
const API_KEY = /\bsk-[\w-]{20,}\b/
const URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/gi
const EMAIL_PATTERN = /[\w.%+-]+@([a-z\d.-]+\.[a-z]{2,})/gi

const nonEmpty = v.pipe(v.string(), v.minLength(1))
const toolCall = v.strictObject({ id: nonEmpty, name: nonEmpty, arguments: v.record(v.string(), jsonValueSchema) })
const fixtureSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^case-\d{3}$/)),
  input: v.strictObject({
    cwd: v.pipe(v.string(), v.regex(/^\/workspace\/[\w./-]+$/)),
    messages: v.pipe(
      v.array(
        v.variant('role', [
          v.strictObject({
            role: v.literal('user'),
            text: nonEmpty,
            provenance: v.picklist(['interactive', 'rpc', 'extension', 'uncertain']),
          }),
          v.strictObject({ role: v.literal('assistant'), text: v.string(), toolCalls: v.optional(v.array(toolCall)) }),
          v.strictObject({
            role: v.literal('tool'),
            text: v.string(),
            toolName: nonEmpty,
            toolCallId: nonEmpty,
            isError: v.boolean(),
          }),
        ]),
      ),
      v.minLength(1),
    ),
    action: v.strictObject({
      command: nonEmpty,
      extraInput: v.pipe(
        v.record(v.string(), jsonValueSchema),
        v.check(value => !Object.hasOwn(value, 'command')),
      ),
    }),
  }),
  expected: v.picklist(['allow', 'deny']),
  pair: v.optional(
    v.strictObject({ id: v.pipe(v.string(), v.regex(/^pair-\d{3}$/)), stage: v.picklist(['before', 'after']) }),
  ),
})

function publicHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.example') ||
    ['example.com', 'example.net', 'example.org'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
  )
}

/** Rejects a fixture with identifiers that look like they come from a real person, machine or account */
function passesPrivacyChecks(fixture: ReplayFixture): boolean {
  const text = JSON.stringify(fixture)
  if ([MAC_HOME, PRIVATE_HOME, SESSION_ID, PRIVATE_KEY, API_KEY].some(pattern => pattern.test(text))) {
    return false
  }
  for (const url of text.match(URL_PATTERN) ?? []) {
    try {
      const parsed = new URL(url)
      if (!publicHost(parsed.hostname) || parsed.username !== '' || parsed.password !== '') {
        return false
      }
    } catch {
      return false
    }
  }

  return (text.match(EMAIL_PATTERN) ?? []).every(email => publicHost(email.slice(email.indexOf('@') + 1)))
}

export function parseReplayFixture(source: string): ReplayFixture {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('Invalid evaluation fixture: expected JSON')
  }
  const result = v.safeParse(fixtureSchema, value)
  if (!result.success) {
    throw new Error('Invalid evaluation fixture: check its schema and explicit provenance')
  }
  if (!passesPrivacyChecks(result.output)) {
    throw new Error('Evaluation fixture requires privacy review before inference')
  }

  return result.output
}

export function loadReplayFixtures(directory: string): ReplayFixture[] {
  const fixtures = readdirSync(directory)
    .filter(path => path.endsWith('.json'))
    .toSorted()
    .map(path => parseReplayFixture(readFileSync(join(directory, path), 'utf8')))
  if (fixtures.length === 0 || fixtures.length > 10) {
    throw new Error('Expected between one and ten evaluation fixtures')
  }
  if (new Set(fixtures.map(fixture => fixture.id)).size !== fixtures.length) {
    throw new Error('Duplicate evaluation case ID')
  }
  const pairs = new Map<string, Set<'before' | 'after'>>()
  for (const { pair } of fixtures) {
    if (pair === undefined) {
      continue
    }
    const stages = pairs.get(pair.id) ?? new Set<'before' | 'after'>()
    if (stages.has(pair.stage)) {
      throw new Error('Duplicate evaluation pair checkpoints')
    }
    stages.add(pair.stage)
    pairs.set(pair.id, stages)
  }
  if ([...pairs.values()].some(stages => stages.size !== 2)) {
    throw new Error('Incomplete evaluation pair checkpoints')
  }

  return fixtures
}
