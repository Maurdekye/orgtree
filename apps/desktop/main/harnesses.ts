import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HARNESS_LINKS, TOKEN_HEADER, externalHttpUrl } from './policy'

const names = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode (ACP)', antigravity: 'Antigravity', muse: 'Muse Code' }
const registryIds: Record<string, string> = { claude: 'claude-code', codex: 'codex-cli' }
export type HarnessSetup = { id: string; name: string; url: string; detected: boolean }

function knownClaude() {
  const profile = os.homedir()
  const candidates = [path.join(profile, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')]
  if (process.platform === 'win32') candidates.push(path.join(
    process.env.APPDATA || path.join(profile, 'AppData', 'Roaming'), 'npm', 'claude.cmd'))
  return candidates.find(file => { try { return fs.statSync(file).isFile() } catch { return false } })
}

function knownMuse() {
  if (process.env.ORGTREE_MUSE_BIN) return process.env.ORGTREE_MUSE_BIN
  const dir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'muse')
    : path.join(os.homedir(), '.local', 'bin')
  try { return fs.readdirSync(dir).filter(n => n.startsWith('muse-bin-')).map(n => path.join(dir, n)).find(p => fs.statSync(p).isFile()) } catch { return undefined }
}

/** Presence only. Never launches, logs in, installs, or contacts a provider. */
export function detectHarnesses(searchPath = process.env.PATH ?? '', knownLocations: Partial<Record<keyof typeof HARNESS_LINKS, string>> = {
  claude: knownClaude(),
  codex: process.env.ORGTREE_CODEX,
  muse: knownMuse(),
  opencode: process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe') : undefined,
  antigravity: process.env.ORGTREE_ANTIGRAVITY || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : path.join(os.homedir(), '.local', 'bin', 'agy')),
}) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const exists = (file?: string) => { try { return !!file && fs.statSync(file).isFile() } catch { return false } }
  return (Object.keys(HARNESS_LINKS) as (keyof typeof HARNESS_LINKS)[]).map(id => ({ id, name: names[id], url: HARNESS_LINKS[id],
    detected: exists(knownLocations[id]) || searchPath.split(path.delimiter).filter(Boolean).some(dir => extensions.some(ext => {
      try { return fs.statSync(path.join(dir.replace(/^"|"$/g, ''), (id === 'antigravity' ? 'agy' : id) + ext)).isFile() } catch { return false }
    })),
  }))
}

/** Bounded, authenticated registry read. Old/offline engines use shell presence. */
export async function readHarnessRegistry(origin: string | null | undefined, token: string, request = fetch): Promise<HarnessSetup[] | null> {
  if (!origin) return null
  try {
    const response = await request(origin + '/api/harnesses', {
      headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(1500), redirect: 'error',
    })
    if (!response.ok) return null
    const value = await response.json()
    if (!Array.isArray(value?.harnesses) || !value.harnesses.length || value.harnesses.length > 100) return null
    const rows: HarnessSetup[] = [], seen = new Set<string>()
    for (const h of value.harnesses) {
      if (!h || typeof h.id !== 'string' || !h.id || seen.has(h.id) || typeof h.name !== 'string' || !h.name || typeof h.installed !== 'boolean') return null
      const legacy = h.id === 'claude-code' ? 'claude' : h.id === 'codex-cli' ? 'codex' : h.id
      const url = h.install_url || (Object.hasOwn(HARNESS_LINKS, legacy) ? HARNESS_LINKS[legacy as keyof typeof HARNESS_LINKS] : '')
      if (typeof url !== 'string' || !externalHttpUrl(url) || !url.startsWith('https://')) return null
      rows.push({ id: h.id, name: h.name, detected: h.installed, url }); seen.add(h.id)
    }
    return rows
  } catch { return null }
}

/** Stable registry order within detected/missing groups; setup is always clickable. */
export function harnessSetupMenu(registry: HarnessSetup[] | null, fallback: ReturnType<typeof detectHarnesses>, open: (url: string) => unknown) {
  const rows = registry ? [...registry] : []
  for (const h of fallback) {
    const id = registryIds[h.id] || h.id
    if (!rows.some(r => r.id === id)) rows.push({ ...h, id })
  }
  const item = (h: HarnessSetup) => ({ label: `${h.name}: ${h.detected ? 'detected' : 'not detected'} - official setup`, click: () => { void open(h.url) } })
  const detected = rows.filter(h => h.detected).map(item), missing = rows.filter(h => !h.detected).map(item)
  return [...detected, ...(detected.length && missing.length ? [{ type: 'separator' as const }] : []), ...missing]
}
