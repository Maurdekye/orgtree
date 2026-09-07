// D-222 — org settings is ONE modal.
//
// User directive 2026-09-01: "consolidate settings into ONE modal. Remove the
// separate/nested Advanced Settings modal and its launch flow. The single
// modal should use a tab series: first tab = Basic settings; every subsequent
// tab = one of the tabs/sections currently housed in the Advanced modal."
//
// The panel used to render an `advanced…` disclosure that opened a SECOND
// `.overlay` on top of the first, with its own Escape handler, its own tab
// strip (roleless buttons, no arrow keys) and its own "done" button — while
// the only real save button stayed on the panel underneath, which is why each
// advanced tab had to end with a note explaining where its save button was.
//
// These tests state the consolidation as properties rather than as pixels:
// one overlay, one save, direct tab reach, nothing lost across a tab switch,
// and no orphaned launch flow.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

/** the shape SettingsPanel actually reads. Deliberately a plain org: no
 *  kiosk (so Autonomy exists) and a mail identity (so Mailserver exists),
 *  which is the widest tab set an ordinary org can show. */
function tree(over: Record<string, unknown> = {}): TreePayload {
  return {
    slug: 'acme', name: 'Acme', nodes: [], edges: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
    default_effort: '', cascade_hire: true, cascade_alloc: true,
    fable_limit_policy: 'halt', fable_filter_policy: 'halt',
    auto_cheap_compact: { enabled: false, occ: 0.5 },
    auto_resume_compact: false,
    kiosk: null, sandboxed: false, disk: null, net: { hubs: [] },
    ...over,
  } as unknown as TreePayload
}

function stubFetch(seen: { method: string; path: string; body: unknown }[]) {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    seen.push({ method, path,
      body: init?.body ? JSON.parse(String(init.body)) : null })
    const payload = path.startsWith('/api/orgs/acme/orgmd')
      ? { content: '# Acme\n' }
      : path.startsWith('/api/orgs/acme/net') ? { hubs: [], identity: null }
        : {}
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }
}

async function mountOrg(over: Record<string, unknown> = {}) {
  const closed: true[] = []
  const view = await mountView(
    <SettingsPanel tree={tree(over)} toast={() => {}}
      close={() => { closed.push(true) }} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return { view, closed }
}

const tabs = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]

/** a React controlled field ignores a plain `.value =` — its value tracker
 *  sees no change and the onChange never fires. Go through the prototype
 *  setter and dispatch the event React actually listens for. (Same technique
 *  as tests/kbdhire.test.tsx; kept local rather than exported so this file
 *  stays readable on its own.) */
async function setField(el: HTMLInputElement | HTMLSelectElement, v: string) {
  const w = el.ownerDocument.defaultView as unknown as {
    HTMLInputElement: typeof HTMLInputElement
    HTMLSelectElement: typeof HTMLSelectElement
    Event: typeof Event
  }
  const proto = el.tagName === 'SELECT'
    ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  assert.ok(setter, 'no value setter on the element prototype')
  await inAct(async () => {
    setter!.call(el, v)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
    await flush()
  })
}

async function open(el: HTMLElement, label: string) {
  const t = tabs(el).find((b) => b.textContent?.includes(label))
  assert.ok(t, `no tab labelled ${label}`)
  await inAct(async () => { t!.click() })
  return t!
}

test('①  ONE modal: a single overlay, no advanced disclosure, and every '
  + 'former advanced section reachable as a sibling tab', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  try {
    // exactly one overlay in the tree — the nested one is gone
    assert.equal(view.el.querySelectorAll('.overlay').length, 1)
    // and its launch flow with it
    assert.equal(view.el.querySelectorAll('.disclosure').length, 0)
    assert.doesNotMatch(view.el.textContent ?? '', /advanced…/)
    // Basic is first and selected on open
    const labels = tabs(view.el).map((t) => t.textContent?.trim())
    assert.equal(labels[0]?.startsWith('Basic'), true)
    assert.deepEqual(labels,
      ['Basic', 'Policies', 'Org type', 'Mailserver', 'Autonomy'])
    assert.equal(tabs(view.el)[0]!.getAttribute('aria-selected'), 'true')

    // every former advanced category is now reachable in ONE click from the
    // strip, rather than one click to open a modal and another to pick a tab
    for (const label of ['Policies', 'Org type', 'Mailserver', 'Autonomy']) {
      const t = await open(view.el, label)
      assert.equal(t.getAttribute('aria-selected'), 'true')
      // still one overlay: picking a tab must not open a second surface
      assert.equal(view.el.querySelectorAll('.overlay').length, 1)
      const panel = view.el.querySelector(`#${t.getAttribute('aria-controls')}`)
      assert.ok(panel, `${label} tab controls no panel`)
      assert.equal(panel!.hasAttribute('hidden'), false)
    }
  } finally { await view.unmount(); delete g.fetch }
})

test('②  ONE save surface, on every tab — and none of the four "changes here '
  + 'save with the panel\'s own save button" notes survive', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  try {
    for (const label of ['Basic', 'Policies', 'Org type', 'Autonomy']) {
      await open(view.el, label)
      const saves = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => b.textContent?.trim() === 'save')
      assert.equal(saves.length, 1, `${label}: expected exactly one save`)
      // the nested modal's own dismissal is gone; cancel is the panel's
      assert.equal([...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => b.textContent?.trim() === 'done').length, 0,
        `${label}: the nested modal's "done" button survived`)
      assert.doesNotMatch(view.el.textContent ?? '',
        /changes here save with the panel/,
        `${label}: a note explaining where the save button is`)
    }
  } finally { await view.unmount(); delete g.fetch }
})

test('③  a tab switch is lossless: an edit made on one tab is still there '
  + 'after visiting another, and rides the one save', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view, closed } = await mountOrg()
  try {
    // edit on Basic
    await setField(view.el.querySelector<HTMLInputElement>(
      'input[aria-label="top-level grant cap"]')!, '77')

    // edit on Policies
    await open(view.el, 'Policies')
    await setField(view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="fable weekly-limit policy"]')!, 'opus')

    // wander, then come back — both edits survive, because the panels are
    // hidden rather than unmounted
    await open(view.el, 'Org type')
    await open(view.el, 'Basic')
    assert.equal(view.el.querySelector<HTMLInputElement>(
      'input[aria-label="top-level grant cap"]')!.value, '77')
    await open(view.el, 'Policies')
    assert.equal(view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="fable weekly-limit policy"]')!.value, 'opus')

    // one save carries BOTH, from whichever tab you happen to be on
    seen.length = 0
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(12) })
    const settings = seen.find((r) => r.method === 'POST'
      && r.path === '/api/orgs/acme/settings')
    assert.ok(settings, 'save did not POST the settings')
    const body = settings!.body as Record<string, unknown>
    assert.equal(body.max_top_grant, 77)
    assert.equal(body.fable_limit_policy, 'opus')
    assert.equal(closed.length, 1, 'a successful save closes the panel')
  } finally { await view.unmount(); delete g.fetch }
})

test('④  the tab set follows the org: a kiosk has no Autonomy tab, and an '
  + 'org with no mail identity has no Mailserver tab', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  let m = await mountOrg({ net: null })
  try {
    assert.deepEqual(tabs(m.view.el).map((t) => t.textContent?.trim()),
      ['Basic', 'Policies', 'Org type', 'Autonomy'])
  } finally { await m.view.unmount() }

  m = await mountOrg({ kiosk: { enabled: true, credits: 5, spend_limit: 0,
    storage_limit_mb: 0, sandbox: false, share_url: null, max_scope: null,
    auto_raise: false } })
  try {
    assert.deepEqual(tabs(m.view.el).map((t) => t.textContent?.trim()),
      ['Basic', 'Policies', 'Org type', 'Mailserver'])
    // …and the strip and the panels agree: no orphan panel for a tab that
    // is not offered
    assert.equal(m.view.el.querySelector('#org-settings-panel-autonomy'), null)
  } finally { await m.view.unmount(); delete g.fetch }
})

test('⑤  the kiosk ceiling calls its MCP field ADDITIONAL, and says the '
  + 'Orgtree server is always there', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg({
    kiosk: { enabled: true, credits: 5, spend_limit: 0, storage_limit_mb: 0,
      sandbox: false, share_url: null, auto_raise: false,
      max_scope: { tools: { bash: true, web: false, edit: true,
        subagents: false, mcp: [] }, add_dirs: [], org_visibility: 'full',
        permission_mode: 'acceptEdits', max_tier: null } },
  })
  try {
    await open(view.el, 'Org type')
    const panel = view.el.querySelector<HTMLElement>(
      '#org-settings-panel-orgtype')!
    const box = panel.querySelector<HTMLInputElement>(
      'input[aria-label="additional MCP servers"]')
    assert.ok(box, 'the ceiling MCP field is not labelled "additional"')
    // an empty box must not read as "zero callable MCP tools"
    assert.match(panel.textContent ?? '', /always available to every agent/)
  } finally { await view.unmount(); delete g.fetch }
})

test('⑥  content-filter policy: auto-autopsy reveals model selector without fable and saves chosen model', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view, closed } = await mountOrg()
  try {
    await open(view.el, 'Policies')
    const policySelect = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="fable content-filter policy"]')
    assert.ok(policySelect, 'policy select not found')

    const options = [...policySelect.options].map((o) => o.value)
    assert.ok(options.includes('auto-autopsy'), 'auto-autopsy not in policy options')

    // While policy is halt, autopsy model select is not rendered
    assert.equal(view.el.querySelector('select[aria-label="autopsy model"]'), null)

    // Switch policy to auto-autopsy
    await setField(policySelect, 'auto-autopsy')

    // Now autopsy model select is revealed
    const modelSelect = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="autopsy model"]')
    assert.ok(modelSelect, 'autopsy model select not revealed')

    // Fable must NOT be among the choices
    const modelOptions = [...modelSelect.options].map((o) => o.value)
    assert.equal(modelOptions.includes('fable'), false, 'fable must not be selectable as autopsy model')
    assert.ok(modelOptions.includes('opus'), 'opus should be offered')
    assert.ok(modelOptions.includes('sonnet'), 'sonnet should be offered')

    // Select sonnet
    await setField(modelSelect, 'sonnet')

    // Click save
    seen.length = 0
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(12) })

    const settings = seen.find((r) => r.method === 'POST'
      && r.path === '/api/orgs/acme/settings')
    assert.ok(settings, 'save did not POST settings')
    const body = settings!.body as Record<string, unknown>
    assert.equal(body.fable_filter_policy, 'auto-autopsy')
    assert.equal(body.fable_filter_model, 'sonnet')
    assert.equal(closed.length, 1)
  } finally { await view.unmount(); delete g.fetch }
})

