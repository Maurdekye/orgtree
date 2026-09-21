// shellviews.test.tsx — the compact menu, the Homepage and Create views, and
// the rule that decides what a window does when asked to open an
// organization.
//
// The properties under test are the settled ones that are easy to get subtly
// wrong and impossible to notice afterwards:
//
//   · exactly ONE outcome of `requestOrg` changes the calling window, and a
//     window never falls back to switching its own organization;
//   · creating ALWAYS opens a separate window, so a Homepage is never consumed
//     by starting a creation;
//   · a creation failure keeps every detail entered;
//   · the dirty flag is published truthfully and cleared in exactly the two
//     terminal cases;
//   · the menu exists in all four views and carries Usage and App settings,
//     because Homepage and Create have no header action buttons at all.
//
// Run:  node apps/desktop/renderer/tests/run.mjs shellviews
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgtreeMenu } from '../src/shell/menu'
import { HomepageView } from '../src/shell/homepage'
import { CreateOrgView, creationDirty } from '../src/shell/createorg'
import { openOrgEffect, refusalText } from '../src/shell/openorg'
import { OrgViewToggle } from '../src/shell/modetoggle'
import { OrgStatusBar } from '../src/shell/statusbar'
import { useOpenOrgs } from '../src/shell/openorgs'
import { installBridge, removeBridge, typeInto } from './shellbridge'
import type { OrgListEntry, TreePayload } from '../src/types'

const entry = (slug: string, patch: Partial<OrgListEntry> = {}): OrgListEntry => ({
  slug, name: slug, nodes: 3, live: 2, kiosk: false, created: null, ...patch,
})
const ORGS = [entry('studio', { name: 'Studio', working: 2, live: 5 }),
  entry('workshop', { name: 'Workshop', working: 0, live: 1 })]

// ---------------------------------------------- §1 one outcome, one window

test('bound is the ONLY outcome that changes the calling window', () => {
  assert.deepEqual(openOrgEffect({ action: 'bound', org: 'studio' }, 'Studio'),
    { bind: 'studio' })
  // the settled rule is one main window per organization, and this window is
  // not it — the Homepage that asked stays exactly where it was
  const focused = openOrgEffect({ action: 'focused', org: 'studio' }, 'Studio')
  assert.equal(focused.bind, undefined, 'a focused organization never rebinds the caller')
  assert.match(focused.notice ?? '', /already open/)
  assert.deepEqual(openOrgEffect({ action: 'opened', org: 'studio' }, 'Studio'), {},
    'native already made the window; this one does nothing')
  assert.deepEqual(openOrgEffect({ action: 'pending', org: 'studio' }, 'Studio'), {},
    'somebody else is mid-open; racing them is the bug this prevents')
})

test('a refusal is actionable, and an unknown one is reported rather than swallowed', () => {
  const refused = openOrgEffect(
    { action: 'refused', org: 'studio', reason: 'already-bound' }, 'Studio')
  assert.equal(refused.bind, undefined)
  assert.match(refused.error ?? '', /already belongs to an organization/)
  assert.match(refusalText('invalid-org', 'Studio'), /not a valid organization/)
  assert.match(refusalText('something-new', 'Studio'), /something-new/,
    'a refusal nobody can read is worse than an ugly one')
})

// ------------------------------------------------------- §2 the app menu

async function menu(over: Partial<Parameters<typeof OrgtreeMenu>[0]> = {}) {
  const calls: string[] = []
  const view = await mountView(
    <OrgtreeMenu orgs={ORGS} freshness="current" ageMs={0} error={null}
      currentOrg={null} appVersion="3.0.0-alpha.0"
      onOpenOrg={(s) => calls.push('open:' + s)}
      onNewWindow={() => calls.push('new-window')}
      onCreateOrg={() => calls.push('create')}
      onUsage={() => calls.push('usage')}
      onAppSettings={() => calls.push('settings')}
      {...over} />,
    (el) => el)
  const item = (label: string) => [...view.el.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((b) => b.textContent?.includes(label))
  return { view, calls, item }
}

test('the menu carries every route the removed sidebar did, Usage included', async () => {
  const m = await menu()
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    for (const label of ['New window', 'Open organization', 'Create new organization',
      'Usage', 'App settings', 'About Orgtree']) {
      assert.ok(m.item(label), `the menu offers "${label}"`)
    }
    // ⚠ Usage and App settings are here because Homepage and Create windows
    // have no header action buttons at all; without them those two windows
    // would silently lose the usage snapshots the shell must preserve.
    await inAct(async () => { m.item('Usage')!.click() })
    assert.deepEqual(m.calls, ['usage'])
    assert.equal(m.view.el.querySelector('.shell-menu-panel'), null,
      'choosing an entry closes the menu')
  } finally { await m.view.unmount() }
})

test('the About entry shows the REAL running version, and none when there is none', async () => {
  let m = await menu()
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    assert.match(m.item('About Orgtree')!.textContent ?? '', /3\.0\.0-alpha\.0/)
  } finally { await m.view.unmount() }
  m = await menu({ appVersion: null })
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    assert.equal(m.item('About Orgtree')!.querySelector('.shell-menu-value'), null,
      'a browser has no packaged version and is given no invented one')
  } finally { await m.view.unmount() }
})

test('the menu is keyboard-operable and Escape returns focus to its button', async () => {
  const m = await menu()
  try {
    const btn = m.view.el.querySelector<HTMLElement>('.shell-menu-button')!
    await inAct(async () => {
      btn.focus()
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await flush(4)
    })
    assert.ok(m.view.el.querySelector('.shell-menu-panel'), 'ArrowDown opens it')
    assert.equal((document.activeElement as HTMLElement)?.getAttribute('role'), 'menuitem',
      'and lands on the first item rather than nowhere')
    await inAct(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush(4)
    })
    assert.equal(m.view.el.querySelector('.shell-menu-panel'), null)
    assert.equal(document.activeElement, btn,
      'focus comes back to the button, not to the document body')
  } finally { await m.view.unmount() }
})

test('the menu reports when its organization list is open, so the poller runs for it', async () => {
  const seen: boolean[] = []
  const m = await menu({ onOrgListOpen: (v: boolean) => seen.push(v) })
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    await inAct(async () => { m.item('Open organization')!.click(); await flush(4) })
    assert.equal(seen.at(-1), true, 'opening the list says so')
    await inAct(async () => { m.item('Open organization')!.click(); await flush(4) })
    assert.equal(seen.at(-1), false, 'and closing it says so')
  } finally {
    await m.view.unmount()
    assert.equal(seen.at(-1), false,
      'a menu that unmounts with its list open must not leave the poller believing otherwise')
  }
})

test('an unfresh snapshot withholds the menu list’s counts too', async () => {
  const m = await menu({ freshness: 'loading' })
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    await inAct(async () => { m.item('Open organization')!.click(); await flush(4) })
    const values = [...m.view.el.querySelectorAll('.shell-menu-org .shell-menu-value')]
      .map((s) => s.textContent)
    assert.deepEqual(values, ['…', '…'],
      'the same rule the rows obey — no old number presented as current')
  } finally { await m.view.unmount() }
})

// -------------------------------------------------------- §3 the Homepage

test('the Homepage opens an organization and creates in a SEPARATE window', async () => {
  const calls: string[] = []
  const view = await mountView(
    <HomepageView orgs={ORGS} freshness="current" ageMs={0} error={null}
      onOpenOrg={(s) => calls.push('open:' + s)}
      onCreateOrg={() => calls.push('create')}
      onDelete={() => calls.push('delete')} />,
    (el) => el)
  try {
    await inAct(async () => {
      (view.el.querySelector('.org') as HTMLElement).click()
    })
    assert.deepEqual(calls, ['open:studio'])
    await inAct(async () => {
      (view.el.querySelector('.shell-create-btn') as HTMLElement).click()
    })
    // ⚠ the Homepage is NOT consumed by starting a creation — if the creation
    // is abandoned the organization list is still here behind it
    assert.deepEqual(calls, ['open:studio', 'create'])
    assert.ok(view.el.querySelector('.shell-homepage-list'), 'the list is still on screen')
  } finally { await view.unmount() }
})

test('an organization already open elsewhere says so instead of showing a count', async () => {
  const view = await mountView(
    <HomepageView orgs={ORGS} freshness="current" ageMs={0} error={null}
      isOpenElsewhere={(s) => s === 'studio'}
      onOpenOrg={() => {}} onCreateOrg={() => {}} onDelete={() => {}} />,
    (el) => el)
  try {
    const rows = [...view.el.querySelectorAll('.org')]
    assert.equal(rows[0]!.querySelector('.org-open-badge')?.textContent, 'Already open')
    assert.equal(rows[1]!.querySelector('.org-open-badge'), null)
  } finally { await view.unmount() }
})

// ---------------------------------------------------------- §4 the Create

test('what counts as unfinished input, exactly', () => {
  const clean = { name: '', dirs: [], netAuto: true, netHubs: [] }
  assert.equal(creationDirty(clean), false)
  assert.equal(creationDirty({ ...clean, name: 'x' }), true)
  assert.equal(creationDirty({ ...clean, name: '   ' }), false, 'whitespace is not input')
  assert.equal(creationDirty({ ...clean, dirs: ['C:/work'] }), true)
  assert.equal(creationDirty({ ...clean, netHubs: ['http://h'] }), true)
  // turning the default OFF is a decision, and losing it silently is the same
  // loss as losing a typed name
  assert.equal(creationDirty({ ...clean, netAuto: false }), true)
})

async function createView(opts: {
  create?: (body: unknown) => unknown
  onCreated?: (slug: string) => Promise<void> | void
} = {}) {
  useFakeClock()
  const old = globalThis.fetch
  const dirty: boolean[] = []
  const closed: number[] = []
  const bridge = installBridge({
    requestOrg: async () => ({ action: 'pending', org: 'x' }),
    setUnsavedCreation: async (v: boolean) => { dirty.push(v) },
    closeWindow: async () => { closed.push(1) },
  })
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const made = opts.create ? opts.create(body) : { slug: 'research' }
    if (made instanceof Error) {
      return { ok: false, status: 400, headers: new Headers(),
        text: async () => JSON.stringify({ detail: made.message }),
        json: async () => ({ detail: made.message }) } as Response
    }
    return { ok: true, headers: new Headers(), json: async () => made } as Response
  }) as unknown as typeof fetch
  const created: string[] = []
  const view = await mountView(
    <CreateOrgView
      onCreated={opts.onCreated ?? ((s) => { created.push(s) })}
      onRequestClose={() => { void bridge.closeWindow!() }} />,
    (el) => el)
  await inAct(async () => { await flush(4) })
  return {
    view, dirty, closed, created,
    name: () => view.el.querySelector<HTMLInputElement>('#shell-create-name')!,
    submit: () => view.el.querySelector<HTMLFormElement>('form')!,
    async stop() { await view.unmount(); globalThis.fetch = old; removeBridge(bridge); realClock() },
  }
}

test('the dirty flag is published on the flip, not per keystroke', async () => {
  const c = await createView()
  try {
    assert.deepEqual(c.dirty, [], 'an untouched form publishes nothing')
    await inAct(async () => {
      typeInto(c.name(), 'R')
      await flush(4)
    })
    assert.deepEqual(c.dirty, [true])
    await inAct(async () => {
      typeInto(c.name(), 'Research')
      await flush(4)
    })
    assert.deepEqual(c.dirty, [true], 'still dirty, and saying so again says nothing new')
    await inAct(async () => {
      typeInto(c.name(), '')
      await flush(4)
    })
    assert.deepEqual(c.dirty, [true, false], 'emptying it publishes the flip back')
  } finally { await c.stop() }
})

test('Cancel is a WINDOW CLOSE, so the confirmation in front of it is the native one', async () => {
  const c = await createView()
  try {
    await inAct(async () => {
      typeInto(c.name(), 'Research')
      await flush(4)
    })
    const cancel = [...c.view.el.querySelectorAll('button')]
      .find((b) => b.textContent === 'Cancel')!
    await inAct(async () => { cancel.click(); await flush(4) })
    assert.equal(c.closed.length, 1, 'it asks the window to close')
    assert.equal(c.name().value, 'Research',
      'and resets nothing itself — a Cancel that wiped the form would be the one discard with no confirmation in front of it')
    assert.equal(c.dirty.at(-1), true, 'the flag still stands; only a confirmed discard clears it')
  } finally { await c.stop() }
})

test('a failed creation keeps every detail and says what went wrong', async () => {
  const c = await createView({ create: () => new Error('an organization named Research already exists') })
  try {
    await inAct(async () => {
      typeInto(c.name(), 'Research')
      await flush(4)
    })
    await inAct(async () => { c.submit().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(10) })
    assert.match(c.view.el.querySelector('.shell-create-error')?.textContent ?? '',
      /already exists/, 'an actionable error')
    assert.equal(c.name().value, 'Research', 'and nothing entered is thrown away')
    assert.equal(c.dirty.at(-1), true, 'a failure is not terminal, so the flag stands')
    assert.deepEqual(c.created, [], 'and no window was bound')
  } finally { await c.stop() }
})

test('a successful creation clears the flag before it binds', async () => {
  const c = await createView()
  try {
    await inAct(async () => {
      typeInto(c.name(), 'Research')
      await flush(4)
    })
    await inAct(async () => { c.submit().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(10) })
    assert.deepEqual(c.created, ['research'], 'this window becomes the new organization')
    assert.equal(c.dirty.at(-1), false,
      'success is terminal for the form, whatever the binding then does')
  } finally { await c.stop() }
})

// ----------------------------------------------------- §5 the mode toggle

test('the toggle is a radio group with both labels always visible', async () => {
  const picked: string[] = []
  const view = await mountView(
    <OrgViewToggle mode="canvas" setMode={(m) => picked.push(m)} attentionAvailable={false} />,
    (el) => el)
  try {
    const radios = [...view.el.querySelectorAll('[role="radio"]')]
    assert.deepEqual(radios.map((r) => r.textContent), ['Canvas', 'Attention'])
    assert.equal(radios[0]!.getAttribute('aria-checked'), 'true')
    assert.match(radios[1]!.getAttribute('title') ?? '', /not available in this build yet/,
      'an unavailable destination says so rather than pretending')
    await inAct(async () => { (radios[1] as HTMLElement).click() })
    assert.deepEqual(picked, ['attention'])
    await inAct(async () => { (radios[0] as HTMLElement).click() })
    assert.deepEqual(picked, ['attention'], 'choosing the current mode is not a change')
  } finally { await view.unmount() }
})

// ---------------------------------------------------- §6 the status strip

const TREE = {
  slug: 'studio', name: 'Studio', roots: [], tiers: {},
  audit: { no_overdraft: true, problems: [] },
  cost_usd_total: 4.5, cost_usd_unknown: false,
  net: { hubs: [{ id: 'local', name: 'local hub', address: 'x', enabled: true, hidden: false, connected: true, queued: 0 }] },
} as unknown as TreePayload

test('the strip carries the chip run with its click-through, and pins the error', async () => {
  const opened: number[] = []
  const view = await mountView(
    <OrgStatusBar tree={TREE} orgs={[]} error="signal timed out"
      onOpenConnections={() => opened.push(1)} />,
    (el) => el)
  try {
    assert.ok(view.el.querySelector('.chip.agents'), 'the live/active agent chip')
    assert.match(view.el.textContent ?? '', /\$4\.50/, 'the cost chip')
    const hub = [...view.el.querySelectorAll('.chip')]
      .find((c) => c.textContent?.includes('local hub'))!
    assert.match(hub.getAttribute('title') ?? '', /click to open Connections/)
    await inAct(async () => { (hub as HTMLElement).click() })
    assert.deepEqual(opened, [1], 'a failure’s diagnostics stay one click from the failure')
    // ⚠ OUTSIDE the scrolling run: an error carried off the end of a row
    // nobody scrolls is an error nobody reads
    const err = view.el.querySelector('.shell-statusbar-error')!
    assert.equal(err.getAttribute('role'), 'alert')
    assert.equal(err.closest('.shell-statusbar-chips'), null)
  } finally { await view.unmount() }
})

// ------------------------------------------------- §7 which orgs are open

test('the open-organization list is a LABEL, kept live by an event and never polled', async () => {
  let fire: (e: { type: string; data: unknown }) => void = () => {}
  let asked = 0
  const bridge = installBridge({
    openOrgs: async () => { asked++; return ['studio'] },
    onEvent: (fn: typeof fire) => { fire = fn; return () => { fire = () => {} } },
  })
  try {
    function View() {
      const open = useOpenOrgs()
      return <span className="open">{[...open].sort().join(',') || '-'}</span>
    }
    useFakeClock()
    const view = await mountView(<View />, (el) => el.querySelector('.open')!.textContent)
    await inAct(async () => { await flush(6) })
    assert.equal(view.last(), 'studio')
    assert.equal(asked, 1, 'one read at mount')
    // a window binds, opens or closes anywhere in the application
    await inAct(async () => { fire({ type: 'open-orgs', data: ['studio', 'workshop'] }); await flush(4) })
    assert.equal(view.last(), 'studio,workshop')
    await inAct(async () => { fire({ type: 'open-orgs', data: { orgs: ['workshop'] } }); await flush(4) })
    assert.equal(view.last(), 'workshop', 'the payload may name the list or be the list')
    await inAct(async () => { fire({ type: 'open-orgs', data: 'nonsense' }); await flush(4) })
    assert.equal(view.last(), 'workshop', 'an unreadable payload is not evidence that nothing is open')
    await advance(60_000)
    assert.equal(asked, 1, 'and it is never polled — this arrives on every bind, open and close')
    await view.unmount(); realClock()
  } finally { removeBridge(bridge) }
})

test('a shell that does not publish the list leaves every row unlabelled', async () => {
  const bridge = installBridge({})   // no openOrgs
  try {
    function View() {
      const open = useOpenOrgs()
      return <span className="open">{open.size}</span>
    }
    const view = await mountView(<View />, (el) => el.querySelector('.open')!.textContent)
    await inAct(async () => { await flush(6) })
    // ⚠ an empty set means NO ROW IS LABELLED, never that a row is known not
    // to be open. The behaviour never depended on this: requestOrg answers
    // `focused` and brings the window forward either way.
    assert.equal(view.last(), '0')
    await view.unmount()
  } finally { removeBridge(bridge) }
})
