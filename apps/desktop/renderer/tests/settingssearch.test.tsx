// Settings search (docket settings-search-idea-backlogged, USER 2026-11-08
// m2149285a4d0a; the liaison's defaults are the spec): a search box in each
// settings window (App, Org, Agent) that searches its own window across every
// tab and section. Labels, help text and section/tab names; case-insensitive,
// any word order. Typing filters to the matching settings, grouped under their
// tab and section, the match marked; click or Enter jumps to the setting in
// its tab and marks it a moment. Ctrl+F focuses the box, Esc clears it, and an
// empty result reads "No settings match <query>".
//
//   §1  App settings: box above the strip; a hit grouped Runtime > Agent processes, marked
//   §2  Enter jumps: the tab, the row marked, its switch focused, the box cleared
//   §3  any order, any case; help text and section names match too
//   §4  the empty state
//   §5  Esc clears a focused query; the next Esc closes the window as before
//   §6  Ctrl+F focuses the box (also on a non-Latin layout); outside the window it does nothing
//   §7  Org settings: a row on a never-visited tab is found, and a click lands on it
//   §8  a tab whose name matches but holds no settings opens from its own result
//   §9  Agent settings: the rows above the tabs are found; ’ and ' are the same letter
//   §10 the secret EPIC mode switch never shows in results
//   §11 nothing unmounts: a half-typed field and the panels survive a search
//   §12 arrows move the choice; Enter opens the chosen one
//   §13 a link into settings while a search is showing clears the search and lands
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs settingssearch

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import { AccountsPanel } from '../src/canvas/accounts'
import { NodeConfig } from '../src/canvas/modals'
import { legacyAppBackend } from './appfeed-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { ProvidersPayload, TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
const HL = 'set-target-hl'

// ------------------------------------------------------------------ helpers

const box = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.set-search input[type="search"]')
const root = (el: HTMLElement) => el.querySelector<HTMLElement>('.set-search')
const hits = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.set-search-results [role="option"]')]
const hitLabels = (el: HTMLElement) => hits(el).map((h) => h.querySelector('.set-label')?.textContent?.trim() ?? '')
const hitByLabel = (el: HTMLElement, label: string) =>
  hits(el).find((h) => h.querySelector('.set-label')?.textContent?.trim() === label)
const selectedTab = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ''
const marked = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.' + HL)]
/** the tab heading, then the section heading, a hit sits under */
function placeOf(hit: HTMLElement): { tab: string; section: string } {
  const group = hit.closest<HTMLElement>('.set-search-group')
  let section = ''
  for (let n = hit.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.classList.contains('set-search-section')) { section = n.textContent?.trim() ?? ''; break }
  }
  return { tab: group?.querySelector('.set-search-tab')?.textContent?.trim() ?? '', section }
}

async function type(el: HTMLElement, value: string) {
  const field = box(el)!
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await inAct(async () => { await flush(8) })
}
async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await inAct(() => { target.dispatchEvent(ev) })
  await inAct(async () => { await flush(8) })
  return ev
}
async function settle() { await inAct(async () => { await flush(10) }) }

// ------------------------------------------------------------ App settings

const providers: ProvidersPayload = { providers: [] } as unknown as ProvidersPayload
function stubAppFetch() {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const payload = path === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
      : path === '/api/providers' ? providers
        : path === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: true, working_checkups_enabled: true, wait_for_mcp_tools_enabled: false,
              max_concurrent_turns: 16 }
          : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}
async function app() {
  localStorage.clear()
  stubAppFetch()
  const closed = { n: 0 }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => { closed.n++ }} />, (el) => el)
  await settle()
  return { view, closed }
}

test('§1 App settings: the box sits above the tabs; a hit is grouped under its tab and section, the match marked', async () => {
  const { view } = await app()
  try {
    const r = root(view.el)
    assert.ok(r, 'App settings has a settings search box')
    const strip = view.el.querySelector('[role="tablist"]')!
    assert.equal(!!(r!.compareDocumentPosition(strip) & 4), true, 'the box comes before the tab strip')
    assert.equal(r!.hasAttribute('data-searching'), false, 'no query, no search view')
    await type(view.el, 'warm')
    assert.equal(r!.hasAttribute('data-searching'), true, 'a query turns the search view on')
    const hit = hitByLabel(view.el, 'Keep agent processes warm')
    assert.ok(hit, `the warming switch is a hit (hits: ${hitLabels(view.el).join(' | ')})`)
    assert.deepEqual(placeOf(hit!), { tab: 'Runtime', section: 'Agent processes' })
    assert.equal(hit!.querySelector('.set-label mark')?.textContent, 'warm', 'the matched word is marked')
    assert.match(view.el.querySelector('.set-search .docket-search-count')?.textContent ?? '', /^\d+ of \d+ match$/)
  } finally { await view.unmount() }
})

test('§2 Enter jumps to the setting: its tab, the row marked, its switch focused, the box cleared', async () => {
  const { view } = await app()
  try {
    assert.equal(selectedTab(view.el), 'Providers')
    await type(view.el, 'keep agent processes warm')
    assert.equal(hits(view.el).length, 1, 'one hit')
    await press(box(view.el)!, 'Enter')
    assert.equal(selectedTab(view.el), 'Runtime', 'the Runtime tab is shown')
    assert.equal(box(view.el)!.value, '', 'the box is cleared')
    assert.equal(root(view.el)!.hasAttribute('data-searching'), false, 'the normal view is back')
    const sw = view.el.querySelector<HTMLInputElement>('input[aria-label="Keep agent processes warm"]')!
    const row = sw.closest<HTMLElement>('.set-row')!
    assert.equal(row.classList.contains(HL), true, 'the row is marked')
    assert.equal(marked(view.el).length, 1, 'and nothing else')
    assert.equal(view.el.ownerDocument.activeElement === sw, true, 'its switch has the focus')
  } finally { await view.unmount() }
})

test('§3 any word order, any case; help text and section names match too', async () => {
  const { view } = await app()
  try {
    await type(view.el, 'WARM Keep')
    assert.ok(hitByLabel(view.el, 'Keep agent processes warm'), 'word order and case do not matter')
    await type(view.el, 'longest idle')
    assert.ok(hitByLabel(view.el, 'Keep agent processes warm'), 'help text matches')
    const marks = [...hitByLabel(view.el, 'Keep agent processes warm')!.querySelectorAll('.set-hint mark')]
      .map((m) => m.textContent?.toLowerCase())
    assert.equal(marks.includes('longest') && marks.includes('idle'), true, `the help text's matches are marked (${marks.join(',')})`)
    await type(view.el, 'credit cost bubbling')
    const labels = hitLabels(view.el)
    assert.ok(labels.includes('Your hires bubble their cost up the chain'), labels.join(' | '))
    assert.ok(labels.includes('Your allocations & model upgrades bubble their cost up the chain'), labels.join(' | '))
    assert.equal(placeOf(hitByLabel(view.el, 'Your hires bubble their cost up the chain')!).section, 'Credit cost bubbling')
  } finally { await view.unmount() }
})

test('§4 nothing matches: "No settings match <query>"', async () => {
  const { view } = await app()
  try {
    await type(view.el, 'zzqxv')
    assert.equal(hits(view.el).length, 0)
    assert.equal(view.el.querySelector('.set-search-empty')?.textContent?.trim(), 'No settings match “zzqxv”')
  } finally { await view.unmount() }
})

test('§5 Esc clears a focused query and keeps the window; the next Esc closes it as before', async () => {
  const { view, closed } = await app()
  try {
    await type(view.el, 'warm')
    box(view.el)!.focus()
    await press(box(view.el)!, 'Escape')
    assert.equal(box(view.el)!.value, '', 'the first Esc clears the box')
    assert.equal(root(view.el)!.hasAttribute('data-searching'), false)
    assert.equal(closed.n, 0, 'and does not close App settings')
    assert.equal(view.el.ownerDocument.activeElement === box(view.el), true, 'the box keeps the focus')
    await press(box(view.el)!, 'Escape')
    assert.equal(closed.n, 1, 'Esc on an empty box closes the window, as it did')
  } finally { await view.unmount() }
})

test('§6 Ctrl+F focuses the box from anywhere in the window, on any layout; outside it does nothing', async () => {
  const { view } = await app()
  try {
    const tabBtn = view.el.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
    tabBtn.focus()
    const ev = await press(tabBtn, 'f', { code: 'KeyF', ctrlKey: true })
    assert.equal(view.el.ownerDocument.activeElement === box(view.el), true, 'Ctrl+F focuses the box')
    assert.equal(ev.defaultPrevented, true, 'and is taken')
    tabBtn.focus()
    await press(tabBtn, 'כ', { code: 'KeyF', ctrlKey: true })
    assert.equal(view.el.ownerDocument.activeElement === box(view.el), true, 'the F key on a Hebrew layout too')
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      outside.focus()
      const away = await press(outside, 'f', { code: 'KeyF', ctrlKey: true })
      assert.equal(document.activeElement === outside, true, 'focus elsewhere stays where it is')
      assert.equal(away.defaultPrevented, false, 'and the key is left alone')
    } finally { outside.remove() }
  } finally { await view.unmount() }
})

test('§10 the secret EPIC mode switch never shows in results', async () => {
  const { view } = await app()
  try {
    assert.ok(view.el.querySelector('.epic-switch'), 'the switch is in the Developer tab')
    await type(view.el, 'epic')
    assert.equal(hitByLabel(view.el, 'EPIC mode'), undefined, 'search does not reveal it')
    assert.equal(view.el.querySelector('.set-search-empty')?.textContent?.trim(), 'No settings match “epic”',
      'the search ran and found nothing else either')
  } finally { await view.unmount() }
})

test('§8 a tab whose name matches but holds no settings opens from its own result', async () => {
  const { view } = await app()
  try {
    await type(view.el, 'harness')
    const tabHit = hits(view.el).find((h) => h.classList.contains('set-search-tabhit'))
    assert.ok(tabHit, 'the Harnesses tab has a result of its own')
    assert.equal(tabHit!.querySelector('.set-label')?.textContent?.trim(), 'Harnesses')
    await inAct(() => { tabHit!.click() })
    await settle()
    assert.equal(selectedTab(view.el), 'Harnesses', 'it opens the tab')
    assert.equal(box(view.el)!.value, '', 'and clears the box')
  } finally { await view.unmount() }
})

test('§12 arrows move the choice; Enter opens the chosen one', async () => {
  const { view } = await app()
  try {
    await type(view.el, 'credit cost bubbling')
    const input = box(view.el)!
    const first = hits(view.el)[0]!, second = hits(view.el)[1]!
    assert.equal(input.getAttribute('aria-activedescendant'), first.id, 'the first hit is chosen at first')
    assert.equal(first.getAttribute('aria-selected'), 'true')
    await press(input, 'ArrowDown')
    assert.equal(input.getAttribute('aria-activedescendant'), second.id, 'Down chooses the next')
    const label = second.querySelector('.set-label')!.textContent!.trim()
    await press(input, 'Enter')
    const sw = view.el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    assert.equal(sw.closest('.set-row')!.classList.contains(HL), true, 'Enter opened the chosen one')
  } finally { await view.unmount() }
})

// ------------------------------------------------------------ Org settings

const orgTree = {
  slug: 'acme', name: 'Acme', nodes: [], edges: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
  default_effort: '', cascade_hire: true, cascade_alloc: true,
  fable_limit_policy: 'halt', fable_filter_policy: 'halt',
  auto_cheap_compact: { enabled: false, occ: 0.5 }, auto_resume_compact: false,
  net: { hubs: [] },
} as unknown as TreePayload
function stubOrgFetch() {
  g.fetch = (url: string) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const payload = p.startsWith('/api/orgs/acme/orgmd') ? { content: '# Acme\n' }
      : p.startsWith('/api/orgs/acme/net') ? { hubs: [], identity: null }
        : p === '/api/mcp-servers' ? { servers: [] } : p === '/api/accounts' ? { accounts: [] } : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}
type Target = { tab: string; field: string; seq: number }
async function org(target?: Target) {
  stubOrgFetch()
  const mount = (t?: Target) => (
    <SettingsPanel tree={orgTree} toast={() => {}} close={() => {}}
      {...({ target: t } as Record<string, unknown>)} />)
  const view = await mountView(mount(target), (el) => el)
  await settle()
  const again = async (t?: Target) => { await view.render(mount(t)); await settle() }
  return { view, again }
}

test('§7 Org settings: a row on a never-visited tab is found, and a click lands on it', async () => {
  const { view } = await org()
  try {
    assert.equal(selectedTab(view.el), 'Basic')
    assert.ok(root(view.el), 'Org settings has a settings search box')
    assert.equal(view.el.querySelector('[data-settings-field="cheap-compact"]'), null, 'Policies was never opened')
    await type(view.el, 'known-cold turn')
    const hit = hitByLabel(view.el, 'Reset a session before a known-cold turn')
    assert.ok(hit, `the Policies switch is found (hits: ${hitLabels(view.el).join(' | ')})`)
    assert.deepEqual(placeOf(hit!), { tab: 'Policies', section: 'Cache-protective cheap compaction' })
    await inAct(() => { hit!.click() })
    await settle()
    assert.equal(selectedTab(view.el), 'Policies')
    const row = view.el.querySelector<HTMLElement>('[data-settings-field="cheap-compact"]')!
    assert.equal(row.classList.contains(HL), true, 'the row is marked')
    assert.equal(view.el.ownerDocument.activeElement === row.querySelector('input[role="switch"]'), true, 'its switch focused')
  } finally { await view.unmount() }
})

test('§13 a link into settings while a search is showing clears the search and lands', async () => {
  const { view, again } = await org()
  try {
    await type(view.el, 'folder')
    assert.equal(root(view.el)!.hasAttribute('data-searching'), true)
    await again({ tab: 'policies', field: 'cheap-compact', seq: 1 })
    assert.equal(root(view.el)!.hasAttribute('data-searching'), false, 'the search view gives way')
    assert.equal(box(view.el)!.value, '')
    assert.equal(selectedTab(view.el), 'Policies')
    const row = view.el.querySelector<HTMLElement>('[data-settings-field="cheap-compact"]')!
    assert.equal(row.classList.contains(HL), true)
    assert.equal(view.el.ownerDocument.activeElement === row.querySelector('input[role="switch"]'), true)
  } finally { await view.unmount() }
})

// ---------------------------------------------------------- Agent settings

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
async function gear() {
  globalThis.fetch = legacyAppBackend((async (url: string) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const payload = p === '/api/accounts' ? { accounts: [] } : { servers: [], turns: [], warnings: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }) as typeof fetch)
  const view = await mountView(
    <NodeConfig node={agent} map={new Map([[agent.id, agent]])} tree={gearTree} slug="org"
      op={async () => ({})} toast={() => {}} close={() => {}} />, (el) => el)
  await settle()
  return view
}

test('§9 Agent settings: rows above the tabs are found, listed first with no tab; ’ and \' match alike', async () => {
  const view = await gear()
  try {
    assert.ok(root(view.el), 'Agent settings has a settings search box')
    await type(view.el, "agent's folder")
    const hit = hitByLabel(view.el, 'Name')
    assert.ok(hit, `the Name row is found by its help text (hits: ${hitLabels(view.el).join(' | ')})`)
    assert.equal(placeOf(hit!).tab, '', 'it sits above the tabs, so no tab heading')
    assert.equal(hits(view.el)[0] === hit, true, 'and it is listed first')
    await type(view.el, 'start fresh')
    const fresh = hitByLabel(view.el, 'Start fresh when needed')
    assert.ok(fresh, hitLabels(view.el).join(' | '))
    assert.equal(placeOf(fresh!).tab, 'Model')
    await inAct(() => { fresh!.click() })
    await settle()
    assert.equal(selectedTab(view.el), 'Model')
    const row = view.el.querySelector<HTMLElement>('[data-settings-field="cheap-compact"]')!
    assert.equal(row.classList.contains(HL), true)
    assert.equal(view.el.ownerDocument.activeElement === row.querySelector('select'), true)
  } finally { await view.unmount() }
})

test('§11 nothing unmounts: a half-typed name and every panel survive a search', async () => {
  const view = await gear()
  try {
    const name = view.el.querySelector<HTMLInputElement>('input[aria-label="Agent name"]')!
    await inAct(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'agent-renamed')
      name.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const panels = [...view.el.querySelectorAll('[role="tabpanel"]')]
    await type(view.el, 'model')
    await type(view.el, '')
    assert.equal(view.el.querySelector<HTMLInputElement>('input[aria-label="Agent name"]') === name, true, 'the same field')
    assert.equal(name.value, 'agent-renamed', 'still holding what was typed')
    const after = [...view.el.querySelectorAll('[role="tabpanel"]')]
    assert.equal(after.length, panels.length)
    assert.equal(after.every((p, i) => p === panels[i]), true, 'the same panels, never remounted')
  } finally { await view.unmount() }
})
