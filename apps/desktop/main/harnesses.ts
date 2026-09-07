import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HARNESS_LINKS } from './policy'

/** Presence only. Never launches, logs in, installs, or contacts a provider. */
export function detectHarnesses(searchPath = process.env.PATH ?? '', knownLocations: Partial<Record<keyof typeof HARNESS_LINKS, string>> = {
  codex: process.env.ORGTREE_CODEX,
  antigravity: process.env.ORGTREE_ANTIGRAVITY || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : path.join(os.homedir(), '.local', 'bin', 'agy')),
}) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const exists = (file?: string) => { try { return !!file && fs.statSync(file).isFile() } catch { return false } }
  return (Object.keys(HARNESS_LINKS) as (keyof typeof HARNESS_LINKS)[]).map(id => ({ id, url: HARNESS_LINKS[id],
    detected: exists(knownLocations[id]) || searchPath.split(path.delimiter).filter(Boolean).some(dir => extensions.some(ext => {
      try { return fs.statSync(path.join(dir.replace(/^"|"$/g, ''), (id === 'antigravity' ? 'agy' : id) + ext)).isFile() } catch { return false }
    })),
  }))
}
