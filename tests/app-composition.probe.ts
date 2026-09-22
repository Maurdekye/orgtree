/** Whole shipping renderer/main.tsx + production preload + native held-event
 * channels/registry/outbox/navigation/load recovery, in one Electron process.
 * Fixture-owned: window construction, IPC registration OTHER THAN held channels,
 * Preferences broadcasting, request-org/adopt glue, canned HTTP and test driver.
 * This does not execute main/index.ts startup, real engine, OS alerts or updater.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { registerHeldEventChannels } from '../apps/desktop/main/held-events'
import { orgWindowRegistry, resolveNativeSender, openOrg } from '../apps/desktop/main/org-windows'
import { windowOutbox } from '../apps/desktop/main/window-outbox'
import { attachWindowEventLifecycle } from '../apps/desktop/main/window-event-lifecycle'
import { attachWindowLoadRecovery } from '../apps/desktop/main/window-load-recovery'
import { configureWindow, popoutRegistry } from '../apps/desktop/main/windows'
import { Preferences } from '../apps/desktop/main/preferences'
import { runAttentionScenarios } from './app-attention-scenarios'
import { runMultiwindowScenarios } from './app-multiwindow-scenarios'

type Event = { type: string; data?: any }
type ApiHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean | Promise<boolean>
type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean
export interface AppWindow {
  id: string; window: BrowserWindow; documentToken: string
  outbox: ReturnType<typeof windowOutbox<Event>>
  navStarted: number; navCommitted: number; popouts: Map<string, BrowserWindow>
  recovery?: ReturnType<typeof attachWindowLoadRecovery>
  closePopouts?: () => void
}
export interface AppScenarioContext {
  create(id: string, org?: string): Promise<AppWindow>
  close(r: AppWindow): void
  check(id: string, ok: boolean, note: string, detail?: unknown): void
  eval<T = any>(r: AppWindow, js: string): Promise<T>
  until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms?: number): Promise<T>
  send(r: AppWindow, event: Event): void
  records: Map<string, AppWindow>
  origin: string
  routeApi(handler: ApiHandler): () => void
  routeUpgrade(handler: UpgradeHandler): () => void
}
const ROOT = process.env.PROBE_ROOT!
const control = process.env.PROBE_MODE ?? 'baseline'
const mode = control === 'no-compact-header' ? 'baseline' : control
const checks: { id: string; ok: boolean; note: string; detail?: unknown }[] = []
const log = (value: unknown) => fs.appendFileSync(path.join(ROOT, 'main.log'), String(value) + '\n')
const check: AppScenarioContext['check'] = (id, ok, note, detail) => {
  checks.push({ id, ok, note, detail }); log(JSON.stringify(checks.at(-1)))
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until: AppScenarioContext['until'] = async (read, accept, ms = 10000) => {
  const end = Date.now() + ms
  let value = await read()
  while (!accept(value) && Date.now() < end) { await pause(50); value = await read() }
  return value
}
const evaluate: AppScenarioContext['eval'] = (r, js) => r.window.webContents.executeJavaScript(js, true)
const nodes = ['agent', 'beta'].map(id => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  generation: 2, state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } }))
const orgs = ['studio', 'other'].map(slug => ({ slug, name: slug === 'studio' ? 'Studio' : 'Other', live: 2, working: 0, seats: 2 }))
const notice = (source_id: string, org = 'studio') => ({ id: `${org}-document-${source_id}`,
  source_id, org, kind: 'document', title: `Document ${source_id}`, body: 'Exact composition target' })
const notices = ['cold', 'bind', 'reload', 'retry', 'truncated', 'guard'].map(id => notice(id))
const documentRow = (id: string) => ({ id, node: 'agent', title: `Document ${id}`,
  at: '2026-09-22T07:00:00Z', node_state: 'live', evicted: false })
const tree = (slug: string) => ({ slug, name: orgs.find(o => o.slug === slug)?.name ?? slug, roots: nodes,
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, tiers: { haiku: 1 },
  audience_requests: [], credit_requests: [], cost_usd_total: 0,
  audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  epoch: 1, rev: 1, work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0,
  watchdogs: [], dirs: [] })

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
for (const key of ['userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps'] as const) {
  const dir = path.join(ROOT, 'electron-' + key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
}
app.whenReady().then(async () => {
  const requests: string[] = [], unexpected: string[] = []
  const routes: ApiHandler[] = []
  const upgrades: UpgradeHandler[] = []
  const routeApi = (handler: ApiHandler) => {
    routes.push(handler)
    return () => { const at = routes.lastIndexOf(handler); if (at >= 0) routes.splice(at, 1) }
  }
  const routeUpgrade = (handler: UpgradeHandler) => {
    upgrades.push(handler)
    return () => { const at = upgrades.lastIndexOf(handler); if (at >= 0) upgrades.splice(at, 1) }
  }
  let stallDocument = 0, failDocuments = false, truncateDocuments = false, rejectCreation = true
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture'), p = url.pathname
    requests.push(`${req.method} ${req.url}`)
    const json = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (p.startsWith('/api/')) {
      for (const handler of [...routes].reverse()) if (await handler(req, res, url)) return
      if (p === '/api/desktop/notifications') return json({ notices, total: notices.length, truncated: false, active: notices.map(n => ({ org: n.org, id: n.id })) })
      if (p === '/api/orgs' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += String(chunk)
        const form = JSON.parse(body)
        if (rejectCreation) return json({ detail: 'Fixture name conflict; choose another name and retry.' }, 409)
        orgs.push({ slug: 'created', name: form.name, live: 2, working: 0, seats: 2 })
        return json({ slug: 'created' })
      }
      if (p === '/api/orgs') return json(orgs)
      const t = /^\/api\/orgs\/([^/]+)$/.exec(p)
      if (t) return json(tree(t[1]!))
      const doc = /^\/api\/orgs\/[^/]+\/documents\/([^/]+)$/.exec(p)
      if (doc) return json({ ...documentRow(doc[1]!), body: `Visible exact document: ${doc[1]}.` })
      if (/\/documents$/.test(p)) return json({ documents: notices.map(n => documentRow(n.source_id)), total: notices.length, offset: 0, located: url.searchParams.get('locate') ?? '', next_offset: null })
      if (/\/work-items$/.test(p)) return json({ items: [], archived: [], backlogged: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
      if (/\/inbox$/.test(p)) return json({ pending: [], delivered: [], sent: [], history: [], messages: [], items: [], unread: 0 })
      if (/\/(work|items|asks|watchdogs|events|audiences|mail)$/.test(p)) return json([])
      if (p === '/api/providers') return json({ providers: [] })
      if (p === '/api/accounts') return json({ accounts: [] })
      if (p === '/api/host') return json({ hostname: 'composition-fixture', build: { commit: 'fixture', branch: 'fixture', started_at: '2026-09-22T00:00:00Z' }, tiers: { haiku: 1 }, dirs: [] })
      if (p === '/api/app-settings/runtime') return json({ quick_staff: false })
      if (/\/usage\/peek$/.test(p)) return json({ available: false })
      if (/\/staffing-options$/.test(p)) return json({ tiers: [], accounts: [], providers: [] })
      if (p === '/api/defaults') return json({})
      if (p === '/api/openrouter') return json({})
      // The multiwindow module installs its own synthetic socket upgrade route.
      if (/\/ws$/.test(p)) return json({ detail: 'WebSocket not provided by composition fixture' }, 503)
      if (/\/agents\//.test(p) || /\/nodes\//.test(p)) return json({ messages: [], turns: [], items: [], events: [] })
      if (/crash|client-log|freeze/.test(p)) return json({ ok: true })
      unexpected.push(req.url!); return json({})
    }
    if (p === '/' || p.startsWith('/o/') || p === '/not-an-app-path') {
      if (stallDocument) { const ms = stallDocument; stallDocument = 0; await pause(ms) }
      if (failDocuments) { req.socket.destroy(); return }
      if (truncateDocuments) {
        // Commit a real HTML response, then violate Content-Length before App
        // can mount. This is distinct from the pre-commit socket failure.
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': '1000000', 'cache-control': 'no-store' })
        res.write('<!doctype html><html><head><title>Incomplete response</title></head><body>Committed incomplete document')
        setTimeout(() => res.destroy(), 350)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(fs.readFileSync(path.join(ROOT, 'app.html'))); return
    }
    const filename = path.basename(p)
    if (filename === 'app.js' || filename === 'app.css' || /\.(woff2?|ttf|svg|png)$/.test(filename)) {
      const file = path.join(ROOT, filename)
      if (fs.existsSync(file)) { res.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); res.end(fs.readFileSync(file)); return }
    }
    res.writeHead(404); res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    for (const handler of [...upgrades].reverse()) if (handler(req, socket, head)) return
    socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const windows = orgWindowRegistry<BrowserWindow, Event>()
  const records = new Map<string, AppWindow>()
  const prefsFile = path.join(ROOT, 'data', 'preferences.json')
  const preferences = new Preferences(prefsFile)
  preferences.set({ notifyDocuments: true })
  const send = (r: AppWindow, event: Event) => {
    if (!r.window.isDestroyed() && r.outbox.offer(event)) r.window.webContents.send('desktop:event', event)
  }
  const broadcast = (event: Event) => { for (const r of records.values()) send(r, event) }
  const openOrgs = () => windows.list().filter(w => w.kind === 'org').map(w => w.org!)
  const publish = () => broadcast({ type: 'open-orgs', data: openOrgs() })
  let blockedReadiness = 0
  registerHeldEventChannels(mode === 'no-readiness' ? {
    on(channel, fn) { ipcMain.on(channel, (...args) => { if (channel === 'desktop:events-listening') { blockedReadiness++; return } fn(...args) }) },
    handle(channel, fn) { ipcMain.handle(channel, (...args) => { if (channel === 'desktop:take-pending-events') { blockedReadiness++; return [] } return fn(...args) }) },
  } : ipcMain, {
    origin: () => origin, registry: windows, record: id => records.get(id),
    token: r => r.documentToken, setToken: (r, token) => { r.documentToken = token },
    drain: r => r.outbox.drain(), send: (r, e) => { if (!r.window.isDestroyed()) r.window.webContents.send('desktop:event', e) },
  })
  const handle = (channel: string, fn: (r: AppWindow, ...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => {
    const entry = resolveNativeSender(event, windows, origin), r = records.get(entry.id)
    if (!r) throw Error('Missing fixture window record')
    return fn(r, ...args)
  })
  const close = (r: AppWindow) => { r.recovery?.dispose(); r.closePopouts?.(); if (!r.window.isDestroyed()) r.window.destroy(); records.delete(r.id); windows.forget(r.id) }
  const construct = (id: string, org?: string, kind: 'org' | 'homepage' | 'create' = org ? 'org' : 'homepage'): AppWindow => {
    const window = new BrowserWindow({ show: false, frame: false, width: 1180, height: 820,
      webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false,
        preload: path.join(ROOT, 'preload.cjs'), additionalArguments: ['--orgtree-ui-origin=' + origin] } })
    window.webContents.setBackgroundThrottling(false)
    const r: AppWindow = { id, window, documentToken: '', navStarted: 0, navCommitted: 0,
      popouts: new Map(), outbox: windowOutbox<Event>({ hold: t => ['open-org', 'notification-click', 'window-identity', 'restore-skipped'].includes(t) }) }
    records.set(id, r)
    windows.register({ id, senderId: window.webContents.id, window, kind, org })
    const popouts = popoutRegistry<BrowserWindow>(state => send(r, { type: 'popout-state', data: state }))
    configureWindow(window, () => origin, true, (child, portal) => { if (portal) child.webContents.setBackgroundThrottling(false) },
      () => { throw Error('Artifacts are outside fixture scope') }, () => { throw Error('External navigation is outside fixture scope') },
      (name, child) => { r.popouts.set(name, child); popouts.track(name, child); child.once('closed', () => r.popouts.delete(name)) })
    r.closePopouts = () => { for (const child of r.popouts.values()) if (!child.isDestroyed()) child.destroy() }
    const lifecycle = mode === 'no-lifecycle' ? { documentLost() {} } : attachWindowEventLifecycle(window.webContents, r, e => send(r, e))
    r.recovery = attachWindowLoadRecovery(window.webContents, {
      record: (...args) => log('recovery ' + id + ' ' + JSON.stringify(args)), target: () => origin,
      route: () => windows.identity(id)?.kind === 'org' ? '/o/' + windows.identity(id)!.org : '/',
      builtFor: () => origin, load: url => window.loadURL(url),
      showHolding: html => window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)),
      suspended: () => window.isDestroyed(), documentLost: lifecycle.documentLost,
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }, () => window.isDestroyed() ? '' : window.webContents.getURL())
    window.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { r.navStarted++; log(`start ${id} ${details.url.slice(0, 120)}`) } })
    window.webContents.on('did-navigate', (_event, url) => { r.navCommitted++; log(`commit ${id} ${url.slice(0, 120)}`) })
    window.webContents.on('did-finish-load', () => log(`finish ${id} ${window.webContents.getURL().slice(0, 120)} failed=${r.recovery?.isFailed}`))
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) log(`console ${id} ${level} ${message}`) })
    window.once('closed', () => { r.recovery?.dispose(); records.delete(id); windows.forget(id) })
    return r
  }
  const create = async (id: string, org?: string) => {
    const r = construct(id, org); await r.window.loadURL(origin + (org ? '/o/' + org : '/'))
    await until(() => evaluate<boolean>(r, '!!document.querySelector(".shell-header, .shell-menu")'), Boolean)
    return r
  }
  handle('desktop:window-identity', r => windows.identity(r.id))
  handle('desktop:open-create-window', async () => {
    const r = construct('create-' + records.size, undefined, 'create')
    await r.window.loadURL(origin + '/'); return windows.identity(r.id)
  })
  handle('desktop:bind-created-org', (r, org) => {
    const outcome = windows.bindCreated(r.id, org)
    if (outcome.action === 'bound') { send(r, { type: 'window-identity', data: windows.identity(r.id) }); publish() }
    return outcome
  })
  handle('desktop:request-org', async (r, org) => {
    const outcome = await openOrg(windows, org, r.id, {
      focus: entry => { entry.window.restore(); entry.window.focus() },
      create: async slug => { const c = construct('opened-' + records.size, slug); void c.window.loadURL(origin + '/o/' + slug); return { id: c.id, senderId: c.window.webContents.id, window: c.window } },
      discard: entry => { const c = records.get(entry.id); if (c) close(c) },
      deliverReveals: (entry, events) => { for (const event of events) send(records.get(entry.id)!, event) },
    })
    if (outcome.action === 'bound') { send(r, { type: 'window-identity', data: windows.identity(r.id) }); publish() }
    return outcome
  })
  handle('desktop:open-orgs', openOrgs)
  handle('desktop:preferences', () => preferences.get())
  handle('desktop:set-preferences', (_r, patch) => { const value = preferences.set(patch); broadcast({ type: 'preferences', data: value }); return value })
  handle('desktop:app-version', () => app.getVersion())
  handle('desktop:status', () => ({ state: 'running', origin }))
  handle('desktop:window-state', () => ({ maximized: false, fullscreen: false }))
  handle('desktop:window-controls-state', () => ({ maximized: false }))
  // Fixture-owned binding, same caller-scoped close operation as main/index.ts.
  handle('desktop:window-close', r => r.window.close())
  handle('desktop:update-status', () => ({ state: 'idle' }))
  handle('desktop:update-capability', () => ({ unattendedInstall: false, installDirectory: ROOT }))
  handle('desktop:maintenance-status', () => null)
  handle('desktop:harnesses', () => [])
  for (const channel of ['set-effective-theme', 'notify', 'sync-notifications', 'pending-attention']) handle('desktop:' + channel, () => false)
  handle('desktop:set-unsaved-creation', (r, dirty) => windows.setUnsavedCreation(r.id, dirty === true))
  handle('desktop:window-refresh', r => r.recovery?.isFailed ? r.recovery.retryNow('fixture user refresh') : r.window.webContents.reload())
  handle('desktop:popout-state', (r, name) => { const w = r.popouts.get(name); return { name, present: !!w && !w.isDestroyed(), maximized: !!w && !w.isDestroyed() && w.isMaximized() } })
  handle('desktop:popout-close', (r, name) => r.popouts.get(name)?.close())
  handle('desktop:popout-focus', (r, name) => { const w = r.popouts.get(name); w?.restore(); w?.focus() })
  const ctx: AppScenarioContext = { create, close, check, eval: evaluate, until, send, records, origin, routeApi, routeUpgrade }
  const visible = (r: AppWindow, id: string) => evaluate<any>(r, `(() => { const p=document.querySelector('.gallery-modal .mailer-read');return {doc:window.__APP_PROBE_DOC,path:location.pathname,galleries:document.querySelectorAll('.gallery-modal').length,visible:!!p&&p.getBoundingClientRect().width>0&&p.getBoundingClientRect().height>0&&getComputedStyle(p).visibility!=='hidden',text:p?.innerText||'',errors:window.__APP_PROBE_ERRORS,exact:!!p?.innerText.includes(${JSON.stringify('Visible exact document: ' + id + '.')})} })()`)
  const awaitVisible = (r: AppWindow, id: string, ms = 12000) => until(() => visible(r, id), v => v.exact && v.visible, ms)
  const click = async (r: AppWindow, selector: string) => evaluate(r, `(() => { const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.click();return true })()`)
  const screenshot = async (r: AppWindow, name: string) => {
    await evaluate(r, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(ROOT, name + '.png'), (await r.window.webContents.capturePage()).toPNG())
  }
  try {
    if (mode !== 'no-lifecycle') {
      const r = construct('cold', 'studio')
      send(r, { type: 'notification-click', data: notice('cold') })
      check('cold-held', r.outbox.holding() && r.outbox.pending() === 1, 'reveal queued before any document exists')
      await r.window.loadURL(origin + '/o/studio')
      const shown = await awaitVisible(r, 'cold', mode === 'baseline' ? 12000 : 3000)
      check('cold-visible-exact', shown.exact && shown.visible && shown.galleries === 1 && shown.path === '/o/studio', 'shipping App shows the exact held document in one visible Presentations pane', shown)
      check('cold-renderer-errors', shown.errors.length === 0, 'shipping App has no uncaught renderer errors', shown.errors)
      await screenshot(r, 'cold')
      if (mode === 'no-readiness') check('control-readiness-exercised', blockedReadiness > 0 && r.outbox.pending() === 1, 'both readiness paths blocked; held event is still pending', { blockedReadiness, pending: r.outbox.pending() })
      await evaluate(r, "localStorage.setItem('orgtree-desktop-last-org','studio');true")
      close(r)
    }
    if (mode === 'baseline') {
      // Persisted state from a DIFFERENT window must not seed this Homepage.
      const readsBeforeHome = requests.length
      const r = await create('homepage')
      const before = await evaluate<any>(r, '({doc:window.__APP_PROBE_DOC,path:location.pathname,home:!!document.querySelector(".shell-homepage"),savedOrg:localStorage.getItem("orgtree-desktop-last-org"),identity:window.orgtreeDesktop.windowIdentity})')
      check('homepage-ignores-saved-org', before.savedOrg === 'studio' && before.identity.kind === 'homepage' && before.path === '/' && !requests.slice(readsBeforeHome).includes('GET /api/orgs/studio'), 'fresh Homepage keeps native identity and root path despite another window saved organization; no stale org fetch', before)
      const commits = r.navCommitted
      await until(() => evaluate<boolean>(r, '!!document.querySelector(".shell-homepage-list .org")'), Boolean)
      await evaluate(r, `(() => {const row=[...document.querySelectorAll('.shell-homepage-list .org')].find(e=>e.textContent.includes('Studio'));if(!row)throw Error('Studio row missing');row.click();return true})()`)
      await until(async () => windows.identity(r.id)?.org, org => org === 'studio')
      send(r, { type: 'notification-click', data: notice('bind') })
      const shown = await awaitVisible(r, 'bind')
      check('homepage-bound-same-document', before.home && before.path === '/' && shown.doc === before.doc && commits === r.navCommitted && windows.identity(r.id)?.org === 'studio', 'actual Homepage row request binds native identity and real App routes without replacing the document', { before, shown, commitsBefore: commits, commitsAfter: r.navCommitted })
      check('homepage-visible-exact', shown.exact && shown.visible && shown.path === '/o/studio', 'bound App reveals exact document', shown)
      await screenshot(r, 'homepage-bound')
      const home = await create('existing-home')
      const homeBefore = await evaluate<string>(home, 'window.__APP_PROBE_DOC')
      await until(() => evaluate<boolean>(home, '!!document.querySelector(".shell-homepage-list .org")'), Boolean)
      await evaluate(home, `([...document.querySelectorAll('.shell-homepage-list .org')].find(e=>e.textContent.includes('Studio')).click(),true)`)
      await until(() => evaluate<string>(home, 'document.body.innerText'), text => text.includes('already open'))
      check('homepage-existing-org', windows.identity(home.id)?.kind === 'homepage' && windows.byOrg('studio')?.id === r.id && await evaluate(home, 'location.pathname') === '/' && await evaluate(home, 'window.__APP_PROBE_DOC') === homeBefore, 'selecting already-open org retains separate Homepage document and existing org window')
      close(home); close(r)

      const a = await create('settings-a', 'studio'), b = await create('settings-b', 'other')
      const header = () => evaluate<any>(a, `({width:innerWidth,actions:[...document.querySelectorAll('.shell-header-actions button')].map(e=>({label:e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent.trim(),width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})),modes:[...document.querySelectorAll('.shell-mode')].map(e=>({text:e.textContent.trim(),width:e.getBoundingClientRect().width})),controls:[...document.querySelectorAll('.shell-header .window-control')].map(e=>({label:e.getAttribute('aria-label'),right:e.getBoundingClientRect().right})),actionRight:document.querySelector('.shell-header-actions').getBoundingClientRect().right,controlLeft:document.querySelector('.shell-header > .window-controls').getBoundingClientRect().left,titleWidth:document.querySelector('.shell-header-title').getBoundingClientRect().width,drawnActionLabels:[...document.querySelectorAll('.shell-action-label')].filter(e=>e.getBoundingClientRect().width>0).length})`)
      const noOverlap = (s: any) => s.actionRight <= s.controlLeft && s.titleWidth > 0
        && s.actions.every((e: any) => e.width === 0 || e.right <= s.controlLeft)
        && ['work docket', 'your inbox', 'Presentations', 'Usage', 'Org settings'].every(label => s.actions.some((e: any) => e.label === label && e.width > 0 && e.right <= s.controlLeft))
        && s.modes.length === 2 && s.modes.every((e: any) => e.text && e.width > 0)
        && s.controls.length === 4 && s.controls.every((e: any) => e.label && e.right <= s.width)
      const wide = await header()
      check('wide-header', wide.width === 1180 && noOverlap(wide) && wide.drawnActionLabels === 5, 'real wide App header displays action labels without overlapping native controls', wide)
      a.window.setSize(640, 820)
      await until(() => evaluate<boolean>(a, 'innerWidth === 640 && [...document.querySelectorAll(".shell-action-label")].every(e=>getComputedStyle(e).display==="none")'), Boolean)
      const narrow = await header()
      check('narrow-header', narrow.width === 640 && noOverlap(narrow) && narrow.drawnActionLabels === 0, 'real frameless App at native640px minimum retains named actions, org title and mode labels without overlapping native controls', narrow)
      await screenshot(a, 'narrow-header')
      await click(a, '.shell-header-actions .kill-latch')
      await until(() => evaluate<boolean>(a, '(document.querySelector(".shell-header-actions .kill-btn.expanded:not(:disabled)")?.getBoundingClientRect().width ?? 0) >= 100'), Boolean)
      const armed = await header()
      check('narrow-header-armed', noOverlap(armed) && armed.actions.some((e: any) => e.label === 'halt every agent in this org until explicit release' && e.width >= 100), 'expanded kill switch remains reachable with org identity, modes, actions and native controls at640px', armed)
      await screenshot(a, 'narrow-header-armed')
      await click(a, '.shell-header-actions .kill-latch')
      const stopHalted = routeApi((req, res, url) => {
        if (req.method !== 'GET' || url.pathname !== '/api/orgs/studio') return false
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ...tree('studio'), killswitch: true })); return true
      })
      const releaseVisible = await until(() => evaluate<boolean>(a, '(document.querySelector(".shell-header-actions .kill-release")?.getBoundingClientRect().width ?? 0) >= 100'), Boolean)
      const halted = await header()
      check('narrow-header-halted', releaseVisible && noOverlap(halted), 'actual halted-tree state keeps the full release control and all header controls reachable at640px', halted)
      await screenshot(a, 'narrow-header-halted')
      stopHalted()
      await until(() => evaluate<boolean>(a, '!!document.querySelector(".shell-header-actions .kill-latch")'), Boolean)
      await evaluate(a, `document.querySelector('.shell-menu-button').focus();true`)
      a.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      a.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      const focusedMenu = await until(() => evaluate<boolean>(a, 'document.activeElement?.getAttribute("role")==="menuitem"'), Boolean)
      a.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      a.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      const returnedMenuFocus = await until(() => evaluate<boolean>(a, 'document.activeElement?.classList.contains("shell-menu-button") && !document.querySelector("[role=menu]")'), Boolean)
      check('shell-menu-keyboard', focusedMenu && returnedMenuFocus, 'real Chromium ArrowDown enters App menu; Escape closes it and returns focus')
      a.window.setSize(1180, 820)
      const settingsOpen = (r: AppWindow) => evaluate<boolean>(r, '(()=>{const p=document.querySelector(".acct-panel");return !!p&&p.getBoundingClientRect().width>0&&p.getBoundingClientRect().height>0&&getComputedStyle(p).visibility!=="hidden"})()')
      const openSettings = async (r: AppWindow) => { await click(r, '.shell-menu-button'); await until(() => evaluate<boolean>(r, '!!document.querySelector("[role=menu]")'), Boolean); await evaluate(r, `([...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('App settings')).click(),true)`); await until(() => settingsOpen(r), Boolean) }
      await openSettings(a)
      check('settings-local-open', await settingsOpen(a) && !await settingsOpen(b), 'opening settings in first App does not open it in second')
      await openSettings(b)
      check('settings-concurrent', await settingsOpen(a) && await settingsOpen(b) && !a.window.isDestroyed() && !b.window.isDestroyed(), 'two real BrowserWindows have App settings open concurrently')
      await click(a, 'input[name="orgtree-startup"][value="homepage"]')
      const selected = (r: AppWindow) => evaluate<string>(r, 'document.querySelector("input[name=orgtree-startup]:checked")?.value')
      await until(() => selected(b), v => v === 'homepage')
      check('settings-a-to-b', await selected(a) === 'homepage' && await selected(b) === 'homepage' && new Preferences(prefsFile).get().startupMode === 'homepage', 'first window edit updates second and is persisted by production Preferences')
      await click(b, 'input[name="orgtree-startup"][value="restore"]')
      await until(() => selected(a), v => v === 'restore')
      check('settings-b-to-a', await selected(a) === 'restore' && await selected(b) === 'restore' && new Preferences(prefsFile).get().startupMode === 'restore', 'second window edit updates first and persisted shared value')
      await screenshot(a, 'settings-a'); await screenshot(b, 'settings-b')
      await evaluate(a, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true")
      await until(() => settingsOpen(a), v => !v)
      check('settings-local-close', !await settingsOpen(a) && await settingsOpen(b), 'closing first settings leaves second settings open')
      close(a); close(b)

      // Real App creation form and real native dirty/bind registry. The host
      // does not open OS confirmation dialogs; beginClose/settleClose below
      // establish registry cancellation only, never native-dialog appearance.
      const homeCreate = await create('create-home')
      await click(homeCreate, '.shell-create-btn')
      const c = await until(async () => [...records.values()].find(r => windows.identity(r.id)?.kind === 'create'), Boolean)
      if (!c) throw Error('Create action did not construct separate window')
      await until(() => evaluate<boolean>(c, '!!document.querySelector("#shell-create-name")'), Boolean)
      const createBefore = await evaluate<any>(c, '({doc:window.__APP_PROBE_DOC,path:location.pathname,name:document.querySelector("#shell-create-name").value,savedOrg:localStorage.getItem("orgtree-desktop-last-org"),identity:window.orgtreeDesktop.windowIdentity})')
      check('create-blank-separate', createBefore.name === '' && createBefore.path === '/' && createBefore.savedOrg === 'studio' && createBefore.identity.kind === 'create' && windows.identity(homeCreate.id)?.kind === 'homepage', 'real Homepage Create action opens separate blank Create document despite saved org state', createBefore)
      await evaluate(c, `(() => { const e=document.querySelector('#shell-create-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Fixture organization');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
      await until(async () => windows.get(c.id)?.unsavedCreation, Boolean)
      check('create-dirty-published', windows.get(c.id)?.unsavedCreation === true, 'real form input publishes dirty state through production preload to native registry')
      const decision = windows.beginClose(c.id); windows.settleClose(c.id, false)
      check('create-cancel-registry', decision === 'confirm' && windows.get(c.id)?.unsavedCreation === true && await evaluate(c, 'document.querySelector("#shell-create-name").value') === 'Fixture organization', 'native registry cancellation preserves entered form and dirty state; no OS dialog is claimed')
      await click(c, '.shell-create-actions button[type="submit"]')
      const error = await until(() => evaluate<string>(c, 'document.querySelector(".shell-create-error")?.innerText||""'), Boolean)
      check('create-failure-preserves', error.includes('Fixture name conflict') && windows.identity(c.id)?.kind === 'create' && windows.get(c.id)?.unsavedCreation === true && await evaluate(c, 'document.querySelector("#shell-create-name").value') === 'Fixture organization', 'failed real create request displays actionable error and preserves context', { error })
      rejectCreation = false
      await click(c, '.shell-create-actions button[type="submit"]')
      await until(async () => windows.identity(c.id)?.org, org => org === 'created')
      await until(() => evaluate<string>(c, 'location.pathname'), p => p === '/o/created')
      check('create-success-binds', windows.identity(c.id)?.kind === 'org' && windows.identity(c.id)?.org === 'created' && windows.get(c.id)?.unsavedCreation === false && await evaluate(c, 'window.__APP_PROBE_DOC') === createBefore.doc && await evaluate(c, '!!document.querySelector(".shell-mode")'), 'success binds same Create window/document into new org Canvas and clears dirty state')
      await screenshot(c, 'created'); close(c); close(homeCreate)

      // Preserve production sender/token comparisons rather than replacing
      // them with fixture callbacks that accept every window.
      const holder = await create('guard-holder', 'studio')
      const ownToken = holder.documentToken
      holder.outbox.rearm(); holder.documentToken = 'superseding-document-token'
      send(holder, { type: 'notification-click', data: notice('guard') })
      const other = await create('guard-other', 'other')
      check('guard-other-window', !!ownToken && !!other.documentToken && ownToken !== other.documentToken && holder.outbox.holding() && holder.outbox.pending() === 1, 'another registered App window readiness cannot release holder queue')
      await evaluate(holder, 'window.orgtreeDesktop.onEvent(()=>{});window.orgtreeDesktop.takePendingWindowEvents()')
      await pause(150)
      check('guard-stale-document', holder.outbox.holding() && holder.outbox.pending() === 1 && !(await visible(holder, 'guard')).exact, 'same window stale preload token cannot acknowledge or take reveal')
      holder.documentToken = ownToken
      await evaluate(holder, 'window.orgtreeDesktop.onEvent(()=>{});true')
      const revealed = await awaitVisible(holder, 'guard')
      check('guard-current-visible', revealed.exact && revealed.visible && holder.outbox.pending() === 0 && !(await visible(other, 'guard')).exact, 'current holder acknowledgment reveals exact document only in its App')
      close(holder); close(other)
      const outside = construct('outside')
      await outside.window.loadURL(origin + '/not-an-app-path')
      check('guard-outside-path', await evaluate(outside, 'typeof window.orgtreeDesktop') === 'undefined', 'production preload exposes no native bridge outside admitted App routes')
      close(outside)
    }
    if (mode === 'baseline' || mode === 'no-lifecycle') {
      const r = await create('reload', 'studio')
      const before = await evaluate<string>(r, 'window.__APP_PROBE_DOC')
      const started = r.navStarted, committed = r.navCommitted
      stallDocument = 1600; r.window.webContents.reload()
      await until(async () => r.navStarted, n => n > started)
      send(r, { type: 'notification-click', data: notice('reload') })
      check('reload-provisional', r.navStarted > started && r.navCommitted === committed, 'reveal sent after real navigation start and before real commit', { started: r.navStarted - started, committed: r.navCommitted - committed })
      const queued = r.outbox.pending()
      const shown = await awaitVisible(r, 'reload', mode === 'baseline' ? 12000 : 5000)
      check('reload-visible-exact', shown.doc !== before && shown.exact && shown.visible && shown.path === '/o/studio', 'new shipping App document displays exact reveal sent during reload', { before, queued, shown })
      await screenshot(r, 'reload'); close(r)
    }
    if (mode === 'baseline') {
      const r = await create('retry', 'studio')
      const before = await evaluate<string>(r, 'window.__APP_PROBE_DOC')
      failDocuments = true; r.window.webContents.reload()
      await until(async () => r.recovery?.isFailed, Boolean)
      await until(() => evaluate<boolean>(r, `location.protocol === 'data:' && document.readyState === 'complete' && !!document.querySelector('[aria-label="Refresh app view"]')`).catch(() => false), Boolean)
      send(r, { type: 'notification-click', data: notice('retry') })
      check('retry-held-on-failure', r.recovery?.isFailed === true && r.outbox.pending() === 1, 'failed load enters production recovery and keeps targeted reveal', { pending: r.outbox.pending(), url: r.window.webContents.getURL().slice(0, 60) })
      await screenshot(r, 'terminal-holding')
      failDocuments = false
      await evaluate(r, "document.querySelector('[aria-label=\"Refresh app view\"]').click();true")
      const shown = await awaitVisible(r, 'retry')
      check('retry-visible-exact', shown.doc !== before && shown.exact && shown.visible && shown.path === '/o/studio', 'production holding-page Refresh retries bound route and exact target is visible in new App', shown)
      await screenshot(r, 'retry'); close(r)
      const truncated = await create('truncated', 'studio')
      const previousDoc = await evaluate<string>(truncated, 'window.__APP_PROBE_DOC')
      const previousCommits = truncated.navCommitted
      truncateDocuments = true; truncated.window.webContents.reload()
      await until(async () => truncated.navCommitted, n => n > previousCommits)
      send(truncated, { type: 'notification-click', data: notice('truncated') })
      check('truncated-committed', truncated.navCommitted > previousCommits && truncated.outbox.pending() === 1, 'real incomplete HTML response commits before terminal failure, with exact reveal held', { before: previousCommits, after: truncated.navCommitted, queued: truncated.outbox.pending() })
      const holding = await until(async () => ({ failed: truncated.recovery?.isFailed === true,
        ready: await evaluate<boolean>(truncated, `location.protocol === 'data:' && document.readyState === 'complete' && !!document.querySelector('[aria-label="Refresh app view"]')`).catch(() => false) }), s => s.failed && s.ready, 5000)
      check('truncated-holding', holding.failed && holding.ready && truncated.outbox.pending() === 1, 'committed-body truncation reaches production holding page and retains reveal', holding)
      await screenshot(truncated, 'truncated-holding')
      truncateDocuments = false
      if (holding.failed && holding.ready) {
        await evaluate(truncated, `document.querySelector('[aria-label="Refresh app view"]').click();true`)
        const target = await awaitVisible(truncated, 'truncated')
        check('truncated-visible-exact', target.doc !== previousDoc && target.exact && target.visible && target.path === '/o/studio', 'Refresh after committed-body truncation opens exact document in the recovered App', target)
        await screenshot(truncated, 'truncated-recovered')
      } else check('truncated-visible-exact', false, 'recovery cannot reveal exact target without its holding page', holding)
      close(truncated)
      await runAttentionScenarios(ctx)
      await runMultiwindowScenarios(ctx)
    }
  } catch (error) { check('fatal', false, 'fixture could not complete', String((error as Error).stack ?? error)) }
  finally {
    for (const r of records.values()) close(r)
    server.close()
    fs.writeFileSync(path.join(ROOT, 'http.json'), JSON.stringify({ requests, unexpected }, null, 2))
    const report = { mode: control, summary: { assertions: checks.length, failing: checks.filter(c => !c.ok).length }, checks,
      limits: ['main/index.ts startup/IPC glue is not executed; fixture-owned bindings are described in source header', 'canned loopback HTTP and synthetic WebSocket frames; no real engine, OS notification service, install or updater', 'main BrowserWindows are offscreen; screenshots and DOM geometry assert rendered visibility', 'Create close cancellation is a native registry decision; no OS confirmation dialog is shown', 'App, preload, Preferences, held-event registration, registry/outbox and lifecycle modules are production code; controls explicitly remove the named mechanism'] }
    fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify(report, null, 2))
    app.exit(report.summary.failing ? 1 : 0)
  }
}).catch(error => { log(String(error.stack ?? error)); app.exit(2) })
