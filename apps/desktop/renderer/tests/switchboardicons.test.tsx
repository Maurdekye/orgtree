// switchboardicons.test.tsx — user 2026-09-11: "remove mail icon from
// switchboard; remove agent hire defaults icon and put it as a new tab in Org
// settings", steered the same hour with "remove these icons from switchboard
// zoomed-in view where it shows desks too … both overview and zoomed-in
// desks".
//
// So there were FOUR buttons, not two, and this file states the removal as
// two properties — one per surface — plus the move of what the ⚙ opened.
//
// ⚠ ANTI-VACUITY, and it matters more than usual here: every assertion about
// the icons is a NEGATIVE ("no such button"), and a negative passes for free
// against a component that rendered nothing at all — a broken fixture, a
// prop rename, a mount that silently threw. So §1 and §2 each carry a
// POSITIVE CONTROL first: the surface must prove it rendered its own
// furniture (the eye, the hire strip; the tab strip, the `auto` toggle)
// before its missing buttons mean anything.
//
// ⚠ The save gate has its own anti-vacuity pair. §5 proves an edit on the new
// tab DOES reach both endpoints; §6 proves a save that never touched the tab
// sends NEITHER. A gate stuck open passes §5 and fails §6; a gate stuck shut
// passes §6 and fails §5. Neither test is worth anything without the other.
//
// Run:  cd frontend && node tests/run.mjs switchboardicons

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EyeDesk, UserNode } from '../src/canvas/cards'
import { SettingsPanel } from '../src/App'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }

/** every button on the surface, by its icon's test id. MUI icons render
 *  `data-testid="MailIcon"` / `"SettingsIcon"`, which is what lets this ask
 *  "is there a mail button" without depending on a class name that the
 *  removal was free to change. */
const iconButtons = (el: HTMLElement, icon: string) =>
  [...el.querySelectorAll('button')]
    .filter((b) => b.querySelector(`[data-testid="${icon}"]`))

// ========================================================= §1 THE OVERVIEW

test('§1 the overseer eye card carries no ✉ and no ⚙', async (t) => {
  const view = await mountView(
    <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
      stats={{ circ: 0, seats: 0, free: 0 }} seats={seats}
      pub={false} kiosk={undefined} kioskRemaining={null} pxc={1} zoom={1}
      onSpawn={noop} onMailLink={noop} focused={false} eyeW={124}
      posX={() => 0} map={new Map()} op={op} slug="org" toast={noop} />,
    (el) => el)
  t.after(() => view.unmount())

  // POSITIVE CONTROL — the card really rendered. Without these two, the
  // assertions below would pass against an empty div.
  assert.ok(view.el.querySelector('.sq.user svg.eye'), 'the eye did not render')
  assert.ok(view.el.querySelector('.sq.user .hsof'),
    'the hire strip did not render — the fixture, not the icons, is at fault')

  assert.equal(iconButtons(view.el, 'MailIcon').length, 0,
    'the mail button is still on the overview eye card')
  assert.equal(iconButtons(view.el, 'SettingsIcon').length, 0,
    'the agent-hire-defaults ⚙ is still on the overview eye card')
  // the classes the two buttons wore, gone with them (and with their CSS)
  assert.equal(view.el.querySelector('.eye-inbox'), null)
  assert.equal(view.el.querySelector('.eye-gear'), null)
})

// ============================================== §2 THE ZOOMED-IN SWITCHBOARD

function agent(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', model_id: 'haiku', parent: USER,
    mail_pending: 0, children: [], seat: 1, grant: 0, free: 0,
    audiences_held: [], scope: { tools: {}, add_dirs: [] },
  } as unknown as CanvasNode
}

test('§2 the switchboard head — the zoomed-in view with the desks — carries '
  + 'no ✉ and no ⚙ either', async (t) => {
  const map = new Map([['alpha', agent('alpha')]])
  const view = await mountView(
    <EyeDesk map={map} op={op} slug="swbicons" toast={noop} pub={false}
      eyeW={1200} posX={() => 0} onMailLink={noop} />, (el) => el)
  t.after(() => view.unmount())
  await flush()

  // POSITIVE CONTROL — the head rendered its own furniture: the agent's tab
  // and the `auto` toggle, which is the one head control the user did NOT
  // ask to remove.
  assert.equal(view.el.querySelectorAll('.eye-tab').length, 1,
    'the switchboard rendered no tabs — the fixture is at fault')
  assert.ok([...view.el.querySelectorAll('button')]
    .some((b) => b.textContent?.trim() === 'auto'),
  'the `auto` toggle is missing — it was not one of the two to remove')

  // The tab row has its own per-agent buttons; only the HEAD controls are in
  // question, so scope the search to the head rather than the whole desk.
  const head = view.el.querySelector<HTMLElement>('.eye-head')!
  const headButtons = [...head.children]
    .filter((c): c is HTMLElement => c.tagName === 'BUTTON')
  assert.equal(headButtons.filter((b) =>
    b.querySelector('[data-testid="MailIcon"]')).length, 0,
  'the mail button is still in the switchboard head')
  assert.equal(headButtons.filter((b) =>
    b.querySelector('[data-testid="SettingsIcon"]')).length, 0,
  'the agent-hire-defaults ⚙ is still in the switchboard head')
})

// ================================================ §3-§6 THE ORG SETTINGS TAB

const g = globalThis as unknown as Record<string, unknown>

/** an org whose hire defaults are all NON-DEFAULT, so §4 fails if the tab
 *  renders hardcoded fallbacks instead of what the org actually has saved. */
function tree(over: Record<string, unknown> = {}): TreePayload {
  return {
    slug: 'acme', name: 'Acme', nodes: [], edges: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
    default_effort: '', cascade_hire: true, cascade_alloc: true,
    fable_limit_policy: 'halt', fable_filter_policy: 'halt',
    auto_cheap_compact: { enabled: false, occ: 0.5 },
    auto_resume_compact: false,
    kiosk: null, sandboxed: false, disk: null, net: { hubs: [] },
    workspace: 'C:\\ws',
    dirs: [{ path: 'C:\\ws', mode: 'rw' }, { path: 'C:\\shared', mode: 'ro' }],
    default_tools: { bash: false, web: true, edit: true, subagents: false,
      mcp: ['*'] },
    default_visibility: 'team',
    permission_mode: 'plan',
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
      : path.startsWith('/api/mcp-servers')
        ? { servers: ['alpha-mcp'], sandbox_mcp: false }
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

async function open(el: HTMLElement, label: string) {
  const t = tabs(el).find((b) => b.textContent?.includes(label))
  assert.ok(t, `no tab labelled ${label}`)
  await inAct(async () => { t!.click(); await flush(10) })
  return t!
}

/** React ignores a plain `.value =` on a controlled field — go through the
 *  prototype setter and dispatch what React listens for. Same technique as
 *  tests/orgsettings.test.tsx. */
async function setField(el: HTMLSelectElement, v: string) {
  const w = el.ownerDocument.defaultView as unknown as {
    HTMLSelectElement: typeof HTMLSelectElement; Event: typeof Event
  }
  const setter = Object.getOwnPropertyDescriptor(
    w.HTMLSelectElement.prototype, 'value')?.set
  assert.ok(setter, 'no value setter on the element prototype')
  await inAct(async () => {
    setter!.call(el, v)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
    await flush()
  })
}

const save = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === 'save')!

test('§3 the ⚙ panel became a tab: every control it had is reachable there, '
  + 'and nothing opens a second modal to get to them', async (t) => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  t.after(async () => { await view.unmount(); delete g.fetch })

  // the tab is not fetched until it is opened — same lazy rule the other
  // fetching tabs follow
  assert.equal(seen.some((r) => r.path === '/api/mcp-servers'), false,
    'the unvisited tab issued its MCP request anyway')

  await open(view.el, 'Hire defaults')
  await inAct(async () => { await flush(10) })
  assert.ok(seen.some((r) => r.path === '/api/mcp-servers'))

  const panel = view.el.querySelector('[role="tabpanel"]:not([hidden])')!
  // the four controls the ⚙ panel carried, plus its danger row
  assert.ok(panel.querySelector('select[aria-label="org-structure visibility"]'))
  assert.ok(panel.querySelector('select[aria-label="permission mode for new agents"]'))
  assert.ok(panel.querySelector('input[aria-label="all registered MCP servers"]'))
  assert.ok(panel.querySelector('.dirlist'), 'folder access did not come across')
  assert.ok([...panel.querySelectorAll('button')]
    .some((b) => b.textContent?.trim() === 'dissolve all agents'),
  'dissolve all agents had no other door — it must have moved with the panel')

  // still ONE surface and ONE save: the tab is not a modal in a modal
  assert.equal(view.el.querySelectorAll('.overlay').length, 1)
  assert.equal([...view.el.querySelectorAll<HTMLButtonElement>('button')]
    .filter((b) => b.textContent?.trim() === 'save').length, 1)
})

test('§4 the tab shows the org’s SAVED values, not fresh defaults', async (t) => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  t.after(async () => { await view.unmount(); delete g.fetch })
  await open(view.el, 'Hire defaults')
  await inAct(async () => { await flush(10) })

  // the fixture's org is non-default in every one of these, so a tab that
  // ignored `tree` and rendered its own fallbacks fails here rather than
  // passing by coincidence
  assert.equal(view.el.querySelector<HTMLSelectElement>(
    'select[aria-label="org-structure visibility"]')!.value, 'team')
  assert.equal(view.el.querySelector<HTMLSelectElement>(
    'select[aria-label="permission mode for new agents"]')!.value, 'plan')
  const tools = [...view.el.querySelectorAll<HTMLInputElement>(
    '.checkline input[type="checkbox"]')]
  const byLabel = (word: string) => tools.find((i) =>
    i.parentElement?.textContent?.toLowerCase().includes(word))
  assert.equal(byLabel('bash')?.checked, false, 'bash: false was not honoured')
  assert.equal(byLabel('web')?.checked, true)
  assert.equal(byLabel('subagent')?.checked, false)

  // the org's own folder holding is listed, with the workspace shown as the
  // permanent RW row rather than an editable one
  const paths = [...view.el.querySelectorAll('.dirrow .chip')]
    .map((c) => c.textContent)
  assert.ok(paths.includes('C:\\shared'), 'the org holding is missing')
  assert.ok(paths.includes('C:\\ws'), 'the workspace row is missing')
  assert.equal(view.el.querySelectorAll('.dirrow .modebtn.rw').length, 1,
    'the workspace must be the only permanent RW row')
})

test('§5 one save carries the tab’s edits, and keeps the two-endpoint split '
  + 'the ⚙ panel had', async (t) => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view, closed } = await mountOrg()
  t.after(async () => { await view.unmount(); delete g.fetch })

  await open(view.el, 'Hire defaults')
  await inAct(async () => { await flush(10) })
  await setField(view.el.querySelector<HTMLSelectElement>(
    'select[aria-label="org-structure visibility"]')!, 'subtree')
  await setField(view.el.querySelector<HTMLSelectElement>(
    'select[aria-label="permission mode for new agents"]')!, 'acceptEdits')

  // wander to another tab and back: the panel's one buffer must hold the
  // edit, the way it does for Basic's fields
  await open(view.el, 'Basic')
  await open(view.el, 'Hire defaults')
  assert.equal(view.el.querySelector<HTMLSelectElement>(
    'select[aria-label="org-structure visibility"]')!.value, 'subtree')

  seen.length = 0
  await inAct(async () => { save(view.el).click(); await flush(12) })

  // the OPEN half rides /defaults — the ceiling-clamped endpoint, kept
  // separate exactly as the ⚙ panel kept it
  const defaults = seen.find((r) => r.method === 'POST'
    && r.path === '/api/orgs/acme/defaults')
  assert.ok(defaults, 'the hire defaults did not reach /defaults')
  const db = defaults!.body as Record<string, unknown>
  assert.equal(db.default_visibility, 'subtree')
  assert.deepEqual((db.default_tools as Record<string, unknown>).mcp, ['*'])

  // …and the ADMIN half rides /settings, in the SAME request as the rest of
  // the panel rather than a second call
  const settings = seen.filter((r) => r.method === 'POST'
    && r.path === '/api/orgs/acme/settings')
  assert.equal(settings.length, 1, 'the panel must POST /settings exactly once')
  const sb = settings[0]!.body as Record<string, unknown>
  assert.equal(sb.permission_mode, 'acceptEdits')
  assert.deepEqual(sb.org_dirs, [{ path: 'C:\\shared', mode: 'ro' }])
  assert.equal(sb.max_top_grant, 1000, 'the other tabs still save')
  // the workspace is never sent — the server re-adds it (api.py
  // `_org_settings_locked`), and sending it would make it an ordinary entry
  assert.equal((sb.org_dirs as { path: string }[])
    .some((d) => d.path === 'C:\\ws'), false)
  assert.equal(closed.length, 1, 'a successful save closes the panel')
})

test('§6 THE ZERO EDGE: a save that never touched the tab writes neither of '
  + 'its two payloads', async (t) => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  t.after(async () => { await view.unmount(); delete g.fetch })

  // open it — VISITING is not EDITING, and a gate that fired on mount would
  // pass a version of this test that never opened the tab at all
  await open(view.el, 'Hire defaults')
  await inAct(async () => { await flush(10) })
  await open(view.el, 'Basic')

  seen.length = 0
  await inAct(async () => { save(view.el).click(); await flush(12) })

  assert.equal(seen.some((r) => r.path === '/api/orgs/acme/defaults'), false,
    '/defaults was written without the tab being edited')
  const settings = seen.find((r) => r.method === 'POST'
    && r.path === '/api/orgs/acme/settings')
  assert.ok(settings, 'the ordinary settings save must still happen')
  const sb = settings!.body as Record<string, unknown>
  // an unchanged org_dirs makes the server walk every node hunting for
  // grants to revoke or downgrade, so an untouched tab must send no key
  assert.equal('org_dirs' in sb, false, 'org_dirs was sent unedited')
  assert.equal('permission_mode' in sb, false, 'permission_mode was sent unedited')
  assert.equal(sb.max_top_grant, 1000, 'the rest of the panel still saves')
})
