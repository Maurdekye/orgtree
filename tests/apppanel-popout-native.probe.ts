// A popped-out app panel fills its window, before and after the window is
// resized (user report 2026-10-26, "i popped the panel out and therss this
// empty space on the ritht side": the panel stopped about 80 px short of the
// window's right edge). jsdom has no layout, so this is measured in real
// windows: the REAL AppsWorkspace, mounted against a loopback stand-in for
// the apps API, popped out by its own "Open in new window" button through the
// product's window-open path (`configureWindow`, never a look-alike handler;
// see tests/popout-bounds.probe.ts for why), then measured against the window
// it got and photographed.
//
// Session 0 only (docs/agents/development-and-verification.md, test-window
// isolation): on Windows it refuses to start anywhere else. Every permission
// request is refused, both documents' clipboard paths are replaced with
// refusals, and the receipt records the session, the processes and every
// clipboard call. The only input is the panel's own button, clicked in its own
// window. No engine, no app data, no network beyond the loopback server.
//
//   node tools/test-apppanel-popout-native.mjs [--css-from <rev>] [--shots <dir>]
import { app, BrowserWindow, screen, session } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { configureWindow, popoutRegistry } from '../apps/desktop/main/windows'

const root = process.env.ORGTREE_APPPANEL_ROOT!
const shots = process.env.ORGTREE_APPPANEL_SHOTS || root
const label = process.env.ORGTREE_APPPANEL_LABEL || 'tip'

const sessionOf = (pid: number) => Number(execFileSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).SessionId`],
  { encoding: 'utf8', windowsHide: true }).trim())
const sessionId = process.platform === 'win32' ? sessionOf(process.pid) : null
if (sessionId !== null && sessionId !== 0) {
  console.error(`refusing to open windows outside Session 0 (this Electron runs in Session ${sessionId})`)
  app.exit(2)
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-apppanel-probe-')))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => { /* the probe decides when to exit */ })

const SLUG = 'demo'
// Full-bleed, with a stripe on its own right edge: where the stripe is, the
// panel ends. Anything to the right of it is window, not panel.
const HTML = '<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden;background:#1d3557;color:#f1faee;font:14px system-ui}'
  + '#edge{position:fixed;top:0;right:0;bottom:0;width:6px;background:#e63946}p{margin:12px}</style>'
  + '<p>Synthetic panel. The red stripe is its right edge.</p><div id="edge"></div>'
const APP = { id: 'synthetic-app', name: 'Synthetic placement', description: 'Probe app', rev: 1, permission_rev: 1,
  width: 720, height: 420, capabilities: [], permissions: {}, created_by: 'probe', updated_at: '',
  definition: { name: 'Synthetic placement', description: 'Probe app', html: HTML, initial_state: {}, capabilities: [], width: 720, height: 420 } }
const panel: Record<string, unknown> = { id: 'synthetic-panel', app: APP.id, label: 'Synthetic copy', rev: 1, open: true, running: true,
  run_generation: 1, state: {}, event_seq: 0, placement: { mode: 'float', x: 40, y: 40, width: 720, height: 420 }, used_at: '', updated_at: '' }

// Every page clipboard path refuses, and says so in the receipt.
const CLIPBOARD = `(() => {
  if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) })
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true
})()`

const MEASURE = `(() => {
  const box = selector => { const e = document.querySelector(selector); if (!e) return null
    const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
  const section = document.querySelector('.popout-mount section.custom-app-window[data-detached]')
  return { window: { width: innerWidth, height: innerHeight, client: document.documentElement.clientWidth },
    section: box('.popout-mount section.custom-app-window[data-detached]'), header: box('.popout-mount .custom-app-title'),
    frame: box('.popout-mount .custom-app-host iframe'), status: box('.popout-mount .custom-app-status'),
    maxWidth: section ? getComputedStyle(section).maxWidth : null, maxHeight: section ? getComputedStyle(section).maxHeight : null }
})()`
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
type Measured = { window: { width: number; height: number; client: number }; section: Box | null; header: Box | null; frame: Box | null; status: Box | null; maxWidth: string | null; maxHeight: string | null }

const calls: string[] = []
const permissions: string[] = []
const receipt: Record<string, unknown> = { label, electron: process.versions.electron, chrome: process.versions.chrome,
  electronPid: process.pid, sessionId, calls, permissions }
const writeReceipt = () => fs.writeFileSync(path.join(shots, `${label}-receipt.json`), JSON.stringify(receipt, null, 2))

function serve(request: http.IncomingMessage, response: http.ServerResponse, body: string) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const json = (value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
  }
  if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
    response.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' })
    response.end(fs.readFileSync(path.join(root, url.pathname.slice(1)))); return
  }
  if (url.pathname === `/o/${SLUG}`) {
    // the real index.html's head, with the bundle in place of /src/main.tsx
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>orgtree</title>'
      + '<link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
    return
  }
  const apps = `/api/orgs/${SLUG}/apps`
  const input = url.pathname === apps && request.method === 'GET'
    ? JSON.parse(url.searchParams.get('request') ?? '{}') : body ? JSON.parse(body) : {}
  calls.push(`${request.method} ${url.pathname} ${input.action ?? ''}`.trim())
  if (url.pathname === apps && request.method === 'GET') {
    if (input.action === 'list') return json(input.kind === 'apps'
      ? { kind: 'apps', items: [APP], next_cursor: null, new_count: 0 } : { kind: 'panels', items: [panel], next_cursor: null })
    if (input.action === 'app_get') return json(APP)
    if (input.action === 'panel_get') return json(panel)
    if (input.action === 'events') return json({ panel: panel.id, events: [], next_cursor: null, oldest_retained: null })
  }
  if (url.pathname === apps && request.method === 'POST' && input.action === 'panel_update') {
    for (const key of ['placement', 'open', 'label']) if (key in input) panel[key] = input[key]
    panel.rev = (panel.rev as number) + 1
    return json(panel)
  }
  if (url.pathname === `${apps}/runtime`) return json({ stop: [], sample_epoch: 0 })
  if (url.pathname === `${apps}/bridge` && input.action === 'session_close') return json({})
  json({ detail: 'not part of this probe' }, 404)
}

const js = <T>(window: BrowserWindow, code: string, gesture = false) => window.webContents.executeJavaScript(code, gesture) as Promise<T>
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(window: BrowserWindow, code: string, what: string, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await js(window, code)) return; await settle(50) }
  throw new Error(`timed out waiting for ${what}`)
}
/** Two frames and a beat, so the photograph shows the state just measured. */
const painted = (window: BrowserWindow) => js(window, `new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), 2000)
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(true) }, 150)))
})`)
async function photograph(window: BrowserWindow, name: string) {
  const file = path.join(shots, `${label}-${name}.png`)
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG())
  return file
}

/** The panel, its header, its frame and its status bar each reach every edge of the window. */
function fills(m: Measured, when: string) {
  assert.ok(m.section && m.header && m.frame && m.status, `${when}: the popped-out panel is laid out (${JSON.stringify(m)})`)
  const { width, height } = m.window
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  assert.ok(near(m.section!.left, 0) && near(m.section!.top, 0), `${when}: the panel starts at the window's corner`)
  assert.ok(near(m.section!.right, width),
    `${when}: the panel reaches the window's right edge (panel ${m.section!.right} px, window ${width} px, max-width ${m.maxWidth})`)
  assert.ok(near(m.section!.bottom, height), `${when}: the panel reaches the window's bottom (panel ${m.section!.bottom} px, window ${height} px)`)
  for (const part of ['header', 'frame', 'status'] as const) {
    assert.ok(near(m[part]!.right, width), `${when}: the ${part} reaches the window's right edge (${m[part]!.right} of ${width} px)`)
  }
}

async function main() {
  await app.whenReady()
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { permissions.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => { permissions.push('check:' + permission); return false })
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { try { serve(request, response, body) } catch (error) { response.writeHead(500); response.end(String(error)) } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const registry = popoutRegistry<BrowserWindow>(() => {})
  const opener = new BrowserWindow({ show: true, x: 0, y: 0, width: 1000, height: 700, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true } })
  configureWindow(opener, () => origin, true, undefined, undefined, undefined, registry.track)
  await opener.loadURL(`${origin}/o/${SLUG}`)
  await js(opener, CLIPBOARD)
  await until(opener, `!!document.querySelector('section.custom-app-window[data-custom-panel="synthetic-panel"] iframe')`, 'the panel in the main window')
  receipt.openerPid = opener.webContents.getOSProcessId()
  receipt.docked = await js(opener, `(() => { const r = document.querySelector('section.custom-app-window').getBoundingClientRect()
    return { width: r.width, height: r.height, centered: !!document.querySelector('.custom-app-centered section.custom-app-window') } })()`)

  // ---- pop it out with its own button, in its own window
  const created = new Promise<[BrowserWindow, string]>(resolve =>
    opener.webContents.once('did-create-window', (window, details) => resolve([window, details.frameName])))
  await js(opener, `document.querySelector('section.custom-app-window[data-custom-panel="synthetic-panel"] button[aria-label="Open in new window"]').click(); true`, true)
  const [child, frameName] = await created
  await js(child, CLIPBOARD)
  await until(child, `!!document.querySelector('.popout-mount section.custom-app-window[data-detached] iframe')
    && [...document.querySelectorAll('link[rel="stylesheet"]')].every(link => link.sheet)`, 'the panel in its own window, styled')
  assert.match(frameName, /^orgtree-popout-\d+$/, 'the panel opened its own named popout')
  assert.equal(registry.window(frameName), child, 'and the product tracks that window under its name')
  receipt.frameName = frameName
  receipt.childPid = child.webContents.getOSProcessId()
  receipt.childSessionId = process.platform === 'win32' ? sessionOf(receipt.childPid as number) : null

  await settle(400); await painted(child)
  const before = await js<Measured>(child, MEASURE)
  receipt.before = { ...before, native: child.getContentBounds(), shot: await photograph(child, 'popout-before') }

  // ---- resize the window, then measure again
  const area = screen.getDisplayMatching(child.getBounds()).workArea
  const width = before.window.width + 180 <= area.width ? before.window.width + 180 : before.window.width - 180
  const height = before.window.height + 100 <= area.height ? before.window.height + 100 : before.window.height - 100
  child.setContentSize(width, height)
  await until(child, `Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`, `the window to become ${width}x${height}`)
  await settle(200); await painted(child)
  const after = await js<Measured>(child, MEASURE)
  receipt.after = { ...after, native: child.getContentBounds(), shot: await photograph(child, 'popout-after-resize') }
  receipt.clipboard = { opener: await js(opener, 'window.__clipboardCalls'), child: await js(child, 'window.__clipboardCalls') }
  writeReceipt()

  assert.ok(Math.abs(after.window.width - before.window.width) >= 100, 'POSITIVE CONTROL: the resize really changed the window')
  fills(before, 'as popped out')
  fills(after, 'after a resize')
  assert.deepEqual(receipt.clipboard, { opener: [], child: [] }, 'nothing touched a clipboard')
  return `PASS a popped-out app panel fills its window: ${before.window.width}x${before.window.height}, then ${after.window.width}x${after.window.height} after a resize`
}

/** Never outlive the assertions: app.exit(), not app.quit(). */
const finish = (code: number) => {
  try { for (const window of BrowserWindow.getAllWindows()) window.destroy() } catch { /* already gone */ }
  app.exit(code)
}
const deadline = setTimeout(() => { console.error('app panel popout probe exceeded its own deadline'); writeReceipt(); finish(1) }, 60000)
main().then(
  message => { clearTimeout(deadline); console.log(message); finish(0) },
  error => { clearTimeout(deadline); receipt.error = String(error?.stack ?? error); writeReceipt(); console.error(error); finish(1) })
