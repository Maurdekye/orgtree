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

test('Settings has a Streamer mode category next to Display: eight switches with defaults, persistence keys and live sync; Display links to it', async (t) => {
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
  assert.equal(tabs.indexOf('Streamer mode'), tabs.indexOf('Display') + 1, 'the category sits right after Display: ' + JSON.stringify(tabs))
  // Display keeps on/off + auto switches and gains the link row; there is no second on/off switch in the new category
  const display = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
  assert.ok(display.querySelector('[data-settings-field="streamerMode"]'))
  assert.ok(display.querySelector('[data-settings-field="streamerHides"] button.link')!.textContent!.includes('What streamer mode hides'))
  await inAct(async () => { display.querySelector<HTMLButtonElement>('[data-settings-field="streamerHides"] button')!.click(); await flush(4) })
  const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-streamer')!
  assert.equal(panel.hasAttribute('hidden') || panel.getAttribute('aria-hidden') === 'true', false, 'the link opens the category')
  assert.ok(!panel.querySelector('[data-settings-field="streamerMode"]'), 'no second on/off switch')
  assert.ok(/Off/.test(panel.querySelector('[data-settings-field="streamerStatus"]')!.textContent!), 'read-only state')
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
  // back on Display: the link row and status
  await inAct(async () => { panel.querySelector<HTMLButtonElement>('[data-settings-field="streamerStatus"] button')!.click(); await flush(4) })
  assert.equal(view.el.querySelector<HTMLElement>('#app-settings-panel-display')!.hasAttribute('hidden'), false)
})
