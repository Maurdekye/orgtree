// main/orgtree-link-linux.ts — orgtree:// registration on Linux
// (docs/rust-engine/orgtree-links.md; USER 2026-11-20 m5b5128333307).
//
// Windows registers the scheme through Electron (main/orgtree-link.ts). Linux
// has no such call that works for an AppImage, so the packaged app writes the
// two per-user files itself:
//
//   <data>/applications/dev.orgtree.link.desktop   its OWN handler entry
//   <config>/mimeapps.list                         the default for the scheme
//
// ⚠ It never changes or removes an entry it did not write (a launcher named
// orgtree.desktop belongs to whoever made it), and it becomes the default only
// when nothing is: a default the user or another program chose stays.
import fs from 'node:fs'
import path from 'node:path'
import { appImageExtracted } from './engine-runtime'

export const LINK_ENTRY = 'dev.orgtree.link.desktop'
export const LINK_MIME = 'x-scheme-handler/orgtree'
const DEFAULTS = '[Default Applications]'

export interface LinuxLinkInputs {
  platform: string
  isPackaged: boolean
  /** The account's real home (`os.userInfo().homedir`), not `$HOME`. */
  home: string
  version: string
  /** `process.execPath`: the program of an installed package. */
  execPath: string
  env: Record<string, string | undefined>
}

export interface LinuxLinkResult {
  entry: 'written' | 'current' | 'skipped'
  /** set: written now; ours: already this entry; other: someone else's, left alone. */
  default: 'set' | 'ours' | 'other' | 'skipped'
  other?: string
}

/** One program path as an Exec argument: quoted, with the Desktop Entry
 *  escapes (inside quotes `"`, `` ` ``, `$` and `\` take a backslash; a string
 *  value doubles each backslash; `%` doubles). Null for a path that is not
 *  absolute or holds a control character: nothing is written for it. */
export function desktopExecArg(program: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!program.startsWith('/') || /[\u0000-\u001f\u007f]/.test(program)) return null
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

const sameFolder = (a: string, b: string) => path.resolve(a) === path.resolve(b)
const xdg = (value: string | undefined, fallback: string) => (value && path.isAbsolute(value) ? value : fallback)

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try { fs.writeFileSync(tmp, text, { mode: 0o644 }); fs.renameSync(tmp, file) }
  catch (error) { fs.rmSync(tmp, { force: true }); throw error }
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
  const program = o.env.APPIMAGE || o.execPath
  if (desktopExecArg(program) === null) return skipped
  const entry = path.join(xdg(o.env.XDG_DATA_HOME, path.join(o.home, '.local', 'share')), 'applications', LINK_ENTRY)
  const text = linkEntryText({ program, extracted: appImageExtracted(o.env) !== null, version: o.version })
  let current = false
  try { current = fs.readFileSync(entry, 'utf8') === text } catch { /* not there yet */ }
  if (!current) writeAtomic(entry, text)
  const claimed = claimDefault(path.join(xdg(o.env.XDG_CONFIG_HOME, path.join(o.home, '.config')), 'mimeapps.list'))
  return { entry: current ? 'current' : 'written', ...claimed }
}
