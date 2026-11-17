// shader-warmup-window.ts - the Electron side of main/shader-warmup.ts: the never-shown offscreen
// window, its own session that serves only the UI's files, and the skip marker.
// Kept apart from index.ts so the main-process edit there is one call.
import { app, BrowserWindow, powerMonitor, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ShaderWarmup, WARMUP_DEFAULTS, WARMUP_MARKER, WARMUP_ORIGIN, WARMUP_PATH, WARMUP_TYPES as TYPES, WARMUP_WINDOW_OPTIONS, warmupFile, type WarmupOptions, type WarmupOutcome } from './shader-warmup'

// ⚠ "persist:" IS REQUIRED. Chromium never writes shaders compiled for an off-the-record (in-memory)
// session to GrShaderCache: measured 2026-11-16, an in-memory warm-up left the next launch compiling
// 50 of 51 shaders again (longest flush 398 ms); a persistent partition left 6 (40 ms). The partition
// only ever holds the synthetic scene, and its storage is cleared after each run.
const PARTITION = 'persist:orgtree-shader-warmup'

let sessionReady = false
function warmupSession(uiDirectory: string): Electron.Session {
  const ses = session.fromPartition(PARTITION, { cache: false })
  if (sessionReady) return ses
  sessionReady = true
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false))   // clipboard, media, notifications: all refused
  ses.setPermissionCheckHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  // the UI's own files and nothing else: no engine, no network
  ses.webRequest.onBeforeRequest((details, done) => done({ cancel: !(details.url.startsWith(WARMUP_ORIGIN + '/') || details.url.startsWith('data:') || details.url.startsWith('blob:')) }))
  ses.protocol.handle('https', async request => {
    const file = warmupFile(uiDirectory, request.url)
    if (!file) return new Response(null, { status: 404 })
    try { return new Response(await fs.promises.readFile(file), { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] } }) }
    catch { return new Response(null, { status: 404 }) }
  })
  return ses
}

/** Start the warm-up (once per launch). Off with ORGTREE_SHADER_WARMUP=0; skipped when the GPU does not raster. */
export function startShaderWarmup(o: { uiDirectory: string; log: (line: Record<string, unknown>) => void; options?: WarmupOptions }): ShaderWarmup | null {
  if (process.env.ORGTREE_SHADER_WARMUP === '0') return null
  const userData = app.getPath('userData')
  const warmup = new ShaderWarmup({
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    gpuRasters: () => {
      const status = app.getGPUFeatureStatus()
      return String(status.gpu_compositing).startsWith('enabled') && String(status.rasterization).startsWith('enabled')
    },
    keyParts: async () => {
      const info = await app.getGPUInfo('basic') as { gpuDevice?: { vendorId?: number; deviceId?: number; driverVersion?: string; active?: boolean }[] }
      const gpu = info.gpuDevice?.find(d => d.active) ?? info.gpuDevice?.[0]
      return { app: app.getVersion(), chrome: process.versions.chrome, vendor: gpu?.vendorId, device: gpu?.deviceId, driver: gpu?.driverVersion }
    },
    readMarker: () => fs.promises.readFile(path.join(userData, WARMUP_MARKER), 'utf8').catch(() => null),
    writeMarker: text => fs.promises.writeFile(path.join(userData, WARMUP_MARKER), text),
    cacheInfo: async () => {
      const dir = path.join(userData, 'GrShaderCache')
      const st = await fs.promises.stat(dir).catch(() => null)
      if (!st?.isDirectory()) return null
      let bytes = 0
      for (const f of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (f.isFile()) bytes += (await fs.promises.stat(path.join(dir, f.name)).catch(() => null))?.size ?? 0
      }
      return { birth: Math.round(st.birthtimeMs), bytes }
    },
    createWindow: () => {
      const win = new BrowserWindow({ ...WARMUP_WINDOW_OPTIONS, webPreferences: { ...WARMUP_WINDOW_OPTIONS.webPreferences, session: warmupSession(o.uiDirectory) } })
      win.webContents.setAudioMuted(true)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())
      return {
        loadURL: url => win.loadURL(url),
        onTitle: fn => win.webContents.on('page-title-updated', (_e, title) => fn(title)),
        onGone: fn => { win.webContents.on('render-process-gone', fn); win.on('closed', fn) },
        destroy: () => {
          const ses = win.webContents.session
          win.destroy()
          // nothing of the synthetic scene stays (localStorage, IndexedDB, service workers); the shader cache is not here
          void ses.clearStorageData().catch(() => {})
        },
        isDestroyed: () => win.isDestroyed(),
      }
    },
    url: WARMUP_ORIGIN + WARMUP_PATH,
    log: o.log,
  }, o.options ?? WARMUP_DEFAULTS)
  void warmup.start()
  app.once('will-quit', () => warmup.stop())
  return warmup
}

export type { WarmupOutcome }
