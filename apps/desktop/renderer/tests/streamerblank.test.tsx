// Streamer mode must mask values, never the window (USER 2026-11-03 09:23:39Z
// m84db138f69e6 "streamer mode completely breaks the window, i cant see
// anything at all"; docket streamer-mode-blanks-the-whole-window-in-4-5-5-a).
// In 4.5.5-alpha.1 the canvas's full-viewport wire <canvas> and graph-sized
// edges <svg> were treated as opaque content and each got a fixed, topmost
// opaque cover; an unready or overflowing identity set hid every child of
// <body>; and a recovery holding page's native cover outlived its document.
// Each test below failed on 0c8a390.
import { JSDOM, flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installStreamerBoundary } from '../src/streamer-boundary'
import { sensitiveSpans } from '../../../../packages/contracts/streamer'
import { setNativeStreamer } from '../../main/streamer-native'
import { protectOpaqueDocument } from '../../main/streamer-opaque'
import { AccountsPanel } from '../src/canvas/accounts'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { startStreamerMode } from '../src/streamer'

function fixture(highlights = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  if (highlights) {
    Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
    Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...ranges: Range[]) { super(...ranges) } }, configurable: true })
  }
  return { dom, doc: dom.window.document, registry }
}

/** every stylesheet rule that hides an element outright and matches `el` */
function hidingRules(doc: Document, el: Element): string[] {
  const out: string[] = []
  for (const sheet of [...doc.styleSheets]) for (const rule of [...sheet.cssRules]) {
    if (!('selectorText' in rule)) continue
    const style = (rule as CSSStyleRule).style
    if (style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0') continue
    let hit = false
    try { hit = el.matches((rule as CSSStyleRule).selectorText) } catch { /* selector jsdom cannot parse */ }
    if (hit) out.push((rule as CSSStyleRule).selectorText)
  }
  return out
}

const CANVAS = '<main class="canvas-stage"><div class="viewport"><canvas class="glwires" aria-hidden="true"></canvas>'
  + '<svg class="edges" width="4000" height="3000"><path d="M0 0L10 10"></path></svg>'
  + '<div class="sq"><svg class="eye" viewBox="0 0 48 26"></svg><span class="name">Reviewer</span></div>'
  + '<div class="desk"><img class="toolimg" alt="tool result"></div></div></main>'

test('canvas graphics are app chrome: only content media get covers, inside their own stacking context', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc, () => {})
  doc.body.innerHTML = CANVAS
  try {
    boundary.update(true, ['Private Account'])
    await flush()
    const covers = [...doc.querySelectorAll<HTMLElement>('[data-streamer-cover]')]
    assert.equal(covers.length, 1, 'one cover: the tool-result image, not the wire canvas, edges or card icons')
    for (const sel of ['canvas.glwires', 'svg.edges', 'svg.eye', '.sq .name']) {
      assert.deepEqual(hidingRules(doc, doc.querySelector(sel)!), [], `${sel} stays visible`)
    }
    // The cover sits beside the image it hides, so app menus, settings and
    // modals stacked above that surface stay above its cover too.
    const img = doc.querySelector('img.toolimg')!
    assert.equal(covers[0]!.parentElement, img.parentElement)
    assert.equal(covers[0]!.parentElement === doc.body, false, 'never a topmost body-level layer')
    assert.equal(img.isConnected, true)
  } finally { boundary.dispose(); dom.window.close() }
})

test('unready identities, an overflowing identity set or a missing Highlight API never hide the window', async () => {
  for (const [label, highlights, ready] of [['identities not loaded', true, false], ['no Highlight API', false, true]] as const) {
    const { dom, doc, registry } = fixture(highlights)
    let turnedOff = 0
    const boundary = installStreamerBoundary(doc, () => { turnedOff++ })
    doc.body.innerHTML = '<div id="root"><nav class="shell-menu">Modes <button>Streamer mode</button></nav><p>Mail from reader@example.test</p></div>'
    try {
      boundary.update(true, ['Private Account'], ready)
      await flush()
      const root = doc.getElementById('root')!
      assert.deepEqual(hidingRules(doc, root), [], `${label}: the app stays on screen`)
      assert.deepEqual(hidingRules(doc, doc.querySelector('.shell-menu button')!), [], `${label}: the menu toggle stays on screen`)
      const off = [...doc.querySelectorAll<HTMLButtonElement>('[data-streamer-banner] button')]
      assert.equal(off.length, 1, `${label}: the banner keeps its Turn off control`)
      off[0]!.click(); assert.equal(turnedOff, 1)
      if (highlights) {
        const ranges = registry.get('streamer-sensitive') as unknown as Range[]
        assert.equal(ranges?.some(r => r.toString().includes('reader@example.test')), true, `${label}: values are still masked one by one`)
      }
    } finally { boundary.dispose(); dom.window.close() }
  }
})

test('a known identity too short to identify anyone never masks ordinary text', () => {
  const text = 'Reviewed. See the plan at step 2 — ab'
  assert.deepEqual(sensitiveSpans(text, ['.', 'ab', 'e']), [])
  assert.equal(sensitiveSpans('Private Account here', ['Private Account']).length, 1)
})

test('a recovery holding page cover ends when the window shows any other document', () => {
  class Contents extends EventEmitter {
    closed = false; isDestroyed() { return this.closed } close() { this.closed = true }
    setWindowOpenHandler() {} setAudioMuted() {} loadURL() { return Promise.resolve() }
  }
  class Cover { webContents = new Contents(); setBackgroundColor() {} setBounds() {} }
  class Window extends EventEmitter {
    webContents = new Contents()
    covers: Cover[] = []
    contentView = { addChildView: (v: Cover) => this.covers.push(v), removeChildView: (v: Cover) => { this.covers = this.covers.filter(c => c !== v) } }
    isDestroyed() { return false } getContentSize() { return [1000, 760] }
  }
  const win = new Window()
  setNativeStreamer(true)
  const stop = protectOpaqueDocument(win as never, () => new Cover() as never)
  try {
    assert.equal(win.covers.length, 1, 'the holding page is covered')
    win.webContents.emit('did-navigate', {}, 'data:text/html;charset=utf-8,holding')
    assert.equal(win.covers.length, 1, 'still the holding page')
    // reloaded by a path other than the recovery hook (main/index.ts engine restart)
    win.webContents.emit('did-navigate', {}, 'http://127.0.0.1:4410/o/fixture')
    assert.equal(win.covers.length, 0, 'the app document is never covered')
    setNativeStreamer(false); setNativeStreamer(true)
    assert.equal(win.covers.length, 0, 'turning streamer mode on later does not bring a whole-window cover back')
  } finally { stop(); setNativeStreamer(false) }
})

// ── App settings › Display carries both mode toggles (USER 2026-11-03 09:24:13Z
//    m6164da08f4fa "also put the toggles in the display tab of app settings")

const g = globalThis as unknown as Record<string, unknown>
const native = window as unknown as { orgtreeDesktop?: unknown }
function stubFetch(): void {
  g.fetch = (url: string, init?: RequestInit) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const payload = p === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
      : p === '/api/providers' ? { providers: [] }
        : p === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false }
          : p === '/api/app/records' ? { type: 'app_snapshot', epoch: 'e', seq: 1, registry: { type: 'registry_snapshot', epoch: 'e', cursor: { app_uuid: 't', incarnation: 'e', rev: 1 }, records: [] }, summaries: {}, notices: {}, runtime: { orgs: {}, values: {} } }
            : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${p}`))
    return Promise.resolve(new Response(JSON.stringify(payload)))
  }
}
function installBridge(t: TestContext) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES }
  const writes: Partial<NativePreferences>[] = []
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const broadcast = () => { for (const fn of [...listeners]) fn({ type: 'preferences', data: saved }) }
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => {
      writes.push(patch); saved = { ...saved, ...preferencesPatch(patch) }; broadcast(); return saved
    },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  /** another window (or App menu › Modes) changes the same preference */
  const elsewhere = (patch: Partial<NativePreferences>) => { saved = { ...saved, ...patch }; broadcast() }
  return { writes, elsewhere }
}

test('App settings › Display has Streamer mode and Attract mode toggles bound to the one shared preference', async (t) => {
  const { WebSocket } = g
  g.WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
  t.after(() => { g.WebSocket = WebSocket })
  const bridge = installBridge(t)
  stubFetch()
  const stop = startStreamerMode()
  t.after(() => { stop(); delete g.fetch })
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="display" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(10) })
  const host = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
  const row = (field: string) => host.querySelector<HTMLElement>(`[data-settings-field="${field}"]`)
  const box = (field: string) => row(field)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
  assert.equal(row('streamerMode') === null, false, 'Streamer mode row')
  assert.equal(row('attractMode') === null, false, 'Attract mode row')
  assert.equal(row('streamerMode')!.querySelector('.set-label')!.textContent, 'Streamer mode')
  assert.equal(row('attractMode')!.querySelector('.set-label')!.textContent, 'Attract mode')
  // the Display tab's existing toggle row, the same one every other switch uses
  assert.equal(row('streamerMode')!.classList.contains('set-row'), true)
  assert.equal(box('streamerMode')!.getAttribute('role'), 'switch')
  assert.deepEqual([box('streamerMode')!.checked, box('attractMode')!.checked], [false, false])

  await inAct(async () => { box('streamerMode')!.click(); await flush(8) })
  await inAct(async () => { box('attractMode')!.click(); await flush(8) })
  assert.deepEqual(bridge.writes, [{ streamerMode: true }, { attractMode: true }])
  assert.deepEqual([box('streamerMode')!.checked, box('attractMode')!.checked], [true, true])
  // with streamer mode on, its own switch stays on screen
  assert.deepEqual(hidingRules(document, row('streamerMode')!), [])

  await inAct(async () => { bridge.elsewhere({ streamerMode: false, attractMode: false }); await flush(8) })
  assert.deepEqual([box('streamerMode')!.checked, box('attractMode')!.checked], [false, false], 'follows the menu and other windows')
})
