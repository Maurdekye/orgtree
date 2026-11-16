import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HARNESS_LINKS, TOKEN_HEADER, externalHttpUrl } from './policy'

const names = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode (ACP)', antigravity: 'Antigravity', muse: 'Muse Code' }
const registryIds: Record<string, string> = { claude: 'claude-code', codex: 'codex-cli' }
export type HarnessSetup = { id: string; name: string; url: string; detected: boolean }

// PRESENCE WITHOUT BLOCKING (@item:orgtree/nick-pc-4-6-0-desktop-main-process-stalls-input-f item 3): this scan was
// 100-600 statSync calls (5 harnesses x every PATH folder x 4 extensions) on EVERY tray rebuild, at least every 5 s,
// measured in Nick-PC's main-thread stall stacks. It is now asynchronous, and HarnessCache runs it at most every 5
// minutes; the tray uses the engine's registry first (USER via @coordinator-opus mc30c3aeead90, choice B).
const isFile = async (file?: string) => { try { return !!file && (await fs.promises.stat(file)).isFile() } catch { return false } }

async function knownClaude(): Promise<string | undefined> {
  const profile = os.homedir()
  const candidates = [path.join(profile, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')]
  if (process.platform === 'win32') candidates.push(path.join(
    process.env.APPDATA || path.join(profile, 'AppData', 'Roaming'), 'npm', 'claude.cmd'))
  for (const file of candidates) if (await isFile(file)) return file
  return undefined
}

async function knownMuse(): Promise<string | undefined> {
  if (process.env.ORGTREE_MUSE_BIN) return process.env.ORGTREE_MUSE_BIN
  const dir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'muse')
    : path.join(os.homedir(), '.local', 'bin')
  try {
    for (const n of (await fs.promises.readdir(dir)).filter(n => n.startsWith('muse-bin-'))) if (await isFile(path.join(dir, n))) return path.join(dir, n)
  } catch { /* no folder */ }
  return undefined
}

export type HarnessRow = { id: keyof typeof HARNESS_LINKS; name: string; url: string; detected: boolean }

/** Presence only. Never launches, logs in, installs, or contacts a provider. */
export async function detectHarnesses(searchPath = process.env.PATH ?? '', knownLocations?: Partial<Record<keyof typeof HARNESS_LINKS, string>>): Promise<HarnessRow[]> {
  const known = knownLocations ?? {
    claude: await knownClaude(),
    codex: process.env.ORGTREE_CODEX,
    muse: await knownMuse(),
    opencode: process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe') : undefined,
    antigravity: process.env.ORGTREE_ANTIGRAVITY || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
      : path.join(os.homedir(), '.local', 'bin', 'agy')),
  }
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = searchPath.split(path.delimiter).filter(Boolean).map(dir => dir.replace(/^"|"$/g, ''))
  const onPath = async (id: string) => {
    for (const dir of dirs) for (const ext of extensions) if (await isFile(path.join(dir, (id === 'antigravity' ? 'agy' : id) + ext))) return true
    return false
  }
  return Promise.all((Object.keys(HARNESS_LINKS) as (keyof typeof HARNESS_LINKS)[]).map(async id => ({ id, name: names[id], url: HARNESS_LINKS[id],
    detected: await isFile(known[id]) || await onPath(id) })))
}

export const HARNESS_SCAN_MAX_AGE_MS = 5 * 60_000

const undetected = (): HarnessRow[] => (Object.keys(HARNESS_LINKS) as (keyof typeof HARNESS_LINKS)[])
  .map(id => ({ id, name: names[id], url: HARNESS_LINKS[id], detected: false }))

/** The last presence scan, refreshed asynchronously at most every HARNESS_SCAN_MAX_AGE_MS. `onUpdate` runs when a
 *  scan lands (the tray rebuilds then). Before the first scan every harness reads "not detected". */
export class HarnessCache {
  private rows: HarnessRow[] | null = null
  private at = -Infinity
  private running: Promise<HarnessRow[]> | null = null
  constructor(private readonly onUpdate: () => void = () => {},
    private readonly scan: () => Promise<HarnessRow[]> = () => detectHarnesses(),
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs = HARNESS_SCAN_MAX_AGE_MS) {}
  /** The cached rows, never waiting; `refresh` starts a scan when they are stale. */
  current(refresh: boolean): HarnessRow[] {
    if (refresh && !this.running && this.now() - this.at >= this.maxAgeMs) void this.refresh()
    return this.rows ?? undetected()
  }
  /** Rows no older than the limit: the cache, or a scan's result. */
  async fresh(): Promise<HarnessRow[]> {
    return this.rows && this.now() - this.at < this.maxAgeMs ? this.rows : this.refresh()
  }
  refresh(): Promise<HarnessRow[]> {
    this.running ??= this.scan().then(rows => { this.rows = rows; return rows }, () => this.rows ?? undetected())
      .finally(() => { this.at = this.now(); this.running = null; try { this.onUpdate() } catch { /* the tray only */ } })
    return this.running
  }
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
export function harnessSetupMenu(registry: HarnessSetup[] | null, fallback: HarnessRow[], open: (url: string) => unknown) {
  const rows = registry ? [...registry] : []
  for (const h of fallback) {
    const id = registryIds[h.id] || h.id
    if (!rows.some(r => r.id === id)) rows.push({ ...h, id })
  }
  const item = (h: HarnessSetup) => ({ label: `${h.name}: ${h.detected ? 'detected' : 'not detected'} - official setup`, click: () => { void open(h.url) } })
  const detected = rows.filter(h => h.detected).map(item), missing = rows.filter(h => !h.detected).map(item)
  return [...detected, ...(detected.length && missing.length ? [{ type: 'separator' as const }] : []), ...missing]
}
