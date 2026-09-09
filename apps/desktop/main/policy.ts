import { isVisualTheme } from '../../../packages/contracts/visual-theme'
import { isAppPath } from '../../../packages/contracts/ui-route'
import path from 'node:path'
import fs from 'node:fs'
import type { DesktopPreferences, EngineReady } from '../../../packages/contracts/index'

export const DEFAULT_PREFERENCES: DesktopPreferences = { visualTheme: 'orgtree', exitOnClose: false, startAtLogin: true, routineNotifications: false, onboarded: false }
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
    if (key === 'visualTheme') {
      if (!isVisualTheme(val)) throw new Error('Invalid visual theme')
      result.visualTheme = val
    } else {
      if (!['exitOnClose', 'startAtLogin', 'routineNotifications', 'onboarded'].includes(key) || typeof val !== 'boolean') throw new Error('Invalid preference')
      result[key as 'exitOnClose' | 'startAtLogin' | 'routineNotifications' | 'onboarded'] = val
    }
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

export interface EngineAttach { port: number; enginePid: number; token: string }

/** Validate a boot host's attach descriptor. Possession of the file is not
 *  authorization by itself: the caller must still prove identity over
 *  /api/desktop/identity, because a persisted port can move between boots.
 *  Throws on anything structurally wrong so a stale or foreign descriptor is
 *  reported, never silently trusted. */
export function parseAttach(raw: string, expectedRoot: string): EngineAttach {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('attach descriptor is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid attach descriptor')
  const r = value as { type?: unknown; protocol?: unknown; port?: unknown; enginePid?: unknown; dataRootId?: unknown; token?: unknown }
  if (r.type !== 'attach' || r.protocol !== 1) throw new Error('unsupported attach descriptor')
  if (!Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535) throw new Error('invalid attach port')
  if (!Number.isInteger(r.enginePid) || (r.enginePid as number) < 1) throw new Error('invalid attach engine PID')
  if (typeof r.token !== 'string' || !/^[0-9a-f]{64}$/.test(r.token)) throw new Error('invalid attach token')
  if (typeof r.dataRootId !== 'string' || !path.isAbsolute(r.dataRootId) || canonicalPath(r.dataRootId) !== canonicalPath(expectedRoot)) throw new Error('attach descriptor root mismatch')
  return { port: r.port as number, enginePid: r.enginePid as number, token: r.token }
}

export function canonicalPath(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface DescriptorOwner { ok: boolean; detail: string }

/** THE authentication step of attachment (redteam-opus F1): everything in the
 *  descriptor and the identity response is authored by whoever wrote the
 *  file, so trust reduces to WHO CAN WRITE IT. Require the file's owner SID
 *  to equal the current user's before the token is sent anywhere. Fail
 *  closed: no platform support, no parse, no match — no attach. Cross-account
 *  attack not measured on this machine (single account); the property relied
 *  on is NTFS ownership of a freshly created file. */
export function verifyDescriptorOwner(file: string): Promise<DescriptorOwner> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, detail: 'owner verification is Windows-only' })
  const escaped = file.replace(/'/g, "''")
  const script = `$o=(Get-Acl -LiteralPath '${escaped}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value;` +
    `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Write-Output ($o+'|'+$me)`
  return new Promise(resolve => {
    // Lazy import keeps policy.ts loadable in bundled unit tests without electron.
    import('node:child_process').then(({ execFile }) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve({ ok: false, detail: `owner query failed: ${error.message.slice(0, 200)}` })
          const [owner, current] = stdout.trim().split('|')
          if (!owner || !current || !owner.startsWith('S-') || !current.startsWith('S-')) return resolve({ ok: false, detail: `owner query unparseable: ${stdout.trim().slice(0, 120)}` })
          resolve(owner === current ? { ok: true, detail: `owner ${owner}` } : { ok: false, detail: `owner ${owner} is not current user ${current}` })
        })
    }, () => resolve({ ok: false, detail: 'child_process unavailable' }))
  })
}

/** A structured startup refusal from the engine (e.g. another owner already
 *  holds the data root during the boot race). Distinguishable from a broken
 *  engine so the desktop can retry attachment instead of failing fatally. */
export function parseRefusal(line: string): string | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const r = value as { type?: unknown; reason?: unknown }
  if (r.type !== 'refused' || typeof r.reason !== 'string') return null
  return r.reason.slice(0, 300)
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
  return u.protocol === 'http:' && isAppPath(u.pathname)
}

export function closeAction(exitOnClose: boolean, quitting: boolean, otherVisibleViews = 0): 'hide' | 'quit' | 'close' {
  return quitting ? 'close' : exitOnClose && otherVisibleViews === 0 ? 'quit' : 'hide'
}
