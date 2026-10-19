import fs from 'node:fs/promises'
import path from 'node:path'
import { TOKEN_HEADER } from './policy'

export type FolderOpenResult = { ok: boolean; error?: string }

async function resolveAgentScratchFolder(
  engine: { origin: string; token: string }, org: unknown, node: unknown, scope: unknown, unlinkedRoot = false,
): Promise<string> {
  if (scope !== 'agent' && scope !== 'team' && scope !== 'shared') {
    throw new Error('No valid scratch folder scope given.')
  }
  if (typeof org !== 'string' || !org || typeof node !== 'string'
    || (scope === 'shared' ? node !== '' : !node)
    || [org, node].some(s => s === '.' || s === '..' || s.includes('\0'))) {
    throw new Error('No valid agent identity given.')
  }
  const origin = new URL(engine.origin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Scratch folders can only be opened for the local desktop engine.')
  }
  const identity = scope === 'shared' ? '_shared' : node
  const query = scope === 'agent' ? '' : `?scope=${scope}`
  const response = await fetch(engine.origin + `/api/orgs/${encodeURIComponent(org)}/nodes/${encodeURIComponent(identity)}/scratch-folder${query}`, {
    headers: { [TOKEN_HEADER]: engine.token }, redirect: 'error', signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`Could not resolve the scratch folder (HTTP ${response.status}).`)
  const value = await response.json() as { path?: unknown; scope?: unknown }
  if (scope !== 'agent' && value?.scope !== scope) {
    throw new Error('The local engine does not support this scratch folder scope.')
  }
  if (typeof value?.path !== 'string' || !path.isAbsolute(value.path) || value.path.includes('\0')) {
    throw new Error('The engine did not return an absolute scratch folder path.')
  }
  if (unlinkedRoot) {
    // lstat, not stat: Windows junctions/symbolic-link reparse points must
    // never redirect an Edit/create action through any ancestor of the root.
    for (let current = path.resolve(value.path); ; ) {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Scratch note roots cannot contain links.')
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const directory = await fs.realpath(value.path)
  if (!(await fs.stat(directory)).isDirectory()) throw new Error("This agent's scratch path is not a directory.")
  return directory
}

async function rootAgentsFile(directory: string): Promise<string | null> {
  const file = path.join(directory, 'AGENTS.md')
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null
    const real = await fs.realpath(file)
    if (path.dirname(real) !== directory) return null
    return real
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

/** Check the root note for the exact authenticated scratch folder. */
export async function agentScratchAgentsFileExists(
  engine: { origin: string; token: string }, org: unknown, node: unknown, scope: unknown = 'agent',
): Promise<{ ok: boolean; exists?: boolean; error?: string }> {
  try {
    const directory = await resolveAgentScratchFolder(engine, org, node, scope, true)
    return { ok: true, exists: !!(await rootAgentsFile(directory)) }
  } catch (error) {
    return { ok: false, error: (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? "This agent's scratch folder does not exist."
      : error instanceof Error ? error.message : String(error) }
  }
}

/** Re-resolve and re-check at activation time; never accept a renderer path. */
export async function openAgentScratchAgentsFile(
  engine: { origin: string; token: string }, org: unknown, node: unknown,
  openFile: (file: string) => Promise<string>, scope: unknown = 'agent',
): Promise<FolderOpenResult> {
  try {
    const directory = await resolveAgentScratchFolder(engine, org, node, scope, true)
    let file = await rootAgentsFile(directory)
    if (!file) {
      // Exclusive create never follows/overwrites an existing note or link.
      // Another first edit may win this race; both re-check the same root.
      try { await fs.writeFile(path.join(directory, 'AGENTS.md'), '', { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error }
      file = await rootAgentsFile(directory)
    }
    if (!file) return { ok: false, error: 'The root AGENTS.md must be a regular file, without links.' }
    const error = await openFile(file)
    return error ? { ok: false, error } : { ok: true }
  } catch (error) {
    return { ok: false, error: (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? "This agent's scratch folder does not exist."
      : error instanceof Error ? error.message : String(error) }
  }
}

/** Only agent identity crosses IPC. Paths come from our authenticated local
 * engine, never from agent markdown or a renderer-provided filesystem path. */
export async function openAgentScratchFolder(
  engine: { origin: string; token: string }, org: unknown, node: unknown,
  openDirectory: (directory: string) => Promise<string>,
  scope: unknown = 'agent',
): Promise<FolderOpenResult> {
  try {
    const directory = await resolveAgentScratchFolder(engine, org, node, scope)
    const error = await openDirectory(directory)
    return error ? { ok: false, error } : { ok: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, error: "This agent's scratch folder does not exist." }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
