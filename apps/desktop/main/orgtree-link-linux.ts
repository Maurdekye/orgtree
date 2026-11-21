// main/orgtree-link-linux.ts — orgtree:// registration and extract-mode desktop entry on Linux
// (docs/rust-engine/orgtree-links.md; USER 2026-11-20 m5b5128333307;
//  docs/steamos-steam-frame.md; USER 2026-11-21 m633d58394fc0).
//
// Windows registers the scheme through Electron (main/orgtree-link.ts). Linux
// has no such call that works for an AppImage, so the packaged app writes its
// per-user files itself:
//
//   <data>/applications/dev.orgtree.link.desktop   its OWN handler entry
//   <config>/mimeapps.list                         the default for the scheme
//   <data>/applications/orgtree.desktop            extract-and-run mode ONLY,
//                                                  only created or repaired if ours
//
// ⚠ It never changes or removes a hand-written entry (an orgtree.desktop without
// X-Orgtree-Version= or any entry under another name belongs to whoever made it),
// and it becomes the default only when nothing is: a default the user or another
// program chose stays.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appImageExtracted } from './engine-runtime'

export const LINK_ENTRY = 'dev.orgtree.link.desktop'
export const LINK_MIME = 'x-scheme-handler/orgtree'
export const APP_ENTRY = 'orgtree.desktop'
const APP_ICON_REL = path.join('icons', 'hicolor', '256x256', 'apps', 'orgtree.png')
const DEFAULTS = '[Default Applications]'
const MAX_ENTRY_BYTES = 256 * 1024
const MAX_ICON_BYTES = 4 * 1024 * 1024
let tmpSeq = 0

export interface LinuxLinkInputs {
  platform: string
  isPackaged: boolean
  /** The account's real home (`os.userInfo().homedir`), not `$HOME`. */
  home: string
  version: string
  /** `process.execPath`: the program of an installed package. */
  execPath: string
  env: Record<string, string | undefined>
  /** Test seam: invoked after staging a temporary file and immediately before publishing `dest`. */
  beforePublish?: (dest: string) => void
  /** Test seam: override the temporary pathname chosen for `file`. */
  makeTempPath?: (file: string) => string
}

export interface LinuxLinkResult {
  entry: 'written' | 'current' | 'skipped'
  /** set: written now; ours: already this entry; other: someone else's, left alone. */
  default: 'set' | 'ours' | 'other' | 'skipped'
  other?: string
}

export interface LinuxAppEntryInputs extends LinuxLinkInputs {
  /** Optional path to the packaged PNG icon (`<resourcesPath>/runtime-icons/orgtree-eye.png`). */
  iconSource?: string
}

export interface LinuxAppEntryResult {
  /** written: created or repaired our entry; current: ours and unchanged;
   *  other: an existing non-Orgtree orgtree.desktop was left alone;
   *  skipped: guards did not permit writing. */
  entry: 'written' | 'current' | 'other' | 'skipped'
  /** written: installed the icon; exists: already present (left alone);
   *  skipped: not attempted or optional write failed. */
  icon: 'written' | 'exists' | 'skipped'
}

/** One program path as an Exec argument. A plain path (letters, digits and
 *  `/._+-`) is written bare; any other is quoted, with the Desktop Entry
 *  escapes (inside quotes `"`, `` ` ``, `$` and `\` take a backslash; a string
 *  value doubles each backslash; `%` doubles). Null for a path that is not
 *  absolute or holds a control character: nothing is written for it.
 *  ⚠ Bare wherever it can be: SteamOS gamescope's xdg-open (generic mode) keeps
 *  the quotes as part of the name, so a quoted Exec starts nothing there
 *  (4.6.6 on a Steam Frame, 2026-11-20). A path that needs quotes may still fail there. */
export function desktopExecArg(program: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!program.startsWith('/') || /[\u0000-\u001f\u007f]/.test(program)) return null
  if (/^\/[A-Za-z0-9/._+-]+$/.test(program)) return program
  return '"' + program.replace(/["`$\\]/g, c => '\\' + c).replace(/\\/g, '\\\\').replace(/%/g, '%%') + '"'
}

/** The handler entry. A run without a FUSE mount asks for the same mode through
 *  the variable: the AppImage runtime consumes the argument form.
 *  ⚠ NO_CLEANUP stays with it. Every launch of one AppImage file extracts into
 *  the same folder, and the runtime removes that folder when the app it started
 *  exits: without it each link would delete the running app's files as it
 *  handed over (measured on a Steam Frame 2026-11-20; runtime.c, AppImageKit effcebc). */
export function linkEntryText(o: { program: string; extracted: boolean; version: string }): string {
  const exec = `${o.extracted ? 'env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 ' : ''}${desktopExecArg(o.program)} %u`
  return ['[Desktop Entry]', 'Type=Application', 'Name=Orgtree link', 'NoDisplay=true', `Exec=${exec}`,
    `MimeType=${LINK_MIME};`, `X-Orgtree-Version=${o.version.replace(/[^0-9A-Za-z.+-]/g, '')}`, ''].join('\n')
}

/** The visible app-list entry written in extract-and-run mode so FUSE-less
 *  systems (SteamOS / Steam Frame) launch the original AppImage path with
 *  APPIMAGE_EXTRACT_AND_RUN=1 and NO_CLEANUP=1, preserving in-place updates.
 *  Carries X-Orgtree-Version= to mark it as Orgtree-managed; hand-written
 *  entries without that marker are never overwritten. */
export function appEntryText(o: { program: string; version: string }): string {
  const exec = `env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 ${desktopExecArg(o.program)} %U`
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Orgtree',
    'Comment=Put a team of AI agents to work',
    `Exec=${exec}`,
    'Icon=orgtree',
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=Orgtree',
    `X-Orgtree-Version=${o.version.replace(/[^0-9A-Za-z.+-]/g, '')}`,
    '',
  ].join('\n')
}

const sameFolder = (a: string, b: string) => path.resolve(a) === path.resolve(b)
const xdg = (value: string | undefined, fallback: string) => (value && path.isAbsolute(value) ? value : fallback)

interface WriteHooks {
  beforePublish?: (dest: string) => void
  makeTempPath?: (file: string) => string
}

interface RegularSnapshot {
  text: string
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/** True when `execPath` is strictly inside `appDir` (resolving symlinks when
 *  both paths exist on disk, otherwise using normalized POSIX paths). */
function execInsideAppDir(execPath: string, appDir: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (!execPath.startsWith('/') || !appDir.startsWith('/') || /[\u0000-\u001f\u007f]/.test(execPath) || /[\u0000-\u001f\u007f]/.test(appDir)) {
    return false
  }
  try {
    const realDir = fs.realpathSync(appDir)
    const realExec = fs.realpathSync(execPath)
    if (realDir === '/' || realDir === path.sep) return false
    const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep
    return realExec.startsWith(prefix) && realExec.length > prefix.length
  } catch {
    const normDir = path.posix.normalize(appDir).replace(/\/+$/, '')
    const normExec = path.posix.normalize(execPath)
    if (!normDir || normDir === '/') return false
    return normExec.startsWith(normDir + '/') && normExec.length > normDir.length + 1
  }
}

/** Validate that `APPIMAGE` and `APPDIR` belong to this running process rather
 *  than being inherited from a parent AppImage that launched a native install. */
function ownAppImage(
  execPath: string,
  env: Record<string, string | undefined>,
): { program: string; extracted: boolean } | null {
  const program = env.APPIMAGE
  const appDir = env.APPDIR
  if (!program || !appDir) return null
  const normDir = path.posix.normalize(appDir).replace(/\/+$/, '')
  const base = path.posix.basename(normDir)
  const extracted = appImageExtracted(env) !== null && base.startsWith('appimage_extracted_')
  const mounted = base.startsWith('.mount_')
  if (!extracted && !mounted) return null
  if (!execInsideAppDir(execPath, appDir)) return null
  return { program, extracted }
}

function systemDataDirs(env: Record<string, string | undefined>, dataHome: string): string[] {
  const raw = env.XDG_DATA_DIRS
  const list = raw && raw.length > 0
    ? (raw.includes(';') || /^[A-Za-z]:[\\/]/.test(raw) ? raw.split(';') : raw.split(':'))
    : ['/usr/local/share', '/usr/share']
  const out: string[] = []
  for (const dir of list) {
    if (!dir || !path.isAbsolute(dir) || sameFolder(dir, dataHome)) continue
    out.push(dir)
  }
  return out
}

function hasSystemEntry(env: Record<string, string | undefined>, dataHome: string, entryName: string): boolean {
  for (const dir of systemDataDirs(env, dataHome)) {
    try {
      fs.lstatSync(path.join(dir, 'applications', entryName))
      return true
    } catch { /* absent or unreadable */ }
  }
  return false
}

function defaultTempPath(file: string): string {
  const rand = crypto.randomBytes(6).toString('hex')
  return `${file}.${process.pid}.${tmpSeq++}.${rand}.tmp`
}

/** Exclusively create and populate a temporary file beside `file`.
 *  If the exclusive open fails (e.g. `EEXIST`), the colliding path was NOT
 *  created by us and is never unlinked. Permissions are applied on the open
 *  file descriptor before closing. */
function writeTempExclusive(file: string, data: string | Buffer, makeTempPath?: (file: string) => string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = makeTempPath ? makeTempPath(file) : defaultTempPath(file)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(tmp, flags, 0o644)
  try {
    try {
      fs.writeFileSync(fd, data)
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o644)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return tmp
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* best-effort cleanup of file we created */ }
    throw error
  }
}

function writeAtomic(file: string, data: string | Buffer, makeTempPath?: (file: string) => string): void {
  const tmp = writeTempExclusive(file, data, makeTempPath)
  try { fs.renameSync(tmp, file) }
  catch (error) { try { fs.unlinkSync(tmp) } catch { /* ignore */ }; throw error }
}

/** Publish a new file with no-replace semantics (`link(tmp, dest)` + unlink,
 *  falling back to `O_CREAT | O_EXCL` on filesystems without hard-link support).
 *  Returns `'exists'` without touching `file` if another writer created it first. */
function writeNoReplace(file: string, data: string | Buffer, hooks: WriteHooks): 'written' | 'exists' {
  const tmp = writeTempExclusive(file, data, hooks.makeTempPath)
  try {
    hooks.beforePublish?.(file)
    try {
      fs.linkSync(tmp, file)
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      return 'written'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      if (code === 'EEXIST') return 'exists'
      if (code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EPERM') {
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
        let fd: number
        try {
          fd = fs.openSync(file, flags, 0o644)
        } catch (openErr) {
          if ((openErr as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
          throw openErr
        }
        try {
          try {
            fs.writeFileSync(fd, data)
            if (process.platform !== 'win32') fs.fchmodSync(fd, 0o644)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
          return 'written'
        } catch (writeErr) {
          try { fs.unlinkSync(file) } catch { /* ignore */ }
          throw writeErr
        }
      }
      throw error
    }
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

function readRegularSnapshot(file: string): RegularSnapshot | null | 'untrusted' {
  try {
    const lst = fs.lstatSync(file)
    if (!lst.isFile() || lst.size > MAX_ENTRY_BYTES) return 'untrusted'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  let fd: number
  try {
    fd = fs.openSync(file, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') return 'untrusted'
    throw error
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    if (!st.isFile() || st.size > BigInt(MAX_ENTRY_BYTES)) return 'untrusted'
    const buf = Buffer.allocUnsafe(MAX_ENTRY_BYTES + 1)
    let total = 0
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null)
      if (n === 0) break
      total += n
    }
    if (total > MAX_ENTRY_BYTES) return 'untrusted'
    return {
      text: buf.subarray(0, total).toString('utf8'),
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      ctimeNs: st.ctimeNs,
    }
  } finally {
    fs.closeSync(fd)
  }
}

function sameSnapshot(a: RegularSnapshot, b: RegularSnapshot): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs
    && a.text === b.text
}

function isManagedOrgtreeEntry(text: string): boolean {
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { inside = line === '[Desktop Entry]'; continue }
    if (!inside) continue
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(0, eq).trim() === 'X-Orgtree-Version' && line.slice(eq + 1).trim().length > 0) return true
  }
  return false
}

function installIconIfMissing(dataHome: string, iconSource: string | undefined, hooks: WriteHooks): LinuxAppEntryResult['icon'] {
  if (!iconSource) return 'skipped'
  try {
    const dest = path.join(dataHome, APP_ICON_REL)
    try {
      fs.lstatSync(dest)
      return 'exists'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'skipped'
    }
    const src = fs.statSync(iconSource)
    if (!src.isFile() || src.size === 0 || src.size > MAX_ICON_BYTES) return 'skipped'
    const bytes = fs.readFileSync(iconSource)
    return writeNoReplace(dest, bytes, hooks)
  } catch {
    return 'skipped'
  }
}

/** The scheme's default in a mimeapps.list (`[Default Applications]`), first
 *  entry of its value; '' when there is none. */
function defaultIn(lines: string[]): { at: number; section: number; value: string } {
  let inside = false, section = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith('[')) { inside = line === DEFAULTS; if (inside && section < 0) section = i; continue }
    if (!inside) continue
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(0, eq).trim() === LINK_MIME) return { at: i, section, value: line.slice(eq + 1).split(';')[0]!.trim() }
  }
  return { at: -1, section, value: '' }
}

function claimDefault(file: string): Pick<LinuxLinkResult, 'default' | 'other'> {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const found = defaultIn(lines)
  if (found.value === LINK_ENTRY) return { default: 'ours' }
  if (found.value) return { default: 'other', other: found.value }
  const ours = `${LINK_MIME}=${LINK_ENTRY};`
  if (found.at >= 0) lines[found.at] = ours
  else if (found.section >= 0) {
    // after the section's last line that is not blank
    let end = found.section + 1
    for (let i = end; i < lines.length && !lines[i]!.trim().startsWith('['); i++) if (lines[i]!.trim()) end = i + 1
    lines.splice(end, 0, ours)
  } else {
    if (lines.length) lines.push('')
    lines.push(DEFAULTS, ours)
  }
  writeAtomic(file, lines.join('\n') + '\n')
  return { default: 'set' }
}

/** Register orgtree:// for this Orgtree on Linux, with the Windows guards: a
 *  packaged build with its real profile only. Development, a custom data root or
 *  profile, and a run whose HOME is not the account's home (a smoke) write
 *  nothing: each would aim the user's links at a test copy. */
export function registerLinuxOrgtreeScheme(o: LinuxLinkInputs): LinuxLinkResult {
  const skipped: LinuxLinkResult = { entry: 'skipped', default: 'skipped' }
  if (o.platform !== 'linux' || !o.isPackaged || !o.home) return skipped
  if (o.env.ORGTREE_V2_DATA || o.env.ORGTREE_V2_PROFILE) return skipped
  if (o.env.HOME && !sameFolder(o.env.HOME, o.home)) return skipped
  const owned = ownAppImage(o.execPath, o.env)
  const program = owned ? owned.program : o.execPath
  const extracted = owned ? owned.extracted : false
  if (desktopExecArg(program) === null) return skipped
  const entry = path.join(xdg(o.env.XDG_DATA_HOME, path.join(o.home, '.local', 'share')), 'applications', LINK_ENTRY)
  const text = linkEntryText({ program, extracted, version: o.version })
  let current = false
  try { current = fs.readFileSync(entry, 'utf8') === text } catch { /* not there yet */ }
  if (!current) writeAtomic(entry, text, o.makeTempPath)
  const claimed = claimDefault(path.join(xdg(o.env.XDG_CONFIG_HOME, path.join(o.home, '.config')), 'mimeapps.list'))
  return { entry: current ? 'current' : 'written', ...claimed }
}

/** Write or repair Orgtree's visible orgtree.desktop (and install its icon if
 *  missing) when running as a packaged Linux AppImage in extract-and-run mode.
 *  Uses the same real-install and foreign-HOME guards as scheme registration.
 *  Only writes or repairs our own entry (marked with X-Orgtree-Version=); never
 *  modifies a hand-written orgtree.desktop, a symlink, a concurrent user edit,
 *  an administrator-installed system entry, or any entry under another name. */
export function registerLinuxOrgtreeApp(o: LinuxAppEntryInputs): LinuxAppEntryResult {
  const skipped: LinuxAppEntryResult = { entry: 'skipped', icon: 'skipped' }
  if (o.platform !== 'linux' || !o.isPackaged || !o.home) return skipped
  if (o.env.ORGTREE_V2_DATA || o.env.ORGTREE_V2_PROFILE) return skipped
  if (o.env.HOME && !sameFolder(o.env.HOME, o.home)) return skipped
  const owned = ownAppImage(o.execPath, o.env)
  if (!owned || !owned.extracted) return skipped
  const program = owned.program
  if (desktopExecArg(program) === null) return skipped

  const dataHome = xdg(o.env.XDG_DATA_HOME, path.join(o.home, '.local', 'share'))
  const entryPath = path.join(dataHome, 'applications', APP_ENTRY)
  const text = appEntryText({ program, version: o.version })

  const snap = readRegularSnapshot(entryPath)
  if (snap === 'untrusted') return { entry: 'other', icon: 'skipped' }

  let entryStatus: 'written' | 'current'
  if (snap === null) {
    if (hasSystemEntry(o.env, dataHome, APP_ENTRY)) return { entry: 'other', icon: 'skipped' }
    if (writeNoReplace(entryPath, text, o) === 'exists') return { entry: 'other', icon: 'skipped' }
    entryStatus = 'written'
  } else {
    if (!isManagedOrgtreeEntry(snap.text)) return { entry: 'other', icon: 'skipped' }
    if (snap.text === text) {
      entryStatus = 'current'
    } else {
      const tmp = writeTempExclusive(entryPath, text, o.makeTempPath)
      try {
        o.beforePublish?.(entryPath)
        const cur = readRegularSnapshot(entryPath)
        if (cur === null) {
          try {
            fs.linkSync(tmp, entryPath)
            try { fs.unlinkSync(tmp) } catch { /* ignore */ }
          } catch (error) {
            try { fs.unlinkSync(tmp) } catch { /* ignore */ }
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { entry: 'other', icon: 'skipped' }
            throw error
          }
        } else if (cur === 'untrusted' || !sameSnapshot(snap, cur)) {
          try { fs.unlinkSync(tmp) } catch { /* ignore */ }
          return { entry: 'other', icon: 'skipped' }
        } else {
          fs.renameSync(tmp, entryPath)
        }
      } catch (error) {
        try { fs.unlinkSync(tmp) } catch { /* ignore */ }
        throw error
      }
      entryStatus = 'written'
    }
  }

  const icon = installIconIfMissing(dataHome, o.iconSource, o)
  return { entry: entryStatus, icon }
}
