import { normalizeVisualTheme } from '../../../packages/contracts/visual-theme'
import { sanitizeCanvasBackground } from '../../../packages/contracts/canvas-background'
import { DEFAULT_CONTRAST, isContrastTheme } from '../../../packages/contracts/contrast-theme'
import { isAgentColorSource } from '../../../packages/contracts/agent-colors'
import { DEFAULT_NOTIFICATIONS, NOTIFICATION_OPTIONS } from '../../../packages/contracts/notifications'
import { isAppPath } from '../../../packages/contracts/ui-route'
import { isStartupMode } from '../../../packages/contracts/desktop-window'
import path from 'node:path'
import fs from 'node:fs'
import type { DesktopPreferences, EngineReady } from '../../../packages/contracts/index'
import type { DesktopIdentity } from './build-channel'

export const DEFAULT_PREFERENCES: DesktopPreferences = { ...DEFAULT_NOTIFICATIONS, visualTheme: 'claude', contrastTheme: DEFAULT_CONTRAST, agentColorSource: 'provider', visualThemeExplicit: false, exitOnClose: false, startAtLogin: true, automaticUpdates: true, routineNotifications: false, onboarded: false, startupMode: 'restore', questionTarget: 'desk', activeAgentsOnly: false, quickChatActiveAgentsOnly: false, attentionDeskActiveAgentsOnly: false }
export const TOKEN_HEADER = 'X-Orgtree-Desktop-Token'
export const HARNESS_LINKS = Object.freeze({
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli',
  opencode: 'https://opencode.ai/docs/',
  antigravity: 'https://antigravity.google/download',
  muse: 'https://dev.meta.ai/docs/muse-code#install',
})

export function preferencesPatch(value: unknown): Partial<DesktopPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preferences')
  const result: Partial<DesktopPreferences> = {}
  for (const [key, val] of Object.entries(value)) {
    if (key === 'visualTheme') {
      const theme = normalizeVisualTheme(val, (value as Record<string, unknown>).visualThemeExplicit)
      if (!theme) throw new Error('Invalid visual theme')
      result.visualTheme = theme
    } else if (key === 'rainbowTheme') {
      const mode = val as DesktopPreferences['rainbowTheme']
      if (!mode || typeof mode.revealed !== 'boolean' || typeof mode.enabled !== 'boolean'
        || !Number.isSafeInteger(mode.epoch) || mode.epoch < 0 || (mode.enabled && !mode.revealed)) throw new Error('Invalid rainbow theme')
      result.rainbowTheme = { revealed: mode.revealed, enabled: mode.enabled, epoch: mode.epoch }
    } else if (key === 'contrastTheme') {
      if (!isContrastTheme(val)) throw new Error('Invalid contrast theme')
      result.contrastTheme = val
    } else if (key === 'agentColorSource') {
      if (!isAgentColorSource(val)) throw new Error('Invalid agent color source')
      result.agentColorSource = val
    } else if (key === 'questionTarget') {
      if (val !== 'desk' && val !== 'mail') throw new Error('Invalid question destination')
      result.questionTarget = val
    } else if (key === 'startupMode') {
      if (!isStartupMode(val)) throw new Error('Invalid startup mode')
      result.startupMode = val
    } else if (key === 'orgView') {
      const v = val as { slug?: unknown; view?: unknown } | null
      if (!v || typeof v.slug !== 'string' || !v.slug || v.slug.length > 256 || (v.view !== 'attention' && v.view !== 'canvas')) throw new Error('Invalid organization view')
      result.orgView = { slug: v.slug, view: v.view }
    } else if (key === 'attentionOrgs' || key === 'canvasOrgs') {
      if (!Array.isArray(val) || val.length > 200 || !val.every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) throw new Error('Invalid view organizations')
      result[key] = [...new Set(val as string[])]
    } else if (key === 'visualThemeExplicit') {
      if (typeof val !== 'boolean') throw new Error('Invalid preference')
      result.visualThemeExplicit = val
    } else if (key === 'epicMode' || key === 'epicMuted' || key === 'streamerMode' || key === 'streamerAuto' || key === 'streamerPaths' || key === 'streamerIps' || key === 'streamerEmails' || key === 'streamerSecrets' || key === 'streamerPhones' || key === 'streamerTokenUrls' || key === 'streamerExternals' || key === 'streamerOrgs' || key === 'streamerCover' || key === 'streamerAutoActive' || key === 'attractMode' || key === 'attractRefuseQuestions') {
      // optional and absent by default: an untouched install stores nothing
      if (typeof val !== 'boolean') throw new Error('Invalid preference')
      result[key] = val
    } else if (key === 'attractIdleSeconds') {
      // whole seconds, 0 and up, no maximum (the renderer's timer clamps to what setTimeout can hold)
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) throw new Error('Invalid preference')
      result.attractIdleSeconds = val
    } else if (key === 'streamerAutoApp') {
      if (typeof val !== 'string' || val.length > 40) throw new Error('Invalid preference')
      result.streamerAutoApp = val
    } else if (key === 'activeAgentsOnly' || key === 'quickChatActiveAgentsOnly' || key === 'attentionDeskActiveAgentsOnly') {
      if (typeof val !== 'boolean') throw new Error('Invalid preference')
      result[key] = val
    } else if (key === 'activeAgentsByOrg') {
      if (!val || typeof val !== 'object' || Array.isArray(val)) throw new Error('Invalid preference')
      const entries = Object.entries(val as Record<string, unknown>)
      if (entries.length > 200) throw new Error('Invalid preference')
      const clean: NonNullable<DesktopPreferences['activeAgentsByOrg']> = {}
      for (const [slug, entry] of entries) {
        if (!slug || slug.length > 256 || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid preference')
        const fields = Object.entries(entry)
        if (!fields.length || fields.length > 3) throw new Error('Invalid preference')
        const value: NonNullable<DesktopPreferences['activeAgentsByOrg']>[string] = {}
        for (const [surface, enabled] of fields) {
          if (typeof enabled !== 'boolean') throw new Error('Invalid preference')
          if (surface === 'agents') value.agents = enabled
          else if (surface === 'quickChat') value.quickChat = enabled
          else if (surface === 'attentionDesk') value.attentionDesk = enabled
          else throw new Error('Invalid preference')
        }
        Object.defineProperty(clean, slug, { value, enumerable: true, writable: true, configurable: true })
      }
      result.activeAgentsByOrg = clean
    } else if (key === 'canvasBackground') {
      // optional and absent by default, like epicMode: the sanitizer rebuilds
      // the stored shape from known fields and rejects anything else
      const clean = sanitizeCanvasBackground(val)
      if (!clean) throw new Error('Invalid canvas background')
      result.canvasBackground = clean
    } else {
      if (!['exitOnClose', 'startAtLogin', 'automaticUpdates', 'routineNotifications', 'onboarded', 'notificationsEnabled', ...NOTIFICATION_OPTIONS.map(o => o.key)].includes(key) || typeof val !== 'boolean') throw new Error('Invalid preference')
      result[key as 'exitOnClose' | 'startAtLogin' | 'automaticUpdates' | 'routineNotifications' | 'onboarded' | 'notificationsEnabled'] = val
    }
  }
  return result
}

/** A path with its longest existing prefix resolved through links, so two
 *  spellings of the same folder (case, `..`, a junction) compare equal. */
export function resolveExisting(p: string): string {
  if (fs.existsSync(p)) return fs.realpathSync.native(p)
  const parent = path.dirname(p)
  if (parent === p) throw new Error('Invalid data root')
  return path.join(resolveExisting(parent), path.basename(p))
}
const canonicalRoot = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p

export const DATA_LOCATION_FILE = 'data-location.json'
export const DATA_MOVE_MARKER_FILE = '.data-move-in-progress.json'
export const DATA_LOCATION_MAX_BYTES = 16 * 1024

export interface DataLocationConfig {
  version: 1
  dataRoot: string
  previousRoot?: string
  movedAt?: string
}

/** Normalize a local absolute data-folder path, rejecting UNC (`\\server\share`),
 *  verbatim UNC (`\\?\UNC\...`), Win32 device (`\\.\...`), relative, and `..` paths. */
export function normalizeLocalDataPath(raw: string, platform: NodeJS.Platform = process.platform): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (platform === 'win32' || trimmed.startsWith('\\\\')) {
    let plain = trimmed
    if (trimmed.startsWith('\\\\?\\')) {
      const rest = trimmed.slice(4)
      if (!/^[A-Za-z]:[\\/]/.test(rest)) return null
      plain = rest
    } else if (trimmed.startsWith('\\\\')) {
      return null
    }
    if (platform === 'win32') {
      if (!/^[A-Za-z]:[\\/]/.test(plain)) return null
      if (plain.split(/[\\/]+/).includes('..')) return null
      return path.win32.normalize(plain)
    }
    return null
  }
  if (!path.posix.isAbsolute(trimmed)) return null
  if (trimmed.split('/').includes('..')) return null
  return path.normalize(trimmed)
}

export function isLocalAbsoluteDataPath(raw: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeLocalDataPath(raw, platform) !== null
}

/** `<userData>\data-location.json` when present, non-reparse, <=16 KiB, and valid; null otherwise. */
export function readDataLocationConfig(
  userData: string,
  io: Pick<typeof fs, 'readFileSync'> & Partial<Pick<typeof fs, 'lstatSync' | 'readlinkSync'>> = fs,
): DataLocationConfig | null {
  const file = path.join(userData, DATA_LOCATION_FILE)
  if (typeof io.lstatSync === 'function') {
    let st: fs.Stats
    try { st = io.lstatSync(file) } catch { return null }
    if (st.isSymbolicLink() || !st.isFile() || st.size > DATA_LOCATION_MAX_BYTES) return null
    if (process.platform === 'win32' && typeof io.readlinkSync === 'function') {
      try { io.readlinkSync(file); return null } catch { /* regular file */ }
    }
  }
  let text: string
  try { text = io.readFileSync(file, 'utf8') } catch { return null }
  if (Buffer.byteLength(text, 'utf8') > DATA_LOCATION_MAX_BYTES) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || typeof raw.dataRoot !== 'string') return null
  const dataRoot = normalizeLocalDataPath(raw.dataRoot)
  if (!dataRoot) return null
  const previousRoot = typeof raw.previousRoot === 'string'
    ? (normalizeLocalDataPath(raw.previousRoot) ?? undefined)
    : undefined
  const movedAt = typeof raw.movedAt === 'string' && raw.movedAt.trim() ? raw.movedAt.trim().slice(0, 64) : undefined
  return {
    version: 1,
    dataRoot,
    ...(previousRoot ? { previousRoot } : {}),
    ...(movedAt ? { movedAt } : {}),
  }
}

let lastResolvedFromEnv = false

/** Whether the last `resolveDataRoot` call took an explicit environment override. */
export function isDataRootFromEnv(): boolean {
  return lastResolvedFromEnv
}

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
 *  Every other identity obeys `ORGTREE_V2_DATA` first, then `data-location.json`
 *  in `userData`, and otherwise `<userData>\data`. */
export function resolveDataRoot(requested: string | undefined, userData: string, identity: Pick<DesktopIdentity, 'ownDataRootOnly'>): string {
  const own = path.join(userData, 'data')
  if (!identity.ownDataRootOnly) {
    if (requested !== undefined) {
      lastResolvedFromEnv = true
      return requested
    }
    lastResolvedFromEnv = false
    return readDataLocationConfig(userData)?.dataRoot ?? own
  }
  if (requested === undefined) { lastResolvedFromEnv = false; return own }
  if (path.isAbsolute(requested) && canonicalRoot(resolveExisting(path.resolve(requested))) === canonicalRoot(resolveExisting(path.resolve(own)))) {
    lastResolvedFromEnv = true
    return own
  }
  throw new Error(`This Orgtree 3.0 alpha uses only its own data folder, ${own}. ORGTREE_V2_DATA is set to ${JSON.stringify(requested)}, which is a different folder. Unset ORGTREE_V2_DATA and start it again.`)
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

export interface DescriptorOwner {
  ok: boolean
  detail: string
  /** POSIX: the folder whose write permission for others caused the refusal.
   *  Its owner can fix that with chmod; nothing else changes the verdict, so
   *  the caller stops waiting and says so (see unsafeFolderMessage). */
  unsafeFolder?: string
  /** Windows: the accounts (SIDs, comma-separated) that can change
   *  `unsafeFolder`, and whether it is a folder above the data folder (they
   *  can replace it) or the data folder itself (they can write in it). Set
   *  only for a folder: a refusal about the file itself can end when a new
   *  engine replaces the file, so it keeps the ordinary wait. */
  unsafeBy?: string
  unsafeAbove?: boolean
}

/** The accounts Windows itself defines, by the names its dialogs show. */
const WELL_KNOWN_ACCOUNTS: Record<string, string> = { 'S-1-1-0': 'Everyone', 'S-1-5-11': 'Authenticated Users',
  'S-1-5-32-545': 'Users', 'S-1-5-32-546': 'Guests', 'S-1-5-4': 'Interactive', 'S-1-5-7': 'Anonymous' }

/** What the user is told when a refused folder blocks the background engine:
 *  which folder, who can change it, and what to do. Waiting changes nothing,
 *  so this replaces "no verified attachment in time" (user ruling 2026-11-14). */
export function unsafeDescriptorMessage(trust: DescriptorOwner): string {
  const folder = trust.unsafeFolder ?? ''
  if (trust.unsafeBy === undefined) return unsafeFolderMessage(folder)
  const accounts = trust.unsafeBy.split(',').filter(Boolean).map(sid => WELL_KNOWN_ACCOUNTS[sid] ? `${WELL_KNOWN_ACCOUNTS[sid]} (${sid})` : sid).join(', ')
  const what = trust.unsafeAbove ? `the folder ${folder}, which is above Orgtree's data folder` : `Orgtree's data folder ${folder}`
  return `Orgtree's background engine is running, but Orgtree will not connect to it because other accounts on this computer can change ${what}: ${accounts}.${trust.unsafeAbove ? ' Orgtree does not change permissions outside its own folders.' : ''}

To fix it, open the folder's Properties, choose Security, and remove those accounts' permission to modify it. Then start Orgtree again.`
}

/** Single-quoted for a POSIX shell. */
export function shellQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }

/** What the user is told when a folder others can write blocks the background
 *  engine. Orgtree never changes permissions outside its own folders (ruling
 *  2026-10-10), so the fix is theirs to run. */
export function unsafeFolderMessage(folder: string): string {
  return `Orgtree's background engine is running, but Orgtree will not connect to it because other users can change the folder ${folder}. Orgtree does not change permissions outside its own folders.

To fix it, run this in a terminal and start Orgtree again:

chmod g-w,o-w ${shellQuote(folder)}`
}

export type PosixStat = Pick<fs.Stats, 'uid' | 'mode'> & { isFile(): boolean; isDirectory(): boolean }

/** The directory and each ancestor up to `/`, nearest first. */
function ancestorStats(dir: string): Array<[string, PosixStat]> {
  const out: Array<[string, PosixStat]> = []
  for (let d = dir; ; d = path.dirname(d)) {
    out.push([d, fs.statSync(d)])
    if (path.dirname(d) === d) return out
  }
}

/** macOS and Linux (the LaunchAgent / systemd host writes the descriptor
 *  0600): the same write boundary as the Windows check. The file is a regular
 *  file of this user's that nobody else may read or write (it carries the
 *  token); its directory is this user's (or root's) and writable by nobody
 *  else; an ancestor that others can write must be sticky (/tmp), so nobody
 *  can replace a path component. */
export function judgePosixTrust(uid: number, file: PosixStat, dirs: Array<[string, PosixStat]>): DescriptorOwner {
  if (!file.isFile()) return { ok: false, detail: 'descriptor is not a regular file' }
  if (file.uid !== uid) return { ok: false, detail: `owner ${file.uid} is not current user ${uid}` }
  if (file.mode & 0o077) return { ok: false, detail: `descriptor mode ${(file.mode & 0o777).toString(8)} lets others read or write it` }
  for (const [i, [name, s]] of dirs.entries()) {
    if (!s.isDirectory()) return { ok: false, detail: `${name} is not a directory` }
    if (s.uid !== uid && s.uid !== 0) return { ok: false, detail: `${i ? 'path replaceable via ancestor' : 'descriptor directory owned by'} ${name} (owner ${s.uid})` }
    const othersWrite = (s.mode & 0o022) !== 0
    if (othersWrite && (i === 0 || !(s.mode & 0o1000))) return { ok: false, detail: `${i ? 'path replaceable via ancestor' : 'descriptor directory writable by others:'} ${name}`, unsafeFolder: name }
  }
  return { ok: true, detail: `owner ${uid}, exclusive write boundary` }
}

/** Windows PowerShell 5.1 by its absolute path (as runasadmin.ts runs it),
 *  never whichever `powershell.exe` the inherited PATH finds first. */
export const WINDOWS_POWERSHELL = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** The environment for a Windows PowerShell child: this process's, except that
 *  PSModulePath names Windows PowerShell's own module folders only. A desktop
 *  started from PowerShell 7 inherits a PSModulePath that lists PowerShell 7's
 *  modules first, and Windows PowerShell 5.1 then cannot load the modules both
 *  ship (Get-Acl: "found in the module 'Microsoft.PowerShell.Security', but the
 *  module could not be loaded"); pwsh repairs that only for children it starts
 *  itself. Windows matches variable names case-insensitively, so the inherited
 *  value is dropped under every casing. */
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() !== 'psmodulepath') out[key] = value
  const windows = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const programs = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  out.PSModulePath = `${windows}\\system32\\WindowsPowerShell\\v1.0\\Modules;${programs}\\WindowsPowerShell\\Modules`
  return out
}

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
  if (process.platform !== 'win32') {
    try {
      const uid = process.getuid?.()
      if (uid === undefined) return Promise.resolve({ ok: false, detail: 'no user id on this platform' })
      return Promise.resolve(judgePosixTrust(uid, fs.lstatSync(file), ancestorStats(path.dirname(file))))
    } catch (error) { return Promise.resolve({ ok: false, detail: `descriptor stat failed: ${(error as Error).message}` }) }
  }
  const escaped = file.replace(/'/g, "''")
  const directory = path.dirname(file).replace(/'/g, "''")
  // File + immediate directory use the full write mask; ANCESTORS use the
  // replacement mask (delete/delete-child/perm-change/take-ownership/
  // generic-all): higher up, only the power to REPLACE a path component
  // matters, and counting create rights there would flag every stock C:\.
  // Inherit-only ACEs are skipped everywhere — they apply to future
  // children, not to the object itself (the stock C:\ Authenticated Users
  // ACE is exactly that shape).
  // A DRIVE'S ROOT is judged without DELETE (user ruling 2026-11-14): nobody
  // can delete or rename a volume's root folder, and Windows gives the root
  // of a formatted data drive "Authenticated Users: Modify", which carries
  // it. Every other replacement right still counts there. A root is any
  // drive letter's (`X:\`), a SUBST letter and a mapped network drive too
  // (user ruling 2026-11-14 08:00Z: "Any drive letter"). A UNC path has no
  // drive letter and keeps the full mask. The installer's copy of this rule
  // (Get-DescriptorDistrust, tools/installer-upgrade.ps1) is the same;
  // tests/descriptor-trust-drive-root.test.mjs holds both to one table.
  const script =
    `$ErrorActionPreference='Stop';` +
    `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;` +
    `$allowed=@($me,'S-1-5-18','S-1-5-32-544','S-1-3-0');` +
    `$writeMask=0x116 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000;` +
    `$replaceMask=0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000;` +
    `$rootMask=0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000;` +
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
    `while($a){$mask=$replaceMask;if($a -match '^[A-Za-z]:\\\\$'){$mask=$rootMask};$hits=BadWriters $a $mask;` +
    `if($hits.Count -gt 0){$ancestorBad+=($a+'='+($hits -join ','))};` +
    `$next=Split-Path $a;if($next -eq $a){break};$a=$next};` +
    `Write-Output ($me+'|'+$owner+'|'+($fileBad -join ',')+'|'+($dirBad -join ',')+'|'+($ancestorBad -join ';'))`
  return new Promise(resolve => {
    // Lazy import keeps policy.ts loadable in bundled unit tests without electron.
    import('node:child_process').then(({ execFile }) => {
      execFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true, env: windowsPowerShellEnv() },
        (error, stdout) => {
          if (error) return resolve({ ok: false, detail: `trust query failed: ${error.message.slice(0, 200)}` })
          const parts = stdout.trim().split('|')
          if (parts.length !== 5 || !parts[0].startsWith('S-') || !parts[1].startsWith('S-')) return resolve({ ok: false, detail: `trust query unparseable: ${stdout.trim().slice(0, 120)}` })
          const [current, owner, fileBad, dirBad, ancestorBad] = parts
          resolve(judgeDescriptorTrust(current, owner, fileBad, dirBad, ancestorBad, path.dirname(file)))
        })
    }, () => resolve({ ok: false, detail: 'child_process unavailable' }))
  })
}

export function judgePosixDirectoryTrust(uid: number, dirs: Array<[string, PosixStat]>): DescriptorOwner {
  for (const [i, [name, s]] of dirs.entries()) {
    if (!s.isDirectory()) return { ok: false, detail: `${name} is not a directory` }
    if (s.uid !== uid && s.uid !== 0) return { ok: false, detail: `${i ? 'path replaceable via ancestor' : 'descriptor directory owned by'} ${name} (owner ${s.uid})` }
    const othersWrite = (s.mode & 0o022) !== 0
    if (othersWrite && (i === 0 || !(s.mode & 0o1000))) return { ok: false, detail: `${i ? 'path replaceable via ancestor' : 'descriptor directory writable by others:'} ${name}`, unsafeFolder: name }
  }
  return { ok: true, detail: `owner ${uid}, exclusive write boundary` }
}

/** Read-only directory + ancestor DACL trust check (same write/replace/drive-root
 *  boundary as `verifyDescriptorTrust`, evaluated directly on `dir` before any
 *  engine or PostgreSQL process is started on a custom data folder). */
export function verifyDataFolderTrust(dir: string): Promise<DescriptorOwner> {
  if (process.platform !== 'win32') {
    try {
      const uid = process.getuid?.()
      if (uid === undefined) return Promise.resolve({ ok: false, detail: 'no user id on this platform' })
      return Promise.resolve(judgePosixDirectoryTrust(uid, ancestorStats(path.resolve(dir))))
    } catch (error) { return Promise.resolve({ ok: false, detail: `directory stat failed: ${(error as Error).message}` }) }
  }
  const resolvedDir = path.resolve(dir)
  const directory = resolvedDir.replace(/'/g, "''")
  const script =
    `$ErrorActionPreference='Stop';` +
    `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;` +
    `$allowed=@($me,'S-1-5-18','S-1-5-32-544','S-1-3-0');` +
    `$writeMask=0x116 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000;` +
    `$replaceMask=0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000;` +
    `$rootMask=0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000;` +
    `function BadWriters($p,$mask){$acl=Get-Acl -LiteralPath $p;$bad=@();` +
    `foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){` +
    `if($r.AccessControlType -ne 'Allow'){continue};` +
    `if(($r.PropagationFlags.ToString()) -match 'InheritOnly'){continue};` +
    `$sid=$r.IdentityReference.Value;` +
    `if($allowed -contains $sid){continue};` +
    `if(([int]$r.FileSystemRights -band $mask) -ne 0){$bad+=$sid}};` +
    `,@($bad | Select-Object -Unique)};` +
    `$owner=(Get-Acl -LiteralPath '${directory}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value;` +
    `$dirBad=BadWriters '${directory}' $writeMask;` +
    `$ancestorBad=@();$a=Split-Path '${directory}';` +
    `while($a){$mask=$replaceMask;if($a -match '^[A-Za-z]:\\\\$'){$mask=$rootMask};$hits=BadWriters $a $mask;` +
    `if($hits.Count -gt 0){$ancestorBad+=($a+'='+($hits -join ','))};` +
    `$next=Split-Path $a;if($next -eq $a){break};$a=$next};` +
    `Write-Output ($me+'|'+$owner+'||'+($dirBad -join ',')+'|'+($ancestorBad -join ';'))`
  return new Promise(resolve => {
    import('node:child_process').then(({ execFile }) => {
      execFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true, env: windowsPowerShellEnv() },
        (error, stdout) => {
          if (error) return resolve({ ok: false, detail: `trust query failed: ${error.message.slice(0, 200)}` })
          const parts = stdout.trim().split('|')
          if (parts.length !== 5 || !parts[0].startsWith('S-') || !parts[1].startsWith('S-')) return resolve({ ok: false, detail: `trust query unparseable: ${stdout.trim().slice(0, 120)}` })
          const [current, owner, fileBad, dirBad, ancestorBad] = parts
          resolve(judgeDescriptorTrust(current, owner, fileBad, dirBad, ancestorBad, resolvedDir))
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
export function judgeDescriptorTrust(current: string, owner: string, fileBad: string, dirBad: string, ancestorBad: string, directory = ''): DescriptorOwner {
  if (owner !== current && !TRUSTED_OWNERS.has(owner)) return { ok: false, detail: `owner ${owner} is not current user ${current}` }
  if (fileBad) return { ok: false, detail: `descriptor writable by ${fileBad}` }
  if (dirBad) return { ok: false, detail: `descriptor directory writable by ${dirBad}`, ...(directory ? { unsafeFolder: directory, unsafeBy: dirBad, unsafeAbove: false } : {}) }
  if (ancestorBad) {
    // `folder=sid,sid;folder=sid`, nearest first: the first is the one to name
    const nearest = /^(.*?)=(S-1-[0-9-]+(?:,S-1-[0-9-]+)*)(?:;|$)/.exec(ancestorBad)
    return { ok: false, detail: `path replaceable via ancestor ${ancestorBad.slice(0, 300)}`,
      ...(nearest ? { unsafeFolder: nearest[1], unsafeBy: nearest[2], unsafeAbove: true } : {}) }
  }
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
 *  All migration/conversion steps get one hour (user request 2026-10-05).
 *  The boot host uses the same 3600 s. */
export const CONVERSION_WINDOW_MS = 3600000

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

/** The header a window bound to an organization of a REMOTE engine carries on its engine requests: that
 *  engine's connection id (docs/rust-engine/remote-org.md). The local engine relays such a window's
 *  organization and engine routes to the remote and stamps its answers with both processes. */
export const REMOTE_HEADER = 'X-Orgtree-Remote'

/** Run on ALL destinations after `scopedHeaders`: a page-supplied header is always stripped, and the
 *  owner window's remote engine id is added only to a permitted request to this engine (`origin` is
 *  empty for a request that is not permitted, as for the token). */
export function remoteHeaders(headers: Record<string, string>, url: string, origin: string, remote: string | undefined): Record<string, string> {
  const clean = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== REMOTE_HEADER.toLowerCase()))
  if (remote && engineUrl(url, origin)) clean[REMOTE_HEADER] = remote
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

/** A Hubchat desktop deep link (`hubchat://chat?to=@net:...`) opened by a
 *  HubContactChip when Hubchat is installed on this PC. */
export function hubchatChatUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'hubchat:' && !u.username && !u.password
  } catch { return false }
}

export function closeAction(exitOnClose: boolean, quitting: boolean, otherVisibleViews = 0): 'hide' | 'quit' | 'close' {
  return quitting ? 'close' : exitOnClose && otherVisibleViews === 0 ? 'quit' : 'hide'
}
