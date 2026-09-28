import { isVisualTheme } from '../../../packages/contracts/visual-theme'
import { DEFAULT_CONTRAST, isContrastTheme } from '../../../packages/contracts/contrast-theme'
import { isAgentColorSource } from '../../../packages/contracts/agent-colors'
import { DEFAULT_NOTIFICATIONS, NOTIFICATION_OPTIONS } from '../../../packages/contracts/notifications'
import { isAppPath } from '../../../packages/contracts/ui-route'
import { isStartupMode } from '../../../packages/contracts/desktop-window'
import path from 'node:path'
import fs from 'node:fs'
import type { DesktopPreferences, EngineReady } from '../../../packages/contracts/index'
import type { DesktopIdentity } from './build-channel'

export const DEFAULT_PREFERENCES: DesktopPreferences = { ...DEFAULT_NOTIFICATIONS, visualTheme: 'orgtree', contrastTheme: DEFAULT_CONTRAST, agentColorSource: 'provider', visualThemeExplicit: false, exitOnClose: false, startAtLogin: true, automaticUpdates: true, routineNotifications: false, onboarded: false, startupMode: 'restore' }
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
    } else if (key === 'contrastTheme') {
      if (!isContrastTheme(val)) throw new Error('Invalid contrast theme')
      result.contrastTheme = val
    } else if (key === 'agentColorSource') {
      if (!isAgentColorSource(val)) throw new Error('Invalid agent color source')
      result.agentColorSource = val
    } else if (key === 'startupMode') {
      if (!isStartupMode(val)) throw new Error('Invalid startup mode')
      result.startupMode = val
    } else if (key === 'visualThemeExplicit') {
      if (typeof val !== 'boolean') throw new Error('Invalid preference')
      result.visualThemeExplicit = val
    } else {
      if (!['exitOnClose', 'startAtLogin', 'automaticUpdates', 'routineNotifications', 'onboarded', 'notificationsEnabled', ...NOTIFICATION_OPTIONS.map(o => o.key)].includes(key) || typeof val !== 'boolean') throw new Error('Invalid preference')
      result[key as 'exitOnClose' | 'startAtLogin' | 'automaticUpdates' | 'routineNotifications' | 'onboarded' | 'notificationsEnabled'] = val
    }
  }
  return result
}

/** A path with its longest existing prefix resolved through links, so two
 *  spellings of the same folder (case, `..`, a junction) compare equal. */
function resolveExisting(p: string): string {
  if (fs.existsSync(p)) return fs.realpathSync.native(p)
  const parent = path.dirname(p)
  if (parent === p) throw new Error('Invalid data root')
  return path.join(resolveExisting(parent), path.basename(p))
}
const canonicalRoot = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p

/** Never allow the current v1 root, a nested directory within it, or its parent. */
export function validateDataRoot(candidate: string, forbidden: string): string {
  if (!path.isAbsolute(candidate)) throw new Error('V2 data root must be absolute')
  const root = resolveExisting(path.resolve(candidate))
  const old = resolveExisting(path.resolve(forbidden))
  const a = canonicalRoot(root), b = canonicalRoot(old)
  const overlaps = (parent: string, child: string) => { const r = path.relative(parent, child); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)) }
  if (overlaps(a, b) || overlaps(b, a)) throw new Error('V2 data root overlaps the v1 data root')
  return root
}

/** The backend data root this process starts or attaches to.
 *
 *  ⚠ THE 3.0.0-alpha.0 BUILD HAS EXACTLY ONE DATA ROOT: `<userData>\data`,
 *  which is 2.1.12's own `%APPDATA%\Orgtree v2\data`, because this build
 *  replaces 2.1.12 (user decision 2026-09-28). ORGTREE_V2_DATA is a
 *  development override, and obeying it here would let the installed v3 app
 *  read and write, or bootstrap PostgreSQL into, some other folder and adopt
 *  whatever engine that folder's attach descriptor names. So for this build
 *  the variable is allowed only when unset or when it resolves to that same
 *  folder; any other value, including an empty or relative one, is refused
 *  before anything is started or attached, and the refusal names both paths.
 *
 *  Every other identity keeps the override exactly as before. */
export function resolveDataRoot(requested: string | undefined, userData: string, identity: Pick<DesktopIdentity, 'ownDataRootOnly'>): string {
  const own = path.join(userData, 'data')
  if (!identity.ownDataRootOnly) return requested ?? own
  if (requested === undefined) return own
  if (path.isAbsolute(requested) && canonicalRoot(resolveExisting(path.resolve(requested))) === canonicalRoot(resolveExisting(path.resolve(own)))) return own
  throw new Error(`Orgtree 3.0.0-alpha.0 uses only its own data folder, ${own}. ORGTREE_V2_DATA is set to ${JSON.stringify(requested)}, which is a different folder. Unset ORGTREE_V2_DATA and start it again.`)
}

/** A checkpoint is evidence only for this child/root and only once. Arbitrary
 * logs, duplicated checkpoints and another engine's output buy no extra time. */
export function parseProgress(line: string, expectedRoot: string, expectedPid: number, previous: number): number {
  let value: unknown
  try { value = JSON.parse(line) } catch { return previous }
  if (!value || typeof value !== 'object') return previous
  const p = value as Record<string, unknown>
  if (p.type !== 'startup-progress' || p.protocol !== 1 || p.pid !== expectedPid
    || typeof p.sequence !== 'number' || !Number.isSafeInteger(p.sequence) || p.sequence <= previous
    || typeof p.phase !== 'string' || !p.phase.length || p.phase.length > 100
    || typeof p.dataRootId !== 'string' || !path.isAbsolute(p.dataRootId)
    || canonicalPath(p.dataRootId) !== canonicalPath(expectedRoot)) return previous
  return p.sequence
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
 *    1. the file's owner SID equals the current user's, or is SYSTEM or
 *       Administrators (see TRUSTED_OWNERS: both are inside the write set
 *       rule 2 enforces, so they add no writer);
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
          resolve(judgeDescriptorTrust(current, owner, fileBad, dirBad, ancestorBad))
        })
    }, () => resolve({ ok: false, detail: 'child_process unavailable' }))
  })
}

/** Principals that may OWN the descriptor besides the current user. Both
 *  already sit inside the exclusive write set the ACE scan enforces, so an
 *  owner among them moves no trust boundary: whoever can act as SYSTEM or
 *  Administrators can already write the file (and everything else). It is
 *  possible for an administrator token to default new-file ownership to
 *  Administrators. The boot host still sets the operator explicitly; touching
 *  an existing file does not establish that its owner changed. CREATOR OWNER
 *  is a placeholder, never an actual owner, so it is not listed. */
const TRUSTED_OWNERS = new Set(['S-1-5-18', 'S-1-5-32-544'])

/** The pure verdict on the trust query's five measured fields (exported so
 *  the owner rule is testable without minting an Administrators-owned file,
 *  which an unelevated test cannot do). Preconditions: verifyDescriptorTrust
 *  validates the five-field response and SID prefixes before calling this;
 *  this helper is not a validator for arbitrary external input. */
export function judgeDescriptorTrust(current: string, owner: string, fileBad: string, dirBad: string, ancestorBad: string): DescriptorOwner {
  if (owner !== current && !TRUSTED_OWNERS.has(owner)) return { ok: false, detail: `owner ${owner} is not current user ${current}` }
  if (fileBad) return { ok: false, detail: `descriptor writable by ${fileBad}` }
  if (dirBad) return { ok: false, detail: `descriptor directory writable by ${dirBad}` }
  if (ancestorBad) return { ok: false, detail: `path replaceable via ancestor ${ancestorBad.slice(0, 300)}` }
  return { ok: true, detail: `owner ${owner}, exclusive write boundary` }
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

/** ⚠ THE FIRST-LAUNCH CONVERSION (user decision 38, 2026-09-28): a 2.1.12
 *  data folder still on SQLite is converted to PostgreSQL by the engine on
 *  the first v3 start, in whichever process starts the engine first — this
 *  app, or the boot host the installer starts at once. The engine side
 *  (engine/pg_process.py, service_host.py) is p03-ws1-pgservice's; the
 *  contract the desktop pins is these three things, all agreed with it:
 *
 *   · progress: the ordinary startup-progress lines, phase prefixed
 *     `database-convert` (at most 100 characters);
 *   · failure: one stdout line `{"type":"refused","code":"conversion-failed",
 *     "reason":...}`, the reason written for the user and naming the log
 *     folder. Unlike `root-owned` it is NOT an attach race: never retried;
 *   · status file `<data>\conversion\current.json`, written ONLY by a
 *     conversion (a leftover `done` just means "converted then"), so a
 *     desktop waiting to ATTACH to a converting boot host, which cannot see
 *     that host's stdout, can still show what is happening. */
export const CONVERSION_PHASE = 'database-convert'
export const CONVERSION_FAILED = 'Orgtree could not convert your data to the new storage.\n'
/** Between checkpoints while converting: copying one large org, or reading
 *  it back, is a single step that can outlast the ordinary 60 s window.
 *  The boot host uses the same 900 s. */
export const CONVERSION_WINDOW_MS = 900000

export function parseConversionFailure(line: string): string | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const r = value as { type?: unknown; code?: unknown; reason?: unknown }
  if (r.type !== 'refused' || r.code !== 'conversion-failed' || typeof r.reason !== 'string') return null
  return r.reason.slice(0, 2000)
}

/** The phase of a progress line `parseProgress` has already accepted. */
export function progressPhase(line: string): string | null {
  try {
    const p = JSON.parse(line) as { type?: unknown; phase?: unknown }
    return p && p.type === 'startup-progress' && typeof p.phase === 'string' ? p.phase.slice(0, 200) : null
  } catch { return null }
}

export function isConversionPhase(phase: string | null | undefined): phase is string {
  return typeof phase === 'string' && phase.startsWith(CONVERSION_PHASE)
}

export interface ConversionStatus { state: 'running' | 'failed' | 'done'; phase: string; pid: number; at: string; log: string | null; reason: string | null }

/** `<data>\conversion\current.json`, or null when absent, unreadable or not
 *  the agreed schema (a malformed file is never a verdict either way). */
export function readConversionStatus(dataRoot: string, io: Pick<typeof fs, 'readFileSync'> = fs): ConversionStatus | null {
  let value: unknown
  try { value = JSON.parse(io.readFileSync(path.join(dataRoot, 'conversion', 'current.json'), 'utf8')) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (s.schema !== 'orgtree.conversion-status/v1' || !['running', 'failed', 'done'].includes(s.state as string)
    || typeof s.phase !== 'string' || !Number.isSafeInteger(s.pid) || (s.pid as number) <= 0 || typeof s.at !== 'string'
    || (s.log !== null && typeof s.log !== 'string') || (s.reason !== null && typeof s.reason !== 'string')) return null
  return { state: s.state as ConversionStatus['state'], phase: s.phase.slice(0, 200), pid: s.pid as number, at: s.at,
    log: s.log as string | null, reason: s.reason === null ? null : (s.reason as string).slice(0, 2000) }
}

/** Is that pid a process at all? EPERM means it exists under another
 *  principal; only ESRCH is "gone". */
export function processExists(pid: number, kill: (pid: number, signal: 0) => unknown = process.kill): boolean {
  try { kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EPERM' }
}

/** What a desktop waiting to attach should do about a conversion:
 *  'converting' (keep waiting, show `phase`), a failure reason, or null
 *  (no conversion in progress: the ordinary attach budget applies). A
 *  `running` file whose process is gone is a conversion that was killed;
 *  the next start re-runs it, so it is not a verdict. */
export function conversionWait(status: ConversionStatus | null, exists: (pid: number) => boolean = processExists):
  { converting: string } | { failed: string } | null {
  if (!status) return null
  if (status.state === 'running') return exists(status.pid) ? { converting: status.phase } : null
  if (status.state === 'failed' && !exists(status.pid)) return { failed: status.reason ?? `The conversion failed; see ${status.log ?? 'the conversion log folder'}.` }
  return null
}

/** The one sentence the conversion window shows. */
export function conversionMessage(phase: string): string {
  const detail = phase.startsWith(CONVERSION_PHASE) ? phase.slice(CONVERSION_PHASE.length).replace(/^[:\s]+/, '') : phase
  return 'Orgtree is converting your data to the new storage. This happens once and may take a few minutes.'
    + (detail ? `\n\n${detail}` : '')
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** The page the conversion window shows: static, no script, no remote
 *  content. Exported so a test can read exactly what the user sees. */
export function conversionPage(phase: string): string {
  const [lead, ...rest] = conversionMessage(phase).split('\n\n')
  return '<!doctype html><meta charset="utf-8"><title>Orgtree</title>'
    + '<style>body{font:14px Segoe UI,sans-serif;margin:24px;color:#222;background:#fafafa}p{margin:0 0 12px}.d{color:#555;font-size:12px}</style>'
    + `<p>${escapeHtml(lead)}</p>` + rest.map(line => `<p class="d">${escapeHtml(line)}</p>`).join('')
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

/** The internal holding page shown during engine reconnection is a trusted window sender. */
export function isHoldingUrl(value: string): boolean {
  try {
    return typeof value === 'string' && value.startsWith('data:text/html') && decodeURIComponent(value).includes('<title>Orgtree — reconnecting</title>')
  } catch { return false }
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
