import path from 'node:path'
import fs from 'node:fs'
import type { DesktopPreferences, EngineReady } from '../../../packages/contracts/index'

export const DEFAULT_PREFERENCES: DesktopPreferences = { exitOnClose: false, startAtLogin: true }
export const TOKEN_HEADER = 'X-Orgtree-Desktop-Token'
export const HARNESS_LINKS = Object.freeze({
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli',
  antigravity: 'https://antigravity.google/download',
})

export function preferencesPatch(value: unknown): Partial<DesktopPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preferences')
  const result: Partial<DesktopPreferences> = {}
  for (const [key, val] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_PREFERENCES, key) || typeof val !== 'boolean') throw new Error('Invalid preference')
    result[key as keyof DesktopPreferences] = val
  }
  return result
}

/** Never allow the current v1 root, a nested directory within it, or its parent. */
export function validateDataRoot(candidate: string, forbidden: string): string {
  if (!path.isAbsolute(candidate)) throw new Error('V2 data root must be absolute')
  const resolveExisting = (p: string): string => {
    if (fs.existsSync(p)) return fs.realpathSync.native(p)
    const parent = path.dirname(p)
    if (parent === p) throw new Error('Invalid data root')
    return path.join(resolveExisting(parent), path.basename(p))
  }
  const root = resolveExisting(path.resolve(candidate))
  const old = resolveExisting(path.resolve(forbidden))
  const canonical = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p
  const a = canonical(root), b = canonical(old)
  const overlaps = (parent: string, child: string) => { const r = path.relative(parent, child); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)) }
  if (overlaps(a, b) || overlaps(b, a)) throw new Error('V2 data root overlaps the v1 data root')
  return root
}

export function parseReady(line: string, expectedRoot: string, expectedPid: number): EngineReady | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'ready') return null
  const r = value as EngineReady
  if (r.protocol !== 1 || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535 || r.pid !== expectedPid || typeof r.dataRootId !== 'string') throw new Error('Invalid engine readiness')
  const canon = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  if (!path.isAbsolute(r.dataRootId) || canon(r.dataRootId) !== canon(expectedRoot)) throw new Error('Engine data root mismatch')
  return r
}

export function engineUrl(value: string, origin: string): boolean {
  try {
    const u = new URL(value), expected = new URL(origin)
    return !u.username && !u.password && (u.protocol === 'http:' || u.protocol === 'ws:') && u.hostname === '127.0.0.1' && u.host === expected.host
  } catch { return false }
}

/** Run on ALL destinations, stripping any previous header before selective injection. */
export function scopedHeaders(headers: Record<string, string>, url: string, origin: string, token: string): Record<string, string> {
  const clean = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== TOKEN_HEADER.toLowerCase()))
  if (engineUrl(url, origin)) clean[TOKEN_HEADER] = token
  return clean
}

export function trustedUiUrl(value: string, origin: string): boolean {
  if (!engineUrl(value, origin)) return false
  const u = new URL(value)
  return u.protocol === 'http:' && (u.pathname === '/' || u.pathname === '/index.html')
}

export function closeAction(exitOnClose: boolean, quitting: boolean): 'hide' | 'quit' | 'close' {
  return quitting ? 'close' : exitOnClose ? 'quit' : 'hide'
}
