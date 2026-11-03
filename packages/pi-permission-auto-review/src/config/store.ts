import type { AutoReviewConfig, AutoReviewConfigFile } from './config.js'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { CONFIG_SCHEMA_URL, EXTENSION_ID, mergeConfig, parseConfigFile, validateConfigFile } from './config.js'

export type ConfigScope = 'global' | 'project'

export type ScopeSnapshot = { scope: ConfigScope; cwd: string; path: string; source: string | undefined } & (
  | { valid: true; config: AutoReviewConfigFile }
  | { valid: false; issue: string }
)

export interface LoadConfigResult {
  config: AutoReviewConfig | undefined
  issues: string[]
}

export type ConfigMutationResult =
  | { ok: true; loadResult: LoadConfigResult }
  | {
      ok: false
      message: string
      /** When another edit changed a field that the draft also changed: the file as it is now, and the merged draft */
      rebased?: { snapshot: ScopeSnapshot; draft: AutoReviewConfigFile } | undefined
    }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function configPath(cwd: string, scope: ConfigScope): string {
  return scope === 'global'
    ? join(getAgentDir(), 'extensions', EXTENSION_ID, 'config.json')
    : join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json')
}

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export function readScope(cwd: string, scope: ConfigScope): ScopeSnapshot {
  const path = configPath(cwd, scope)
  let source: string | undefined
  try {
    source = readSource(path)
  } catch (error) {
    return { scope, cwd, path, source: undefined, valid: false, issue: describeError(error) }
  }
  if (source === undefined) {
    return { scope, cwd, path, source, valid: true, config: {} }
  }
  const parsed = parseConfigFile(source)

  return parsed.ok
    ? { scope, cwd, path, source, valid: true, config: parsed.config }
    : { scope, cwd, path, source, valid: false, issue: parsed.issue }
}

/** The scope as it takes part in the merge: an untrusted project's file is left unread, so it can neither loosen nor break the config */
export function readActiveScope(cwd: string, scope: ConfigScope, projectTrusted: boolean): ScopeSnapshot {
  return scope === 'project' && !projectTrusted
    ? { scope, cwd, path: configPath(cwd, scope), source: undefined, valid: true, config: {} }
    : readScope(cwd, scope)
}

function merge(global: ScopeSnapshot, project: ScopeSnapshot): LoadConfigResult {
  if (!global.valid || !project.valid) {
    const issues = [global, project].flatMap(snapshot => (snapshot.valid ? [] : `${snapshot.path}: ${snapshot.issue}`))

    return { config: undefined, issues }
  }

  return { config: mergeConfig(global.config, project.config), issues: [] }
}

export function loadConfig(cwd: string, projectTrusted: boolean): LoadConfigResult {
  return merge(readScope(cwd, 'global'), readActiveScope(cwd, 'project', projectTrusted))
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The path with every link in its existing part resolved, so two names for one file compare equal */
function canonical(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return path
      }
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Refuses to write or delete a file through a link. A project's own repository decides its `.pi` directory, and a link
 * there could point an edit of the project config at the global config, or at any other file
 */
function containmentIssue(snapshot: ScopeSnapshot): string | undefined {
  const linked = `Refusing to change '${snapshot.path}', which is or is reached through a symbolic link`
  if (isLink(snapshot.path)) {
    return linked
  }
  if (snapshot.scope === 'project') {
    const root = join(snapshot.cwd, '.pi')
    const parts = relative(root, dirname(snapshot.path)).split(sep).filter(Boolean)
    const directories = parts.map((_, index) => join(root, ...parts.slice(0, index + 1)))
    if ([root, ...directories].some(isLink)) {
      return linked
    }
    const inside = relative(canonical(snapshot.cwd), canonical(dirname(snapshot.path)))
    if (inside.startsWith('..') || isAbsolute(inside)) {
      return `Refusing to change '${snapshot.path}', which is outside the project`
    }
  }
  const other = configPath(snapshot.cwd, snapshot.scope === 'global' ? 'project' : 'global')
  if (canonical(other) === canonical(snapshot.path)) {
    return linked
  }

  return undefined
}

function checkForConflict(snapshot: ScopeSnapshot): string | undefined {
  let current: string | undefined
  try {
    current = readSource(snapshot.path)
  } catch (error) {
    return `Failed to re-read config at '${snapshot.path}': ${describeError(error)}`
  }

  return current === snapshot.source
    ? undefined
    : `Config at '${snapshot.path}' changed while it was being edited; reopen the command and try again.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Applies the changes that turned `base` into `draft` to `current`, field by field and into nested objects. A field
 * that both edits changed to different values takes the draft's value and is listed as a conflict
 */
function mergeEdits(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string[] = [],
): { merged: Record<string, unknown>; conflicts: string[] } {
  const merged: Record<string, unknown> = {}
  const conflicts: string[] = []
  for (const key of new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(current)])) {
    const [before, mine, theirs] = [base[key], draft[key], current[key]]
    let value = mine
    if (isDeepStrictEqual(before, mine)) {
      value = theirs
    } else if (isRecord(mine) && isRecord(theirs) && (before === undefined || isRecord(before))) {
      const nested = mergeEdits(before ?? {}, mine, theirs, [...path, key])
      value = nested.merged
      conflicts.push(...nested.conflicts)
    } else if (!isDeepStrictEqual(before, theirs) && !isDeepStrictEqual(mine, theirs)) {
      conflicts.push([...path, key].join('.'))
    }
    if (value !== undefined) {
      merged[key] = value
    }
  }

  return { merged, conflicts }
}

/** The scope as it is now, or undefined when the file still contains what `snapshot` read */
function changedScope(snapshot: ScopeSnapshot): ScopeSnapshot | undefined {
  const current = readScope(snapshot.cwd, snapshot.scope)
  const unreadable = !current.valid && current.source === undefined

  return !unreadable && current.source === snapshot.source ? undefined : current
}

/** Saves the draft over a file that changed after `snapshot` read it, keeping the other edit where the two do not conflict */
function saveMerged(
  snapshot: ScopeSnapshot & { valid: true },
  draft: AutoReviewConfigFile,
  current: ScopeSnapshot,
  projectTrusted: boolean,
  mayMerge: boolean,
): ConfigMutationResult {
  if (!current.valid) {
    return {
      ok: false,
      message:
        current.source === undefined
          ? `Failed to re-read config at '${current.path}': ${current.issue}`
          : `Config at '${current.path}' changed while it was being edited and is now invalid: ${current.issue}`,
    }
  }
  if (!mayMerge) {
    return { ok: false, message: `Config at '${current.path}' changed again while it was being saved; save again.` }
  }
  const { merged, conflicts } = mergeEdits(snapshot.config, draft, current.config)
  const validated = validateConfigFile(merged)
  if (!validated.ok) {
    return { ok: false, message: `${current.path}: ${validated.issue}` }
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      message: `Config at '${current.path}' changed while it was being edited, and the other edit also changed ${conflicts.join(', ')}. Save again to keep your values.`,
      rebased: { snapshot: current, draft: validated.config },
    }
  }

  return save(current, validated.config, projectTrusted, false)
}

/**
 * Writes the draft to the snapshot's scope. When another edit changed the file after the snapshot was read, the draft's
 * changes are merged into the file's current contents
 */
export function saveScope(
  snapshot: ScopeSnapshot,
  draft: AutoReviewConfigFile,
  projectTrusted: boolean,
): ConfigMutationResult {
  return save(snapshot, draft, projectTrusted, true)
}

function save(
  snapshot: ScopeSnapshot,
  draft: AutoReviewConfigFile,
  projectTrusted: boolean,
  mayMerge: boolean,
): ConfigMutationResult {
  if (!snapshot.valid) {
    return { ok: false, message: `Cannot save invalid config at '${snapshot.path}': ${snapshot.issue}` }
  }
  const validated = validateConfigFile(draft)
  if (!validated.ok) {
    return { ok: false, message: `${snapshot.path}: ${validated.issue}` }
  }

  const { $schema = CONFIG_SCHEMA_URL, ...fields } = validated.config
  const config = { $schema, ...fields }
  const source = `${JSON.stringify(config, null, 2)}\n`
  const replacement: ScopeSnapshot = { ...snapshot, source, config }
  const other = readActiveScope(snapshot.cwd, snapshot.scope === 'global' ? 'project' : 'global', projectTrusted)
  const loadResult = snapshot.scope === 'global' ? merge(replacement, other) : merge(other, replacement)
  if (loadResult.config === undefined) {
    return { ok: false, message: loadResult.issues.join('\n') }
  }
  const refused = containmentIssue(snapshot)
  if (refused !== undefined) {
    return { ok: false, message: refused }
  }
  const changed = changedScope(snapshot)
  if (changed !== undefined) {
    return saveMerged(snapshot, draft, changed, projectTrusted, mayMerge)
  }

  // A fresh name beside the file keeps the rename atomic, and exclusive creation never reuses another writer's file
  const temporary = join(dirname(snapshot.path), `.${basename(snapshot.path)}.${randomUUID()}.tmp`)
  try {
    mkdirSync(dirname(snapshot.path), { recursive: true })
    const mode = snapshot.source === undefined ? undefined : statSync(snapshot.path).mode & 0o777
    writeFileSync(temporary, source, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) })
    if (mode !== undefined) {
      chmodSync(temporary, mode)
    }
    // Checked again just before the rename, which narrows the window for a concurrent edit to the rename itself
    const changedSince = changedScope(snapshot)
    if (changedSince !== undefined) {
      rmSync(temporary, { force: true })
      return saveMerged(snapshot, draft, changedSince, projectTrusted, mayMerge)
    }
    renameSync(temporary, snapshot.path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The write error is the actionable one
    }

    return { ok: false, message: `Failed to save config at '${snapshot.path}': ${describeError(error)}` }
  }

  return { ok: true, loadResult }
}

export function resetScope(snapshot: ScopeSnapshot, projectTrusted: boolean): ConfigMutationResult {
  if (!snapshot.valid && snapshot.source === undefined) {
    return { ok: false, message: `Cannot reset unreadable config at '${snapshot.path}': ${snapshot.issue}` }
  }
  const refused = containmentIssue(snapshot) ?? checkForConflict(snapshot)
  if (refused !== undefined) {
    return { ok: false, message: refused }
  }
  if (snapshot.source !== undefined) {
    try {
      unlinkSync(snapshot.path)
    } catch (error) {
      return { ok: false, message: `Failed to reset config at '${snapshot.path}': ${describeError(error)}` }
    }
  }

  return { ok: true, loadResult: loadConfig(snapshot.cwd, projectTrusted) }
}
