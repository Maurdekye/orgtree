import { flush, inAct, JSDOM, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DocReader, presentationDocument } from '../src/canvas/docs'
import { PANEL_PROTOCOL, panelDocument } from '../src/canvas/apps/sdk'
import { PanelHtml } from '../src/canvas/apps/host'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import type { CustomApp, CustomPanel } from '../src/canvas/apps/types'

// HTML presentations and app panels get Orgtree's current colors (USER
// 2026-10-27 m4e1fae02a0ca "feed the current theme coloring into html
// presentations and apps"; m164909566caf "both the main visual theme color and
// the contrast theme colors"). Pages read --orgtree-* CSS variables; a theme
// switch restyles an open page without reloading it. The frames' own scripts
// run here in standalone jsdom windows; the app's real stylesheet supplies
// every color, so the expectations are the colors Orgtree itself paints.

declare const __SRC_DIR__: string
const appSheet = document.createElement('style')
appSheet.textContent = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/^@import[^;]*;/m, '')
document.head.appendChild(appSheet)

type Theme = { colorScheme: 'dark' | 'light'; colors: Record<string, string> }
const CHARCOAL_CLAUDE: Theme = { colorScheme: 'dark', colors: {
  accent: '#d97757', accentHover: '#e99b81', accentSoft: 'rgba(217, 119, 87, 0.16)', accentText: '#17191d',
  bg: '#1f1f1f', sidebar: '#181818', card: '#252526', hover: '#2d2d30', input: '#313131',
  text: '#cccccc', textStrong: '#e8e8e8', textDim: '#9d9d9d', border: '#3c3c3c', borderSoft: '#2b2b2b',
  success: '#6fd377', danger: '#f14c4c', warning: '#e5c07b' } }
// Light contrast deepens the Claude accent to its light partner (styles.css).
const LIGHT_CLAUDE: Theme = { colorScheme: 'light', colors: {
  accent: '#89391f', accentHover: '#672b17', accentSoft: 'rgba(137, 57, 31, 0.16)', accentText: '#ffffff',
  bg: '#f6f7f9', sidebar: '#eceff3', card: '#ffffff', hover: '#e8ebef', input: '#ffffff',
  text: '#2d333b', textStrong: '#161b22', textDim: '#57606a', border: '#c5ccd4', borderSoft: '#dce1e7',
  success: '#23722d', danger: '#bf2929', warning: '#805b0b' } }
/** The public names pages use. */
const VARS: Record<string, string> = {
  accent: '--orgtree-accent', accentHover: '--orgtree-accent-hover', accentSoft: '--orgtree-accent-soft',
  accentText: '--orgtree-accent-text', bg: '--orgtree-bg', sidebar: '--orgtree-sidebar', card: '--orgtree-card',
  hover: '--orgtree-hover', input: '--orgtree-input', text: '--orgtree-text', textStrong: '--orgtree-text-strong',
  textDim: '--orgtree-text-dim', border: '--orgtree-border', borderSoft: '--orgtree-border-soft',
  success: '--orgtree-success', danger: '--orgtree-danger', warning: '--orgtree-warning',
}

function look(contrast: 'charcoal' | 'light', theme = 'claude') { applyContrast(contrast); applyTheme(theme) }

type FrameWindow = Window & { orgtree?: { theme?: { get(): Theme; onChange(fn: (t: Theme) => void): () => void } } }
/** Runs a frame document the way its sandboxed frame does: its own scripts, its own window. */
function runFrame(doc: string, t: { after: (fn: () => void) => void }, beforeParse?: (w: FrameWindow) => void) {
  const dom = new JSDOM(doc, { runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse: beforeParse as unknown as ((w: unknown) => void) | undefined })
  const w = dom.window as unknown as FrameWindow
  t.after(() => dom.window.close())
  const read = (name: string) => w.getComputedStyle(w.document.documentElement).getPropertyValue(name).trim()
  return { w, read }
}
// jsdom drops the spaces in a custom property's rgba() (Chromium keeps them);
// the exact sheet text is pinned by the posted-message and host checks.
const tight = (value: string | undefined) => (value ?? '').replace(/\s+/g, '')
function assertColors(read: (name: string) => string, theme: Theme, label: string, except: string[] = []) {
  for (const [name, property] of Object.entries(VARS)) {
    if (!except.includes(name)) assert.equal(tight(read(property)), tight(theme.colors[name]), `${label}: ${property}`)
  }
  assert.equal(read('--orgtree-color-scheme'), theme.colorScheme, `${label}: --orgtree-color-scheme`)
}
const fromParent = (w: FrameWindow, data: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data, source: w }))

test('an HTML presentation starts with Orgtree\'s colors as --orgtree-* variables the page may use or override', (t) => {
  look('charcoal')
  const author = '<!doctype html><html><head><style>:root{--orgtree-warning:#123456}</style></head><body><p>x</p></body></html>'
  const doc = presentationDocument(author, true)
  assert.ok(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'), 'the author doctype and the policy stay first')
  assert.ok(doc.indexOf('--orgtree-bg') < doc.indexOf('<html>'), 'the colors precede the author markup')
  const { w, read } = runFrame(doc, t)
  assertColors(read, CHARCOAL_CLAUDE, 'charcoal', ['warning'])
  assert.equal(read('--orgtree-warning'), '#123456', 'a page\'s own value wins')
  // Opt-in only: one sheet of our own variables, nothing else on the page.
  const ours = w.document.head.querySelector('style')!.textContent ?? ''
  assert.ok(ours.startsWith(':where(:root){'), 'zero specificity')
  for (const declaration of ours.slice(ours.indexOf('{') + 1, -1).split(';')) assert.match(declaration, /^--orgtree-[a-z-]+:/)
  assert.equal(w.document.documentElement.getAttribute('style'), null)
})

const encoder = new TextEncoder()
function serve(html: string) {
  const row = { id: 'deck', title: 'Status deck', format: 'html', node: 'agent', tier: 'sol', at: '2026-10-27T18:00:00Z',
    node_state: 'live', evicted: false, viewed_at: '2026-10-27T18:00:00Z' }
  const original = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = new URL(String(url), 'http://localhost')
    const json = (v: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => v }) as unknown as Response
    if (u.pathname.endsWith('/mockup')) {
      const bytes = encoder.encode(html)
      return { ok: true, status: 200, headers: new Headers({ 'Content-Length': String(bytes.byteLength) }),
        body: { cancel: async () => {} }, text: async () => html,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as Response
    }
    const id = u.pathname.match(/\/documents\/([^/]+)$/)?.[1]
    if (id === 'viewed') return json({ ok: true })
    if (id) return json({ ...row, body: '<p>source</p>' })
    return json({ documents: [row], total: 1, next_offset: null, offset: 0 })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

test('a theme switch restyles an open presentation in place, without reloading it', async (t) => {
  look('charcoal')
  t.after(serve('<!doctype html><p>deck</p>'))
  const view = await mountView(<DocReader slug="org" docId="deck" toast={() => {}} close={() => {}} />, (host) => host)
  t.after(() => view.unmount())
  await flush(); await flush()
  const frame = view.el.querySelector<HTMLIFrameElement>('iframe.html-presentation-frame')
  assert.ok(frame, 'the reader shows the presentation inline')
  const before = frame.getAttribute('srcdoc') ?? ''
  assert.ok(before.includes('--orgtree-bg:#1f1f1f'), 'the frame starts with the current colors')
  const posted: unknown[] = []
  Object.defineProperty(frame, 'contentWindow', { configurable: true,
    value: { postMessage: (message: unknown, origin: string) => { posted.push([message, origin]) } } })
  await inAct(() => look('light'))
  const last = posted.at(-1) as [{ orgtreePresentationTheme?: unknown }, string] | undefined
  assert.equal(typeof last?.[0].orgtreePresentationTheme, 'string', 'the switch posts the new colors into the frame')
  assert.equal(last![1], '*')
  assert.deepEqual(Object.keys(last![0]), ['orgtreePresentationTheme'], 'a theme switch never changes Fit width')
  const { w, read } = runFrame(before, t)
  assertColors(read, CHARCOAL_CLAUDE, 'before the switch')
  fromParent(w, last![0])
  assertColors(read, LIGHT_CLAUDE, 'after the switch')
  fromParent(w, { orgtreePresentationTheme: 42 })
  assertColors(read, LIGHT_CLAUDE, 'a malformed message changes nothing')
  await inAct(() => applyTheme('codex'))
  assert.match(String((posted.at(-1) as [{ orgtreePresentationTheme: string }])[0].orgtreePresentationTheme), /--orgtree-accent:#035b46;/,
    'a visual theme switch posts too, with the light partner Orgtree paints')
  assert.equal(frame.getAttribute('srcdoc'), before, 'no reload: the presentation keeps its own state')
  assert.equal(view.el.querySelector('iframe.html-presentation-frame'), frame)
})

test('while the rainbow accent moves, an open presentation follows it; when it stops, so do the posts', async (t) => {
  look('charcoal', 'custom:#3366cc')
  t.after(serve('<!doctype html><p>deck</p>'))
  const view = await mountView(<DocReader slug="org" docId="deck" toast={() => {}} close={() => {}} />, (host) => host)
  t.after(() => view.unmount())
  await flush(); await flush()
  const frame = view.el.querySelector<HTMLIFrameElement>('iframe.html-presentation-frame')!
  const posted: Array<{ orgtreePresentationTheme?: string }> = []
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: (m: { orgtreePresentationTheme?: string }) => { posted.push(m) } } })
  const root = document.documentElement
  t.after(() => { root.classList.remove('rainbow-theme'); look('charcoal') })
  // What rainbow.ts does: the accent is repainted every frame without an event.
  // (Chromium resolves its var(--rainbow-accent) indirection in the computed
  // token; jsdom does not, so this sets the moving value directly.)
  root.classList.add('rainbow-theme')
  await inAct(() => { window.dispatchEvent(new window.CustomEvent('orgtree:visual-theme-changed')) })
  root.style.setProperty('--accent', '#cc3366')
  await new Promise(r => setTimeout(r, 400))
  assert.ok(posted.some(m => m.orgtreePresentationTheme?.includes('--orgtree-accent:#cc3366;')), 'the moving accent reaches the page')
  root.classList.remove('rainbow-theme')
  root.style.setProperty('--accent', '#3366cc')
  await inAct(() => { window.dispatchEvent(new window.CustomEvent('orgtree:visual-theme-changed')) })
  const count = posted.length
  root.style.setProperty('--accent', '#33cc66')
  await new Promise(r => setTimeout(r, 400))
  assert.equal(posted.length, count, 'no polling once the rainbow is off')
})

test('an app panel starts with the colors and reads them from orgtree.theme, live', async (t) => {
  look('charcoal')
  const ports: MessagePort[] = []
  t.after(() => { for (const port of ports) port.close() })
  const { w, read } = runFrame(panelDocument('<p>panel</p>', 'theme-channel'), t, (win) => {
    Object.assign(win, { MessageChannel,
      postMessage: (_m: unknown, _o: string, transfer?: MessagePort[]) => { if (transfer?.[0]) ports.push(transfer[0]) } })
  })
  assertColors(read, CHARCOAL_CLAUDE, 'panel')
  const api = w.orgtree?.theme
  assert.equal(typeof api?.get, 'function', 'the SDK offers orgtree.theme')
  assert.deepEqual(JSON.parse(JSON.stringify(api!.get())), CHARCOAL_CLAUDE)
  assert.ok(Object.isFrozen(api!.get()) && Object.isFrozen(api!.get().colors))
  const seen: Theme[] = []
  const stop = api!.onChange(theme => seen.push(theme))
  // The SDK re-offers a fresh port every 250 ms until the host answers: use the latest.
  const send = async (data: object) => { ports.at(-1)!.postMessage({ protocol: PANEL_PROTOCOL, channel: 'theme-channel', ...data }); await new Promise(r => setTimeout(r, 30)) }
  await send({ kind: 'ready' })
  const lightCss = ':where(:root){' + Object.entries(LIGHT_CLAUDE.colors).map(([name, color]) => `${VARS[name]}:${color}`).join(';') + ';--orgtree-color-scheme:light}'
  await send({ kind: 'theme', theme: LIGHT_CLAUDE, css: lightCss })
  assertColors(read, LIGHT_CLAUDE, 'after the switch')
  assert.equal(seen.length, 1, 'onChange runs once per switch')
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), LIGHT_CLAUDE)
  assert.equal(api!.get().colorScheme, 'light')
  await send({ kind: 'theme', theme: LIGHT_CLAUDE })
  assert.equal(seen.length, 1, 'a message without its sheet is ignored')
  stop()
  await send({ kind: 'theme', theme: CHARCOAL_CLAUDE, css: ':where(:root){--orgtree-bg:#1f1f1f;--orgtree-color-scheme:dark}' })
  assert.equal(seen.length, 1, 'a removed listener is not called')
  assert.equal(read('--orgtree-bg'), '#1f1f1f')
})

function panelFixture() {
  const app = { id: 'themed-app', name: 'Board', description: '', rev: 2, permission_rev: 1, width: 360, height: 300, capabilities: [],
    permissions: {}, created_by: 'maker', updated_at: 'now', definition: { name: 'Board', description: '', html: '<p>board</p>' } } as unknown as CustomApp
  const panel: CustomPanel = { id: 'board-1', app: app.id, label: 'Board', open: true, rev: 1, state: {},
    placement: { mode: 'float', x: 20, y: 20, width: 360, height: 300 }, updated_at: 'now', used_at: 'now' } as CustomPanel
  const original = globalThis.fetch
  globalThis.fetch = async (raw, init) => {
    const url = new URL(String(raw), 'http://local')
    const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
    const out = input.action === 'app_get' ? app : input.action === 'panel_get' ? panel
      : input.action === 'events' ? { events: [], next_cursor: null } : {}
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { app, panel, restore: () => { globalThis.fetch = original } }
}

test('the panel host sends the colors after the handshake and on each theme switch, without reloading the panel', async (t) => {
  look('charcoal')
  const f = panelFixture(); t.after(f.restore)
  const view = await mountView(<PanelHtml slug="themed" app={f.app} panel={f.panel} />, (el) => el)
  t.after(() => view.unmount())
  const tick = async () => { for (let i = 0; i < 5; i++) await flush() }
  await inAct(tick)
  const frame = view.el.querySelector('iframe')!
  assert.ok(frame, 'the panel frame is shown')
  const srcdoc = frame.getAttribute('srcdoc') ?? ''
  assert.ok(srcdoc.includes('"bg":"#1f1f1f"') && srcdoc.includes('--orgtree-bg:#1f1f1f'), 'the panel document starts with the current colors')
  const channel = JSON.parse(srcdoc.match(/channel=("[^"]+")/)![1]!) as string
  const win = frame.ownerDocument.defaultView!, answers: Array<Record<string, unknown>> = []
  await inAct(async () => {
    const e = new win.MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { protocol: PANEL_PROTOCOL, channel, id: 'ready', method: 'host.ready' } })
    Object.defineProperty(e, 'ports', { value: [{ postMessage: (v: Record<string, unknown>) => answers.push(v), close: () => {} }] })
    win.dispatchEvent(e); await tick()
  })
  const themes = () => answers.filter(a => a.kind === 'theme')
  assert.ok(answers.some(a => a.kind === 'ready'), 'the handshake completes')
  assert.equal(themes().length, 1, 'each connection repeats the current colors')
  assert.deepEqual(themes()[0]!.theme, CHARCOAL_CLAUDE)
  assert.equal(themes()[0]!.protocol, PANEL_PROTOCOL)
  assert.equal(themes()[0]!.channel, channel)
  assert.match(String(themes()[0]!.css), /^:where\(:root\)\{--orgtree-accent:#d97757;/)
  await inAct(async () => { look('light'); await tick() })
  assert.deepEqual(themes().at(-1)!.theme, LIGHT_CLAUDE, 'a switch reaches the running panel')
  assert.match(String(themes().at(-1)!.css), /--orgtree-bg:#f6f7f9;/)
  assert.equal(view.el.querySelector('iframe'), frame, 'the same frame')
  assert.equal(frame.getAttribute('srcdoc'), srcdoc, 'no reload: the panel keeps its own state')
})
