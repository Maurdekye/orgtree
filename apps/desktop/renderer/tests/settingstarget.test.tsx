// Opening a settings panel AT a control (docket
// cheap-compact-warning-turn-off-in-settings-link-o; USER 2026-10-20: "it will
// require some new ui wiring to automatically open that panel to the right
// window", and the row "should briefly highlight, about 1-2 s, fading, in both
// themes").
//
// A panel takes a `target` — { tab, field, seq } — beside its own `initialTab`:
// `seq` is what makes the same control a NEW request the second time (the
// panel may already be open, on another tab, or pinned or popped out into a
// window of its own), `field` names a row by `data-settings-field`. The panel
// switches to the tab, scrolls the row into view, focuses its control and
// marks the row `set-target-hl` for a moment.
//
//   §1 org settings: the Policies tab, the row marked, its switch focused, the
//      mark gone after about two seconds
//   §2 a panel that is already open follows a later request; the same request
//      twice is one request; a user who moved on is not dragged back by a rerender
//   §3 no target, nothing marked, the default tab
//   §4 the agent's gear: the Model tab, the "Start fresh when needed" row
//   §5 the mark is a theme-variable fade (both themes), not a fixed colour
//   §6 a panel popped out into a window of its own (another document) is landed in THAT document
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs settingstarget

import { JSDOM, flush, inAct, mountView } from './harness'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { SettingsPanel } from '../src/App'
import { NodeConfig } from '../src/canvas/modals'
import { legacyAppBackend } from './appfeed-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const HL = 'set-target-hl'
const MARK_MS = 2100                     // a little over the 1.8 s the mark lasts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const g = globalThis as unknown as Record<string, unknown>

const orgTree = {
  slug: 'acme', name: 'Acme', nodes: [], edges: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
  default_effort: '', cascade_hire: true, cascade_alloc: true,
  fable_limit_policy: 'halt', fable_filter_policy: 'halt',
  auto_cheap_compact: { enabled: false, occ: 0.5 }, auto_resume_compact: false,
  net: { hubs: [] },
} as unknown as TreePayload

function stubFetch() {
  g.fetch = (url: string) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const payload = p.startsWith('/api/orgs/acme/orgmd') ? { content: '# Acme\n' }
      : p.startsWith('/api/orgs/acme/net') ? { hubs: [], identity: null }
        : p === '/api/mcp-servers' ? { servers: [] } : p === '/api/accounts' ? { accounts: [] } : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}

const selectedTab = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ''
const marked = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.' + HL)]
const row = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-settings-field="cheap-compact"]')

type Target = { tab: string; field: string; seq: number }
const tab = (t: string, seq: number): Target => ({ tab: t, field: 'cheap-compact', seq })

async function org(target?: Target) {
  stubFetch()
  const mount = (t?: Target) => (
    <SettingsPanel tree={orgTree} toast={() => {}} close={() => {}}
      {...({ target: t } as Record<string, unknown>)} />)
  const view = await mountView(mount(target), (el) => el)
  await inAct(async () => { await flush(10) })
  const again = async (t?: Target) => { await view.render(mount(t)); await inAct(async () => { await flush(6) }) }
  return { view, again }
}

test('§1 org settings opened at the cheap-compact switch: Policies, marked, focused, then calm', async () => {
  const { view } = await org(tab('policies', 1))
  try {
    assert.equal(selectedTab(view.el), 'Policies')
    const r = row(view.el)
    assert.ok(r, 'the cheap-compaction row is tagged data-settings-field="cheap-compact"')
    assert.equal(r!.classList.contains(HL), true, 'it is marked')
    assert.equal(marked(view.el).length, 1, 'and nothing else is')
    const sw = r!.querySelector<HTMLInputElement>('input[role="switch"]')
    assert.ok(sw, 'the row holds the switch')
    assert.equal(r!.ownerDocument.activeElement === sw, true, 'the switch has the focus')
    await sleep(MARK_MS)
    await inAct(async () => { await flush(2) })
    assert.equal(marked(view.el).length, 0, 'the mark fades away by itself')
    assert.equal(selectedTab(view.el), 'Policies', 'the panel stays where it was sent')
  } finally { await view.unmount() }
})

test('§2 an open panel follows a later request; one request counts once', async () => {
  const { view, again } = await org()
  try {
    assert.equal(selectedTab(view.el), 'Basic')
    await again(tab('policies', 1))
    assert.equal(selectedTab(view.el), 'Policies')
    assert.equal(marked(view.el).length, 1)
    await sleep(MARK_MS)
    // the user moves on; a rerender carrying the SAME request must not drag them back
    const basic = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes('Basic'))!
    await inAct(async () => { basic.click(); await flush(2) })
    assert.equal(selectedTab(view.el), 'Basic')
    await again(tab('policies', 1))
    assert.equal(selectedTab(view.el), 'Basic', 'the same seq is the same request')
    assert.equal(marked(view.el).length, 0)
    // a new request is a new request
    await again(tab('policies', 2))
    assert.equal(selectedTab(view.el), 'Policies')
    assert.equal(marked(view.el).length, 1, 'marked again')
  } finally { await view.unmount() }
})

test('§3 without a target nothing is marked and the panel opens where it always did', async () => {
  const { view } = await org()
  try {
    assert.equal(selectedTab(view.el), 'Basic')
    assert.equal(marked(view.el).length, 0)
    assert.equal(view.el.ownerDocument.querySelector('.' + HL) === null, true)
  } finally { await view.unmount() }
})

// ---------------------------------------------------------------- the gear

const tools = { bash: true, edit: true, web: false, subagents: false, mcp: [] }
const gearTree = { slug: 'org', dirs: [], tiers: { haiku: 1, opus: 5, luna: 0.2, astra: 10 },
  max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
  default_tools: tools } as unknown as TreePayload
const agent = { id: 'agent', title: 'agent', state: 'live', tier: 'opus', model_id: 'opus',
  parent: 'USER', children: [], seat: 5, grant: 10, free: 10, account: 'claude/primary',
  scope: { permission_mode: 'acceptEdits', add_dirs: [], tools, org_visibility: 'team',
    auto_cheap_compact: { enabled: true, occ: 0.4 } },
  configured_scope: { permission_mode: 'acceptEdits', add_dirs: [], tools, org_visibility: 'team',
    auto_cheap_compact: { enabled: true, occ: 0.4 } },
  charter: '', team_charter: '', turns: [], audiences_held: [] } as unknown as CanvasNode

async function gear(target?: Target) {
  globalThis.fetch = legacyAppBackend((async (url: string) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const payload = p === '/api/accounts' ? { accounts: [] } : { servers: [], turns: [], warnings: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }) as typeof fetch)
  const view = await mountView(
    <NodeConfig node={agent} map={new Map([[agent.id, agent]])} tree={gearTree} slug="org"
      op={async () => ({})} toast={() => {}} close={() => {}}
      {...({ target } as Record<string, unknown>)} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

test("§4 the agent's gear opened at the cheap-compact row: Model tab, row marked, its select focused", async () => {
  const view = await gear(tab('model', 1))
  try {
    assert.equal(selectedTab(view.el), 'Model')
    const r = row(view.el)
    assert.ok(r, 'the "Start fresh when needed" row is tagged data-settings-field="cheap-compact"')
    assert.match(r!.textContent ?? '', /Start fresh when needed/)
    assert.equal(r!.classList.contains(HL), true, 'it is marked')
    const sel = r!.querySelector<HTMLSelectElement>('select')
    assert.ok(sel)
    assert.equal(r!.ownerDocument.activeElement === sel, true, 'its select has the focus')
    assert.equal(sel!.value, 'on', "and it shows the agent's own ON override")
  } finally { await view.unmount() }
})

test('§4 the gear opens on its first tab, nothing marked, without a target', async () => {
  const view = await gear()
  try {
    assert.notEqual(selectedTab(view.el), 'Model')
    assert.equal(marked(view.el).length, 0)
  } finally { await view.unmount() }
})

test('§6 a panel popped out into a window of its own is landed in that window, not in the main one', async () => {
  stubFetch()
  const popup = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const host = popup.window.document.createElement('div')
  popup.window.document.body.appendChild(host)
  const view = await mountView(createPortal(
    <SettingsPanel tree={orgTree} toast={() => {}} close={() => {}}
      {...({ target: tab('policies', 1) } as Record<string, unknown>)} />, host), (el) => el)
  try {
    await inAct(async () => { await flush(10) })
    const r = host.querySelector<HTMLElement>('[data-settings-field="cheap-compact"]')
    assert.ok(r, 'the row is in the popped-out document')
    assert.equal(r!.classList.contains(HL), true, 'and marked there')
    const sw = r!.querySelector<HTMLInputElement>('input[role="switch"]')
    assert.equal(popup.window.document.activeElement === sw, true, "focused in that window's own document")
    assert.equal(document.querySelector('.' + HL) === null, true, 'nothing in the main window is marked')
  } finally { await view.unmount(); popup.window.close() }
})

test('§5 the mark is a fade in the theme\'s own accent, so both themes show it', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.set-row\.set-target-hl\b/, 'the row rule')
  const frames = css.match(/@keyframes set-target-fade\s*\{[\s\S]*?\n\}/)
  assert.ok(frames, 'a keyframes fade exists')
  assert.match(frames![0], /var\(--accent-soft\)|var\(--accent\)/, 'it draws in theme variables')
  assert.doesNotMatch(frames![0], /#[0-9a-f]{3,8}\b|rgba?\(/i, 'and carries no fixed colour of its own')
})
