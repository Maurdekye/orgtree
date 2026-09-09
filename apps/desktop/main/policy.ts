import { isVisualTheme } from '../../../packages/contracts/visual-theme'
import { isAppPath } from '../../../packages/contracts/ui-route'
import path from 'node:path'
import fs from 'node:fs'
import type { DesktopPreferences, EngineReady } from '../../../packages/contracts/index'

export const DEFAULT_PREFERENCES: DesktopPreferences = { visualTheme: 'orgtree', visualThemeExplicit: false, exitOnClose: false, startAtLogin: true, routineNotifications: false, onboarded: false }
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
    } else if (key === 'visualThemeExplicit') {
      if (typeof val !== 'boolean') throw new Error('Invalid preference')
      result.visualThemeExplicit = val
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

/** THE authentication step of attachment (redteam-opus F1, root ruling):
 *  everything in the descriptor and the identity response is authored by
 *  whoever can WRITE the file, so trust is a write-boundary property, and
 *  owner SID alone is not it — a user-owned file writable by Everyone, or a
 *  parent directory where others can replace the file, is equally broken
 *  (custom ORGTREE_V2_DATA can point anywhere). The smallest defensible
 *  check, READ-ONLY (existing ACLs are never rewritten or broadened):
 *    1. the file's owner SID equals the current user's;
 *    2. no Allow ACE on the file OR its parent directory grants any
 *       write/delete/permission-change right to a principal other than the
 *       current user, SYSTEM, Administrators or CREATOR OWNER.
 *  Fails closed with the offending SIDs named, so an unsafe custom root is a
 *  clear refusal, not a silent one. Generic write/all bits count as write. */
export function verifyDescriptorTrust(file: string): Promise<DescriptorOwner> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, detail: 'descriptor trust verification is Windows-only' })
  const escaped = file.replace(/'/g, "''")
  const directory = path.dirname(file).replace(/'/g, "''")
  // File + immediate directory use the full write mask; ANCESTORS use the
  // replacement mask (delete/delete-child/perm-change/take-ownership/
  // generic-all): higher up, only the power to REPLACE a path component
  // matters, and counting create rights there would flag every stock C:\.
  // Inherit-only ACEs are skipped everywhere — they apply to future
  // children, not to the object itself (the stock C:\ Authenticated Users
  // ACE is exactly that shape).
  const script =
    `$ErrorActionPreference='Stop';` +
    `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;` +
    `$allowed=@($me,'S-1-5-18','S-1-5-32-544','S-1-3-0');` +
    `$writeMask=0x116 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000;` +
    `$replaceMask=0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000;` +
    `function BadWriters($p,$mask){$acl=Get-Acl -LiteralPath $p;$bad=@();` +
    `foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){` +
    `if($r.AccessControlType -ne 'Allow'){continue};` +
    `if(($r.PropagationFlags.ToString()) -match 'InheritOnly'){continue};` +
    `$sid=$r.IdentityReference.Value;` +
    `if($allowed -contains $sid){continue};` +
    `if(([int]$r.FileSystemRights -band $mask) -ne 0){$bad+=$sid}};` +
    `,@($bad | Select-Object -Unique)};` +
    `$owner=(Get-Acl -LiteralPath '${escaped}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value;` +
    `$fileBad=BadWriters '${escaped}' $writeMask;$dirBad=BadWriters '${directory}' $writeMask;` +
    `$ancestorBad=@();$a=Split-Path '${directory}';` +
    `while($a){$hits=BadWriters $a $replaceMask;` +
    `if($hits.Count -gt 0){$ancestorBad+=($a+'='+($hits -join ','))};` +
    `$next=Split-Path $a;if($next -eq $a){break};$a=$next};` +
    `Write-Output ($me+'|'+$owner+'|'+($fileBad -join ',')+'|'+($dirBad -join ',')+'|'+($ancestorBad -join ';'))`
  return new Promise(resolve => {
    // Lazy import keeps policy.ts loadable in bundled unit tests without electron.
    import('node:child_process').then(({ execFile }) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve({ ok: false, detail: `trust query failed: ${error.message.slice(0, 200)}` })
          const parts = stdout.trim().split('|')
          if (parts.length !== 5 || !parts[0].startsWith('S-') || !parts[1].startsWith('S-')) return resolve({ ok: false, detail: `trust query unparseable: ${stdout.trim().slice(0, 120)}` })
          const [current, owner, fileBad, dirBad, ancestorBad] = parts
          if (owner !== current) return resolve({ ok: false, detail: `owner ${owner} is not current user ${current}` })
          if (fileBad) return resolve({ ok: false, detail: `descriptor writable by ${fileBad}` })
          if (dirBad) return resolve({ ok: false, detail: `descriptor directory writable by ${dirBad}` })
          if (ancestorBad) return resolve({ ok: false, detail: `path replaceable via ancestor ${ancestorBad.slice(0, 300)}` })
          resolve({ ok: true, detail: `owner ${owner}, exclusive write boundary` })
        })
    }, () => resolve({ ok: false, detail: 'child_process unavailable' }))
  })
}

/** A structured startup refusal from the engine. ONLY the machine code
 *  "root-owned" qualifies — that is the lost boot race, the one condition
 *  where retrying attachment is right. Any other refusal shape (or a future
 *  code this build does not know) is treated as a plain failure so a broken
 *  engine can never feed the retry loop (opus N1). */
export function parseRefusal(line: string): string | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const r = value as { type?: unknown; code?: unknown; reason?: unknown }
  if (r.type !== 'refused' || r.code !== 'root-owned' || typeof r.reason !== 'string') return null
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

/** Only plain HTTP(S) URLs may be handed to the user's external browser. */
export function externalHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password
  } catch { return false }
}

export function closeAction(exitOnClose: boolean, quitting: boolean, otherVisibleViews = 0): 'hide' | 'quit' | 'close' {
  return quitting ? 'close' : exitOnClose && otherVisibleViews === 0 ? 'quit' : 'hide'
}
