// switchboardicons.test.tsx — user 2026-09-11: "remove mail icon from
// switchboard; remove agent hire defaults icon and put it as a new tab in Org
// settings", steered the same hour with "remove these icons from switchboard
// zoomed-in view where it shows desks too … both overview and zoomed-in
// desks".
//
// So there were FOUR buttons, not two, and this file states the removal as
// two properties — one per surface — plus the move of what the ⚙ opened.
//
// ⚠ THE USER THEN PARTLY REVERSED IT (2026-09-11 06:49). The OVERVIEW card's
// ✉ and ⚙ come back, but ONLY with "Show agent card shortcuts" enabled, whose
// default stays off; the ⚙ opens GENERAL org settings rather than the Hire
// defaults tab; both stay gone from the zoomed-in switchboard head; and the
// eye gains a context menu carrying Inbox, Org settings and Retire all
// agents, reachable whether or not that setting is on. §1 therefore tests
// the DEFAULT (still bare), §1b the enabled case, and §7 the menu — which is
// the route that does not depend on the setting at all.
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
import fs from 'node:fs'
import path from 'node:path'
import { EyeDesk, UserNode } from '../src/canvas/cards'
import { SettingsPanel } from '../src/App'
import { setAgentShortcutsOn, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const src = (name: string) => fs.readFileSync(path.join(__SRC_DIR__, name), 'utf8')

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }

/** the eye card, with whatever handlers the case under test cares about */
const eye = (over: Partial<Parameters<typeof UserNode>[0]> = {}) => (
  <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={seats}
    pub={false} kiosk={undefined} kioskRemaining={null} pxc={1} zoom={1}
    onSpawn={noop} onMailLink={noop} focused={false} eyeW={124}
    posX={() => 0} map={new Map()} op={op} slug="org" toast={noop} {...over} />
)

/** every button on the surface, by its icon's test id. MUI icons render
 *  `data-testid="MailIcon"` / `"SettingsIcon"`, which is what lets this ask
 *  "is there a mail button" without depending on a class name that the
 *  removal was free to change. */
const iconButtons = (el: HTMLElement, icon: string) =>
  [...el.querySelectorAll('button')]
    .filter((b) => b.querySelector(`[data-testid="${icon}"]`))

// ========================================================= §1 THE OVERVIEW

test('§1 BY DEFAULT the overseer eye card carries no ✉ and no ⚙', async (t) => {
  setAgentShortcutsOn(false)
  const view = await mountView(eye({ onInbox: noop, onGear: noop }), (el) => el)
  t.after(() => view.unmount())
  // ⚠ the handlers ARE passed above, deliberately. Asserting "no buttons"
  // against a card that was given nothing to call would pass for the wrong
  // reason — it is the SETTING that must hide them, not a missing prop.

  // POSITIVE CONTROL — the card really rendered. Without these two, the
  // assertions below would pass against an empty div.
  assert.ok(view.el.querySelector('.sq.user svg.eye'), 'the eye did not render')
  assert.ok(view.el.querySelector('.sq.user .hsof'),
    'the hire strip did not render — the fixture, not the icons, is at fault')

  assert.equal(iconButtons(view.el, 'MailIcon').length, 0,
    'the mail button is still on the overview eye card')
  assert.equal(iconButtons(view.el, 'SettingsIcon').length, 0,
    'the agent-hire-defaults ⚙ is still on the overview eye card')
  assert.equal(view.el.querySelector('.eye-inbox'), null)
  assert.equal(view.el.querySelector('.eye-gear'), null)
})

test('§1b …and WITH agent-card shortcuts on they come back, wired to the '
  + 'inbox and to general org settings', async (t) => {
  setAgentShortcutsOn(true)
  t.after(() => setAgentShortcutsOn(false))
  const opened: string[] = []
  const view = await mountView(eye({
    onInbox: () => opened.push('inbox'), onGear: () => opened.push('gear'),
  }), (el) => el)
  t.after(() => view.unmount())

  const mail = view.el.querySelector<HTMLButtonElement>('.eye-inbox')
  const gear = view.el.querySelector<HTMLButtonElement>('.eye-gear')
  assert.ok(mail, 'the ✉ did not return with the setting on')
  assert.ok(gear, 'the ⚙ did not return with the setting on')
  await inAct(async () => { mail!.click(); gear!.click(); await flush() })
  assert.deepEqual(opened, ['inbox', 'gear'])
  // the ⚙ opens the WHOLE settings modal, not one tab of it — so its label
  // must not promise the hire defaults
  assert.equal(gear!.title, 'org settings')
})

test('§1c a card with nowhere to send the reader shows no control for it — '
  + 'a public org has no settings door, so no ⚙ appears', async (t) => {
  setAgentShortcutsOn(true)
  t.after(() => setAgentShortcutsOn(false))
  const view = await mountView(eye({ onInbox: noop }), (el) => el)   // no onGear
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.eye-inbox'), 'the ✉ still shows')
  assert.equal(view.el.querySelector('.eye-gear'), null,
    'a ⚙ with no handler would be a dead control')
})

test('§1g enabled switchboard shortcuts are hidden at rest and appear on hover or keyboard focus', () => {
  const css = src('styles.css')
  // POSITIVE CONTROL: the stylesheet really loaded and has the base rules
  assert.ok(css.includes('.eye-inbox'), 'styles.css must contain .eye-inbox')
  assert.ok(css.includes('.eye-gear'), 'styles.css must contain .eye-gear')

  // 1. At rest: both .eye-inbox and .eye-gear are opacity: 0 and pointer-events: none
  assert.match(css, /\.eye-inbox,\r?\n\.eye-gear\s*\{[^}]*opacity:\s*0/s,
    'switchboard shortcuts must have opacity: 0 at rest')
  assert.match(css, /\.eye-inbox,\r?\n\.eye-gear\s*\{[^}]*pointer-events:\s*none/s,
    'switchboard shortcuts must have pointer-events: none at rest')

  // 2. On card hover: revealed on .sq.user:hover and .sq:hover
  assert.match(css, /\.sq\.user:hover\s+\.eye-inbox/s, 'card hover must reveal .eye-inbox')
  assert.match(css, /\.sq\.user:hover\s+\.eye-gear/s, 'card hover must reveal .eye-gear')
  assert.match(css, /\.sq:hover\s+\.eye-inbox/s, '.sq:hover must reveal .eye-inbox')
  assert.match(css, /\.sq:hover\s+\.eye-gear/s, '.sq:hover must reveal .eye-gear')

  // 3. On keyboard focus: revealed on .sq.user:focus-within, direct :focus, and :focus-visible
  assert.match(css, /\.sq\.user:focus-within\s+\.eye-inbox/s,
    'card focus-within must reveal .eye-inbox')
  assert.match(css, /\.sq\.user:focus-within\s+\.eye-gear/s,
    'card focus-within must reveal .eye-gear')
  assert.match(css, /\.eye-inbox:focus/s, 'direct focus must reveal .eye-inbox')
  assert.match(css, /\.eye-gear:focus/s, 'direct focus must reveal .eye-gear')
  assert.match(css, /\.eye-inbox:focus-visible/s, 'focus-visible must reveal .eye-inbox')
  assert.match(css, /\.eye-gear:focus-visible/s, 'focus-visible must reveal .eye-gear')

  // 4. The reveal rule grants opacity: .8 and pointer-events: auto
  const revealMatch = /\.sq\.user:hover\s+\.eye-inbox[\s\S]*?\{([^}]*)\}/.exec(css)
  assert.ok(revealMatch, 'reveal rule block must exist in styles.css')
  assert.match(revealMatch[1], /opacity:\s*\.8/, 'revealed shortcuts must have opacity: .8')
  assert.match(revealMatch[1], /pointer-events:\s*auto/, 'revealed shortcuts must have pointer-events: auto')

  // 5. Hovering a shortcut button directly provides full contrast
  const btnHover = /\.eye-inbox:hover,\r?\n\.eye-gear:hover\s*\{([^}]*)\}/.exec(css)
  assert.ok(btnHover, 'button direct hover rule must exist')
  assert.match(btnHover[1], /opacity:\s*1\s*!important/, 'button hover must have full opacity')
})

test('§1h the controls remain clickable, focusable, and do not shift card layout when revealed', async (t) => {
  setAgentShortcutsOn(true)
  t.after(() => setAgentShortcutsOn(false))
  const opened: string[] = []
  let view!: Awaited<ReturnType<typeof mountView>>
  await inAct(async () => {
    view = await mountView(eye({
      onInbox: () => opened.push('inbox'), onGear: () => opened.push('gear'),
    }), (el) => el)
  })
  t.after(() => view.unmount())

  // POSITIVE CONTROLS
  const card = view.el.querySelector<HTMLElement>('.sq.user')!
  assert.ok(card, 'positive control: .sq.user rendered')
  const eyeSvg = card.querySelector('svg.eye')!
  assert.ok(eyeSvg, 'positive control: svg.eye rendered')
  const userLabel = card.querySelector('.user-label')!
  assert.ok(userLabel, 'positive control: .user-label rendered')

  const mail = card.querySelector<HTMLButtonElement>('.eye-inbox')!
  const gear = card.querySelector<HTMLButtonElement>('.eye-gear')!
  assert.ok(mail, 'mail button exists')
  assert.ok(gear, 'gear button exists')

  // Clickable: clicking invokes handlers cleanly
  await inAct(async () => { mail.click(); gear.click(); await flush() })
  assert.deepEqual(opened, ['inbox', 'gear'], 'clicking revealed shortcuts invokes handlers')

  // Focusable: standard HTML button elements support keyboard focus
  assert.equal(mail.tagName, 'BUTTON')
  assert.equal(gear.tagName, 'BUTTON')
  assert.equal(mail.tabIndex, 0, 'mail button must be in tab sequence')
  assert.equal(gear.tabIndex, 0, 'gear button must be in tab sequence')
  await inAct(async () => { mail.focus(); await flush() })
  assert.equal(document.activeElement, mail, 'mail button receives keyboard focus')
  await inAct(async () => { gear.focus(); await flush() })
  assert.equal(document.activeElement, gear, 'gear button receives keyboard focus')

  // Does not shift card layout: buttons are positioned absolutely out of flow
  const css = src('styles.css')
  const posMatch = /\.eye-inbox,\r?\n\.eye-gear\s*\{([^}]*)\}/.exec(css)
  assert.ok(posMatch, 'positioning rule exists')
  assert.match(posMatch[1], /position:\s*absolute/, 'shortcuts must be position: absolute')
  assert.match(posMatch[1], /top:\s*6px/, 'shortcuts must be pinned to top: 6px')
})

test('§1i disabled shortcuts remain absent and cannot be focused', async (t) => {
  setAgentShortcutsOn(false)
  let view!: Awaited<ReturnType<typeof mountView>>
  await inAct(async () => {
    view = await mountView(eye({ onInbox: noop, onGear: noop }), (el) => el)
  })
  t.after(() => view.unmount())

  // POSITIVE CONTROL
  assert.ok(view.el.querySelector('.sq.user svg.eye'), 'the eye did not render')

  assert.equal(view.el.querySelector('.eye-inbox'), null, 'mail shortcut must not be mounted')
  assert.equal(view.el.querySelector('.eye-gear'), null, 'gear shortcut must not be mounted')
  assert.equal(iconButtons(view.el, 'MailIcon').length, 0)
  assert.equal(iconButtons(view.el, 'SettingsIcon').length, 0)
})

// ======================================== §1d-§1f THE EYE'S CONTEXT MENU
//
// The menu is the route that does NOT depend on the shortcuts setting, which
// is what makes turning that setting off a tidying rather than a loss. Every
// test here runs with the setting OFF for exactly that reason — if any of
// them needed it on, the claim would be untrue.

const WIN = window as unknown as Window & typeof globalThis
const menuLabels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => b.textContent ?? '')
const menuItem = (label: string) =>
  [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
    .find((b) => b.textContent === label) as HTMLButtonElement | undefined

async function rightClick(el: Element) {
  const ev = new WIN.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(async () => { el.dispatchEvent(ev); await flush(2) })
  return ev.defaultPrevented
}

test('§1d the eye’s context menu reaches the inbox and org settings with '
  + 'the shortcut buttons OFF', async (t) => {
  setAgentShortcutsOn(false)
  const opened: string[] = []
  const view = await mountView(eye({
    onInbox: () => opened.push('inbox'), onGear: () => opened.push('gear'),
  }), (el) => el)
  t.after(async () => { await view.unmount() })

  // POSITIVE CONTROL: the buttons really are absent, so what follows cannot
  // be passing through them
  assert.equal(view.el.querySelector('.eye-inbox'), null)
  assert.equal(view.el.querySelector('.eye-gear'), null)

  const took = await rightClick(view.el.querySelector('.sq.user')!)
  assert.equal(took, true, 'the eye must take the right-click, not leave it '
    + 'to the browser menu')
  assert.deepEqual(menuLabels(),
    ['Open inbox', 'Org settings', 'Retire all agents…'])

  await inAct(async () => { menuItem('Open inbox')!.click(); await flush(2) })
  assert.deepEqual(opened, ['inbox'])
  await rightClick(view.el.querySelector('.sq.user')!)
  await inAct(async () => { menuItem('Org settings')!.click(); await flush(2) })
  assert.deepEqual(opened, ['inbox', 'gear'])
})

test('§1e Retire all agents asks first, and only then sends the one request '
  + 'the settings tab’s own button sends', async (t) => {
  setAgentShortcutsOn(false)
  const seen: { method: string; path: string }[] = []
  const g = globalThis as unknown as Record<string, unknown>
  const old = g.fetch
  g.fetch = (url: string, init?: RequestInit) => {
    seen.push({ method: init?.method ?? 'GET',
      path: new URL(String(url), 'http://localhost').pathname })
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve({ nodes: 3, freed: 9 }) })
  }
  const view = await mountView(eye({ onInbox: noop, onGear: noop }), (el) => el)
  t.after(async () => { await view.unmount(); g.fetch = old })

  await rightClick(view.el.querySelector('.sq.user')!)
  await inAct(async () => { menuItem('Retire all agents…')!.click(); await flush(2) })

  // ⚠ THE CONFIRMATION IS THE POINT, and this is the assertion that fails if
  // the entry ever becomes a one-click retirement of the whole org.
  const dialog = [...document.querySelectorAll('h3, .modal h3, .overlay h3')]
    .find((h) => /dissolve ALL agents/i.test(h.textContent ?? ''))
  assert.ok(dialog, 'no confirmation appeared before retiring every agent')
  assert.equal(seen.length, 0, 'nothing may be sent before the user confirms')

  const confirm = [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === 'dissolve all')
  assert.ok(confirm, 'the confirmation offers no way through')
  await inAct(async () => { confirm!.click(); await flush(4) })
  assert.deepEqual(seen,
    [{ method: 'POST', path: '/api/orgs/org/dissolve-all' }])
})

test('§1f the menu is absent at switchboard focus, where the open surface '
  + 'owns the right-click', async (t) => {
  setAgentShortcutsOn(false)
  const view = await mountView(eye({
    onInbox: noop, onGear: noop, focused: true, eyeW: 1200,
  }), (el) => el)
  t.after(async () => { await view.unmount() })
  // POSITIVE CONTROL: the focused eye really did render its switchboard
  assert.ok(view.el.querySelector('.eye-desk'), 'the switchboard did not mount')
  const took = await rightClick(view.el.querySelector('.sq.user')!)
  assert.equal(took, false, 'a right-click on the open switchboard must be '
    + 'left to the browser or to the row under it')
  assert.equal(document.querySelector('.ctxmenu'), null)
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
