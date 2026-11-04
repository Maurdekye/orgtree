// Settings > Streamer mode: what streamer mode may hide, one switch per type (USER 2026-11-03 m63438d6bebc3 definitive
// list, maad1c88abeba "file paths can be fine ... make a whole category", m4c7b46b6cffb + m10c6278e1744 external
// addresses and other orgs). Free-form content is pattern-matched for the enabled types; structured fields are either
// always one type (data-streamer-field) or never hidden.
import { JSDOM, flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, STREAMER_ZONES, type StreamerConfig } from '../src/streamer-boundary'
import { DEFAULT_STREAMER_TYPES, sensitiveSpans, streamerCoverFrom, streamerTypesFrom, type StreamerTypes } from '../../../../packages/contracts/streamer'
import { AccountsPanel } from '../src/canvas/accounts'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { startStreamerMode } from '../src/streamer'

const ALL_ON: StreamerTypes = { paths: true, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true }
const ALL_OFF: StreamerTypes = { paths: false, ips: false, emails: false, secrets: false, phones: false, tokenUrls: false, externals: false, orgs: false }
const cfg = (types: Partial<StreamerTypes>, extra: Partial<StreamerConfig> = {}): StreamerConfig => ({ types: { ...ALL_OFF, ...types }, cover: true, ...extra })

function fixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  return { dom, doc: dom.window.document, registry }
}
const hidden = (registry: Map<string, Range[]>) => Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())

const SAMPLE: Record<string, string> = {
  paths: 'C:\\Users\\reader\\project\\notes.txt', ips: '192.168.12.34', emails: 'reader@example.test', secrets: 'password=short-private',
  phones: '+1 (415) 555-0123', tokenUrls: 'https://example.test/invite/abc123', externals: '@net:private-reader.abc123',
}
test('defaults: paths off, every other type on, the cover on', () => {
  assert.deepEqual(DEFAULT_STREAMER_TYPES, { paths: false, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true })
  assert.deepEqual(streamerTypesFrom({}), DEFAULT_STREAMER_TYPES)
  assert.equal(streamerCoverFrom({}), true)
  assert.equal(streamerTypesFrom({ streamerPaths: true, streamerEmails: false }).paths, true)
  assert.equal(streamerTypesFrom({ streamerPaths: true, streamerEmails: false }).emails, false)
})

test('each type blurs its own samples in free-form text and ONLY when its switch is on', () => {
  for (const [type, value] of Object.entries(SAMPLE)) {
    const text = `Before ${value} after`
    const on = sensitiveSpans(text, { ...ALL_OFF, [type]: true })
    assert.ok(on.some(s => text.slice(s.start, s.end).includes(value) || value.includes(text.slice(s.start, s.end))), `${type} matched when on`)
    assert.deepEqual(sensitiveSpans(text, ALL_OFF), [], `${type} not matched when every switch is off`)
    for (const other of Object.keys(SAMPLE).filter(k => k !== type)) {
      const spans = sensitiveSpans(text, { ...ALL_OFF, [other]: true })
      assert.ok(!spans.some(s => text.slice(s.start, s.end) === value), `${type} sample is not hidden by the ${other} switch`)
    }
  }
})

test('the DOM boundary: switches decide, live; structured fields are never pattern-matched', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = `<div class="md"><p>see C:\\Users\\reader\\notes.txt and reader@example.test</p></div>
    <div class="chart-row"><span class="nm">reader@example.test</span><span class="nm2">C:\\Users\\reader</span></div>
    <div class="usage"><span id="usage-email" data-streamer-field="email">reader@example.test</span> <span id="acct">claude/primary</span></div>
    <input id="folder" data-streamer-field="path" value="C:\\Users\\reader"><input id="plain" value="hello">
    <input id="key" data-streamer-field="secret" type="password" value="k3Y9">`
  try {
    boundary.update(true, cfg({ emails: true }))
    assert.deepEqual(hidden(registry).sort(), ['reader@example.test', 'reader@example.test'].sort(), 'free-form email + the always-email field; not the chart row')
    assert.ok(!hidden(registry).some(t => /claude|primary|C:/.test(t)), 'account name and (disabled) paths stay visible')
    assert.equal(doc.getElementById('folder')!.hasAttribute('data-streamer-blur'), false, 'path field is visible while paths are off')
    assert.equal(doc.getElementById('key')!.hasAttribute('data-streamer-blur'), false)
    // live: turning paths and secrets on re-masks the open surface at once
    boundary.update(true, cfg({ emails: true, paths: true, secrets: true }))
    assert.ok(hidden(registry).some(t => t.includes('C:\\Users\\reader\\notes.txt')), 'paths now blurred in free-form')
    assert.ok(!hidden(registry).some(t => t === 'C:\\Users\\reader'), 'a path in a structured NAME field stays visible')
    assert.equal(doc.getElementById('folder')!.hasAttribute('data-streamer-blur'), true, 'always-path input is blurred')
    assert.equal(doc.getElementById('key')!.hasAttribute('data-streamer-blur'), true, 'always-secret input is blurred')
    assert.equal(doc.getElementById('plain')!.hasAttribute('data-streamer-blur'), false, 'an ordinary input is never blurred')
    // every switch off (allowed): nothing is blurred, streamer mode stays on
    boundary.update(true, cfg({}))
    assert.deepEqual(hidden(registry), [])
    assert.equal(doc.getElementById('folder')!.hasAttribute('data-streamer-blur'), false)
    assert.ok(doc.querySelector('[data-streamer-banner]'), 'the indicator still shows streamer mode is on')
  } finally { boundary.dispose(); dom.window.close() }
})

test('Other orgs: another org name in transcript text blurs; the current org, a short name and plain words do not; live refresh', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<div class="md"><p>Acme Rocket owes Orgtree a review, ab is short, and the rocket launched.</p></div>'
  try {
    boundary.update(true, cfg({ orgs: true }, { orgNames: ['Acme Rocket', 'ab'] }))
    assert.deepEqual(hidden(registry), ['Acme Rocket'], 'exact, word-bounded; the current org (not in the list) and 2-letter names are visible')
    boundary.update(true, cfg({ orgs: true }, { orgNames: ['Acme Rocket', 'rocket'] }))
    assert.deepEqual(hidden(registry).sort(), ['Acme Rocket', 'rocket'].sort(), 'a renamed/added org applies live, case-insensitively')
    boundary.update(true, cfg({ orgs: false }, { orgNames: ['Acme Rocket'] }))
    assert.deepEqual(hidden(registry), [], 'switch off')
    assert.deepEqual(sensitiveSpans('x @org:acme/y z', cfg({ externals: true }).types!).map(s => 'x @org:acme/y z'.slice(s.start, s.end)), ['@org:acme/y'])
  } finally { boundary.dispose(); dom.window.close() }
})

test('External addresses and other-org fields are structured always-fields governed by their own switches', () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<span id="chip" data-streamer-field="external">@net:private-reader.abc123</span><span id="org" data-streamer-field="org">Acme Rocket</span><span id="mine">Orgtree</span>'
  try {
    boundary.update(true, cfg({ externals: true }))
    assert.deepEqual(hidden(registry), ['@net:private-reader.abc123'])
    boundary.update(true, cfg({ orgs: true }))
    assert.deepEqual(hidden(registry), ['Acme Rocket'], 'the current org (unmarked) stays visible')
    boundary.update(true, cfg({}))
    assert.deepEqual(hidden(registry), [])
  } finally { boundary.dispose(); dom.window.close() }
})

test('opaque cover follows its switch; images are never hidden', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<iframe></iframe><video></video><img alt="chart" width="300" height="200">'
  try {
    boundary.update(true, { types: { ...ALL_ON }, cover: true })
    await flush()
    assert.equal(doc.querySelectorAll('[data-streamer-cover]').length, 2)
    boundary.update(true, { types: { ...ALL_ON }, cover: false })
    await flush()
    assert.equal(doc.querySelectorAll('[data-streamer-cover]').length, 0, 'cover switch off removes the covers')
    assert.ok(doc.documentElement.classList.contains('streamer-nocover'))
  } finally { boundary.dispose(); dom.window.close() }
})

test('agent status summaries are free-form wherever they render (tray/attention rows, status chips, tooltips); the agent name beside them never blurs', () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = `<div class="tray-row"><span class="tray-name">reader@example.test</span>
    <div class="tray-sum" title="idle: mail reader@example.test now"><span class="tray-sum-text">idle: <span class="md md-inline">mail reader@example.test now</span></span></div>
    <div class="progress-summary">reported password=k3Y9 done</div>
    <span class="statuschip idle" data-streamer-freeform="" title="password=k3Y9">Idle</span>
    <span class="statusdot idle" data-streamer-freeform="" title="a harmless summary"></span>
    <span class="statusdot idle" title="reader@example.test">unmarked structured dot</span></div>`
  try {
    boundary.update(true, cfg({ emails: true, secrets: true }))
    assert.deepEqual(hidden(registry).sort(), ['password=k3Y9', 'reader@example.test'].sort().concat([]).sort(), 'summary text blurs (the name in .tray-name does not): ' + JSON.stringify(hidden(registry)))
    const title = (sel: string) => doc.querySelector(sel)!.getAttribute('title')
    assert.equal(title('.tray-sum'), 'Hidden in Streamer mode', 'the summary tooltip on the row')
    assert.equal(title('.statuschip'), 'Hidden in Streamer mode', 'a matching status tooltip')
    assert.equal(doc.querySelectorAll('.statusdot')[0]!.getAttribute('title'), 'a harmless summary', 'a tooltip with nothing to hide stays')
    assert.equal(doc.querySelectorAll('.statusdot')[1]!.getAttribute('title'), 'reader@example.test', 'an unmarked structured element is never touched')
    boundary.update(true, cfg({}))
    assert.deepEqual(hidden(registry), [])
    assert.equal(title('.tray-sum'), 'idle: mail reader@example.test now', 'switching the types off restores the tooltip live')
    assert.equal(title('.statuschip'), 'password=k3Y9')
  } finally { boundary.dispose(); dom.window.close() }
})

test('user-written excerpts and previews are free-form: the sticky user-message preview, mail and reply previews, selection excerpts', () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'
  doc.body.innerHTML = `<button class="pinuser"><span class="pinuser-t">↑ you: here is ${KEY} ok</span></button>
    <span class="mail-preview-text">see ${KEY}</span><div class="turn-mail-preview-content">see ${KEY}</div>
    <div class="reply-preview-content">see ${KEY}</div><span class="selection-excerpt">see ${KEY}</span>
    <div class="dead-preview">see ${KEY}</div><span class="agent-name">liaison-opus</span>`
  try {
    boundary.update(true, cfg({ secrets: true }))
    assert.deepEqual(hidden(registry), Array(6).fill(KEY), 'every preview blurs the key; the agent name does not: ' + JSON.stringify(hidden(registry)))
  } finally { boundary.dispose(); dom.window.close() }
})

// USER 2026-11-04 m8183a66a1f68 "better, but there's still some over-masking": the row header of "Request resolved" had
// "resolved", "User", the request id and the date blurred. Cause: the row sits in a free-form `.msg`, and the header's adjacent
// inline fields have no whitespace between them, so their text concatenated into one long token-like run.
test('every transcript row-header kind is structured: a q-id, date, name and status word in a header are never hidden', () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'
  const F = (k: string, v: string) => `<span class="event-head-field" data-event-field="${k}">${v}</span>`
  const HEAD = `<span class="event-family">?</span><strong>Request resolved</strong><span class="event-actor">User</span>${F('qid', 'q35e7490e3d3e')}${F('status', 'resolved')}${F('owner', 'liaison-opus')}<time>2026-11-04 16:25:48 GMT+2</time>`
  doc.body.innerHTML = [
    // mail / typed event card header in a transcript row
    `<div class="msg sys"><section class="turn-mail"><header class="turn-mail-head event-head">${HEAD}</header><div class="turn-mail-body">see ${KEY}</div></section></div>`,
    // plain (list) mail header, event-card header (request / question / status), reply source meta
    `<div class="msg"><div class="mailer-head event-head">${HEAD}</div><span class="reply-source-meta">${HEAD}</span></div>`,
    // answered / resolved request card: summary, chip and verdict rows
    `<div class="msg"><details class="answered-card" open><summary><span class="answered-chip">Q1</span>Request resolved${HEAD}</summary><ul class="resolved-rows"><li class="resolved-row"><span class="resolved-label">liaison-opus</span><span class="resolved-verdict">q35e7490e3d3e</span></li></ul></details></div>`,
    // tool call line: the name and count are structured, its argument is free-form
    `<div class="msg live tools"><span class="tools tchip"><span class="tline">Bash${F('n', 'q35e7490e3d3e')}<span class="tline-count">2026-11-04</span><span class="targ">curl ${KEY}</span></span></span></div>`,
    // state marker and gap divider
    `<div class="msg sys" data-streamer-structured>Working since 2026-11-04q35e7490e3d3eliaison-opus</div>`,
    `<div class="msg sys" data-streamer-structured>— 14s later —q35e7490e3d3e2026-11-04</div>`,
  ].join('')
  try {
    boundary.update(true, cfg({ secrets: true, paths: true }))
    assert.deepEqual(hidden(registry), [KEY, KEY], 'only the two free-form keys are blurred; no header, id, date, name or status: ' + JSON.stringify(hidden(registry)))
  } finally { boundary.dispose(); dom.window.close() }
})

// USER 2026-11-04 m27bbbf036a7a "the streamer mode annotation blocks the version number": the pill was a fixed bottom-right overlay.
test('the banner sits IN the footer strip beside the version label, never over it; a window with no footer reserves a bottom strip', () => {
  const a = fixture(), ba = installStreamerBoundary(a.doc, () => {})
  a.doc.body.innerHTML = '<footer class="shell-statusbar"><div class="shell-statusbar-start">chips</div><div class="shell-statusbar-end"><span class="shell-version dim">Orgtree 4.5.5-alpha.3</span></div></footer>'
  try {
    ba.update(true, cfg({ secrets: true }))
    const banner = a.doc.querySelector('[data-streamer-banner]')!, end = a.doc.querySelector('.shell-statusbar-end')!, ver = a.doc.querySelector('.shell-version')!
    assert.equal(banner.parentElement, end, 'the banner is a child of the footer end group')
    assert.equal(banner.nextElementSibling, ver, 'immediately before the version label, in flow')
    assert.ok(banner.querySelector('button'), 'Turn off stays in it')
    assert.equal(a.doc.documentElement.classList.contains('streamer-banner-fixed'), false)
    ba.update(false)
    assert.equal(a.doc.querySelector('[data-streamer-banner]'), null)
  } finally { ba.dispose(); a.dom.window.close() }
  const b = fixture(), bb = installStreamerBoundary(b.doc, () => {})
  b.doc.body.innerHTML = '<main>popout, no footer</main>'
  try {
    bb.update(true, cfg({ secrets: true }))
    assert.equal(b.doc.documentElement.classList.contains('streamer-banner-fixed'), true, 'no footer: a reserved strip, so nothing is covered')
    bb.update(false)
    assert.equal(b.doc.documentElement.classList.contains('streamer-banner-fixed'), false)
  } finally { bb.dispose(); b.dom.window.close() }
})

// USER 2026-11-04 m79874151077c "selected text is still blocked off in streamer mode". Cause: a blanket
// `html.streamer-on ::selection{color:transparent}` rule blanked ANY selection (a ::selection layer also sits above the
// custom highlight, so a selected key would be drawn in the clear if the rule were just dropped). Now the selection is drawn
// normally and only the enabled-type spans inside it are covered by a mask box.
test('a selection is not blurred wholesale: only the hidden-type spans inside it are masked; previews pattern-match', () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'
  const w = dom.window as unknown as { Range: { prototype: { getClientRects(): unknown } }; getSelection(): Selection }
  w.Range.prototype.getClientRects = function (this: Range) { return [{ left: 10, top: 20, width: this.toString().length * 5, height: 12, right: 0, bottom: 0, x: 10, y: 20, toJSON() {} }] }
  doc.body.innerHTML = `<div class="md"><p id="a">hello world ${KEY} done</p></div>
    <button class="pinuser"><span class="pinuser-t">↑ you: hello world ${KEY}</span></button><span class="mail-preview-text">hello world ${KEY}</span>
    <div class="turn-mail-preview-content">hello world ${KEY}</div><div class="reply-preview-content">hello world ${KEY}</div><span class="selection-excerpt">hello world ${KEY}</span>`
  try {
    boundary.update(true, cfg({ secrets: true }))
    assert.deepEqual(hidden(registry), Array(6).fill(KEY), 'every preview kind: only the key is masked, "hello world" shows: ' + JSON.stringify(hidden(registry)))
    const css = doc.querySelector('[data-streamer-style]')!.textContent!
    assert.ok(!/::selection\s*\{[^}]*(transparent|text-shadow)/.test(css), 'no blanket ::selection blanking rule')
    const text = doc.getElementById('a')!.firstChild!
    const sel = w.getSelection(), range = doc.createRange()
    range.setStart(text, 0); range.setEnd(text, text.textContent!.length); sel.removeAllRanges(); sel.addRange(range)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    const masks = () => [...doc.querySelectorAll('[data-streamer-selmask]')]
    assert.equal(masks().length, 1, 'a selection holding words and a key: one mask box, over the key only')
    assert.equal((masks()[0] as HTMLElement).style.width, KEY.length * 5 + 'px')
    range.setStart(text, 0); range.setEnd(text, 11); sel.removeAllRanges(); sel.addRange(range)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    assert.equal(masks().length, 0, 'a selection of only ordinary words: nothing masked')
    sel.removeAllRanges(); boundary.update(false)
    assert.equal(masks().length, 0)
  } finally { boundary.dispose(); dom.window.close() }
})

// build-sol 2026-11-04 15:21Z: a real Chromium selection over a key froze the renderer. Cause: the mask layer was removed from
// and re-added to <body> on every pass; those childList records target BODY (not a data-streamer-ui node), so the observer
// rescanned, the scan re-ran maskSelection, which mutated body again: an endless microtask loop.
test('showing a selection mask does not re-trigger scans: body mutations settle (no observer feedback loop)', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'
  const w = dom.window as unknown as { Range: { prototype: { getClientRects(): unknown } }; getSelection(): Selection }
  w.Range.prototype.getClientRects = function (this: Range) { return [{ left: 10, top: 20, width: this.toString().length * 5, height: 12, right: 0, bottom: 0, x: 10, y: 20, toJSON() {} }] }
  doc.body.innerHTML = `<div class="md"><p id="a">hello world ${KEY} done</p></div>`
  try {
    boundary.update(true, cfg({ secrets: true }))
    let records = 0
    const watcher = new dom.window.MutationObserver(list => { records += list.length })
    watcher.observe(doc.body, { childList: true })
    const text = doc.getElementById('a')!.firstChild!
    const sel = w.getSelection(), range = doc.createRange()
    range.setStart(text, 0); range.setEnd(text, text.textContent!.length); sel.removeAllRanges(); sel.addRange(range)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    for (let i = 0; i < 60; i++) await Promise.resolve()
    assert.ok(records <= 2, 'the layer is attached once and left alone; body mutations seen: ' + records)
    assert.equal(doc.querySelectorAll('[data-streamer-selmask]').length, 1)
    watcher.disconnect()
  } finally { boundary.dispose(); dom.window.close() }
})

test('the zone table is explicit: free-form containers and the always-field kinds', () => {
  assert.ok(STREAMER_ZONES.freeform.includes('.md') && STREAMER_ZONES.freeform.includes('.msg'))
  assert.deepEqual(Object.keys(STREAMER_ZONES.always).sort(), ['email', 'external', 'ip', 'org', 'path', 'secret'])
})

// ── the settings category ──
const g = globalThis as unknown as Record<string, unknown>
const native = window as unknown as { orgtreeDesktop?: unknown }
function stubFetch(): void {
  g.fetch = (url: string, init?: RequestInit) => {
    const p = new URL(String(url), 'http://localhost').pathname, method = init?.method ?? 'GET'
    const payload = p === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
      : p === '/api/providers' ? { providers: [] }
        : p === '/api/app-settings/runtime' && method === 'GET' ? { warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false }
          : p === '/api/app/records' ? { type: 'app_snapshot', epoch: 'e', seq: 1, registry: { type: 'registry_snapshot', epoch: 'e', cursor: { app_uuid: 't', incarnation: 'e', rev: 1 }, records: [] }, summaries: {}, not: 0 }
            : null
    return payload ? Promise.resolve(new Response(JSON.stringify(payload))) : Promise.reject(new Error(`unexpected ${method} ${p}`))
  }
}
function installBridge(t: TestContext) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES }
  const writes: Partial<NativePreferences>[] = [], listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const broadcast = () => { for (const fn of [...listeners]) fn({ type: 'preferences', data: saved }) }
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => { writes.push(patch); saved = { ...saved, ...preferencesPatch(patch) }; broadcast(); return saved },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  return { writes, elsewhere: (patch: Partial<NativePreferences>) => { saved = { ...saved, ...patch }; broadcast() }, saved: () => saved }
}

test('Settings has a Streaming category next to Display holding the streamer switch, OBS auto-detect, eight type switches and the attract group, in that order; Display has no Modes section', async (t) => {
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
  const tabs = [...view.el.querySelectorAll('[role="tab"]')].map(e => e.textContent)
  assert.equal(tabs.indexOf('Streaming'), tabs.indexOf('Display') + 1, 'the category (renamed from Streamer mode) sits right after Display: ' + JSON.stringify(tabs))
  assert.equal(tabs.includes('Streamer mode'), false)
  // Display no longer has the Modes section; everything moved to Streaming
  const display = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
  for (const f of ['streamerMode', 'streamerAuto', 'attractMode', 'attractIdleSeconds', 'attractRefuseQuestions', 'streamerHides']) assert.equal(display.querySelector(`[data-settings-field="${f}"]`), null, 'Display has no ' + f)
  assert.ok(![...display.querySelectorAll('.set-group-title, h3, h4')].some(e => e.textContent === 'Modes'), 'no Modes heading in Display')
  await inAct(async () => { [...view.el.querySelectorAll<HTMLElement>('[role="tab"]')].find(e => e.textContent === 'Streaming')!.click(); await flush(6) })
  const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-streamer')!
  const order = [...panel.querySelectorAll('[data-settings-field]')].map(e => e.getAttribute('data-settings-field'))
  const want = ['streamerMode', 'streamerAuto', ...['paths', 'ips', 'emails', 'secrets', 'phones', 'tokenUrls', 'externals', 'orgs'].map(k => 'streamer-' + k), 'streamerCover', 'attractMode']
  assert.deepEqual(order.slice(0, want.length), want, 'order: streamer switch, OBS auto-detect, per-type switches, cover, then attract: ' + JSON.stringify(order))
  assert.ok(order.includes('attractRefuseQuestions'))
  assert.equal(panel.querySelector('[data-settings-field="streamerHides"]'), null, 'no "What streamer mode hides" button')
  assert.equal(panel.querySelector('[data-settings-field="streamerStatus"]'), null, 'no read-only status row: the switch itself is here')
  assert.ok(!/Streamer mode settings|Change it in Display/.test(panel.textContent!), 'descriptions do not point at another page')
  const box = (field: string) => panel.querySelector<HTMLInputElement>(`[data-settings-field="${field}"] input[type="checkbox"]`)!
  const fields = ['paths', 'ips', 'emails', 'secrets', 'phones', 'tokenUrls', 'externals', 'orgs'].map(k => 'streamer-' + k)
  assert.deepEqual(fields.map(f => box(f)?.checked), [false, true, true, true, true, true, true, true], 'defaults')
  assert.equal(box('streamerCover').checked, true)
  for (const f of fields) assert.ok(panel.querySelector(`[data-settings-field="${f}"] .set-hint`)!.textContent!.length > 20, f + ' has a one-line description')
  await inAct(async () => { box('streamer-paths').click(); await flush(6) })
  await inAct(async () => { box('streamer-emails').click(); await flush(6) })
  await inAct(async () => { box('streamer-orgs').click(); await flush(6) })
  await inAct(async () => { box('streamerCover').click(); await flush(6) })
  assert.deepEqual(bridge.writes, [{ streamerPaths: true }, { streamerEmails: false }, { streamerOrgs: false }, { streamerCover: false }])
  assert.deepEqual(streamerTypesFrom(bridge.saved()), { ...DEFAULT_STREAMER_TYPES, paths: true, emails: false, orgs: false }, 'persisted through the preference store')
  // all types off is allowed
  for (const f of fields) if (box(f).checked) await inAct(async () => { box(f).click(); await flush(4) })
  assert.deepEqual(fields.map(f => box(f).checked), fields.map(() => false))
  // another window changes one: this window follows (the same broadcast path as the on/off switch)
  await inAct(async () => { bridge.elsewhere({ streamerIps: true }); await flush(6) })
  assert.equal(box('streamer-ips').checked, true)
})
