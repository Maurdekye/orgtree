import fs from 'node:fs/promises'
import path from 'node:path'
import { TOKEN_HEADER } from './policy'

export type FolderOpenResult = { ok: boolean; error?: string }

/** Only agent identity crosses IPC. Paths come from our authenticated local
 * engine, never from agent markdown or a renderer-provided filesystem path. */
export async function openAgentScratchFolder(
  engine: { origin: string; token: string }, org: unknown, node: unknown,
  openDirectory: (directory: string) => Promise<string>,
  scope: unknown = 'agent',
): Promise<FolderOpenResult> {
  try {
    if (scope !== 'agent' && scope !== 'team' && scope !== 'shared') {
      return { ok: false, error: 'No valid scratch folder scope given.' }
    }
    if (typeof org !== 'string' || !org || typeof node !== 'string'
      || (scope === 'shared' ? node !== '' : !node)
      || [org, node].some(s => s === '.' || s === '..' || s.includes('\0'))) {
      return { ok: false, error: 'No valid agent identity given.' }
    }
    const origin = new URL(engine.origin)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return { ok: false, error: 'Scratch folders can only be opened for the local desktop engine.' }
    }
    const identity = scope === 'shared' ? '_shared' : node
    const query = scope === 'agent' ? '' : `?scope=${scope}`
    const response = await fetch(engine.origin + `/api/orgs/${encodeURIComponent(org)}/nodes/${encodeURIComponent(identity)}/scratch-folder${query}`, {
      headers: { [TOKEN_HEADER]: engine.token }, redirect: 'error', signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return { ok: false, error: `Could not resolve the scratch folder (HTTP ${response.status}).` }
    const value = await response.json() as { path?: unknown; scope?: unknown }
    // An older engine can ignore unknown query parameters. Never let its
    // personal-folder response masquerade as a successful scoped action.
    if (scope !== 'agent' && value?.scope !== scope) {
      return { ok: false, error: 'The local engine does not support this scratch folder scope.' }
    }
    if (typeof value?.path !== 'string' || !path.isAbsolute(value.path) || value.path.includes('\0')) {
      return { ok: false, error: 'The engine did not return an absolute scratch folder path.' }
    }
    // Directory-only: never launch a file even if the expected folder was replaced.
    const directory = await fs.realpath(value.path)
    if (!(await fs.stat(directory)).isDirectory()) return { ok: false, error: "This agent's scratch path is not a directory." }
    const error = await openDirectory(directory)
    return error ? { ok: false, error } : { ok: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, error: "This agent's scratch folder does not exist." }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
