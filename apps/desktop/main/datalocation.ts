import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  DataLocationMoveOptions,
  DataLocationMoveResult,
  DataLocationPreflight,
  DataLocationProgress,
  DataLocationSizes,
  DataLocationState,
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
    },
    null,
    2,
  ) + '\n'
  fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 })
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
    }
    if (raw.version !== 1 || typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) return false
    if (typeof raw.startedAtMs === 'number' && Number.isFinite(raw.startedAtMs)) {
      if (nowMs - raw.startedAtMs > MAX_MOVE_MARKER_AGE_MS) return false
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

export type MeasureDirectoryFn = (
  root: string,
  options?: MeasureDirectoryOptions,
) => Promise<{ totalBytes: number; totalFiles: number }>

export async function measureDirectoryBytes(
  root: string,
  options: MeasureDirectoryOptions = {},
): Promise<{ totalBytes: number; totalFiles: number }> {
  const { signal, onProgress } = options
  if (signal?.aborted) throw createScanAbortError()
  if (!root || !fs.existsSync(root)) return { totalBytes: 0, totalFiles: 0 }

  let totalBytes = 0
  let totalFiles = 0
  let lastProgressMs = 0

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
    } catch {
      return
    }
    if (signal?.aborted) throw createScanAbortError()

    const regularFiles: string[] = []
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
        regularFiles.push(full)
      } else if (entry.isDirectory()) {
        subdirs.push({ full, relPosix })
      } else {
        unknownEntries.push({ full, relPosix })
      }
    }

    if (regularFiles.length > 0) {
      await runWithConcurrency(regularFiles, FILE_STAT_CONCURRENCY, signal, async full => {
        try {
          const st = await fs.promises.lstat(full)
          if (!st.isSymbolicLink() && st.isFile()) {
            totalBytes += st.size
            totalFiles += 1
            maybeEmitProgress(false)
          }
        } catch {
          // Entry disappeared during scan.
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
            totalBytes += st.size
            totalFiles += 1
            maybeEmitProgress(false)
          }
        } catch {
          // Entry disappeared during scan.
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
  maybeEmitProgress(true)
  return { totalBytes, totalFiles }
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
  private readonly settled = new Map<string, { totalBytes: number; totalFiles: number }>()
  private readonly inFlight = new Map<
    string,
    {
      promise: Promise<{ totalBytes: number; totalFiles: number }>
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
  ): Promise<{ totalBytes: number; totalFiles: number }> {
    const { signal, onProgress, measureDirectory = measureDirectoryBytes } = options
    if (signal?.aborted) throw createScanAbortError()
    const resolvedRoot = path.resolve(root)
    const key = canonicalCacheKey(resolvedRoot)

    const cached = this.settled.get(key)
    if (cached) {
      onProgress?.(cached)
      return cached
    }

    let entry = this.inFlight.get(key)
    if (!entry) {
      const abortController = new AbortController()
      const listeners = new Set<(info: { totalBytes: number; totalFiles: number }) => void>()
      const created = {
        promise: Promise.resolve({ totalBytes: 0, totalFiles: 0 }),
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
        res => {
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

    return new Promise<{ totalBytes: number; totalFiles: number }>((resolve, reject) => {
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
  try {
    const cache = params.sizeCache ?? defaultDataLocationSizeCache
    const measured = await cache.measure(currentRoot, {
      signal: params.signal,
      onProgress: params.onScanProgress,
      measureDirectory: params.measureDirectory,
    })
    sourceBytes = measured.totalBytes
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

/** Stream-copy `sourceRoot` -> `targetRoot` with chunked cancellation, skipping runtime
 *  ephemerals and symlinks/junctions, then verify every copied file's existence and size
 *  plus PostgreSQL's `PG_VERSION` when a cluster is present. */
export async function copyDataRootWithVerify(
  sourceRoot: string,
  targetRoot: string,
  options: {
    signal?: AbortSignal
    onProgress?: (progress: DataLocationProgress) => void
  } = {},
): Promise<{ filesCopied: number; bytesCopied: number }> {
  const { signal, onProgress } = options
  const dirsToCreate: string[] = [targetRoot]
  const files: CopyManifestItem[] = []
  let totalBytes = 0

  if (fs.existsSync(sourceRoot)) {
    let lastScanEmitMs = Date.now()
    const maybeEmitScan = () => {
      if (!onProgress) return
      const now = Date.now()
      if (now - lastScanEmitMs < SCAN_PROGRESS_INTERVAL_MS) return
      lastScanEmitMs = now
      onProgress({
        phase: 'copying',
        filesCopied: 0,
        totalFiles: files.length,
        bytesCopied: 0,
        totalBytes,
        cancellable: true,
        detail: `Scanning files to copy… (${files.length.toLocaleString('en-US')} files, ${formatBytes(totalBytes)})`,
      })
    }
    const collect = async (dir: string, relPrefix: string): Promise<void> => {
      if (signal?.aborted) throw new Error('Data move cancelled')
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      const fileEntries: { fullSrc: string; fullDst: string; relPosix: string }[] = []
      const subdirs: { fullSrc: string; fullDst: string; relPosix: string }[] = []
      const unknownEntries: { fullSrc: string; fullDst: string; relPosix: string }[] = []

      for (const entry of entries) {
        const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        if (isEphemeralEntry(relPosix, entry.name)) continue
        if (entry.isSymbolicLink()) continue
        const fullSrc = path.join(dir, entry.name)
        const fullDst = path.join(targetRoot, ...relPosix.split('/'))
        if (entry.isFile()) {
          fileEntries.push({ fullSrc, fullDst, relPosix })
        } else if (entry.isDirectory()) {
          dirsToCreate.push(fullDst)
          subdirs.push({ fullSrc, fullDst, relPosix })
        } else {
          unknownEntries.push({ fullSrc, fullDst, relPosix })
        }
      }

      if (fileEntries.length > 0) {
        await runWithConcurrency(fileEntries, FILE_STAT_CONCURRENCY, signal, async item => {
          const st = await fs.promises.lstat(item.fullSrc)
          if (!st.isSymbolicLink() && st.isFile()) {
            files.push({
              relPosix: item.relPosix,
              sourcePath: item.fullSrc,
              targetPath: item.fullDst,
              size: st.size,
              mode: st.mode,
              mtimeMs: st.mtimeMs,
            })
            totalBytes += st.size
            maybeEmitScan()
          }
        })
      }

      if (unknownEntries.length > 0) {
        await runWithConcurrency(unknownEntries, FILE_STAT_CONCURRENCY, signal, async item => {
          const st = await fs.promises.lstat(item.fullSrc)
          if (isEntryReparsePoint(item.fullSrc, st)) return
          if (st.isDirectory()) {
            dirsToCreate.push(item.fullDst)
            subdirs.push(item)
          } else if (st.isFile()) {
            files.push({
              relPosix: item.relPosix,
              sourcePath: item.fullSrc,
              targetPath: item.fullDst,
              size: st.size,
              mode: st.mode,
              mtimeMs: st.mtimeMs,
            })
            totalBytes += st.size
            maybeEmitScan()
          }
        })
      }

      for (const sub of subdirs) {
        if (signal?.aborted) throw new Error('Data move cancelled')
        await collect(sub.fullSrc, sub.relPosix)
      }
    }
    try {
      await collect(sourceRoot, '')
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw new Error('Data move cancelled')
      throw err
    }
  }

  fs.mkdirSync(targetRoot, { recursive: true })
  await lockOwnerOnlyAcl(targetRoot, true)
  for (const dir of dirsToCreate) {
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
      totalFiles: files.length,
      bytesCopied,
      totalBytes,
      cancellable: true,
      detail: `${formatBytes(bytesCopied)} of ${formatBytes(totalBytes)} (${filesCopied} / ${files.length} files)`,
    })
  }
  emit(true)

  for (const item of files) {
    await copyFileCancellable(
      item.sourcePath,
      item.targetPath,
      item.mode,
      item.mtimeMs,
      signal,
      delta => {
        bytesCopied += delta
        emit(false)
      },
    )
    filesCopied += 1
    emit(false)
  }
  emit(true)

  if (signal?.aborted) throw new Error('Data move cancelled')
  onProgress?.({
    phase: 'verifying',
    filesCopied,
    totalFiles: files.length,
    bytesCopied,
    totalBytes,
    cancellable: true,
    detail: `Verifying ${files.length} copied files…`,
  })

  for (const item of files) {
    if (signal?.aborted) throw new Error('Data move cancelled')
    let dstStat: fs.Stats
    try {
      dstStat = await fs.promises.lstat(item.targetPath)
    } catch {
      throw new Error(`Copy verification failed: missing ${item.relPosix}`)
    }
    if (!dstStat.isFile() || dstStat.size !== item.size) {
      throw new Error(`Copy verification failed: size mismatch for ${item.relPosix} (expected ${item.size}, got ${dstStat.size})`)
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

  return { filesCopied, bytesCopied }
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
  startAndVerifyNewEngine: (newRoot: string) => Promise<void>
  restartOldEngineOnRollback: (oldRoot: string) => Promise<void>
}

/** Full guarded move orchestration:
 *  preflight -> stop old engine & verify lock release -> copy & verify ->
 *  stamp `.data-location-moved.json` -> switch `data-location.json` ->
 *  start & verify new engine -> optional old-folder cleanup (or full rollback on any error/cancel). */
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
    return { ok: false, error: preflight.error ?? 'Target folder failed preflight validation.' }
  }

  const oldRoot = path.resolve(currentRoot)
  const newRoot = path.resolve(preflight.resolvedRoot)
  const priorConfig = readDataLocationConfig(userData)
  const newExistedBefore = fs.existsSync(newRoot)
  let switchedConfig = false
  let verifiedNew = false

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
  try {
    emit('stopping', true, 'Stopping the local Orgtree engine…')
    const stopped = await params.stopOldEngine()
    if (!stopped) {
      throw new Error('Orgtree could not confirm that the engine stopped within its timeout. Your existing data folder was not changed.')
    }
    if (isRootLockHeld(oldRoot)) {
      throw new Error('The engine process exited, but a child process is still holding the current data folder lock.')
    }
    if (signal?.aborted) throw new Error('Data move cancelled')

    const copied = await copyDataRootWithVerify(oldRoot, newRoot, { signal, onProgress })
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

    emit('starting', false, 'Starting Orgtree on the new folder and verifying database relocation…', {
      filesCopied: copied.filesCopied,
      totalFiles: copied.filesCopied,
      bytesCopied: copied.bytesCopied,
      totalBytes: copied.bytesCopied,
    })
    await params.startAndVerifyNewEngine(newRoot)
    verifiedNew = true

    if (options.deletePrevious) {
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
          removeDirectoryTreeNoFollow(validOld.resolvedPrev)
        } catch {
          // If an external handle kept a file open, keep previousRoot in data-location.json so Settings offers Delete previous folder.
        }
      }
      if (!fs.existsSync(oldRoot)) {
        defaultDataLocationSizeCache.invalidate(oldRoot)
        await writeDataLocationConfig(userData, {
          version: 1,
          dataRoot: newRoot,
          movedAt,
        })
      }
    }
    defaultDataLocationSizeCache.invalidate(newRoot)

    emit('done', false, 'Move complete. Reopening Orgtree…', {
      filesCopied: copied.filesCopied,
      totalFiles: copied.filesCopied,
      bytesCopied: copied.bytesCopied,
      totalBytes: copied.bytesCopied,
    })
    return { ok: true, relaunching: true }
  } catch (err) {
    const cancelled = !!signal?.aborted || (err instanceof Error && err.message === 'Data move cancelled')
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
      try {
        if (!findReparseAncestor(newRoot)) {
          if (!newExistedBefore) {
            removeDirectoryTreeNoFollow(newRoot)
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
          }
        }
      } catch {
        // Best effort cleanup of partial target.
      }
      try {
        await params.restartOldEngineOnRollback(oldRoot)
      } catch {
        // Caller inspects engine status on reopen.
      }
      if (cancelled) return { ok: false, cancelled: true }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearMoveInProgressMarker(userData)
  }
}

export async function deletePreviousDataLocationFolder(params: {
  userData: string
  currentRoot: string
  forbiddenRoot?: string
  installDirectory?: string
  sizeCache?: DataLocationSizeCache
}): Promise<{ ok: boolean; error?: string }> {
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
  if (fs.existsSync(resolvedPrev)) {
    try {
      removeDirectoryTreeNoFollow(resolvedPrev)
    } catch (err) {
      return { ok: false, error: `Could not delete ${resolvedPrev}: ${(err as Error).message}` }
    }
  }
  if (fs.existsSync(resolvedPrev)) {
    return { ok: false, error: `Some files in ${resolvedPrev} could not be removed.` }
  }
  ;(params.sizeCache ?? defaultDataLocationSizeCache).invalidate(resolvedPrev)
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
  return { ok: true }
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
    return { ok: false, error: preflight.error ?? 'Target folder failed preflight validation.' }
  }

  const topology = await params.resolveMoveTopology()
  if (topology === 'unknown') {
    return {
      ok: false,
      error: params.unreadableTasksMessage ?? 'Scheduled tasks could not be verified.',
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
  const pct =
    progress.totalBytes > 0
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
    `<p>${escapeHtml(detail || 'Keep Orgtree open until this finishes. Your original data folder remains untouched until the new location starts cleanly.')}</p>` +
    '<div class="track"><div class="fill"></div></div>' +
    '<div class="row">' +
    `<span class="note">${progress.cancellable ? 'Safe to cancel — original folder is untouched.' : 'Finishing switch…'}</span>` +
    (progress.cancellable ? `<a class="btn" href="${DATA_MOVE_CANCEL_URL}">Cancel</a>` : '') +
    '</div>'
  )
}
