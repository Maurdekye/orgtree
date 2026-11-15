import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  DataLocationDeletePreviousResult,
  DataLocationLastMoveReport,
  DataLocationMoveOptions,
  DataLocationMoveResult,
  DataLocationPreflight,
  DataLocationProgress,
  DataLocationSizes,
  DataLocationState,
  DataLocationUnreadableEntry,
} from '../../../packages/contracts/index'
import {
  canonicalPath,
  DATA_LOCATION_FILE,
  DATA_LOCATION_MAX_BYTES,
  DATA_MOVE_MARKER_FILE,
  normalizeLocalDataPath,
  processExists,
  readDataLocationConfig,
  resolveExisting,
  unsafeDescriptorMessage,
  validateDataRoot,
  verifyDataFolderTrust,
  verifyDescriptorTrust,
  WINDOWS_POWERSHELL,
  windowsPowerShellEnv,
  type DataLocationConfig,
  type DescriptorOwner,
} from './policy'

export const DATA_LOCATION_SUBFOLDER = 'Orgtree data'
export const DATA_LOCATION_MOVED_STAMP = '.data-location-moved.json'
export const DATA_MOVE_LOG_FILE = 'data-location-move.log'
export const DATA_MOVE_LOG_PREV_FILE = 'data-location-move.previous.log'
export const DATA_MOVE_LOG_MAX_BYTES = 1024 * 1024 // 1 MiB
export const DATA_MOVE_REPORT_FILE = 'data-location-move-report.json'
export const DATA_MOVE_REPORT_MAX_BYTES = 512 * 1024 // 512 KiB
/** At most this many files "changed during the move" are named in the result report (R7). */
export const MAX_REPORTED_CHANGED_FILES = 200
export const MIN_FREE_MARGIN_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
export const MIN_USER_DATA_FREE_BYTES = 64 * 1024 * 1024 // 64 MiB
export const MAX_MOVE_MARKER_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours

const EPHEMERAL_ROOT_FILES = new Set([
  'engine-attach.json',
  '.desktop-engine.lock',
  '.port',
  'core-lifecycle.json',
  'core-manual-quit.json',
  DATA_LOCATION_MOVED_STAMP,
])

function isEphemeralEntry(relPosix: string, fileName: string): boolean {
  if (!relPosix.includes('/')) {
    if (EPHEMERAL_ROOT_FILES.has(fileName)) return true
    if (fileName.startsWith('core-stop-') && fileName.endsWith('.json')) return true
    if (fileName.startsWith('core-recovery-')) return true
    if (fileName.startsWith('.core-') && fileName.endsWith('.tmp')) return true
    if (fileName.startsWith('.engine-attach-') && fileName.endsWith('.tmp')) return true
    if (fileName.startsWith('.orgtree-trust-probe-')) return true
  }
  if (relPosix === 'pg/cluster/data/postmaster.pid' || relPosix === 'pg/cluster/data/postmaster.opts') return true
  if (fileName.startsWith('.s.PGSQL.')) return true
  return false
}

export function interactiveRelaunchArgs(
  argv: string[],
  isLinkArg: (arg: string) => boolean = () => false,
): string[] {
  return argv.filter(
    arg =>
      !arg.startsWith('--orgtree-taskbar=') &&
      arg !== '--background' &&
      arg !== '--core-recovered' &&
      !isLinkArg(arg),
  )
}

function overlapsPath(parent: string, child: string): boolean {
  const a = canonicalPath(parent)
  const b = canonicalPath(child)
  const rel = path.relative(a, b)
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 || idx === 0 ? Math.round(val) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`
}

/** Detect any symlink or NTFS junction/mount-point on `targetPath` or its existing ancestors.
 *  Uses `lstatSync` + `readlinkSync` (which libuv resolves for both symlinks and NTFS junctions
 *  without false-flagging Windows 8.3 short path components). */
export function findReparseAncestor(targetPath: string): string | null {
  let cur = path.resolve(targetPath)
  for (;;) {
    if (fs.existsSync(cur)) {
      try {
        const st = fs.lstatSync(cur)
        if (st.isSymbolicLink()) return cur
      } catch {
        // Check readlink below as well.
      }
      // Skip drive roots (`C:\`), where readlink does not apply to volume mount points.
      const parent = path.dirname(cur)
      if (parent !== cur) {
        try {
          fs.readlinkSync(cur)
          return cur
        } catch {
          // Ordinary directory: EINVAL / UNKNOWN.
        }
      }
    }
    const next = path.dirname(cur)
    if (next === cur) break
    cur = next
  }
  return null
}

let cachedUserSid: string | null = null

async function currentWindowsUserSid(): Promise<string> {
  if (cachedUserSid) return cachedUserSid
  const sid = await new Promise<string>((resolve, reject) => {
    execFile(
      WINDOWS_POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      ],
      { timeout: 10000, windowsHide: true, env: windowsPowerShellEnv() },
      (error, stdout) => {
        if (error) return reject(new Error(`Could not query Windows user SID: ${error.message}`))
        const out = String(stdout).trim()
        if (!out.startsWith('S-1-')) return reject(new Error(`Unexpected Windows user SID output: ${out.slice(0, 80)}`))
        resolve(out)
      },
    )
  })
  cachedUserSid = sid
  return sid
}

async function readWindowsAccessSddl(targetPath: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const escaped = targetPath.replace(/'/g, "''")
  return new Promise(resolve => {
    execFile(
      WINDOWS_POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Acl -LiteralPath '${escaped}').GetSecurityDescriptorSddlForm('Access')`,
      ],
      { timeout: 10000, windowsHide: true, env: windowsPowerShellEnv() },
      (error, stdout) => {
        if (error) return resolve(null)
        const sddl = String(stdout).trim()
        resolve(sddl || null)
      },
    )
  })
}

async function restoreWindowsAccessSddl(targetPath: string, sddl: string): Promise<void> {
  if (process.platform !== 'win32' || !sddl) return
  const escapedPath = targetPath.replace(/'/g, "''")
  const escapedSddl = sddl.replace(/'/g, "''")
  await new Promise<void>(resolve => {
    execFile(
      WINDOWS_POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$acl = Get-Acl -LiteralPath '${escapedPath}'; $acl.SetSecurityDescriptorSddlForm('${escapedSddl}', 'Access'); Set-Acl -LiteralPath '${escapedPath}' -AclObject $acl`,
      ],
      { timeout: 10000, windowsHide: true, env: windowsPowerShellEnv() },
      () => resolve(),
    )
  })
}

/** Apply protected owner-only ACL (`CurrentUser`, `SYSTEM`, `Administrators`) to a directory or file Orgtree owns. */
export async function lockOwnerOnlyAcl(targetPath: string, isDirectory: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, isDirectory ? 0o700 : 0o600)
    return
  }
  const sid = await currentWindowsUserSid()
  const grantSuffix = isDirectory ? ':(OI)(CI)F' : ':F'
  const icaclsExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
  await new Promise<void>((resolve, reject) => {
    execFile(
      icaclsExe,
      [
        targetPath,
        '/inheritance:r',
        '/grant:r',
        `*S-1-5-18${grantSuffix}`,
        `*S-1-5-32-544${grantSuffix}`,
        `*${sid}${grantSuffix}`,
      ],
      { timeout: 15000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          return reject(
            new Error(
              `Could not apply owner-only permissions to ${targetPath}: ${(stderr || error.message).trim().slice(0, 240)}`,
            ),
          )
        }
        resolve()
      },
    )
  })
}

export async function writeDataLocationConfig(userData: string, config: DataLocationConfig | null): Promise<void> {
  const file = path.join(userData, DATA_LOCATION_FILE)
  const defaultRoot = path.join(userData, 'data')
  if (
    !config ||
    (canonicalPath(config.dataRoot) === canonicalPath(defaultRoot) && !config.previousRoot)
  ) {
    try { fs.unlinkSync(file) } catch { /* already absent */ }
    return
  }
  fs.mkdirSync(userData, { recursive: true })
  const tmp = path.join(userData, `.data-location-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  const payload = JSON.stringify(
    {
      version: 1,
      dataRoot: path.normalize(config.dataRoot),
      ...(config.previousRoot ? { previousRoot: path.normalize(config.previousRoot) } : {}),
      ...(config.movedAt ? { movedAt: config.movedAt } : {}),
    },
    null,
    2,
  ) + '\n'
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    await lockOwnerOnlyAcl(tmp, false)
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

let cachedSelfCreatedStamp: string | null | undefined

function queryWindowsProcessCreatedStamp(pid: number): string | null {
  if (process.platform !== 'win32') return null
  if (pid === process.pid && cachedSelfCreatedStamp !== undefined) return cachedSelfCreatedStamp
  try {
    const out = execFileSync(
      WINDOWS_POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.StartTime.ToFileTimeUtc().ToString() }`,
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, env: windowsPowerShellEnv() },
    ).trim()
    const stamp = /^\d+$/.test(out) ? out : null
    if (pid === process.pid) cachedSelfCreatedStamp = stamp
    return stamp
  } catch {
    return null
  }
}

export function writeMoveInProgressMarker(userData: string, sourceRoot: string, targetRoot: string): void {
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, DATA_MOVE_MARKER_FILE)
  const nowMs = Date.now()
  const created = process.platform === 'win32' ? queryWindowsProcessCreatedStamp(process.pid) : null
  const payload = JSON.stringify(
    {
      version: 1,
      pid: process.pid,
      ...(created ? { created } : {}),
      sourceRoot: path.resolve(sourceRoot),
      targetRoot: path.resolve(targetRoot),
      startedAt: new Date(nowMs).toISOString(),
      startedAtMs: nowMs,
      heartbeatAtMs: nowMs,
    },
    null,
    2,
  ) + '\n'
  fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 })
}

/** Every 60 s while a move runs: refresh `heartbeatAtMs` so a copy longer than
 *  `MAX_MOVE_MARKER_AGE_MS` (the user's 243 GB copy took over five hours) keeps
 *  the boot host, installer and helpers out. A crashed desktop stops beating, so
 *  the marker still expires. Rewrites only this desktop's own marker. */
export function refreshMoveInProgressMarker(userData: string, nowMs: number = Date.now()): boolean {
  const file = path.join(userData, DATA_MOVE_MARKER_FILE)
  try {
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink() || !st.isFile() || st.size > DATA_LOCATION_MAX_BYTES) return false
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (raw.version !== 1 || raw.pid !== process.pid) return false
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...raw, heartbeatAtMs: nowMs }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

const MOVE_MARKER_HEARTBEAT_MS = 60 * 1000

function latestMarkerMs(raw: { startedAtMs?: unknown; heartbeatAtMs?: unknown }): number | null {
  const values = [raw.startedAtMs, raw.heartbeatAtMs].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  )
  return values.length ? Math.max(...values) : null
}

export function clearMoveInProgressMarker(userData: string): void {
  try { fs.unlinkSync(path.join(userData, DATA_MOVE_MARKER_FILE)) } catch { /* already absent */ }
}

export function hasActiveMoveInProgressMarker(userData: string, nowMs: number = Date.now()): boolean {
  try {
    const file = path.join(userData, DATA_MOVE_MARKER_FILE)
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink() || !st.isFile() || st.size > DATA_LOCATION_MAX_BYTES) return false
    if (process.platform === 'win32') {
      try { fs.readlinkSync(file); return false } catch { /* regular file */ }
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version?: unknown
      pid?: unknown
      created?: unknown
      startedAtMs?: unknown
      heartbeatAtMs?: unknown
    }
    if (raw.version !== 1 || typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) return false
    const latest = latestMarkerMs(raw)
    if (latest !== null) {
      if (nowMs - latest > MAX_MOVE_MARKER_AGE_MS) return false
    } else if (nowMs - st.mtimeMs > MAX_MOVE_MARKER_AGE_MS) {
      return false
    }
    if (!processExists(raw.pid)) return false
    if (process.platform === 'win32' && typeof raw.created === 'string' && raw.created.length > 0) {
      const actual = queryWindowsProcessCreatedStamp(raw.pid)
      if (!actual || actual !== raw.created) return false
    }
    return true
  } catch {
    return false
  }
}

/** True when `.desktop-engine.lock` exists and its byte-0 lock is currently held by another process. */
export function isRootLockHeld(root: string): boolean {
  if (!root || !fs.existsSync(root)) return false
  let lockFile = ''
  try {
    lockFile = path.join(fs.realpathSync.native(root), '.desktop-engine.lock')
  } catch {
    lockFile = path.join(root, '.desktop-engine.lock')
  }
  if (!fs.existsSync(lockFile)) return false
  try {
    const fd = fs.openSync(lockFile, 'r+')
    try {
      fs.writeSync(fd, Buffer.from('0'), 0, 1, 0)
    } finally {
      fs.closeSync(fd)
    }
    return false
  } catch {
    return true
  }
}

const DIR_WALK_CONCURRENCY = 8
const FILE_STAT_CONCURRENCY = 32
const SCAN_PROGRESS_INTERVAL_MS = 150

function createScanAbortError(): Error {
  const err = new Error('Data size measurement cancelled')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === 'Data size measurement cancelled')
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let nextIdx = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      if (signal?.aborted) throw createScanAbortError()
      const idx = nextIdx
      nextIdx += 1
      await worker(items[idx]!)
    }
  })
  await Promise.all(runners)
}

export interface MeasureDirectoryOptions {
  signal?: AbortSignal
  onProgress?: (info: { totalBytes: number; totalFiles: number }) => void
}

export interface MeasureDirectoryResult {
  totalBytes: number
  totalFiles: number
  unreadableEntries: DataLocationUnreadableEntry[]
}

export type MeasureDirectoryFn = (
  root: string,
  options?: MeasureDirectoryOptions,
) => Promise<{ totalBytes: number; totalFiles: number; unreadableEntries?: DataLocationUnreadableEntry[] }>

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

const isNonRootPosix =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

export async function measureDirectoryBytes(
  root: string,
  options: MeasureDirectoryOptions = {},
): Promise<MeasureDirectoryResult> {
  const { signal, onProgress } = options
  if (signal?.aborted) throw createScanAbortError()
  if (!root || !fs.existsSync(root)) return { totalBytes: 0, totalFiles: 0, unreadableEntries: [] }

  let totalBytes = 0
  let totalFiles = 0
  let lastProgressMs = 0
  const unreadableEntries: DataLocationUnreadableEntry[] = []

  const maybeEmitProgress = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastProgressMs < SCAN_PROGRESS_INTERVAL_MS) return
    lastProgressMs = now
    onProgress({ totalBytes, totalFiles })
  }

  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    if (signal?.aborted) throw createScanAbortError()
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const code = errnoCode(err)
      if (code === 'ENOENT') return
      if (relPrefix === '') throw err
      unreadableEntries.push({
        path: path.resolve(dir),
        relativePath: relPrefix,
        kind: 'directory',
        ...(code ? { code } : {}),
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (signal?.aborted) throw createScanAbortError()

    const regularFiles: { full: string; relPosix: string }[] = []
    const subdirs: { full: string; relPosix: string }[] = []
    const unknownEntries: { full: string; relPosix: string }[] = []

    for (const entry of entries) {
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (isEphemeralEntry(relPosix, entry.name)) continue
      // On Windows NTFS and POSIX, libuv sets UV_DIRENT_LINK (`entry.isSymbolicLink()`)
      // for both symbolic links and NTFS directory junctions right from FindFirstFileW /
      // getdents without opening each entry or blocking the main thread with readlinkSync.
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isFile()) {
        regularFiles.push({ full, relPosix })
      } else if (entry.isDirectory()) {
        subdirs.push({ full, relPosix })
      } else {
        unknownEntries.push({ full, relPosix })
      }
    }

    if (regularFiles.length > 0) {
      await runWithConcurrency(regularFiles, FILE_STAT_CONCURRENCY, signal, async item => {
        try {
          const st = await fs.promises.lstat(item.full)
          if (!st.isSymbolicLink() && st.isFile()) {
            if (isNonRootPosix && (st.mode & 0o444) === 0) {
              unreadableEntries.push({
                path: path.resolve(item.full),
                relativePath: item.relPosix,
                kind: 'file',
                code: 'EACCES',
                error: `EACCES: permission denied, open '${item.full}'`,
              })
              return
            }
            totalBytes += st.size
            totalFiles += 1
            maybeEmitProgress(false)
          }
        } catch (err) {
          const code = errnoCode(err)
          if (code !== 'ENOENT') {
            unreadableEntries.push({
              path: path.resolve(item.full),
              relativePath: item.relPosix,
              kind: 'file',
              ...(code ? { code } : {}),
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      })
    }

    if (unknownEntries.length > 0) {
      await runWithConcurrency(unknownEntries, FILE_STAT_CONCURRENCY, signal, async item => {
        try {
          const st = await fs.promises.lstat(item.full)
          if (isEntryReparsePoint(item.full, st)) return
          if (st.isDirectory()) {
            subdirs.push(item)
          } else if (st.isFile()) {
            if (isNonRootPosix && (st.mode & 0o444) === 0) {
              unreadableEntries.push({
                path: path.resolve(item.full),
                relativePath: item.relPosix,
                kind: 'file',
                code: 'EACCES',
                error: `EACCES: permission denied, open '${item.full}'`,
              })
              return
            }
            totalBytes += st.size
            totalFiles += 1
            maybeEmitProgress(false)
          }
        } catch (err) {
          const code = errnoCode(err)
          if (code !== 'ENOENT') {
            unreadableEntries.push({
              path: path.resolve(item.full),
              relativePath: item.relPosix,
              kind: 'entry',
              ...(code ? { code } : {}),
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      })
    }

    if (subdirs.length > 0) {
      await runWithConcurrency(subdirs, DIR_WALK_CONCURRENCY, signal, async sub => {
        await walk(sub.full, sub.relPosix)
      })
    }
  }

  await walk(root, '')
  unreadableEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  maybeEmitProgress(true)
  return { totalBytes, totalFiles, unreadableEntries }
}

async function reprobeCachedUnreadableEntries(entries: readonly DataLocationUnreadableEntry[]): Promise<boolean> {
  for (const entry of entries) {
    try {
      if (entry.kind === 'directory') {
        await fs.promises.readdir(entry.path)
        return true
      }
      const st = await fs.promises.lstat(entry.path)
      if (isNonRootPosix && (st.mode & 0o444) === 0) continue
      const fh = await fs.promises.open(entry.path, 'r')
      await fh.close().catch(() => {})
      return true
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return true
    }
  }
  return false
}

function canonicalCacheKey(root: string): string {
  const resolved = path.resolve(root)
  try {
    return canonicalPath(resolveExisting(resolved))
  } catch {
    return canonicalPath(resolved)
  }
}

/** Single-flight, session-scoped directory size cache:
 *  - `getCachedBytes(root)` never walks the filesystem and returns `null` until measured;
 *  - `measure(root)` runs at most ONE walk in flight per canonical root and caches settled totals;
 *  - individual callers with an `AbortSignal` detach immediately on abort without killing a
 *    concurrent background waiter, while aborting the underlying walk if no waiters remain. */
export class DataLocationSizeCache {
  private readonly settled = new Map<string, MeasureDirectoryResult>()
  private readonly inFlight = new Map<
    string,
    {
      promise: Promise<MeasureDirectoryResult>
      abortController: AbortController
      waiters: number
      latestBytes: number
      latestFiles: number
      listeners: Set<(info: { totalBytes: number; totalFiles: number }) => void>
    }
  >()

  getCachedBytes(root: string): number | null {
    if (!root || this.settled.size === 0) return null
    const hit = this.settled.get(canonicalCacheKey(root))
    return hit ? hit.totalBytes : null
  }

  invalidate(root: string): void {
    if (!root) return
    const key = canonicalCacheKey(root)
    this.settled.delete(key)
    const running = this.inFlight.get(key)
    if (running) {
      this.inFlight.delete(key)
      running.abortController.abort()
    }
  }

  clear(): void {
    this.settled.clear()
    for (const running of this.inFlight.values()) {
      running.abortController.abort()
    }
    this.inFlight.clear()
  }

  async measure(
    root: string,
    options: {
      signal?: AbortSignal
      onProgress?: (info: { totalBytes: number; totalFiles: number }) => void
      measureDirectory?: MeasureDirectoryFn
    } = {},
  ): Promise<MeasureDirectoryResult> {
    const { signal, onProgress, measureDirectory = measureDirectoryBytes } = options
    if (signal?.aborted) throw createScanAbortError()
    const resolvedRoot = path.resolve(root)
    const key = canonicalCacheKey(resolvedRoot)

    const cached = this.settled.get(key)
    if (cached) {
      onProgress?.({ totalBytes: cached.totalBytes, totalFiles: cached.totalFiles })
      return cached
    }

    let entry = this.inFlight.get(key)
    if (!entry) {
      const abortController = new AbortController()
      const listeners = new Set<(info: { totalBytes: number; totalFiles: number }) => void>()
      const created = {
        promise: Promise.resolve({ totalBytes: 0, totalFiles: 0, unreadableEntries: [] as DataLocationUnreadableEntry[] }),
        abortController,
        waiters: 0,
        latestBytes: 0,
        latestFiles: 0,
        listeners,
      }
      created.promise = measureDirectory(resolvedRoot, {
        signal: abortController.signal,
        onProgress: info => {
          created.latestBytes = info.totalBytes
          created.latestFiles = info.totalFiles
          for (const listener of listeners) {
            try { listener(info) } catch { /* ignore listener failure */ }
          }
        },
      }).then(
        raw => {
          const res: MeasureDirectoryResult = {
            totalBytes: raw.totalBytes,
            totalFiles: raw.totalFiles,
            unreadableEntries: raw.unreadableEntries ? [...raw.unreadableEntries] : [],
          }
          if (this.inFlight.get(key) === created) {
            this.inFlight.delete(key)
            if (!abortController.signal.aborted) {
              this.settled.set(key, res)
            }
          }
          return res
        },
        err => {
          if (this.inFlight.get(key) === created) {
            this.inFlight.delete(key)
          }
          throw err
        },
      )
      // Prevent unhandled rejection when all waiters detach via AbortSignal.
      created.promise.catch(() => {})
      this.inFlight.set(key, created)
      entry = created
    }

    const activeEntry = entry
    activeEntry.waiters += 1
    if (onProgress && (activeEntry.latestFiles > 0 || activeEntry.latestBytes > 0)) {
      onProgress({ totalBytes: activeEntry.latestBytes, totalFiles: activeEntry.latestFiles })
    }
    if (onProgress) activeEntry.listeners.add(onProgress)

    if (!signal) {
      try {
        return await activeEntry.promise
      } finally {
        if (onProgress) activeEntry.listeners.delete(onProgress)
        activeEntry.waiters = Math.max(0, activeEntry.waiters - 1)
      }
    }

    return new Promise<MeasureDirectoryResult>((resolve, reject) => {
      let settledWaiter = false
      const cleanup = () => {
        if (onProgress) activeEntry.listeners.delete(onProgress)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (settledWaiter) return
        settledWaiter = true
        cleanup()
        activeEntry.waiters = Math.max(0, activeEntry.waiters - 1)
        if (activeEntry.waiters === 0 && this.inFlight.get(key) === activeEntry) {
          this.inFlight.delete(key)
          activeEntry.abortController.abort()
        }
        reject(createScanAbortError())
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      activeEntry.promise.then(
        res => {
          if (settledWaiter) return
          settledWaiter = true
          cleanup()
          activeEntry.waiters = Math.max(0, activeEntry.waiters - 1)
          resolve(res)
        },
        err => {
          if (settledWaiter) return
          settledWaiter = true
          cleanup()
          activeEntry.waiters = Math.max(0, activeEntry.waiters - 1)
          reject(err)
        },
      )
    })
  }
}

export const defaultDataLocationSizeCache = new DataLocationSizeCache()

function existingAncestor(p: string): string {
  let cur = path.resolve(p)
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) throw new Error(`Drive or root does not exist for ${p}`)
    cur = parent
  }
  return cur
}

function availableVolumeBytes(targetPath: string): number {
  const existing = existingAncestor(targetPath)
  const stat = fs.statfsSync(existing)
  return Number(stat.bavail) * Number(stat.bsize)
}

export function requiredTargetBytes(sourceBytes: number): number {
  return sourceBytes + Math.max(MIN_FREE_MARGIN_BYTES, Math.ceil(sourceBytes * 0.1))
}

export function validateDeletablePreviousFolder(params: {
  previousRoot: string
  currentRoot: string
  userData: string
  forbiddenRoot?: string
  installDirectory?: string
}): { ok: true; resolvedPrev: string; realPrev: string } | { ok: false; error: string } {
  const normalized = normalizeLocalDataPath(params.previousRoot)
  if (!normalized) {
    return { ok: false, error: 'Previous data folder path is not a valid local drive path.' }
  }
  const resolvedPrev = path.resolve(normalized)
  if (path.dirname(resolvedPrev) === resolvedPrev) {
    return { ok: false, error: 'Refusing to delete a bare drive or filesystem root.' }
  }
  const reparseTyped = findReparseAncestor(resolvedPrev)
  if (reparseTyped) {
    return { ok: false, error: `Refusing to delete through a symbolic link or junction (${reparseTyped}).` }
  }
  let realPrev: string
  try {
    realPrev = resolveExisting(resolvedPrev)
  } catch (err) {
    return { ok: false, error: `Could not resolve previous data folder: ${(err as Error).message}` }
  }
  if (path.dirname(realPrev) === realPrev) {
    return { ok: false, error: 'Refusing to delete a bare drive or filesystem root.' }
  }
  const reparseReal = findReparseAncestor(realPrev)
  if (reparseReal) {
    return { ok: false, error: `Refusing to delete through a symbolic link or junction (${reparseReal}).` }
  }

  let realCurr: string
  let realUserData: string
  let realDefaultData: string
  try {
    realCurr = resolveExisting(path.resolve(params.currentRoot))
    realUserData = resolveExisting(path.resolve(params.userData))
    realDefaultData = resolveExisting(path.join(params.userData, 'data'))
  } catch (err) {
    return { ok: false, error: `Could not resolve active paths: ${(err as Error).message}` }
  }

  if (
    overlapsPath(resolvedPrev, path.resolve(params.currentRoot)) ||
    overlapsPath(path.resolve(params.currentRoot), resolvedPrev) ||
    overlapsPath(realPrev, realCurr) ||
    overlapsPath(realCurr, realPrev)
  ) {
    return { ok: false, error: 'Refusing to delete a folder that overlaps the active data folder.' }
  }

  const isDefaultData = canonicalPath(realPrev) === canonicalPath(realDefaultData)
  if (!isDefaultData && (overlapsPath(realPrev, realUserData) || overlapsPath(realUserData, realPrev))) {
    return { ok: false, error: `Refusing to delete Orgtree's settings folder (${params.userData}) or its contents.` }
  }

  if (params.forbiddenRoot) {
    try {
      const realForbidden = resolveExisting(path.resolve(params.forbiddenRoot))
      if (overlapsPath(realPrev, realForbidden) || overlapsPath(realForbidden, realPrev)) {
        return { ok: false, error: 'Refusing to delete a folder that overlaps the v1 data folder.' }
      }
    } catch {
      // Ignore unreadable forbiddenRoot fallback.
    }
  }

  if (params.installDirectory) {
    try {
      const realInstall = resolveExisting(path.resolve(params.installDirectory))
      if (overlapsPath(realPrev, realInstall) || overlapsPath(realInstall, realPrev)) {
        return { ok: false, error: "Refusing to delete a folder that overlaps Orgtree's installation folder." }
      }
    } catch {
      // Ignore unreadable installDirectory fallback.
    }
  }

  return { ok: true, resolvedPrev, realPrev }
}

function isEntryReparsePoint(fullPath: string, st: fs.Stats): boolean {
  if (st.isSymbolicLink()) return true
  if (process.platform === 'win32' && path.dirname(fullPath) !== fullPath) {
    try {
      fs.readlinkSync(fullPath)
      return true
    } catch {
      return false
    }
  }
  return false
}

function unlinkReparseEntry(fullPath: string): void {
  if (process.platform === 'win32') {
    try {
      fs.rmdirSync(fullPath)
      return
    } catch {
      // Fall back to unlinkSync for file symlinks.
    }
  }
  fs.unlinkSync(fullPath)
}

/** Delete a directory tree bottom-up without ever recursing through symlinks or NTFS junctions. */
export function removeDirectoryTreeNoFollow(targetDir: string): void {
  const resolved = path.resolve(targetDir)
  if (!fs.existsSync(resolved)) return
  if (path.dirname(resolved) === resolved) {
    throw new Error(`Refusing to remove filesystem root ${resolved}`)
  }
  const reparse = findReparseAncestor(resolved)
  if (reparse) {
    throw new Error(`Refusing to remove directory through symbolic link or junction (${reparse})`)
  }

  const removeNode = (cur: string): void => {
    const st = fs.lstatSync(cur)
    if (isEntryReparsePoint(cur, st)) {
      unlinkReparseEntry(cur)
      return
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(cur)) {
        removeNode(path.join(cur, name))
      }
      try {
        fs.rmdirSync(cur)
      } catch {
        try { fs.chmodSync(cur, 0o700) } catch { /* best effort */ }
        fs.rmdirSync(cur)
      }
      return
    }
    try {
      fs.unlinkSync(cur)
    } catch {
      try { fs.chmodSync(cur, 0o600) } catch { /* best effort */ }
      fs.unlinkSync(cur)
    }
  }

  removeNode(resolved)
}

function canonicalEntryVariants(targetPath: string): string[] {
  const resolved = path.resolve(targetPath)
  const out = [canonicalPath(resolved)]
  try {
    out.push(canonicalPath(fs.realpathSync.native(resolved)))
  } catch {
    // Unreadable leaf or absent path.
  }
  const parent = path.dirname(resolved)
  if (parent !== resolved) {
    try {
      out.push(canonicalPath(path.join(fs.realpathSync.native(parent), path.basename(resolved))))
    } catch {
      // Unreadable or absent parent.
    }
  }
  return out
}

function canonicalEntryKeySet(paths: readonly string[] | undefined): Set<string> {
  const keys = new Set<string>()
  if (!paths) return keys
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue
    for (const v of canonicalEntryVariants(p)) keys.add(v)
  }
  return keys
}

function matchesCanonicalKeySet(candidatePath: string, keySet: ReadonlySet<string>): boolean {
  if (keySet.size === 0) return false
  for (const v of canonicalEntryVariants(candidatePath)) {
    if (keySet.has(v)) return true
  }
  return false
}

function unapprovedUnreadableEntries(
  unreadable: readonly DataLocationUnreadableEntry[],
  skipPaths: readonly string[] | undefined,
): DataLocationUnreadableEntry[] {
  if (unreadable.length === 0) return []
  const skipSet = canonicalEntryKeySet(skipPaths)
  return unreadable.filter(entry => !matchesCanonicalKeySet(entry.path, skipSet))
}

/** Delete everything deletable in `targetDir` bottom-up without following symlinks or NTFS junctions,
 *  leaving any preserved/unreadable/undeletable entries and the parent directories holding them intact. */
export function removeDirectoryTreeSelectiveNoFollow(
  targetDir: string,
  options: { preservePaths?: readonly string[]; checkReadablePaths?: readonly string[] } = {},
): { deletedAll: boolean; remainingPaths: string[] } {
  const resolved = path.resolve(targetDir)
  if (!fs.existsSync(resolved)) return { deletedAll: true, remainingPaths: [] }
  if (path.dirname(resolved) === resolved) {
    throw new Error(`Refusing to remove filesystem root ${resolved}`)
  }
  const reparse = findReparseAncestor(resolved)
  if (reparse) {
    throw new Error(`Refusing to remove directory through symbolic link or junction (${reparse})`)
  }

  const preserveSet = canonicalEntryKeySet(options.preservePaths)
  const checkReadableSet = canonicalEntryKeySet(options.checkReadablePaths)
  const remainingSet = new Set<string>()

  const removeNode = (cur: string): boolean => {
    if (cur !== resolved && matchesCanonicalKeySet(cur, preserveSet)) {
      remainingSet.add(path.resolve(cur))
      return false
    }
    let st: fs.Stats
    try {
      st = fs.lstatSync(cur)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return true
      remainingSet.add(path.resolve(cur))
      return false
    }
    if (isEntryReparsePoint(cur, st)) {
      try {
        unlinkReparseEntry(cur)
        return true
      } catch {
        remainingSet.add(path.resolve(cur))
        return false
      }
    }
    if (st.isDirectory()) {
      let entries: string[]
      try {
        // Probe readdirSync BEFORE rmdirSync so an empty unreadable directory (whose parent grants
        // Windows FILE_DELETE_CHILD) is treated as unreadable rather than silently removed.
        entries = fs.readdirSync(cur)
      } catch {
        remainingSet.add(path.resolve(cur))
        return false
      }
      let allChildrenRemoved = true
      for (const name of entries) {
        if (!removeNode(path.join(cur, name))) {
          allChildrenRemoved = false
        }
      }
      if (!allChildrenRemoved) {
        return false
      }
      try {
        fs.rmdirSync(cur)
        return true
      } catch {
        try {
          fs.chmodSync(cur, 0o700)
          fs.rmdirSync(cur)
          return true
        } catch {
          remainingSet.add(path.resolve(cur))
          return false
        }
      }
    }

    if (matchesCanonicalKeySet(cur, checkReadableSet) || (isNonRootPosix && (st.mode & 0o444) === 0)) {
      try {
        const fd = fs.openSync(cur, 'r')
        fs.closeSync(fd)
      } catch {
        remainingSet.add(path.resolve(cur))
        return false
      }
    }

    try {
      fs.unlinkSync(cur)
      return true
    } catch {
      try {
        fs.chmodSync(cur, 0o600)
        fs.unlinkSync(cur)
        return true
      } catch {
        remainingSet.add(path.resolve(cur))
        return false
      }
    }
  }

  removeNode(resolved)
  const deletedAll = !fs.existsSync(resolved)
  const remainingPaths = [...remainingSet].sort((a, b) => a.localeCompare(b))
  return { deletedAll, remainingPaths }
}

export function hasDataLocationMoveLog(userData: string): boolean {
  if (!userData || findReparseAncestor(userData)) return false
  try {
    const file = path.join(userData, DATA_MOVE_LOG_FILE)
    const st = fs.lstatSync(file)
    return !isEntryReparsePoint(file, st) && st.isFile()
  } catch {
    return false
  }
}

export function appendDataLocationMoveLog(
  userData: string,
  phase: string,
  message: string,
  paths?: readonly string[],
): void {
  if (!userData) return
  try {
    if (findReparseAncestor(userData)) return
    fs.mkdirSync(userData, { recursive: true })
    const logFile = path.join(userData, DATA_MOVE_LOG_FILE)
    let createdNew = false
    if (fs.existsSync(logFile)) {
      const st = fs.lstatSync(logFile)
      if (isEntryReparsePoint(logFile, st) || !st.isFile()) return
      if (st.size >= DATA_MOVE_LOG_MAX_BYTES) {
        const prevFile = path.join(userData, DATA_MOVE_LOG_PREV_FILE)
        try {
          if (fs.existsSync(prevFile)) {
            const prevSt = fs.lstatSync(prevFile)
            if (!isEntryReparsePoint(prevFile, prevSt)) fs.unlinkSync(prevFile)
          }
          fs.renameSync(logFile, prevFile)
          createdNew = true
        } catch {
          // Best-effort rotation.
        }
      }
    } else {
      createdNew = true
    }
    const cleanPhase = String(phase).replace(/[\r\n]+/g, ' ').trim()
    const cleanMsg = String(message).replace(/[\r\n]+/g, ' ').trim()
    let block = `[${new Date().toISOString()}] [${cleanPhase}] ${cleanMsg}\n`
    if (paths && paths.length > 0) {
      for (const p of paths) {
        block += `  - ${String(p).replace(/[\r\n]+/g, ' ')}\n`
      }
    }
    fs.appendFileSync(logFile, block, { encoding: 'utf8', mode: 0o600 })
    if (createdNew) {
      void lockOwnerOnlyAcl(logFile, false).catch(() => {})
    }
  } catch {
    // Log writes must never interrupt or mask move/rollback execution.
  }
}

export async function openDataLocationMoveLogFile(
  userData: string,
  openFile: (file: string) => Promise<string>,
): Promise<{ ok: boolean; error?: string }> {
  if (!userData || findReparseAncestor(userData)) {
    return { ok: false, error: 'Refusing to open a symbolic link or junction.' }
  }
  const logFile = path.join(userData, DATA_MOVE_LOG_FILE)
  if (!hasDataLocationMoveLog(userData)) {
    return { ok: false, error: 'No data move log has been recorded yet.' }
  }
  try {
    const err = await openFile(logFile)
    return err ? { ok: false, error: err } : { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function readDataLocationMoveReport(userData: string): DataLocationLastMoveReport | null {
  if (!userData || findReparseAncestor(userData)) return null
  try {
    const file = path.join(userData, DATA_MOVE_REPORT_FILE)
    const st = fs.lstatSync(file)
    if (isEntryReparsePoint(file, st) || !st.isFile() || st.size > DATA_MOVE_REPORT_MAX_BYTES) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (raw.version !== 1) return null
    if (typeof raw.movedAt !== 'string' || typeof raw.fromRoot !== 'string' || typeof raw.toRoot !== 'string') return null
    if (!normalizeLocalDataPath(raw.fromRoot) || !normalizeLocalDataPath(raw.toRoot)) return null
    if (typeof raw.deletePreviousRequested !== 'boolean' || typeof raw.oldFolderDeleted !== 'boolean') return null
    const skippedEntries: DataLocationUnreadableEntry[] = Array.isArray(raw.skippedEntries)
      ? raw.skippedEntries
          .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
          .filter(e => typeof e.path === 'string' && typeof e.relativePath === 'string')
          .map(e => ({
            path: path.normalize(String(e.path)),
            relativePath: String(e.relativePath),
            kind: e.kind === 'directory' || e.kind === 'file' ? e.kind : 'entry',
            ...(typeof e.code === 'string' && e.code ? { code: e.code } : {}),
            error: typeof e.error === 'string' ? e.error : '',
          }))
      : []
    const remainingPaths: string[] = Array.isArray(raw.remainingPaths)
      ? raw.remainingPaths
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map(p => path.normalize(p))
      : []
    const changedDuringMove: string[] = Array.isArray(raw.changedDuringMove)
      ? raw.changedDuringMove
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .slice(0, MAX_REPORTED_CHANGED_FILES)
      : []
    const unsettledDuringMove: string[] = Array.isArray(raw.unsettledDuringMove)
      ? raw.unsettledDuringMove
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .slice(0, MAX_REPORTED_CHANGED_FILES)
          .map(p => path.normalize(p))
      : []
    return {
      movedAt: raw.movedAt,
      fromRoot: path.normalize(raw.fromRoot),
      toRoot: path.normalize(raw.toRoot),
      deletePreviousRequested: raw.deletePreviousRequested,
      oldFolderDeleted: raw.oldFolderDeleted,
      skippedEntries,
      remainingPaths,
      ...(changedDuringMove.length > 0 ? { changedDuringMove } : {}),
      ...(unsettledDuringMove.length > 0 ? { unsettledDuringMove } : {}),
      ...(typeof raw.changedDuringMoveTotal === 'number' && Number.isFinite(raw.changedDuringMoveTotal) && raw.changedDuringMoveTotal > changedDuringMove.length
        ? { changedDuringMoveTotal: Math.floor(raw.changedDuringMoveTotal) }
        : {}),
      ...(typeof raw.pendingRestartNotice === 'boolean' ? { pendingRestartNotice: raw.pendingRestartNotice } : {}),
    }
  } catch {
    return null
  }
}

function writeDataLocationMoveReportSync(userData: string, report: DataLocationLastMoveReport | null): string | null {
  if (!userData || findReparseAncestor(userData)) return null
  const file = path.join(userData, DATA_MOVE_REPORT_FILE)
  if (!report) {
    try { fs.unlinkSync(file) } catch { /* already absent */ }
    return null
  }
  fs.mkdirSync(userData, { recursive: true })
  const tmp = path.join(userData, `.data-move-report-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  const payload = JSON.stringify({ version: 1, ...report }, null, 2) + '\n'
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return file
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    return null
  }
}

export async function writeDataLocationMoveReport(
  userData: string,
  report: DataLocationLastMoveReport | null,
): Promise<void> {
  const written = writeDataLocationMoveReportSync(userData, report)
  if (written) {
    await lockOwnerOnlyAcl(written, false).catch(() => {})
  }
}

/** Consume the one-shot post-restart move summary notice for `currentRoot` so it opens once after relaunch
 *  while remaining visible inside Settings -> Runtime -> Data location while `fromRoot` still exists. */
export function consumePendingMoveRestartNotice(
  userData: string,
  currentRoot: string,
): DataLocationLastMoveReport | null {
  const report = readDataLocationMoveReport(userData)
  if (!report || !report.pendingRestartNotice) return null
  if (canonicalPath(path.resolve(report.toRoot)) !== canonicalPath(path.resolve(currentRoot))) return null
  const updated: DataLocationLastMoveReport = { ...report, pendingRestartNotice: false }
  const written = writeDataLocationMoveReportSync(userData, updated)
  if (written) {
    void lockOwnerOnlyAcl(written, false).catch(() => {})
  }
  return updated
}

function resolveValidPreviousFolder(params: {
  cfg: DataLocationConfig | null
  currentRoot: string
  userData: string
  forbiddenRoot?: string
  installDirectory?: string
}): { previousRoot: string; resolvedPrev: string } | null {
  const { cfg, currentRoot, userData, forbiddenRoot, installDirectory } = params
  if (
    !cfg?.previousRoot ||
    canonicalPath(cfg.previousRoot) === canonicalPath(currentRoot) ||
    !fs.existsSync(cfg.previousRoot)
  ) {
    return null
  }
  const check = validateDeletablePreviousFolder({
    previousRoot: cfg.previousRoot,
    currentRoot,
    userData,
    forbiddenRoot,
    installDirectory,
  })
  if (!check.ok) return null
  try {
    const st = fs.lstatSync(check.resolvedPrev)
    if (!isEntryReparsePoint(check.resolvedPrev, st) && st.isDirectory()) {
      return { previousRoot: cfg.previousRoot, resolvedPrev: check.resolvedPrev }
    }
  } catch {
    // Ignore unreadable previousRoot.
  }
  return null
}

/** Return configured Data location paths and flags immediately with NO directory walk.
 *  `currentBytes` and `previousBytes` are `null` ("not measured yet") until populated in
 *  the session's `DataLocationSizeCache` by `measureDataLocationSizes` or `preflightDataLocation`. */
export async function readDataLocationState(params: {
  currentRoot: string
  userData: string
  envOverride: boolean
  moving: boolean
  forbiddenRoot?: string
  installDirectory?: string
  sizeCache?: DataLocationSizeCache
  measureDirectory?: MeasureDirectoryFn
}): Promise<DataLocationState> {
  const cache = params.sizeCache ?? defaultDataLocationSizeCache
  const defaultRoot = path.join(params.userData, 'data')
  const currentRoot = path.resolve(params.currentRoot)
  const cfg = readDataLocationConfig(params.userData)
  const isCustom = !params.envOverride && canonicalPath(currentRoot) !== canonicalPath(defaultRoot)
  const prev = resolveValidPreviousFolder({
    cfg,
    currentRoot,
    userData: params.userData,
    forbiddenRoot: params.forbiddenRoot,
    installDirectory: params.installDirectory,
  })
  const rawReport = readDataLocationMoveReport(params.userData)
  const lastMoveReport =
    rawReport &&
    canonicalPath(path.resolve(rawReport.toRoot)) === canonicalPath(currentRoot) &&
    fs.existsSync(rawReport.fromRoot)
      ? rawReport
      : null

  return {
    currentRoot,
    defaultRoot,
    isCustom,
    envOverride: params.envOverride,
    currentBytes: cache.getCachedBytes(currentRoot),
    previousRoot: prev?.previousRoot ?? null,
    previousBytes: prev ? cache.getCachedBytes(prev.resolvedPrev) : null,
    movedAt: cfg?.movedAt ?? null,
    moving: params.moving,
    lastMoveReport,
    moveLogExists: hasDataLocationMoveLog(params.userData),
  }
}

/** Measure `currentRoot` (and any valid `previousRoot`) in the background with single-flight
 *  deduplication per root and session-wide caching. */
export async function measureDataLocationSizes(params: {
  currentRoot: string
  userData: string
  forbiddenRoot?: string
  installDirectory?: string
  sizeCache?: DataLocationSizeCache
  measureDirectory?: MeasureDirectoryFn
  signal?: AbortSignal
}): Promise<DataLocationSizes> {
  const cache = params.sizeCache ?? defaultDataLocationSizeCache
  const currentRoot = path.resolve(params.currentRoot)
  const cfg = readDataLocationConfig(params.userData)
  const prev = resolveValidPreviousFolder({
    cfg,
    currentRoot,
    userData: params.userData,
    forbiddenRoot: params.forbiddenRoot,
    installDirectory: params.installDirectory,
  })

  const [curRes, prevRes] = await Promise.all([
    cache.measure(currentRoot, {
      signal: params.signal,
      measureDirectory: params.measureDirectory,
    }),
    prev
      ? cache.measure(prev.resolvedPrev, {
          signal: params.signal,
          measureDirectory: params.measureDirectory,
        })
      : Promise.resolve(null),
  ])

  return {
    currentRoot,
    currentBytes: curRes.totalBytes,
    previousRoot: prev?.previousRoot ?? null,
    previousBytes: prevRes ? prevRes.totalBytes : null,
  }
}

function firstNonExistentAncestor(targetPath: string): string | null {
  let cur = path.resolve(targetPath)
  let missing: string | null = null
  while (!fs.existsSync(cur)) {
    missing = cur
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return missing
}

export async function preflightDataLocation(params: {
  pickedPath: string
  currentRoot: string
  userData: string
  forbiddenRoot: string
  installDirectory?: string
  envOverride?: boolean
  activeAgents?: number
  trustCheck?: (file: string) => Promise<DescriptorOwner>
  sizeCache?: DataLocationSizeCache
  measureDirectory?: MeasureDirectoryFn
  signal?: AbortSignal
  onScanProgress?: (info: { totalBytes: number; totalFiles: number }) => void
}): Promise<DataLocationPreflight> {
  const activeAgents = params.activeAgents ?? 0
  const baseFail = (pickedPath: string, resolvedRoot: string, usedSubfolder: boolean, error: string): DataLocationPreflight => ({
    ok: false,
    pickedPath,
    resolvedRoot,
    usedSubfolder,
    sourceBytes: 0,
    requiredBytes: 0,
    freeBytes: 0,
    activeAgents,
    error,
  })

  if (params.envOverride) {
    return baseFail(
      params.pickedPath,
      params.pickedPath,
      false,
      'Data location is controlled by an environment variable for this session. Unset it before moving data in Settings.',
    )
  }

  const rawPick = typeof params.pickedPath === 'string' ? params.pickedPath.trim() : ''
  const normalizedPick = normalizeLocalDataPath(rawPick)
  if (!rawPick || !normalizedPick) {
    return baseFail(
      rawPick,
      rawPick,
      false,
      'Choose an absolute local drive-letter folder path (network UNC and device paths are not supported).',
    )
  }

  const pickedPath = path.resolve(normalizedPick)
  const currentRoot = path.resolve(params.currentRoot)
  const defaultRoot = path.resolve(path.join(params.userData, 'data'))
  const userData = path.resolve(params.userData)
  const cfg = readDataLocationConfig(userData)

  // Check reparse/symlink/junction on pickedPath and existing ancestors before touching anything.
  const reparseOnPick = findReparseAncestor(pickedPath)
  if (reparseOnPick) {
    return baseFail(
      pickedPath,
      pickedPath,
      false,
      `Orgtree cannot store its data inside a symbolic link or junction (${reparseOnPick}). Choose a real local folder.`,
    )
  }

  let resolvedRoot = pickedPath
  let usedSubfolder = false

  if (fs.existsSync(pickedPath)) {
    let st: fs.Stats
    try {
      st = fs.statSync(pickedPath)
    } catch (err) {
      return baseFail(pickedPath, pickedPath, false, `Could not inspect ${pickedPath}: ${(err as Error).message}`)
    }
    if (!st.isDirectory()) {
      return baseFail(pickedPath, pickedPath, false, `${pickedPath} is a file, not a folder.`)
    }
    if (canonicalPath(pickedPath) === canonicalPath(currentRoot)) {
      return baseFail(pickedPath, pickedPath, false, 'Orgtree is already using this folder.')
    }
    let entries: string[]
    try {
      entries = fs.readdirSync(pickedPath)
    } catch (err) {
      return baseFail(pickedPath, pickedPath, false, `Could not read ${pickedPath}: ${(err as Error).message}`)
    }
    if (entries.length > 0) {
      if (canonicalPath(pickedPath) === canonicalPath(defaultRoot)) {
        const isPrev = cfg?.previousRoot && canonicalPath(cfg.previousRoot) === canonicalPath(defaultRoot)
        return baseFail(
          pickedPath,
          pickedPath,
          false,
          isPrev
            ? `The default folder (${defaultRoot}) still holds your previous backup. Delete the previous folder in Settings first, then switch back.`
            : `The default folder (${defaultRoot}) already contains files. Empty or move them before switching back to the default location.`,
        )
      }
      resolvedRoot = path.join(pickedPath, DATA_LOCATION_SUBFOLDER)
      usedSubfolder = true
      if (fs.existsSync(resolvedRoot)) {
        let subStat: fs.Stats
        try {
          subStat = fs.statSync(resolvedRoot)
        } catch (err) {
          return baseFail(pickedPath, resolvedRoot, true, `Could not inspect ${resolvedRoot}: ${(err as Error).message}`)
        }
        if (!subStat.isDirectory()) {
          return baseFail(pickedPath, resolvedRoot, true, `${resolvedRoot} already exists and is not a folder.`)
        }
        const subEntries = fs.readdirSync(resolvedRoot)
        if (subEntries.length > 0) {
          return baseFail(
            pickedPath,
            resolvedRoot,
            true,
            `${resolvedRoot} already exists and is not empty. Choose an empty folder instead.`,
          )
        }
      }
    }
  }

  const reparseOnResolved = findReparseAncestor(resolvedRoot)
  if (reparseOnResolved) {
    return baseFail(
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      `Orgtree cannot store its data inside a symbolic link or junction (${reparseOnResolved}). Choose a real local folder.`,
    )
  }

  // Validate against forbidden v1 root.
  try {
    validateDataRoot(resolvedRoot, params.forbiddenRoot)
  } catch (err) {
    return baseFail(pickedPath, resolvedRoot, usedSubfolder, (err as Error).message)
  }

  // Resolve through existing ancestors for overlap checks.
  let canonResolved: string
  let canonCurrent: string
  let canonUserData: string
  let canonDefault: string
  try {
    canonResolved = resolveExisting(resolvedRoot)
    canonCurrent = resolveExisting(currentRoot)
    canonUserData = resolveExisting(userData)
    canonDefault = resolveExisting(defaultRoot)
  } catch (err) {
    return baseFail(pickedPath, resolvedRoot, usedSubfolder, (err as Error).message)
  }

  if (overlapsPath(canonCurrent, canonResolved) || overlapsPath(canonResolved, canonCurrent)) {
    return baseFail(
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      'The new data folder cannot be the current folder, inside it, or a parent folder above it.',
    )
  }

  if (
    (overlapsPath(canonUserData, canonResolved) || overlapsPath(canonResolved, canonUserData)) &&
    canonicalPath(canonResolved) !== canonicalPath(canonDefault)
  ) {
    return baseFail(
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      `Choose a folder outside Orgtree's settings folder (${userData}), or use the default location.`,
    )
  }

  if (params.installDirectory) {
    try {
      const canonInstall = resolveExisting(path.resolve(params.installDirectory))
      if (overlapsPath(canonInstall, canonResolved) || overlapsPath(canonResolved, canonInstall)) {
        return baseFail(
          pickedPath,
          resolvedRoot,
          usedSubfolder,
          `The data folder cannot overlap Orgtree's installation folder (${params.installDirectory}).`,
        )
      }
    } catch {
      // Ignore unreadable installDirectory in unpackaged tests.
    }
  }

  let sourceBytes = 0
  let unreadableEntries: DataLocationUnreadableEntry[] = []
  try {
    const cache = params.sizeCache ?? defaultDataLocationSizeCache
    let measured = await cache.measure(currentRoot, {
      signal: params.signal,
      onProgress: params.onScanProgress,
      measureDirectory: params.measureDirectory,
    })
    if (!params.measureDirectory && measured.unreadableEntries.length > 0) {
      const changed = await reprobeCachedUnreadableEntries(measured.unreadableEntries)
      if (changed) {
        cache.invalidate(currentRoot)
        measured = await cache.measure(currentRoot, {
          signal: params.signal,
          onProgress: params.onScanProgress,
        })
      }
    }
    sourceBytes = measured.totalBytes
    unreadableEntries = measured.unreadableEntries
  } catch (err) {
    if (params.signal?.aborted || isAbortError(err)) {
      return {
        ok: false,
        cancelled: true,
        pickedPath,
        resolvedRoot,
        usedSubfolder,
        sourceBytes: 0,
        requiredBytes: 0,
        freeBytes: 0,
        activeAgents,
      }
    }
    return baseFail(
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      `Could not measure current data folder (${currentRoot}): ${(err as Error).message}`,
    )
  }
  const requiredBytes = requiredTargetBytes(sourceBytes)
  let freeBytes = 0
  try {
    freeBytes = availableVolumeBytes(resolvedRoot)
  } catch (err) {
    return {
      ok: false,
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      sourceBytes,
      requiredBytes,
      freeBytes: 0,
      activeAgents,
      error: `Could not check free disk space for ${resolvedRoot}: ${(err as Error).message}`,
    }
  }

  if (freeBytes < requiredBytes) {
    return {
      ok: false,
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      sourceBytes,
      requiredBytes,
      freeBytes,
      activeAgents,
      error: `Not enough free disk space on the destination drive: ${formatBytes(freeBytes)} available, ${formatBytes(requiredBytes)} required (${formatBytes(sourceBytes)} data plus safety headroom).`,
    }
  }

  try {
    const userDataFree = availableVolumeBytes(userData)
    if (userDataFree < MIN_USER_DATA_FREE_BYTES) {
      return {
        ok: false,
        pickedPath,
        resolvedRoot,
        usedSubfolder,
        sourceBytes,
        requiredBytes,
        freeBytes,
        activeAgents,
        error: `Not enough free space in ${userData} (${formatBytes(userDataFree)} free; at least ${formatBytes(MIN_USER_DATA_FREE_BYTES)} required to update configuration safely).`,
      }
    }
  } catch {
    // Non-fatal if statfs is unsupported on mock fs.
  }

  // Probe directory creation, owner-only NTFS DACL, canonical + typed descriptor trust, and r+ lock write.
  const existedBefore = fs.existsSync(resolvedRoot)
  const createdTop = existedBefore ? null : firstNonExistentAncestor(resolvedRoot)
  const priorSddl = existedBefore ? await readWindowsAccessSddl(resolvedRoot) : null
  const probeName = `.orgtree-trust-probe-${process.pid}-${randomBytes(6).toString('hex')}`
  const probeFile = path.join(resolvedRoot, probeName)
  const trustCheck = params.trustCheck ?? verifyDescriptorTrust

  try {
    fs.mkdirSync(resolvedRoot, { recursive: true })
    await lockOwnerOnlyAcl(resolvedRoot, true)
    fs.writeFileSync(probeFile, '0', { encoding: 'utf8', mode: 0o600 })
    await lockOwnerOnlyAcl(probeFile, false)

    // Probe r+ write semantics (same as Engine.guardianReleased).
    const fd = fs.openSync(probeFile, 'r+')
    try {
      fs.writeSync(fd, Buffer.from('0'), 0, 1, 0)
    } finally {
      fs.closeSync(fd)
    }

    const typedTrust = await trustCheck(probeFile)
    if (!typedTrust.ok) {
      const msg = typedTrust.unsafeFolder ? unsafeDescriptorMessage(typedTrust) : `Folder permissions failed security verification: ${typedTrust.detail}`
      return {
        ok: false,
        pickedPath,
        resolvedRoot,
        usedSubfolder,
        sourceBytes,
        requiredBytes,
        freeBytes,
        activeAgents,
        error: msg,
      }
    }

    const realProbe = fs.realpathSync.native(probeFile)
    if (realProbe !== probeFile) {
      const realTrust = await trustCheck(realProbe)
      if (!realTrust.ok) {
        const msg = realTrust.unsafeFolder ? unsafeDescriptorMessage(realTrust) : `Canonical folder permissions failed security verification: ${realTrust.detail}`
        return {
          ok: false,
          pickedPath,
          resolvedRoot,
          usedSubfolder,
          sourceBytes,
          requiredBytes,
          freeBytes,
          activeAgents,
          error: msg,
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      pickedPath,
      resolvedRoot,
      usedSubfolder,
      sourceBytes,
      requiredBytes,
      freeBytes,
      activeAgents,
      error: (err as Error).message,
    }
  } finally {
    try { fs.unlinkSync(probeFile) } catch { /* best effort */ }
    if (!existedBefore && createdTop) {
      try { fs.rmSync(createdTop, { recursive: true, force: true }) } catch { /* best effort */ }
    } else if (existedBefore && priorSddl) {
      await restoreWindowsAccessSddl(resolvedRoot, priorSddl)
    }
  }

  return {
    ok: true,
    pickedPath,
    resolvedRoot,
    usedSubfolder,
    sourceBytes,
    requiredBytes,
    freeBytes,
    activeAgents,
    unreadableEntries,
  }
}

interface CopyManifestItem {
  relPosix: string
  sourcePath: string
  targetPath: string
  size: number
  mode: number
  mtimeMs: number
}

async function copyFileCancellable(
  src: string,
  dst: string,
  mode: number,
  mtimeMs: number,
  signal: AbortSignal | undefined,
  onChunk: (delta: number) => void,
): Promise<void> {
  if (signal?.aborted) throw new Error('Data move cancelled')
  const srcHandle = await fs.promises.open(src, 'r')
  let dstHandle: fs.promises.FileHandle | undefined
  try {
    dstHandle = await fs.promises.open(dst, 'w', mode & 0o777 || 0o600)
    const buf = Buffer.allocUnsafe(1024 * 1024) // 1 MiB chunks
    for (;;) {
      if (signal?.aborted) throw new Error('Data move cancelled')
      const { bytesRead } = await srcHandle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      let offset = 0
      while (offset < bytesRead) {
        const { bytesWritten } = await dstHandle.write(buf, offset, bytesRead - offset, null)
        offset += bytesWritten
      }
      onChunk(bytesRead)
    }
    await dstHandle.datasync()
  } finally {
    await dstHandle?.close().catch(() => {})
    await srcHandle.close().catch(() => {})
  }
  const mtimeSec = mtimeMs / 1000
  try { await fs.promises.utimes(dst, mtimeSec, mtimeSec) } catch { /* best effort */ }
}

/** How many catch-up passes run after the bulk copy (R6). The last one is the final copy (R7):
 *  every file still changing then gets its latest bytes copied once more and is named in the
 *  result screen and the move log; the move completes instead of rolling back. */
export const MAX_RECOPY_PASSES = 3
/** Extra rounds after those passes while the watcher still reports changes (R7 review). */
export const FINAL_DRAIN_ROUNDS = 2
/** Reads of one file per round before it counts as "could not be settled" (R7 review). */
export const STABLE_COPY_ATTEMPTS = 3
/** How a file that never held still during its copies is named; the old folder is kept. */
export const UNSETTLED_DURING_MOVE_NOTE = 'could not be settled; the previous folder was kept'
/** How long a catch-up pass lets the source watcher deliver pending events (R7). */
export const WATCH_SETTLE_MS = 750
/** How long the pre-check watches the quiet source for files still changing (R7). */
export const DATA_MOVE_CHANGE_WATCH_MS = 12_000
/** How a file still changing at the final copy is named in the move log and result screen. */
export const CHANGED_DURING_MOVE_NOTE = 'changed during the move; latest version copied'

interface SourceScan {
  dirs: string[]
  files: CopyManifestItem[]
  totalBytes: number
  skippedPaths: string[]
}

/** Walk `sourceRoot` without following symlinks or junctions, skipping runtime ephemerals and
 *  the preflight-approved unreadable entries. Any other unreadable entry throws. `relBase` scans
 *  a subfolder of the data root (its entries' relative paths start with `relBase/`). */
async function scanSourceTree(
  sourceRoot: string,
  targetRoot: string,
  skipSet: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  onEntry?: (files: number, bytes: number) => void,
  relBase = '',
): Promise<SourceScan> {
  const scan: SourceScan = { dirs: [targetRoot], files: [], totalBytes: 0, skippedPaths: [] }
  if (!fs.existsSync(sourceRoot)) return scan
  const addFile = (item: { fullSrc: string; fullDst: string; relPosix: string }, st: fs.Stats) => {
    scan.files.push({
      relPosix: item.relPosix,
      sourcePath: item.fullSrc,
      targetPath: item.fullDst,
      size: st.size,
      mode: st.mode,
      mtimeMs: st.mtimeMs,
    })
    scan.totalBytes += st.size
    onEntry?.(scan.files.length, scan.totalBytes)
  }
  const collect = async (dir: string, relPrefix: string): Promise<void> => {
    if (signal?.aborted) throw new Error('Data move cancelled')
    if (relPrefix !== '' && matchesCanonicalKeySet(dir, skipSet)) {
      scan.skippedPaths.push(path.resolve(dir))
      return
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    const fileEntries: { fullSrc: string; fullDst: string; relPosix: string }[] = []
    const subdirs: { fullSrc: string; fullDst: string; relPosix: string }[] = []
    const unknownEntries: { fullSrc: string; fullDst: string; relPosix: string }[] = []

    for (const entry of entries) {
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (isEphemeralEntry(relPosix, entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const fullSrc = path.join(dir, entry.name)
      if (matchesCanonicalKeySet(fullSrc, skipSet)) {
        scan.skippedPaths.push(path.resolve(fullSrc))
        continue
      }
      const fullDst = path.join(targetRoot, ...relPosix.slice(relBase ? relBase.length + 1 : 0).split('/'))
      if (entry.isFile()) {
        fileEntries.push({ fullSrc, fullDst, relPosix })
      } else if (entry.isDirectory()) {
        scan.dirs.push(fullDst)
        subdirs.push({ fullSrc, fullDst, relPosix })
      } else {
        unknownEntries.push({ fullSrc, fullDst, relPosix })
      }
    }

    if (fileEntries.length > 0) {
      await runWithConcurrency(fileEntries, FILE_STAT_CONCURRENCY, signal, async item => {
        const st = await fs.promises.lstat(item.fullSrc)
        if (!st.isSymbolicLink() && st.isFile()) addFile(item, st)
      })
    }

    if (unknownEntries.length > 0) {
      await runWithConcurrency(unknownEntries, FILE_STAT_CONCURRENCY, signal, async item => {
        const st = await fs.promises.lstat(item.fullSrc)
        if (isEntryReparsePoint(item.fullSrc, st)) return
        if (st.isDirectory()) {
          scan.dirs.push(item.fullDst)
          subdirs.push(item)
        } else if (st.isFile()) {
          addFile(item, st)
        }
      })
    }

    for (const sub of subdirs) {
      if (signal?.aborted) throw new Error('Data move cancelled')
      await collect(sub.fullSrc, sub.relPosix)
    }
  }
  try {
    await collect(sourceRoot, relBase)
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw new Error('Data move cancelled')
    throw err
  }
  return scan
}

/** A recursive watch of the data root that records which paths changed (R7). It is cheap
 *  (ReadDirectoryChangesW on Windows) and never rescans. An event without a file name means
 *  the system dropped events (buffer overflow), so the next catch-up rescans fully; a watch
 *  that cannot start or errors marks itself failed and every pass rescans. */
interface SourceWatch {
  failed: boolean
  take(): { paths: Set<string>; overflow: boolean }
  close(): void
}

function startSourceWatch(sourceRoot: string): SourceWatch {
  let paths = new Set<string>()
  let overflow = false
  let watcher: fs.FSWatcher | null = null
  const state: SourceWatch = {
    failed: false,
    take() {
      const out = { paths, overflow: overflow || state.failed }
      paths = new Set<string>()
      overflow = false
      return out
    },
    close() {
      try { watcher?.close() } catch { /* already closed */ }
      watcher = null
    },
  }
  try {
    watcher = fs.watch(sourceRoot, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename == null || filename === '') {
        overflow = true
        return
      }
      const rel = String(filename).split(path.sep).join('/').replace(/^\/+|\/+$/g, '')
      if (rel) paths.add(rel)
    })
    watcher.on('error', () => { state.failed = true })
  } catch {
    state.failed = true
  }
  return state
}

/** Whether a changed path is one the copy tracks: not a runtime ephemeral, not inside a
 *  preflight-approved skipped entry, and not below a symlink or junction. */
function isTrackedRelPath(sourceRoot: string, relPosix: string, skipSet: ReadonlySet<string>): boolean {
  const parts = relPosix.split('/')
  let full = sourceRoot
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!
    if (name === '' || name === '.' || name === '..') return false
    const rel = parts.slice(0, i + 1).join('/')
    if (isEphemeralEntry(rel, name)) return false
    full = path.join(full, name)
    if (matchesCanonicalKeySet(full, skipSet)) return false
    if (i < parts.length - 1) {
      try {
        const st = fs.lstatSync(full)
        if (st.isSymbolicLink() || isEntryReparsePoint(full, st) || !st.isDirectory()) return false
      } catch {
        return false
      }
    }
  }
  return true
}

/** Pre-check (R7): after Orgtree's writers are quiet, watch the source for `durationMs` and
 *  return the files (relative, sorted) that still changed. Nothing is rescanned and no process
 *  is looked for or stopped. An unusable watcher returns no files. */
export async function watchSourceForChanges(
  sourceRoot: string,
  options: {
    durationMs: number
    skipUnreadablePaths?: readonly string[]
    signal?: AbortSignal
    onTick?: (elapsedMs: number, durationMs: number) => void
    tickMs?: number
  },
): Promise<string[]> {
  const skipSet = canonicalEntryKeySet(options.skipUnreadablePaths)
  const watch = startSourceWatch(sourceRoot)
  const started = Date.now()
  try {
    const tick = options.tickMs ?? 1000
    options.onTick?.(0, options.durationMs)
    for (;;) {
      if (options.signal?.aborted) throw new Error('Data move cancelled')
      const elapsed = Date.now() - started
      if (elapsed >= options.durationMs) break
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(tick, options.durationMs - elapsed)))
      options.onTick?.(Math.min(Date.now() - started, options.durationMs), options.durationMs)
    }
  } finally {
    watch.close()
  }
  const { paths } = watch.take()
  const files: string[] = []
  for (const rel of paths) {
    if (!isTrackedRelPath(sourceRoot, rel, skipSet)) continue
    try {
      const st = fs.lstatSync(path.join(sourceRoot, ...rel.split('/')))
      if (st.isFile() && !isEntryReparsePoint(path.join(sourceRoot, ...rel.split('/')), st)) files.push(rel)
    } catch {
      // Gone again: nothing to copy, nothing to warn about.
    }
  }
  return files.sort()
}

/** Manifest entry plus the bytes this copy actually wrote (a file can change while it is read). */
type ManifestItem = CopyManifestItem & { copiedBytes?: number }

/** Stream-copy `sourceRoot` -> `targetRoot` with chunked cancellation, skipping runtime
 *  ephemerals, symlinks/junctions, and any preflight-approved `skipUnreadablePaths`.
 *  The caller stops every writer of `sourceRoot` first. A recursive watch started before the
 *  first scan records what changes during the copy; each catch-up pass looks only at those
 *  paths (a full rescan only when the watch dropped events or is unusable): a changed or new
 *  file is recopied, one that vanished is removed from the target. The last pass is the final
 *  copy (R7): files still changing get their latest bytes and are returned in
 *  `changedDuringMove`; the copy does NOT fail for them. Finally every copied file is verified
 *  strictly (no exclusions): an unchanged file whose copy differs fails, as does any copy error. */
export async function copyDataRootWithVerify(
  sourceRoot: string,
  targetRoot: string,
  options: {
    signal?: AbortSignal
    onProgress?: (progress: DataLocationProgress) => void
    skipUnreadablePaths?: readonly string[]
    /** Each catch-up pass: the files recopied and those removed because they left the source. */
    onRecopy?: (pass: number, recopied: readonly string[], removed: readonly string[]) => void
    /** Each catch-up pass: whether it used the watcher's changed paths or a full rescan. */
    onCatchUpPass?: (pass: number, mode: 'watch' | 'full') => void
    /** Test seam: runs after the bulk copy, before each catch-up pass looks for changes. */
    beforeRescan?: (pass: number) => Promise<void> | void
    /** Test seam: runs after each catch-up read of a file, before its source is checked again. */
    afterRecopyRead?: (relPosix: string, attempt: number) => Promise<void> | void
    watchSettleMs?: number
  } = {},
): Promise<{
  filesCopied: number
  bytesCopied: number
  skippedPaths: string[]
  recopiedPaths: string[]
  changedDuringMove: string[]
  unsettledPaths: string[]
}> {
  const { signal, onProgress } = options
  const skipSet = canonicalEntryKeySet(options.skipUnreadablePaths)
  const settleMs = options.watchSettleMs ?? WATCH_SETTLE_MS
  const watch = startSourceWatch(sourceRoot)
  try {
    return await copyWatched()
  } finally {
    watch.close()
  }

  async function copyWatched() {
    let lastScanEmitMs = Date.now()
    const first = await scanSourceTree(sourceRoot, targetRoot, skipSet, signal, (count, bytes) => {
      if (!onProgress) return
      const now = Date.now()
      if (now - lastScanEmitMs < SCAN_PROGRESS_INTERVAL_MS) return
      lastScanEmitMs = now
      onProgress({
        phase: 'copying',
        filesCopied: 0,
        totalFiles: count,
        bytesCopied: 0,
        totalBytes: bytes,
        cancellable: true,
        detail: `Scanning files to copy… (${count.toLocaleString('en-US')} files, ${formatBytes(bytes)})`,
      })
    })
    const skippedPaths = first.skippedPaths
    const manifest = new Map<string, ManifestItem>(first.files.map(f => [f.relPosix, f]))
    const dirRels = new Set<string>()
    for (const d of first.dirs) {
      const rel = path.relative(targetRoot, d).split(path.sep).join('/')
      if (rel) dirRels.add(rel)
    }
    const totalBytes = first.totalBytes
    const bulkCount = first.files.length

    fs.mkdirSync(targetRoot, { recursive: true })
    await lockOwnerOnlyAcl(targetRoot, true)
    for (const dir of first.dirs) {
      if (signal?.aborted) throw new Error('Data move cancelled')
      fs.mkdirSync(dir, { recursive: true })
    }

    // Explicitly lock sensitive secret directories when present on POSIX/Windows.
    for (const secretRel of [['secrets'], ['pg', 'cluster', 'secrets']]) {
      const secDir = path.join(targetRoot, ...secretRel)
      if (fs.existsSync(secDir)) {
        await lockOwnerOnlyAcl(secDir, true)
      }
    }

    let filesCopied = 0
    let bytesCopied = 0
    let lastEmitMs = 0
    const emit = (force = false) => {
      const now = Date.now()
      if (!force && now - lastEmitMs < 150) return
      lastEmitMs = now
      onProgress?.({
        phase: 'copying',
        filesCopied,
        totalFiles: bulkCount,
        bytesCopied,
        totalBytes,
        cancellable: true,
        detail: `${formatBytes(bytesCopied)} of ${formatBytes(totalBytes)} (${filesCopied} / ${bulkCount} files)`,
      })
    }
    emit(true)

    const copyItem = async (item: ManifestItem, onChunk: (delta: number) => void) => {
      let copied = 0
      await copyFileCancellable(item.sourcePath, item.targetPath, item.mode, item.mtimeMs, signal, delta => {
        copied += delta
        onChunk(delta)
      })
      item.copiedBytes = copied
    }

    for (const item of first.files) {
      await copyItem(item, delta => {
        bytesCopied += delta
        emit(false)
      })
      filesCopied += 1
      emit(false)
    }
    emit(true)

    if (signal?.aborted) throw new Error('Data move cancelled')

    // A catch-up copy counts only when the source held still across the read (R7 review): the
    // same size and modification time before and after, and every byte of that size read. A
    // copy goes to a temporary file and replaces the target only when it is stable, or (when
    // the file never holds still) when it is complete for the size the source had: a torn,
    // empty or short read never replaces an earlier good copy.
    const unsettled = new Set<string>()
    const stableCopy = async (item: ManifestItem): Promise<'ok' | 'gone' | 'unsettled'> => {
      const tmp = `${item.targetPath}.orgtree-recopy-${process.pid}.tmp`
      let haveTarget = false
      try { haveTarget = fs.lstatSync(item.targetPath).isFile() } catch { haveTarget = false }
      const discardTmp = () => { try { fs.unlinkSync(tmp) } catch { /* absent */ } }
      let lastComplete = false
      for (let attempt = 1; attempt <= STABLE_COPY_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw new Error('Data move cancelled')
        let before: fs.Stats
        try {
          before = fs.lstatSync(item.sourcePath)
        } catch (err) {
          if (errnoCode(err) === 'ENOENT') { discardTmp(); return 'gone' }
          throw err
        }
        if (!before.isFile() || isEntryReparsePoint(item.sourcePath, before)) { discardTmp(); return 'gone' }
        let copied = 0
        try {
          await copyFileCancellable(item.sourcePath, tmp, before.mode, before.mtimeMs, signal, delta => { copied += delta })
        } catch (err) {
          discardTmp()
          if (errnoCode(err) === 'ENOENT' && !fs.existsSync(item.sourcePath)) return 'gone'
          throw err
        }
        await options.afterRecopyRead?.(item.relPosix, attempt)
        let after: fs.Stats | null = null
        try { after = fs.lstatSync(item.sourcePath) } catch (err) { if (errnoCode(err) !== 'ENOENT') throw err }
        if (!after) { discardTmp(); return 'gone' }
        const stable = after.size === before.size && after.mtimeMs === before.mtimeMs && copied === before.size
        const complete = copied === after.size && (copied > 0 || after.size === 0)
        if (stable || complete || !haveTarget) {
          fs.renameSync(tmp, item.targetPath)
          haveTarget = true
          item.size = stable ? before.size : after.size
          item.mtimeMs = stable ? before.mtimeMs : after.mtimeMs
          item.mode = before.mode
          item.copiedBytes = copied
          lastComplete = stable
          if (stable) return 'ok'
        } else {
          discardTmp()
        }
      }
      discardTmp()
      return lastComplete ? 'ok' : 'unsettled'
    }

    // Post-copy step meter: {stepLabel, stepDone, stepTotal}, throttled, each step ends done == total.
    let lastStepEmitMs = 0
    const step = (label: string, done: number, total: number, detail: string, force = false) => {
      const now = Date.now()
      if (!force && done !== total && now - lastStepEmitMs < 150) return
      lastStepEmitMs = now
      onProgress?.({
        phase: 'verifying',
        filesCopied,
        totalFiles: manifest.size,
        bytesCopied,
        totalBytes,
        cancellable: true,
        detail,
        stepLabel: label,
        stepDone: done,
        stepTotal: total,
      })
    }

    interface Delta { changed: ManifestItem[]; removed: ManifestItem[]; newDirs: string[]; replacedDirs: string[] }

    const removeUnder = (rel: string, delta: Delta) => {
      if (!dirRels.has(rel)) return
      const prefix = `${rel}/`
      for (const [key, item] of manifest) if (key.startsWith(prefix)) delta.removed.push(item)
      for (const d of [...dirRels]) if (d === rel || d.startsWith(prefix)) dirRels.delete(d)
      delta.replacedDirs.push(rel)
    }

    // Only the paths the watcher saw change are looked at: an lstat each, a scan only for a
    // folder that appeared or changed type.
    const diffPaths = async (changedRels: Set<string>, label: string): Promise<Delta> => {
      const delta: Delta = { changed: [], removed: [], newDirs: [], replacedDirs: [] }
      const seen = new Set<string>()
      const rels = [...changedRels].sort()
      let done = 0
      step(label, 0, rels.length, `Checking ${rels.length.toLocaleString('en-US')} changed paths…`, true)
      for (const rel of rels) {
        if (signal?.aborted) throw new Error('Data move cancelled')
        done += 1
        step(label, done, rels.length, `Checking ${rels.length.toLocaleString('en-US')} changed paths…`)
        if (seen.has(rel) || !isTrackedRelPath(sourceRoot, rel, skipSet)) continue
        const full = path.join(sourceRoot, ...rel.split('/'))
        let st: fs.Stats | null = null
        try {
          st = fs.lstatSync(full)
        } catch (err) {
          if (errnoCode(err) !== 'ENOENT') throw err
        }
        if (st && (st.isSymbolicLink() || isEntryReparsePoint(full, st))) st = null
        if (st?.isDirectory()) {
          const old = manifest.get(rel)
          if (old) delta.removed.push(old)
          const sub = await scanSourceTree(full, path.join(targetRoot, ...rel.split('/')), skipSet, signal, undefined, rel)
          skippedPaths.push(...sub.skippedPaths.filter(p => !skippedPaths.includes(p)))
          const present = new Set(sub.files.map(f => f.relPosix))
          for (const f of sub.files) {
            seen.add(f.relPosix)
            const prior = manifest.get(f.relPosix)
            if (!prior || prior.size !== f.size || prior.mtimeMs !== f.mtimeMs) delta.changed.push(f)
          }
          const prefix = `${rel}/`
          if (dirRels.has(rel)) {
            for (const [key, item] of manifest) if (key.startsWith(prefix) && !present.has(key)) delta.removed.push(item)
            // A folder below that is no longer a folder (now a file, or gone): its copy goes too,
            // also when the scan already took the event for that path (R7-R3).
            const subDirRels = new Set(sub.dirs.map(d => path.relative(targetRoot, d).split(path.sep).join('/')))
            for (const d of [...dirRels]) {
              if (d.startsWith(prefix) && !subDirRels.has(d)) {
                dirRels.delete(d)
                delta.replacedDirs.push(d)
              }
            }
          }
          for (const d of sub.dirs) {
            const drel = path.relative(targetRoot, d).split(path.sep).join('/')
            if (drel && !dirRels.has(drel)) { dirRels.add(drel); delta.newDirs.push(d) }
          }
          continue
        }
        removeUnder(rel, delta)
        const old = manifest.get(rel)
        if (st?.isFile()) {
          const fresh: ManifestItem = {
            relPosix: rel,
            sourcePath: full,
            targetPath: path.join(targetRoot, ...rel.split('/')),
            size: st.size,
            mode: st.mode,
            mtimeMs: st.mtimeMs,
          }
          // A file the watcher saw written is copied again even when size and time look the same.
          delta.changed.push(fresh)
        } else if (old) {
          delta.removed.push(old)
        }
      }
      return delta
    }

    // Fallback when the watcher dropped events or is unusable: one full rescan.
    const diffFull = async (label: string): Promise<Delta> => {
      step(label, 0, 0, 'Rescanning the data folder for changes…', true)
      const fresh = await scanSourceTree(sourceRoot, targetRoot, skipSet, signal, count => {
        step(label, count, 0, `Rescanning the data folder for changes… (${count.toLocaleString('en-US')} files)`)
      })
      const delta: Delta = { changed: [], removed: [], newDirs: [], replacedDirs: [] }
      const freshKeys = new Set<string>()
      for (const f of fresh.files) {
        freshKeys.add(f.relPosix)
        const old = manifest.get(f.relPosix)
        if (!old || old.size !== f.size || old.mtimeMs !== f.mtimeMs) delta.changed.push(f)
      }
      for (const [key, item] of manifest) if (!freshKeys.has(key)) delta.removed.push(item)
      const freshDirRels = new Set<string>()
      for (const d of fresh.dirs) {
        const rel = path.relative(targetRoot, d).split(path.sep).join('/')
        if (!rel) continue
        freshDirRels.add(rel)
        if (!dirRels.has(rel)) delta.newDirs.push(d)
      }
      for (const rel of dirRels) if (!freshDirRels.has(rel)) delta.replacedDirs.push(rel)
      dirRels.clear()
      for (const rel of freshDirRels) dirRels.add(rel)
      step(label, fresh.files.length, fresh.files.length, 'Rescanned the data folder for changes', true)
      return delta
    }

    const removeTargetFile = (gone: ManifestItem) => {
      // Only "already absent" is fine: any other failure would leave an obsolete file in the
      // new folder, so the copy fails and the move rolls back (R6-R2).
      vanished.set(gone.relPosix, gone.targetPath)
      manifest.delete(gone.relPosix)
      let st: fs.Stats
      try {
        st = fs.lstatSync(gone.targetPath)
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') return
        throw new Error(`Copy verification failed: could not check ${gone.relPosix} in the new folder after it left the source (${errnoCode(err) ?? 'error'})`)
      }
      if (st.isDirectory() && !isEntryReparsePoint(gone.targetPath, st)) return // a folder replaced it already
      if (!st.isFile() || isEntryReparsePoint(gone.targetPath, st)) {
        throw new Error(`Copy verification failed: ${gone.relPosix} in the new folder is no longer a regular file`)
      }
      try {
        fs.unlinkSync(gone.targetPath)
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') {
          throw new Error(`Copy verification failed: could not remove ${gone.relPosix} from the new folder after it left the source (${errnoCode(err) ?? 'error'})`)
        }
      }
    }

    const applyDelta = async (delta: Delta, label: string): Promise<{ copied: string[]; removed: string[] }> => {
      const changedKeys = new Set(delta.changed.map(f => f.relPosix))
      const removed = delta.removed.filter(f => !changedKeys.has(f.relPosix))
      for (const gone of removed) removeTargetFile(gone)
      // A source folder that is now a file (or gone): its now-empty copy goes, never following links.
      for (const rel of delta.replacedDirs.sort((a, b) => b.length - a.length)) {
        const dst = path.join(targetRoot, ...rel.split('/'))
        try {
          const st = fs.lstatSync(dst)
          if (st.isDirectory() && !isEntryReparsePoint(dst, st)) removeDirectoryTreeNoFollow(dst)
        } catch (err) {
          if (errnoCode(err) !== 'ENOENT') throw err
        }
      }
      for (const dir of delta.newDirs) fs.mkdirSync(dir, { recursive: true })
      const copied: string[] = []
      let done = 0
      step(label, 0, delta.changed.length, `Copying ${delta.changed.length.toLocaleString('en-US')} changed files…`, true)
      for (const item of delta.changed) {
        fs.mkdirSync(path.dirname(item.targetPath), { recursive: true })
        const prior = manifest.get(item.relPosix)
        if (prior && prior !== item && prior.copiedBytes !== undefined) item.copiedBytes = prior.copiedBytes
        const outcome = await stableCopy(item)
        if (outcome === 'gone') {
          // Gone between the check and the copy: it left the source, so it leaves the new folder.
          removeTargetFile(item)
          unsettled.delete(item.relPosix)
          done += 1
          continue
        }
        if (outcome === 'unsettled') unsettled.add(item.relPosix)
        else unsettled.delete(item.relPosix)
        manifest.set(item.relPosix, item)
        recopiedPaths.add(item.relPosix)
        copied.push(item.relPosix)
        done += 1
        step(label, done, delta.changed.length, `Copying ${delta.changed.length.toLocaleString('en-US')} changed files…`)
      }
      step(label, delta.changed.length, delta.changed.length, `Copied ${copied.length.toLocaleString('en-US')} changed files`, true)
      return { copied, removed: removed.map(f => f.relPosix) }
    }

    // Catch-up: the writers are stopped, but a file measured before a last write landed (the
    // alpha.5 failure: credential-broker.log grew by 222 bytes) is copied again, never waived.
    // A foreign process may keep writing (the alpha.6 failure: stream-manager/stats.json every
    // 30 s): the last pass copies such files' latest bytes and names them; nothing rolls back.
    const recopiedPaths = new Set<string>()
    const vanished = new Map<string, string>()
    const changedDuringMove = new Set<string>()
    // Strict verification: a copy must hold exactly the bytes accepted for it, and a file that
    // did not change since its scan must match that scan too. Only a file that never held still
    // (kept in the old folder too) is checked against the copy that was kept.
    const verifyItem = async (item: ManifestItem) => {
      let dstStat: fs.Stats
      try {
        dstStat = await fs.promises.lstat(item.targetPath)
      } catch {
        throw new Error(`Copy verification failed: missing ${item.relPosix}`)
      }
      const expected = unsettled.has(item.relPosix) ? (item.copiedBytes ?? item.size) : item.size
      if (!dstStat.isFile() || dstStat.size !== expected || (item.copiedBytes !== undefined && item.copiedBytes !== expected)) {
        throw new Error(`Copy verification failed: size mismatch for ${item.relPosix} (expected ${expected}, got ${dstStat.isFile() ? dstStat.size : 'not a file'})`)
      }
    }
    const verifyAll = async () => {
      const items = [...manifest.values()]
      let verified = 0
      step('Verifying copied files', 0, items.length, `Verifying ${items.length.toLocaleString('en-US')} copied files…`, true)
      for (const item of items) {
        if (signal?.aborted) throw new Error('Data move cancelled')
        await verifyItem(item)
        verified += 1
        step('Verifying copied files', verified, items.length, `Verifying ${items.length.toLocaleString('en-US')} copied files…`)
      }
      step('Verifying copied files', items.length, items.length, `Verified ${items.length.toLocaleString('en-US')} copied files`, true)
    }

    // Rounds: each takes what the watcher saw since the last take and copies it. The copy ends
    // only on an EMPTY take made after the last copy and after strict verification (R7 review:
    // a write landing after a take was otherwise lost). Bounded: after MAX_RECOPY_PASSES the
    // copies are "latest versions" and named; at most FINAL_DRAIN_ROUNDS more rounds follow.
    let round = 0
    let verifiedAll = false
    const maxRounds = MAX_RECOPY_PASSES + FINAL_DRAIN_ROUNDS
    for (;;) {
      if (signal?.aborted) throw new Error('Data move cancelled')
      round += 1
      if (round <= MAX_RECOPY_PASSES) await options.beforeRescan?.(round)
      if (!watch.failed && settleMs > 0) await new Promise<void>(resolve => setTimeout(resolve, settleMs))
      const taken = watch.take()
      const mode = taken.overflow ? 'full' : 'watch'
      options.onCatchUpPass?.(round, mode)
      const delta = mode === 'full' ? await diffFull('Checking for changes') : await diffPaths(taken.paths, 'Checking for changes')
      const changed = delta.changed.length > 0 || delta.removed.length > 0 || delta.newDirs.length > 0 || delta.replacedDirs.length > 0
      if (changed) {
        const final = round >= MAX_RECOPY_PASSES
        const applied = await applyDelta(delta, final ? 'Copying latest versions' : 'Copying changed files')
        options.onRecopy?.(round, applied.copied, applied.removed)
        if (final) {
          for (const rel of [...applied.copied, ...applied.removed]) changedDuringMove.add(rel)
        }
        if (verifiedAll) {
          for (const rel of applied.copied) {
            const item = manifest.get(rel)
            if (item) await verifyItem(item)
          }
        }
        if (round < maxRounds) continue
      }
      if (!verifiedAll) {
        if (signal?.aborted) throw new Error('Data move cancelled')
        await verifyAll()
        verifiedAll = true
        if (round < maxRounds + 1) continue // one more take: writes that landed while verifying
      }
      break
    }
    for (const rel of unsettled) changedDuringMove.delete(rel)
    for (const [relPosix, targetPath] of vanished) {
      if (manifest.has(relPosix)) continue
      let st: fs.Stats | null = null
      try {
        st = fs.lstatSync(targetPath)
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw new Error(`Copy verification failed: could not check ${relPosix} in the new folder (${errnoCode(err) ?? 'error'})`)
      }
      if (st && !(st.isDirectory() && dirRels.has(relPosix))) {
        throw new Error(`Copy verification failed: ${relPosix} left the source but is still in the new folder`)
      }
    }

    const srcPgVersion = path.join(sourceRoot, 'pg', 'cluster', 'data', 'PG_VERSION')
    if (fs.existsSync(srcPgVersion)) {
      const dstPgVersion = path.join(targetRoot, 'pg', 'cluster', 'data', 'PG_VERSION')
      if (!fs.existsSync(dstPgVersion)) {
        throw new Error('Copy verification failed: PostgreSQL PG_VERSION is missing in the new folder.')
      }
      const a = fs.readFileSync(srcPgVersion, 'utf8').trim()
      const b = fs.readFileSync(dstPgVersion, 'utf8').trim()
      if (!b || a !== b) {
        throw new Error('Copy verification failed: PostgreSQL PG_VERSION mismatch.')
      }
    }

    skippedPaths.sort((a, b) => a.localeCompare(b))
    return {
      filesCopied,
      bytesCopied,
      skippedPaths,
      recopiedPaths: [...recopiedPaths].sort(),
      changedDuringMove: [...changedDuringMove].sort(),
      unsettledPaths: [...unsettled].sort(),
    }
  }
}

export interface DataRootWritersReport {
  quiet: boolean
  members: { role: string; life: string }[]
}

/** Poll `probe` (the engine's read-only `core-control quiesce <root>`, which judges each
 *  writer by its stamped PID and creation time, never by image name) until every writer
 *  of the old folder has exited. Throws, naming who is still running, when `timeoutMs`
 *  passes: the move then rolls back before anything was copied. */
export async function waitForDataRootWritersToExit(params: {
  probe: () => Promise<DataRootWritersReport>
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<string> {
  const now = params.now ?? Date.now
  const sleep = params.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const timeoutMs = params.timeoutMs ?? 60_000
  const started = now()
  let last: DataRootWritersReport | null = null
  let lastError: unknown
  for (;;) {
    if (params.signal?.aborted) throw new Error('Data move cancelled')
    try {
      last = await params.probe()
      lastError = undefined
      if (last.quiet && last.members.length === 0) return `all writers exited after ${now() - started} ms`
    } catch (err) {
      lastError = err
    }
    if (now() - started >= timeoutMs) break
    await sleep(params.intervalMs ?? 500)
  }
  const who = last?.members.map(m => `${m.role} (${m.life})`).join(', ')
  throw new Error(
    who
      ? `Orgtree processes still using the data folder did not stop within ${Math.round(timeoutMs / 1000)} s: ${who}. Your existing data folder was not changed.`
      : `Orgtree could not confirm that its other processes stopped (${lastError instanceof Error ? lastError.message : 'no answer'}). Your existing data folder was not changed.`,
  )
}

export function stampDataLocationMoved(fromRoot: string, toRoot: string, movedAt: string): void {
  const variants = new Set<string>()
  variants.add(path.resolve(fromRoot))
  try {
    variants.add(fs.realpathSync.native(fromRoot))
  } catch {
    // Source may be virtual in unit tests.
  }
  let resolvedTo = path.resolve(toRoot)
  try {
    resolvedTo = fs.realpathSync.native(toRoot)
  } catch {
    // Use path.resolve fallback.
  }
  const stamp = {
    version: 1,
    fromRoot: path.resolve(fromRoot),
    fromRootVariants: [...variants],
    toRoot: resolvedTo,
    movedAt,
  }
  fs.writeFileSync(path.join(toRoot, DATA_LOCATION_MOVED_STAMP), JSON.stringify(stamp, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export interface ExecuteDataLocationMoveParams {
  options: DataLocationMoveOptions
  currentRoot: string
  userData: string
  forbiddenRoot: string
  installDirectory?: string
  envOverride?: boolean
  signal?: AbortSignal
  onProgress?: (progress: DataLocationProgress) => void
  trustCheck?: (file: string) => Promise<DescriptorOwner>
  prevalidatedPreflight?: DataLocationPreflight
  stopOldEngine: () => Promise<boolean>
  /** After the engine stopped: resolve only once every other writer of the old folder (the
   *  sign-in helper, the boot host, the desktop recovery watch) has exited; throw otherwise.
   *  Nothing is copied before it resolves. */
  waitForWritersToExit?: (oldRoot: string) => Promise<string>
  /** Pre-check (R7): after the writers stopped, watch the old folder this long (0 = skip) and
   *  list files still changing. */
  changeWatchMs?: number
  /** Asked with the files still changing after the pre-check; false cancels before any copy.
   *  Absent: the move continues (the files are copied at their latest version). */
  confirmChangingFiles?: (files: string[]) => Promise<boolean>
  /** Test/diagnostic seam: each catch-up pass and whether it used the watcher or a full rescan. */
  onCatchUpPass?: (pass: number, mode: 'watch' | 'full') => void
  /** Test seam passed to the copy: runs after each catch-up read of a file. */
  afterRecopyRead?: (relPosix: string, attempt: number) => Promise<void> | void
  startAndVerifyNewEngine: (newRoot: string) => Promise<void>
  restartOldEngineOnRollback: (oldRoot: string) => Promise<void>
}

/** Full guarded move orchestration:
 *  preflight -> stop old engine & verify lock release -> copy & verify ->
 *  stamp `.data-location-moved.json` -> switch `data-location.json` ->
 *  start & verify new engine -> optional selective old-folder cleanup (or full rollback on any error/cancel). */
export async function executeDataLocationMove(params: ExecuteDataLocationMoveParams): Promise<DataLocationMoveResult> {
  const { options, currentRoot, userData, signal, onProgress } = params
  const preflight =
    params.prevalidatedPreflight ??
    (await preflightDataLocation({
      pickedPath: options.targetPath,
      currentRoot,
      userData,
      forbiddenRoot: params.forbiddenRoot,
      installDirectory: params.installDirectory,
      envOverride: params.envOverride,
      trustCheck: params.trustCheck,
    }))
  if (!preflight.ok) {
    const errText = preflight.error ?? 'Target folder failed preflight validation.'
    appendDataLocationMoveLog(userData, 'preflight refused', `${currentRoot} -> ${options.targetPath}: ${errText}`)
    return { ok: false, error: errText }
  }

  const preflightUnreadable = preflight.unreadableEntries ?? []
  const unapproved = unapprovedUnreadableEntries(preflightUnreadable, options.skipUnreadablePaths)
  if (unapproved.length > 0) {
    const errText =
      unapproved.length === 1
        ? `1 unreadable entry in ${path.resolve(currentRoot)} was not approved to skip: ${unapproved[0]!.path}`
        : `${unapproved.length} unreadable entries in ${path.resolve(currentRoot)} were not approved to skip.`
    appendDataLocationMoveLog(
      userData,
      'move refused',
      errText,
      unapproved.map(e => `${e.path}${e.code ? ` (${e.code})` : ''}`),
    )
    return { ok: false, error: errText }
  }

  const oldRoot = path.resolve(currentRoot)
  const newRoot = path.resolve(preflight.resolvedRoot)
  const priorConfig = readDataLocationConfig(userData)
  const newExistedBefore = fs.existsSync(newRoot)
  let switchedConfig = false
  let verifiedNew = false

  appendDataLocationMoveLog(
    userData,
    'move start',
    `${oldRoot} -> ${newRoot} (sourceBytes=${preflight.sourceBytes}, deletePrevious=${Boolean(options.deletePrevious)}, unreadableApproved=${preflightUnreadable.length})`,
    preflightUnreadable.map(e => `${e.path}${e.code ? ` (${e.code})` : ''}`),
  )

  const emit = (
    phase: DataLocationProgress['phase'],
    cancellable: boolean,
    detail: string,
    counts: { filesCopied?: number; totalFiles?: number; bytesCopied?: number; totalBytes?: number } = {},
  ) => {
    onProgress?.({
      phase,
      filesCopied: counts.filesCopied ?? 0,
      totalFiles: counts.totalFiles ?? 0,
      bytesCopied: counts.bytesCopied ?? 0,
      totalBytes: counts.totalBytes ?? preflight.sourceBytes,
      cancellable,
      detail,
    })
  }

  writeMoveInProgressMarker(userData, oldRoot, newRoot)
  const heartbeat = setInterval(() => { refreshMoveInProgressMarker(userData) }, MOVE_MARKER_HEARTBEAT_MS)
  heartbeat.unref?.()
  try {
    emit('stopping', true, 'Stopping the local Orgtree engine…')
    const stopped = await params.stopOldEngine()
    if (!stopped) {
      throw new Error('Orgtree could not confirm that the engine stopped within its timeout. Your existing data folder was not changed.')
    }
    if (isRootLockHeld(oldRoot)) {
      throw new Error('The engine process exited, but a child process is still holding the current data folder lock.')
    }
    appendDataLocationMoveLog(userData, 'engine stopped', `Confirmed local engine stop and lock release on ${oldRoot}`)
    if (signal?.aborted) throw new Error('Data move cancelled')
    if (params.waitForWritersToExit) {
      emit('stopping', true, 'Waiting for the sign-in helper and other Orgtree processes to stop…')
      const writers = await params.waitForWritersToExit(oldRoot)
      appendDataLocationMoveLog(userData, 'writers stopped', writers)
      if (signal?.aborted) throw new Error('Data move cancelled')
    }

    // Pre-check (R7): a cheap look for files that keep changing although Orgtree's writers are
    // quiet (another program writing into the folder). No rescan, no process is looked for.
    if ((params.changeWatchMs ?? 0) > 0) {
      const durationMs = params.changeWatchMs!
      const totalSec = Math.max(1, Math.ceil(durationMs / 1000))
      const changing = await watchSourceForChanges(oldRoot, {
        durationMs,
        signal,
        skipUnreadablePaths: options.skipUnreadablePaths,
        onTick: elapsed => {
          onProgress?.({
            phase: 'preparing',
            filesCopied: 0,
            totalFiles: 0,
            bytesCopied: 0,
            totalBytes: preflight.sourceBytes,
            cancellable: true,
            detail: 'Checking that nothing else is still writing to the data folder…',
            stepLabel: 'Watching for changes',
            stepDone: Math.min(totalSec, Math.round(elapsed / 1000)),
            stepTotal: totalSec,
          })
        },
      })
      onProgress?.({
        phase: 'preparing',
        filesCopied: 0,
        totalFiles: 0,
        bytesCopied: 0,
        totalBytes: preflight.sourceBytes,
        cancellable: true,
        detail: changing.length > 0
          ? `${changing.length} file${changing.length === 1 ? ' is' : 's are'} still changing.`
          : 'Nothing else is writing to the data folder.',
        stepLabel: 'Watching for changes',
        stepDone: totalSec,
        stepTotal: totalSec,
      })
      if (changing.length > 0) {
        appendDataLocationMoveLog(
          userData,
          'still changing before the copy',
          `${changing.length} file(s) in ${oldRoot} changed during a ${Math.round(durationMs / 1000)} s watch after Orgtree's writers stopped`,
          changing.slice(0, MAX_REPORTED_CHANGED_FILES),
        )
        if (params.confirmChangingFiles && !(await params.confirmChangingFiles(changing))) {
          throw new Error('Data move cancelled')
        }
        appendDataLocationMoveLog(userData, 'continue anyway', 'Files still changing are copied at their latest version.')
      }
      if (signal?.aborted) throw new Error('Data move cancelled')
    }

    const copied = await copyDataRootWithVerify(oldRoot, newRoot, {
      signal,
      onProgress,
      skipUnreadablePaths: options.skipUnreadablePaths,
      ...(params.onCatchUpPass ? { onCatchUpPass: params.onCatchUpPass } : {}),
      ...(params.afterRecopyRead ? { afterRecopyRead: params.afterRecopyRead } : {}),
      onRecopy: (pass, recopied, removed) => {
        appendDataLocationMoveLog(
          userData,
          'recopied changed files',
          `pass ${pass}: ${recopied.length} changed or new, ${removed.length} removed from the source after the bulk copy`,
          [...recopied.map(r => `recopied ${r}`), ...removed.map(r => `removed ${r}`)],
        )
      },
    })
    appendDataLocationMoveLog(
      userData,
      'copy verified',
      `filesCopied=${copied.filesCopied} bytesCopied=${copied.bytesCopied} skipped=${copied.skippedPaths.length} recopied=${copied.recopiedPaths.length} changedDuringMove=${copied.changedDuringMove.length}`,
      copied.skippedPaths,
    )
    // A file that never held still while it was copied keeps its intact original in the old
    // folder: that folder is never deleted then, whatever the delete box says (R7 review).
    const unsettledOldPaths = copied.unsettledPaths.map(rel => path.join(oldRoot, ...rel.split('/')))
    if (unsettledOldPaths.length > 0) {
      appendDataLocationMoveLog(
        userData,
        'files could not be settled',
        `${unsettledOldPaths.length} file(s) kept changing while they were copied; the copy kept for each may be torn, and ${oldRoot} is kept with their originals`,
        copied.unsettledPaths.map((rel, i) => `${rel}: ${UNSETTLED_DURING_MOVE_NOTE} (original: ${unsettledOldPaths[i]})`),
      )
    }
    if (copied.changedDuringMove.length > 0) {
      appendDataLocationMoveLog(
        userData,
        CHANGED_DURING_MOVE_NOTE,
        `${copied.changedDuringMove.length} file(s) kept changing after the catch-up passes; the latest version of each was copied`,
        copied.changedDuringMove.map(r => `${r}: ${CHANGED_DURING_MOVE_NOTE}`),
      )
    }
    if (signal?.aborted) throw new Error('Data move cancelled')

    // Point of switch: stamp relocation marker, write data-location.json, clear move-in-progress
    // so the boot host / credential broker can read the new data-location.json cleanly.
    emit('switching', false, 'Updating Orgtree data location…', {
      filesCopied: copied.filesCopied,
      totalFiles: copied.filesCopied,
      bytesCopied: copied.bytesCopied,
      totalBytes: copied.bytesCopied,
    })
    const movedAt = new Date().toISOString()
    stampDataLocationMoved(oldRoot, newRoot, movedAt)
    await writeDataLocationConfig(userData, {
      version: 1,
      dataRoot: newRoot,
      previousRoot: oldRoot,
      movedAt,
    })
    switchedConfig = true
    clearMoveInProgressMarker(userData)
    appendDataLocationMoveLog(userData, 'switched', `data-location.json pointed at ${newRoot}`)

    emit('starting', false, 'Starting Orgtree on the new folder and verifying database relocation…', {
      filesCopied: copied.filesCopied,
      totalFiles: copied.filesCopied,
      bytesCopied: copied.bytesCopied,
      totalBytes: copied.bytesCopied,
    })
    await params.startAndVerifyNewEngine(newRoot)
    verifiedNew = true
    appendDataLocationMoveLog(userData, 'new engine verified', `Verified engine identity and relocation at ${newRoot}`)

    const copiedSkippedSet = canonicalEntryKeySet(copied.skippedPaths)
    const skippedEntries: DataLocationUnreadableEntry[] = preflightUnreadable.filter(e =>
      matchesCanonicalKeySet(e.path, copiedSkippedSet),
    )
    for (const sp of copied.skippedPaths) {
      if (!skippedEntries.some(e => canonicalPath(e.path) === canonicalPath(sp))) {
        skippedEntries.push({
          path: sp,
          relativePath: path.relative(oldRoot, sp).split(path.sep).join('/'),
          kind: 'entry',
          error: 'Skipped',
        })
      }
    }

    let remainingPaths: string[] = skippedEntries.map(e => e.path)
    if (options.deletePrevious && unsettledOldPaths.length > 0) {
      appendDataLocationMoveLog(userData, 'old folder kept', `Not deleting ${oldRoot}: it holds the originals of files that could not be settled`)
    } else if (options.deletePrevious) {
      emit('cleaning', false, 'Deleting the previous data folder…', {
        filesCopied: copied.filesCopied,
        totalFiles: copied.filesCopied,
        bytesCopied: copied.bytesCopied,
        totalBytes: copied.bytesCopied,
      })
      const validOld = validateDeletablePreviousFolder({
        previousRoot: oldRoot,
        currentRoot: newRoot,
        userData,
        forbiddenRoot: params.forbiddenRoot,
        installDirectory: params.installDirectory,
      })
      if (validOld.ok && !isRootLockHeld(validOld.resolvedPrev)) {
        try {
          const cleanup = removeDirectoryTreeSelectiveNoFollow(validOld.resolvedPrev, {
            preservePaths: skippedEntries.map(e => e.path),
          })
          remainingPaths = cleanup.remainingPaths
          appendDataLocationMoveLog(
            userData,
            'old folder cleanup',
            `deletedAll=${cleanup.deletedAll} remaining=${cleanup.remainingPaths.length} in ${oldRoot}`,
            cleanup.remainingPaths,
          )
        } catch (cleanErr) {
          appendDataLocationMoveLog(
            userData,
            'old folder cleanup skipped',
            `Could not clean ${oldRoot}: ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}`,
          )
        }
      }
      defaultDataLocationSizeCache.invalidate(oldRoot)
      if (!fs.existsSync(oldRoot)) {
        remainingPaths = []
        await writeDataLocationConfig(userData, {
          version: 1,
          dataRoot: newRoot,
          movedAt,
        })
      }
    }
    defaultDataLocationSizeCache.invalidate(newRoot)

    const oldFolderDeleted = !fs.existsSync(oldRoot)
    const changedDuringMove = copied.changedDuringMove
    if (skippedEntries.length > 0 || remainingPaths.length > 0 || changedDuringMove.length > 0 || unsettledOldPaths.length > 0) {
      await writeDataLocationMoveReport(userData, {
        movedAt,
        fromRoot: oldRoot,
        toRoot: newRoot,
        deletePreviousRequested: Boolean(options.deletePrevious),
        oldFolderDeleted,
        skippedEntries,
        remainingPaths,
        ...(changedDuringMove.length > 0
          ? {
              changedDuringMove: changedDuringMove.slice(0, MAX_REPORTED_CHANGED_FILES),
              ...(changedDuringMove.length > MAX_REPORTED_CHANGED_FILES ? { changedDuringMoveTotal: changedDuringMove.length } : {}),
            }
          : {}),
        ...(unsettledOldPaths.length > 0 ? { unsettledDuringMove: unsettledOldPaths.slice(0, MAX_REPORTED_CHANGED_FILES) } : {}),
        pendingRestartNotice: true,
      })
    } else {
      await writeDataLocationMoveReport(userData, null)
    }

    appendDataLocationMoveLog(
      userData,
      'move complete',
      `Relaunching on ${newRoot} (skipped=${skippedEntries.length}, changedDuringMove=${changedDuringMove.length}, unsettled=${unsettledOldPaths.length}, oldFolderDeleted=${oldFolderDeleted}, remainingInOld=${remainingPaths.length})`,
    )

    emit('done', false, 'Move complete. Reopening Orgtree…', {
      filesCopied: copied.filesCopied,
      totalFiles: copied.filesCopied,
      bytesCopied: copied.bytesCopied,
      totalBytes: copied.bytesCopied,
    })
    return { ok: true, relaunching: true }
  } catch (err) {
    const cancelled = !!signal?.aborted || (err instanceof Error && err.message === 'Data move cancelled')
    const errMsg = err instanceof Error ? err.message : String(err)
    appendDataLocationMoveLog(
      userData,
      cancelled ? 'move cancelled' : 'move failed',
      `${oldRoot} -> ${newRoot}: ${errMsg}`,
    )
    if (!verifiedNew) {
      try {
        emit('rolling-back', false, cancelled ? 'Move cancelled. Restoring previous data folder…' : 'Move did not complete. Restoring previous data folder…')
      } catch {
        // Never allow a progress listener failure to skip rollback cleanup or engine restart.
      }
      if (switchedConfig) {
        try {
          await writeDataLocationConfig(userData, priorConfig)
        } catch {
          // Best effort restore.
        }
      }
      clearMoveInProgressMarker(userData)
      // Clean partial target folder without traversing symlinks/junctions; never touch oldRoot!
      let partialTargetCleaned = false
      try {
        if (!findReparseAncestor(newRoot)) {
          if (!newExistedBefore) {
            removeDirectoryTreeNoFollow(newRoot)
            partialTargetCleaned = !fs.existsSync(newRoot)
          } else if (fs.existsSync(newRoot)) {
            for (const entry of fs.readdirSync(newRoot)) {
              const child = path.join(newRoot, entry)
              const st = fs.lstatSync(child)
              if (isEntryReparsePoint(child, st)) {
                unlinkReparseEntry(child)
              } else if (st.isDirectory()) {
                removeDirectoryTreeNoFollow(child)
              } else {
                fs.unlinkSync(child)
              }
            }
            partialTargetCleaned = true
          }
        }
      } catch {
        // Best effort cleanup of partial target.
      }
      let oldEngineRestarted = false
      try {
        await params.restartOldEngineOnRollback(oldRoot)
        oldEngineRestarted = true
      } catch {
        // Caller inspects engine status on reopen.
      }
      appendDataLocationMoveLog(
        userData,
        'rollback complete',
        `configRestored=${switchedConfig} partialTargetCleaned=${partialTargetCleaned} oldEngineRestarted=${oldEngineRestarted} originalFolder=${oldRoot}`,
      )
      if (cancelled) return { ok: false, cancelled: true }
      return { ok: false, error: errMsg }
    }
    return { ok: false, error: errMsg }
  } finally {
    clearInterval(heartbeat)
    clearMoveInProgressMarker(userData)
  }
}

export async function deletePreviousDataLocationFolder(params: {
  userData: string
  currentRoot: string
  forbiddenRoot?: string
  installDirectory?: string
  sizeCache?: DataLocationSizeCache
}): Promise<DataLocationDeletePreviousResult> {
  const cfg = readDataLocationConfig(params.userData)
  const previousRoot = cfg?.previousRoot
  if (!previousRoot) {
    return { ok: false, error: 'No previous data folder is recorded.' }
  }
  const valid = validateDeletablePreviousFolder({
    previousRoot,
    currentRoot: params.currentRoot,
    userData: params.userData,
    forbiddenRoot: params.forbiddenRoot,
    installDirectory: params.installDirectory,
  })
  if (!valid.ok) {
    return { ok: false, error: valid.error }
  }
  const { resolvedPrev } = valid
  if (isRootLockHeld(resolvedPrev)) {
    return { ok: false, error: 'Another process is still holding a lock inside the previous data folder.' }
  }

  const priorReport = readDataLocationMoveReport(params.userData)
  const matchesPriorFrom =
    priorReport !== null && canonicalPath(path.resolve(priorReport.fromRoot)) === canonicalPath(resolvedPrev)
  const checkReadablePaths = matchesPriorFrom ? priorReport.skippedEntries.map(e => e.path) : []

  let deletedAll = true
  let remainingPaths: string[] = []
  if (fs.existsSync(resolvedPrev)) {
    try {
      const cleanup = removeDirectoryTreeSelectiveNoFollow(resolvedPrev, { checkReadablePaths })
      deletedAll = cleanup.deletedAll
      remainingPaths = cleanup.remainingPaths
    } catch (err) {
      const errMsg = `Could not delete ${resolvedPrev}: ${(err as Error).message}`
      appendDataLocationMoveLog(params.userData, 'delete previous failed', errMsg)
      return { ok: false, error: errMsg }
    }
  }

  ;(params.sizeCache ?? defaultDataLocationSizeCache).invalidate(resolvedPrev)
  appendDataLocationMoveLog(
    params.userData,
    'delete previous folder',
    `deletedAll=${deletedAll} remaining=${remainingPaths.length} in ${resolvedPrev}`,
    remainingPaths,
  )

  if (!deletedAll) {
    const remainingSet = canonicalEntryKeySet(remainingPaths)
    const retainedSkipped: DataLocationUnreadableEntry[] = matchesPriorFrom
      ? priorReport.skippedEntries.filter(e => matchesCanonicalKeySet(e.path, remainingSet))
      : remainingPaths.map(p => ({
          path: p,
          relativePath: path.relative(resolvedPrev, p).split(path.sep).join('/'),
          kind: 'entry',
          error: 'Could not be removed',
        }))
    await writeDataLocationMoveReport(params.userData, {
      movedAt: priorReport?.movedAt ?? cfg?.movedAt ?? new Date().toISOString(),
      fromRoot: resolvedPrev,
      toRoot: path.resolve(params.currentRoot),
      deletePreviousRequested: true,
      oldFolderDeleted: false,
      skippedEntries: retainedSkipped,
      remainingPaths,
      pendingRestartNotice: false,
    })
    return { ok: true, deletedAll: false, remainingPaths }
  }

  if (matchesPriorFrom) {
    await writeDataLocationMoveReport(params.userData, null)
  }
  await writeDataLocationConfig(
    params.userData,
    cfg
      ? {
          version: 1,
          dataRoot: cfg.dataRoot,
          ...(cfg.movedAt ? { movedAt: cfg.movedAt } : {}),
        }
      : null,
  )
  return { ok: true, deletedAll: true, remainingPaths: [] }
}

export interface ResolveMissingDataLocationParams {
  action: 'choose' | 'default'
  pickedPath?: string
  configuredRoot: string
  defaultDataFolder: string
  userData: string
  forbiddenRoot: string
  installDirectory?: string
  trustCheck?: (fileOrDir: string) => Promise<DescriptorOwner>
  confirmBlankFolder: (folder: string) => Promise<boolean>
}

export type ResolveMissingDataLocationResult =
  | { ok: true; dataRoot: string; stampedRelocation: boolean }
  | { ok: false; cancelled?: boolean; error?: string }

/** Validate and persist a recovery choice from the startup missing-data-folder dialog. */
export async function resolveMissingDataLocationChoice(
  params: ResolveMissingDataLocationParams,
): Promise<ResolveMissingDataLocationResult> {
  const defaultRoot = path.resolve(params.defaultDataFolder)
  const userData = path.resolve(params.userData)

  if (params.action === 'default') {
    const hasCluster = fs.existsSync(path.join(defaultRoot, 'pg', 'cluster', 'data', 'PG_VERSION'))
    if (!hasCluster) {
      const proceed = await params.confirmBlankFolder(defaultRoot)
      if (!proceed) return { ok: false, cancelled: true }
    }
    const currentCfg = readDataLocationConfig(userData)
    const previousRoot =
      currentCfg?.previousRoot && canonicalPath(currentCfg.previousRoot) !== canonicalPath(defaultRoot)
        ? currentCfg.previousRoot
        : undefined
    await writeDataLocationConfig(
      userData,
      previousRoot
        ? {
            version: 1,
            dataRoot: defaultRoot,
            previousRoot,
            ...(currentCfg?.movedAt ? { movedAt: currentCfg.movedAt } : {}),
          }
        : null,
    )
    return { ok: true, dataRoot: defaultRoot, stampedRelocation: false }
  }

  const normalizedPick = normalizeLocalDataPath(params.pickedPath ?? '')
  if (!normalizedPick) {
    return {
      ok: false,
      error: 'Choose an absolute local drive-letter folder path (network UNC and device paths are not supported).',
    }
  }
  const picked = path.resolve(normalizedPick)
  const reparsePicked = findReparseAncestor(picked)
  if (reparsePicked) {
    return {
      ok: false,
      error: `Orgtree cannot store its data inside a symbolic link or junction (${reparsePicked}). Choose a real local folder.`,
    }
  }
  if (!fs.existsSync(picked)) {
    return { ok: false, error: `${picked} does not exist.` }
  }
  let pickedStat: fs.Stats
  try {
    pickedStat = fs.lstatSync(picked)
  } catch (err) {
    return { ok: false, error: `Could not inspect ${picked}: ${(err as Error).message}` }
  }
  if (isEntryReparsePoint(picked, pickedStat) || !pickedStat.isDirectory()) {
    return { ok: false, error: `${picked} is not a real local directory.` }
  }

  let chosenRoot = picked
  const directCluster = path.join(picked, 'pg', 'cluster', 'data', 'PG_VERSION')
  if (!fs.existsSync(directCluster)) {
    const candidateSub = path.join(picked, DATA_LOCATION_SUBFOLDER)
    if (
      !findReparseAncestor(candidateSub) &&
      fs.existsSync(path.join(candidateSub, 'pg', 'cluster', 'data', 'PG_VERSION'))
    ) {
      chosenRoot = candidateSub
    }
  }

  const reparseChosen = findReparseAncestor(chosenRoot)
  if (reparseChosen) {
    return {
      ok: false,
      error: `Orgtree cannot store its data inside a symbolic link or junction (${reparseChosen}). Choose a real local folder.`,
    }
  }

  try {
    validateDataRoot(chosenRoot, params.forbiddenRoot)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  let canonChosen: string
  let canonUserData: string
  let canonDefault: string
  let realChosen: string
  try {
    canonChosen = resolveExisting(chosenRoot)
    canonUserData = resolveExisting(userData)
    canonDefault = resolveExisting(defaultRoot)
    realChosen = fs.realpathSync.native(chosenRoot)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  if (
    (overlapsPath(canonUserData, canonChosen) || overlapsPath(canonChosen, canonUserData)) &&
    canonicalPath(canonChosen) !== canonicalPath(canonDefault)
  ) {
    return {
      ok: false,
      error: `Choose a folder outside Orgtree's settings folder (${userData}), or click "Use default location".`,
    }
  }

  if (params.installDirectory) {
    try {
      const canonInstall = resolveExisting(path.resolve(params.installDirectory))
      if (overlapsPath(canonInstall, canonChosen) || overlapsPath(canonChosen, canonInstall)) {
        return {
          ok: false,
          error: `The data folder cannot overlap Orgtree's installation folder (${params.installDirectory}).`,
        }
      }
    } catch {
      // Ignore unreadable installDirectory fallback.
    }
  }

  const reparseReal = findReparseAncestor(realChosen)
  if (reparseReal) {
    return {
      ok: false,
      error: `Orgtree cannot store its data inside a symbolic link or junction (${reparseReal}). Choose a real local folder.`,
    }
  }

  const checkDir = async (dir: string): Promise<DescriptorOwner> =>
    params.trustCheck ? params.trustCheck(path.join(dir, 'engine-attach.json')) : verifyDataFolderTrust(dir)

  for (const candidateDir of new Set([chosenRoot, realChosen])) {
    const trust = await checkDir(candidateDir)
    if (!trust.ok) {
      return {
        ok: false,
        error: trust.unsafeFolder
          ? unsafeDescriptorMessage(trust)
          : `Folder permissions failed security verification: ${trust.detail}`,
      }
    }
  }

  const hasCluster = fs.existsSync(path.join(chosenRoot, 'pg', 'cluster', 'data', 'PG_VERSION'))
  if (!hasCluster) {
    const proceed = await params.confirmBlankFolder(chosenRoot)
    if (!proceed) return { ok: false, cancelled: true }
  }

  const currentCfg = readDataLocationConfig(userData)
  const movedAt = new Date().toISOString()
  const stampedRelocation = hasCluster && canonicalPath(chosenRoot) !== canonicalPath(params.configuredRoot)
  if (stampedRelocation) {
    stampDataLocationMoved(params.configuredRoot, chosenRoot, movedAt)
  }
  const previousRoot =
    currentCfg?.previousRoot && canonicalPath(currentCfg.previousRoot) !== canonicalPath(chosenRoot)
      ? currentCfg.previousRoot
      : undefined

  await writeDataLocationConfig(
    userData,
    canonicalPath(chosenRoot) === canonicalPath(defaultRoot) && !previousRoot
      ? null
      : {
          version: 1,
          dataRoot: chosenRoot,
          ...(previousRoot ? { previousRoot } : {}),
          movedAt,
        },
  )
  return { ok: true, dataRoot: chosenRoot, stampedRelocation }
}

export interface DesktopMoveCoreLifecycle {
  transition: (planned: boolean) => Promise<unknown>
  complete: () => Promise<unknown>
  start: () => void
  stop: () => void
}

export interface OrchestrateDesktopDataMoveParams {
  options: DataLocationMoveOptions
  currentRoot: string
  userData: string
  forbiddenRoot: string
  installDirectory?: string
  envOverride?: boolean
  signal?: AbortSignal
  trustCheck?: (file: string) => Promise<DescriptorOwner>
  resolveMoveTopology: () => Promise<'boot' | 'managed' | 'unknown'>
  unreadableTasksMessage?: string
  coreLifecycle?: DesktopMoveCoreLifecycle
  prepareUiForMove: () => Promise<{
    closeMoveWindow: () => void
    onProgress?: (progress: DataLocationProgress) => void
  }>
  stopEngineForMove: (topology: 'boot' | 'managed') => Promise<boolean>
  waitForWritersToExit?: (oldRoot: string, topology: 'boot' | 'managed') => Promise<string>
  changeWatchMs?: number
  confirmChangingFiles?: (files: string[]) => Promise<boolean>
  startAndVerifyNewEngine: (newRoot: string, topology: 'boot' | 'managed') => Promise<void>
  restartOldEngineOnRollback: (oldRoot: string, topology: 'boot' | 'managed') => Promise<void>
  finishSuccessfulMove: () => void
  restoreAfterFailedOrCancelledMove: (outcome: DataLocationMoveResult) => Promise<void>
}

/** High-level desktop move coordinator:
 *  validates preflight and Windows scheduled-task topology BEFORE tearing down windows,
 *  uses `CoreLifecycle.transition(true)` (never `cancelRecovery()`), and guarantees
 *  window restoration on any rollback or unexpected exception. */
export async function orchestrateDesktopDataMove(
  params: OrchestrateDesktopDataMoveParams,
): Promise<DataLocationMoveResult> {
  const preflight = await preflightDataLocation({
    pickedPath: params.options.targetPath,
    currentRoot: params.currentRoot,
    userData: params.userData,
    forbiddenRoot: params.forbiddenRoot,
    installDirectory: params.installDirectory,
    envOverride: params.envOverride,
    trustCheck: params.trustCheck,
  })
  if (!preflight.ok) {
    const errText = preflight.error ?? 'Target folder failed preflight validation.'
    appendDataLocationMoveLog(
      params.userData,
      'preflight refused',
      `${params.currentRoot} -> ${params.options.targetPath}: ${errText}`,
    )
    return { ok: false, error: errText }
  }

  const unapproved = unapprovedUnreadableEntries(
    preflight.unreadableEntries ?? [],
    params.options.skipUnreadablePaths,
  )
  if (unapproved.length > 0) {
    const errText =
      unapproved.length === 1
        ? `1 unreadable entry in ${path.resolve(params.currentRoot)} was not approved to skip: ${unapproved[0]!.path}`
        : `${unapproved.length} unreadable entries in ${path.resolve(params.currentRoot)} were not approved to skip.`
    appendDataLocationMoveLog(
      params.userData,
      'move refused',
      errText,
      unapproved.map(e => `${e.path}${e.code ? ` (${e.code})` : ''}`),
    )
    return { ok: false, error: errText }
  }

  const topology = await params.resolveMoveTopology()
  if (topology === 'unknown') {
    const errText = params.unreadableTasksMessage ?? 'Scheduled tasks could not be verified.'
    appendDataLocationMoveLog(params.userData, 'topology refused', errText)
    return {
      ok: false,
      error: errText,
    }
  }

  const ui = await params.prepareUiForMove()
  try {
    const outcome = await executeDataLocationMove({
      options: params.options,
      currentRoot: params.currentRoot,
      userData: params.userData,
      forbiddenRoot: params.forbiddenRoot,
      installDirectory: params.installDirectory,
      envOverride: params.envOverride,
      signal: params.signal,
      trustCheck: params.trustCheck,
      prevalidatedPreflight: preflight,
      onProgress: ui.onProgress,
      stopOldEngine: async () => {
        if (params.coreLifecycle) {
          if (topology === 'boot') {
            await params.coreLifecycle.transition(true)
          }
          params.coreLifecycle.stop()
        }
        return params.stopEngineForMove(topology)
      },
      ...(params.waitForWritersToExit
        ? { waitForWritersToExit: (oldRoot: string) => params.waitForWritersToExit!(oldRoot, topology) }
        : {}),
      ...(params.changeWatchMs ? { changeWatchMs: params.changeWatchMs } : {}),
      ...(params.confirmChangingFiles ? { confirmChangingFiles: params.confirmChangingFiles } : {}),
      startAndVerifyNewEngine: newRoot => params.startAndVerifyNewEngine(newRoot, topology),
      restartOldEngineOnRollback: oldRoot => params.restartOldEngineOnRollback(oldRoot, topology),
    })
    ui.closeMoveWindow()
    if (outcome.ok) {
      params.coreLifecycle?.stop()
      params.finishSuccessfulMove()
      return outcome
    }
    if (topology === 'boot' && params.coreLifecycle) {
      await params.coreLifecycle.complete().catch(() => {})
    }
    params.coreLifecycle?.start()
    await params.restoreAfterFailedOrCancelledMove(outcome)
    return outcome
  } catch (err) {
    ui.closeMoveWindow()
    if (topology === 'boot' && params.coreLifecycle) {
      await params.coreLifecycle.complete().catch(() => {})
    }
    params.coreLifecycle?.start()
    const failOutcome: DataLocationMoveResult = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    await params.restoreAfterFailedOrCancelledMove(failOutcome)
    return failOutcome
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export const DATA_MOVE_CANCEL_URL = 'https://cancel.orgtree.invalid/'

const PHASE_TITLES: Record<DataLocationProgress['phase'], string> = {
  checking: 'Checking folder and measuring data size…',
  stopping: 'Stopping local engine…',
  preparing: 'Preparing the final copy…',
  copying: 'Copying Orgtree data…',
  verifying: 'Verifying copied files…',
  switching: 'Switching data location…',
  starting: 'Starting Orgtree at the new location…',
  cleaning: 'Removing old data folder…',
  'rolling-back': 'Restoring previous data folder…',
  done: 'Reopening Orgtree…',
  error: 'Move could not be completed',
}

/** Static, script-free HTML for the offline move progress window (`javascript: false`).
 *  Clicking Cancel triggers a top-level navigation to `DATA_MOVE_CANCEL_URL`, which main
 *  intercepts with `event.preventDefault()` to abort before the pointer switch. */
export function dataMoveProgressHtml(
  progress: DataLocationProgress,
  maskText: (text: string) => string = s => s,
): string {
  const title = maskText(PHASE_TITLES[progress.phase] || 'Moving Orgtree data…')
  const detail = maskText(progress.detail || '')
  const stepped = !!progress.stepLabel && (progress.phase === 'verifying' || progress.phase === 'preparing')
  const stepTotal = progress.stepTotal ?? 0
  const stepDone = progress.stepDone ?? 0
  const stepText = stepped
    ? `${progress.stepLabel}${stepTotal > 0 ? ` · ${stepDone.toLocaleString('en-US')} / ${stepTotal.toLocaleString('en-US')}` : '…'}`
    : ''
  const pct = stepped
    ? stepTotal > 0
      ? Math.max(0, Math.min(100, Math.round((stepDone / stepTotal) * 100)))
      : 12
    : progress.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((progress.bytesCopied / progress.totalBytes) * 100)))
      : progress.phase === 'verifying' || progress.phase === 'switching' || progress.phase === 'starting' || progress.phase === 'done'
        ? 100
        : 12
  return (
    '<!doctype html><meta charset="utf-8"><title>Orgtree — Moving data</title>' +
    '<style>' +
    'html,body{color-scheme:dark;box-sizing:border-box;overflow:hidden}' +
    'body{font:13px "Segoe UI",system-ui,sans-serif;margin:0;padding:22px 26px;color:#e6e4df;background:#191918;user-select:none}' +
    'h1{font-size:15px;font-weight:600;margin:0 0 8px;color:#f5f3ee}' +
    'p{margin:0 0 14px;color:#a8a49c;line-height:1.45;word-break:break-word}' +
    '.track{height:8px;border-radius:4px;background:#2b2a28;overflow:hidden;margin:0 0 16px}' +
    `.fill{height:100%;width:${pct}%;background:#d97757;transition:width .15s linear}` +
    '.row{display:flex;align-items:center;justify-content:space-between;gap:12px}' +
    '.note{font-size:12px;color:#8a867f}' +
    'a.btn{display:inline-block;padding:6px 14px;border-radius:6px;border:1px solid #3d3b38;background:#262523;color:#ece9e2;text-decoration:none;font-size:12px;font-weight:500}' +
    'a.btn:hover{background:#32302d}' +
    '</style>' +
    `<h1>${escapeHtml(title)}</h1>` +
    (stepText ? `<h1 style="font-size:13px;font-weight:500">${escapeHtml(maskText(stepText))}</h1>` : '') +
    `<p>${escapeHtml(detail || 'Keep Orgtree open until this finishes. Your original data folder remains untouched until the new location starts cleanly.')}</p>` +
    '<div class="track"><div class="fill"></div></div>' +
    '<div class="row">' +
    `<span class="note">${progress.cancellable ? 'Safe to cancel — original folder is untouched.' : 'Finishing switch…'}</span>` +
    (progress.cancellable ? `<a class="btn" href="${DATA_MOVE_CANCEL_URL}">Cancel</a>` : '') +
    '</div>'
  )
}
