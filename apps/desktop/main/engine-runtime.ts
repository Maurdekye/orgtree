import fs from 'node:fs'
import path from 'node:path'

/** THE ENGINE'S OWN COPY, for an AppImage that runs without FUSE (docket
 *  4-6-4-linux-appimage-boot-unit-takeover-fallback).
 *
 *  Started with `--appimage-extract-and-run` (or APPIMAGE_EXTRACT_AND_RUN=1), the
 *  AppImage runtime unpacks the whole app into <tmp>/appimage_extracted_<hash of the
 *  file> and DELETES that folder when the app it started exits. The folder is shared
 *  by every launch of the same file. Measured (x64 4.6.3 AppImage in a container
 *  without FUSE): a second launch that exits removes all of it under the first, which
 *  is still running. The engine and its PostgreSQL then lose the files they have not
 *  opened yet (PostgreSQL loads plpgsql on first use: "could not access file
 *  "plpgsql""). The same folder cannot serve the background engine either: quitting
 *  the desktop would delete it under the engine that is meant to stay.
 *
 *  So in that mode the engine does not run from the extraction. `resources/engine` and
 *  `resources/ui` are copied once per build into
 *  <userData>/engine-runtime/<version>-<commit>, and both the engine the desktop
 *  starts and the background engine's registration use the copy: no AppImage runtime,
 *  no FUSE and no Electron in between. The host finds `../ui` and `postgresql/` beside
 *  itself (engine host.rs), which is the layout kept here.
 *
 *  An AppImage with FUSE, the .deb and macOS do not come here: their files stay put.
 *
 *  Everything is asynchronous: 440 MB in about 800 files took 3 s to copy. */

export const RUNTIME_FOLDER = 'engine-runtime'
/** The parts of `resources` an engine needs beside itself. */
export const RUNTIME_PARTS = ['engine', 'ui'] as const
const COMPLETE = '.complete'
const TMP_PREFIX = '.tmp-'

/** The extraction folder when this process runs from an AppImage WITHOUT a FUSE
 *  mount, else null. The runtime sets APPIMAGE and APPDIR in both modes; with FUSE
 *  APPDIR is a mount (/tmp/.mount_...), without it <tmp>/appimage_extracted_<hash>
 *  (measured; the flag itself is not in the environment). */
export function appImageExtracted(env: NodeJS.ProcessEnv): string | null {
  const appDir = env.APPDIR
  if (!env.APPIMAGE || !appDir) return null
  return path.posix.basename(appDir.replace(/\/+$/, '')).startsWith('appimage_extracted_') ? appDir : null
}

/** One folder per build: a new version never overwrites files an older engine still runs from. */
export function runtimeCopyName(build: { version: string; commit?: string }): string {
  const safe = (s: string) => s.replace(/[^0-9A-Za-z._-]/g, '_')
  const commit = safe(String(build.commit ?? '')).slice(0, 12)
  return commit ? `${safe(build.version)}-${commit}` : safe(build.version)
}

export interface TreeSize { files: number; bytes: number }

/** Regular files and their bytes, links counted as links (never followed). */
export async function treeSize(dir: string): Promise<TreeSize> {
  const total = { files: 0, bytes: 0 }
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isSymbolicLink()) total.files += 1
      else if (entry.isFile()) { total.files += 1; total.bytes += (await fs.promises.stat(file)).size }
    }
  }
  await walk(dir)
  return total
}

export interface RuntimeCopyInputs {
  /** the running app's `resources` folder (inside the extraction) */
  resources: string
  /** <userData>/engine-runtime */
  root: string
  /** runtimeCopyName of this build */
  name: string
  /** whether a running process was started from inside `dir` (never removed then) */
  inUse?: (dir: string) => Promise<boolean>
  /** test seam: how one part is copied */
  copyTree?: (from: string, to: string) => Promise<void>
  /** this process's id, for the temporary folder's name */
  pid?: number
}

export interface RuntimeCopy {
  /** the copy: <root>/<name> */
  dir: string
  /** <dir>/engine, where orgtree-engine and postgresql/ are */
  engine: string
  /** <dir>/ui */
  ui: string
  /** false when a verified copy of this build was already there */
  copied: boolean
  /** older copies removed */
  removed: string[]
}

const copyTree = (from: string, to: string) =>
  // verbatimSymlinks: PostgreSQL's library links stay relative links inside the copy
  fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false })

async function sourceSize(resources: string): Promise<TreeSize> {
  const total = { files: 0, bytes: 0 }
  for (const part of RUNTIME_PARTS) {
    const size = await treeSize(path.join(resources, part))
    total.files += size.files; total.bytes += size.bytes
  }
  return total
}

async function readComplete(dir: string): Promise<TreeSize | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, COMPLETE), 'utf8')) as Partial<TreeSize>
    return typeof parsed.files === 'number' && typeof parsed.bytes === 'number' ? { files: parsed.files, bytes: parsed.bytes } : null
  } catch { return null }
}

/** A copy is used only when it was finished (its marker is written last, before the
 *  rename into place) and still has the file count and bytes of the source. */
async function verified(dir: string, want: TreeSize): Promise<boolean> {
  const marker = await readComplete(dir)
  if (!marker || marker.files !== want.files || marker.bytes !== want.bytes) return false
  try {
    const total = { files: 0, bytes: 0 }
    for (const part of RUNTIME_PARTS) {
      const size = await treeSize(path.join(dir, part))
      total.files += size.files; total.bytes += size.bytes
    }
    return total.files === want.files && total.bytes === want.bytes
  } catch { return false }
}

/** Whether a running process's program lives under `dir` (Linux: /proc/<pid>/exe).
 *  An engine or a PostgreSQL started from a copy keeps that copy alive. Unreadable
 *  entries (other users' processes) are not ours. */
export async function processRunsFrom(dir: string, proc = '/proc'): Promise<boolean> {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
  let entries: string[]
  try { entries = await fs.promises.readdir(proc) } catch { return false }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // a deleted program reads as "<path> (deleted)": still under the folder
      if ((await fs.promises.readlink(path.join(proc, entry, 'exe'))).startsWith(prefix)) return true
    } catch { /* gone, or not ours to read */ }
  }
  return false
}

/** The rename that publishes a finished copy. Retried briefly: a scanner that still
 *  holds a freshly written file makes the first try fail on some systems. */
async function renameIntoPlace(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(from, to); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
}

/** Make sure <root>/<name> holds a verified copy of this build's engine and ui, and
 *  remove older copies: the current one and the newest other one stay (an update can
 *  be undone by starting the previous AppImage), and never one a process runs from.
 *
 *  A copy is built in a temporary folder beside its place and renamed into it, so a
 *  crash or a full disk leaves nothing that looks finished. Throws when the copy
 *  cannot be made or does not match its source; the caller then runs the engine from
 *  the extraction, as before, and registers nothing. */
export async function ensureRuntimeCopy(o: RuntimeCopyInputs): Promise<RuntimeCopy> {
  const inUse = o.inUse ?? (dir => processRunsFrom(dir))
  const dir = path.join(o.root, o.name)
  const result = (copied: boolean, removed: string[]): RuntimeCopy =>
    ({ dir, engine: path.join(dir, 'engine'), ui: path.join(dir, 'ui'), copied, removed })
  // private, like the data folders: programs run from here
  await fs.promises.mkdir(o.root, { recursive: true, mode: 0o700 })
  await fs.promises.chmod(o.root, 0o700).catch(() => undefined)
  const want = await sourceSize(o.resources)
  if (want.files === 0) throw new Error(`nothing to copy under ${o.resources}`)

  let copied = false
  if (!await verified(dir, want)) {
    // An unfinished or damaged copy of this very build. One that a process still runs
    // from is not replaced under it.
    const exists = await fs.promises.access(dir).then(() => true, () => false)
    if (exists && await inUse(dir)) throw new Error(`the engine copy ${dir} does not match this build and is in use`)
    const tmp = path.join(o.root, `${TMP_PREFIX}${o.name}-${o.pid ?? process.pid}`)
    await fs.promises.rm(tmp, { recursive: true, force: true })
    try {
      await fs.promises.mkdir(tmp, { mode: 0o700 })
      for (const part of RUNTIME_PARTS) await (o.copyTree ?? copyTree)(path.join(o.resources, part), path.join(tmp, part))
      const got = { files: 0, bytes: 0 }
      for (const part of RUNTIME_PARTS) {
        const size = await treeSize(path.join(tmp, part))
        got.files += size.files; got.bytes += size.bytes
      }
      if (got.files !== want.files || got.bytes !== want.bytes) {
        throw new Error(`the engine copy is incomplete: ${got.files} files, ${got.bytes} bytes; the app has ${want.files} files, ${want.bytes} bytes`)
      }
      await fs.promises.writeFile(path.join(tmp, COMPLETE), JSON.stringify({ ...want, name: o.name }) + '\n', { mode: 0o600 })
      await fs.promises.rm(dir, { recursive: true, force: true })
      await renameIntoPlace(tmp, dir)
      copied = true
    } catch (error) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  // Older copies, newest first by when each was finished.
  const removed: string[] = []
  const others: { dir: string; finished: number }[] = []
  for (const entry of await fs.promises.readdir(o.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === o.name) continue
    const other = path.join(o.root, entry.name)
    if (entry.name.startsWith(TMP_PREFIX)) {
      // another launch's unfinished copy: left alone while it is fresh, removed when abandoned
      const age = Date.now() - (await fs.promises.stat(other).then(s => s.mtimeMs, () => Date.now()))
      if (age > 15 * 60_000) { await fs.promises.rm(other, { recursive: true, force: true }).catch(() => undefined); removed.push(other) }
      continue
    }
    const marker = await fs.promises.stat(path.join(other, COMPLETE)).then(s => s.mtimeMs, () => null)
    // a folder without the marker is not one of these copies: never touched
    if (marker !== null) others.push({ dir: other, finished: marker })
  }
  others.sort((a, b) => b.finished - a.finished)
  for (const old of others.slice(1)) {
    if (await inUse(old.dir)) continue
    await fs.promises.rm(old.dir, { recursive: true, force: true }).catch(() => undefined)
    removed.push(old.dir)
  }
  return result(copied, removed)
}
