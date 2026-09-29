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
import React from 'react'
import assert from 'node:assert/strict'
import { OrgtreeMenu } from '../src/shell/menu'
import { HomepageView } from '../src/shell/homepage'
import { CreateOrgView, creationDirty } from '../src/shell/createorg'
import { openOrgEffect, refusalText } from '../src/shell/openorg'
import { OrgViewToggle } from '../src/shell/modetoggle'
import { OrgStatusBar } from '../src/shell/statusbar'
import { ShellAction, ShellHeader } from '../src/shell/header'
import { DocketToolbarButton } from '../src/canvas/docket'
import { AskBell } from '../src/App'
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
      currentOrg={null}
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
      'Usage', 'App settings']) {
      assert.ok(m.item(label), `the menu offers "${label}"`)
    }
    // user 2026-09-29: "About Orgtree" only opened App settings, which the
    // entry above already does, so it is gone; the version is on screen
    // without a click instead (see section 6)
    assert.equal(m.item('About'), undefined, 'no About entry')
    // ⚠ Usage and App settings are here because Homepage and Create windows
    // have no header action buttons at all; without them those two windows
    // would silently lose the usage snapshots the shell must preserve.
    await inAct(async () => { m.item('Usage')!.click() })
    assert.deepEqual(m.calls, ['usage'])
    assert.equal(m.view.el.querySelector('.shell-menu-panel'), null,
      'choosing an entry closes the menu')
  } finally { await m.view.unmount() }
})

test('the menu button is an icon with a name, not a word', async () => {
  const m = await menu()
  try {
    const btn = m.view.el.querySelector<HTMLElement>('.shell-menu-button')!
    assert.equal(btn.textContent?.trim(), '', 'no visible text on the button')
    assert.equal(btn.getAttribute('aria-label'), 'Orgtree menu')
    assert.equal(btn.getAttribute('title'), 'Orgtree menu', 'the tooltip names it')
    assert.ok(btn.querySelector('svg'), 'the icon is what shows')
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

test('Open organization… opens a SUBMENU beside the menu, not a list inside it', async () => {
  const m = await menu()
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    const panel = m.view.el.querySelector<HTMLElement>('.shell-menu-panel')!
    const itemsBefore = panel.querySelectorAll('[role="menuitem"]').length
    await inAct(async () => { m.item('Open organization')!.click(); await flush(4) })
    const sub = m.view.el.querySelector<HTMLElement>('.shell-menu-sub')
    assert.ok(sub, 'the submenu opens')
    assert.equal(sub!.getAttribute('role'), 'menu')
    // user 2026-09-29 (image-21): the main menu must not grow — the rows live
    // in their own menu, which is NOT inside the (scrolling) panel
    assert.equal(panel.contains(sub), false, 'the organizations are not inside the main menu')
    assert.equal(panel.querySelectorAll('[role="menuitem"]').length, itemsBefore,
      'the main menu gained no rows')
    const row = m.item('Open organization')!
    assert.equal(row.getAttribute('aria-haspopup'), 'menu')
    assert.equal(row.getAttribute('aria-controls'), sub!.id)
    assert.equal(sub!.querySelectorAll('.shell-menu-org').length, ORGS.length)
    // choosing an organization still opens it and closes the whole menu
    await inAct(async () => { sub!.querySelector<HTMLElement>('.shell-menu-org')!.click() })
    assert.deepEqual(m.calls, ['open:' + ORGS[0]!.slug])
    assert.equal(m.view.el.querySelector('.shell-menu-panel'), null)
    assert.equal(m.view.el.querySelector('.shell-menu-sub'), null)
  } finally { await m.view.unmount() }
})

test('the organization submenu is keyboard-reachable, and Escape steps back to its row', async () => {
  const m = await menu()
  try {
    await inAct(async () => { m.view.el.querySelector<HTMLElement>('.shell-menu-button')!.click() })
    const row = m.item('Open organization')!
    await inAct(async () => {
      row.focus()
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await flush(4)
    })
    const sub = m.view.el.querySelector<HTMLElement>('.shell-menu-sub')!
    assert.ok(sub, 'ArrowRight opens it')
    assert.ok(sub.contains(document.activeElement), 'and moves focus into it')
    await inAct(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await flush(2)
    })
    assert.ok(sub.contains(document.activeElement), 'arrows move within the submenu')
    await inAct(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flush(4)
    })
    assert.equal(m.view.el.querySelector('.shell-menu-sub'), null, 'Escape closes the submenu')
    assert.ok(m.view.el.querySelector('.shell-menu-panel'), '…but not the menu')
    assert.equal(document.activeElement, row, 'focus returns to the row')
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

// user 2026-09-29: "in the new organization window, make the advanced
// settings part of the window content, not a separate modal"
test('Advanced options fold out inside the window, with no modal, and Create applies them', async () => {
  const posted: Record<string, unknown>[] = []
  const c = await createView({ create: (body) => {
    if (body && typeof body === 'object' && 'name' in body) posted.push(body as Record<string, unknown>)
    return { slug: 'research' }
  } })
  try {
    const el = c.view.el
    const toggle = [...el.querySelectorAll<HTMLButtonElement>('button.disclosure')]
      .find((b) => b.textContent?.includes('Advanced options'))!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(el.querySelector('#shell-create-advanced'), null, 'folded by default')
    await inAct(async () => { toggle.click(); await flush(4) })
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    const section = el.querySelector('#shell-create-advanced')
    assert.ok(section, 'the settings are part of the page')
    assert.ok(section!.closest('form'), 'inside the creation form itself')
    assert.equal(el.ownerDocument.querySelector('.overlay, .modalpin-win, .adv-tabs'), null,
      'no modal, no tab strip')
    assert.ok(![...el.ownerDocument.querySelectorAll('button')].some((b) => b.textContent === 'done'),
      'no separate done step')
    assert.match(section!.textContent ?? '', /also grant existing folders/)
    assert.match(section!.textContent ?? '', /connect to this computer's mail hub/)
    assert.match(section!.textContent ?? '', /remote mail hubs/)

    const button = (text: string) => [...section!.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes(text))!
    await inAct(async () => { button('+ add folder').click(); await flush(4) })
    await inAct(async () => { button('+ add a remote mail hub address').click(); await flush(4) })
    await inAct(async () => {
      typeInto(section!.querySelector<HTMLInputElement>('.dirrow input')!, 'E:\work')
      typeInto(section!.querySelector<HTMLInputElement>('input[placeholder="http://host:7370"]')!, 'http://hub:7370')
      section!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
      typeInto(c.name(), 'Research')
      await flush(4)
    })
    await inAct(async () => { toggle.click(); await flush(4) })
    assert.equal(el.querySelector('#shell-create-advanced'), null, 'it folds back up')
    assert.match(toggle.textContent ?? '', /1 folder · hub/, 'and the folded row still says what is set')
    await inAct(async () => { c.submit().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(10) })
    assert.deepEqual(posted, [{ name: 'Research', dirs: ['E:\work'],
      net_autoconnect: false, net_hubs: ['http://hub:7370'] }],
    'folding the section away keeps what was set, and Create sends it exactly as before')
    assert.deepEqual(c.created, ['research'])
  } finally { await c.stop() }
})

// ----------------------------------------------------- §5 the mode toggle

test('the view switch shows ONE word, the current view, and flips on click', async () => {
  const picked: string[] = []
  function Host() {
    const [m, setM] = React.useState<'canvas' | 'attention'>('canvas')
    return <OrgViewToggle mode={m} setMode={(next) => { picked.push(next); setM(next) }} />
  }
  const view = await mountView(<Host />, (el) => el)
  try {
    const sw = () => view.el.querySelector<HTMLElement>('[role="switch"]')!
    assert.equal(view.el.querySelectorAll('[role="switch"]').length, 1, 'one control, not two')
    assert.equal(view.el.querySelectorAll('[role="radio"]').length, 0)
    const word = () => sw().querySelector('.shell-switch-word')!.textContent
    const icon = () => sw().querySelector('.shell-switch-knob svg')?.getAttribute('data-testid')
    assert.equal(word(), 'Canvas', 'only the current view is named')
    assert.doesNotMatch(sw().textContent ?? '', /Attention/, 'the other view is not shown')
    assert.equal(sw().getAttribute('aria-checked'), 'false')
    assert.equal(sw().getAttribute('aria-label'), 'Attention view')
    const canvasIcon = icon()
    assert.ok(canvasIcon, 'the knob carries an icon')
    await inAct(async () => { sw().click() })
    assert.deepEqual(picked, ['attention'])
    assert.equal(word(), 'Attention')
    assert.doesNotMatch(sw().textContent ?? '', /Canvas/)
    assert.equal(sw().getAttribute('aria-checked'), 'true')
    assert.ok(sw().classList.contains('on'), 'the knob moves to the other end')
    assert.notEqual(icon(), canvasIcon, 'the knob icon swaps with the view')
    await inAct(async () => { sw().click() })
    assert.deepEqual(picked, ['attention', 'canvas'], 'a click flips it back')
    // the arrow keys pick a side, and picking the current side is not a change
    await inAct(async () => {
      sw().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    assert.deepEqual(picked, ['attention', 'canvas'])
    await inAct(async () => {
      sw().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    assert.deepEqual(picked, ['attention', 'canvas', 'attention'])
  } finally { await view.unmount() }
})

// ------------------------------------------------ §5b the header buttons

test('header actions are icons with names and badges, and the killswitch sits left of them', async () => {
  const tree = { asks_open: 0, urgent_unread: 0, user_inbox_count: 4 }
  const view = await mountView(
    <ShellHeader menu={<span className="m" />} title="Studio"
      actions={<>
        <DocketToolbarButton label="Work" summary={{ attention: 0, active: 7 }} onClick={() => {}} />
        <AskBell tree={tree} label="Inbox" onOpen={() => {}} />
        <ShellAction label="Presentations" icon={<svg />} badge={<b className="eye-count">3</b>}
          onClick={() => {}} />
        <ShellAction label="Org settings" icon={<svg />} onClick={() => {}} />
      </>}
      guard={<span className="kill"><button type="button" className="kill-latch">L</button></span>} />,
    (el) => el)
  try {
    const buttons = [...view.el.querySelectorAll<HTMLElement>('.shell-header-actions > button')]
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')),
      ['Work', 'Inbox', 'Presentations', 'Org settings'], 'every button is named')
    // the only text a button may show is its count badge
    const shown = buttons.map((b) => {
      const clone = b.cloneNode(true) as HTMLElement
      clone.querySelectorAll('.eye-count').forEach((c) => c.remove())
      return clone.textContent?.trim()
    })
    assert.deepEqual(shown, ['', '', '', ''], 'no words on the buttons')
    assert.deepEqual(buttons.map((b) => b.querySelector('.eye-count')?.textContent ?? null),
      ['7', '4', '3', null], 'the same badge wherever a count applies')
    assert.equal(view.el.querySelector('.shell-action-label'), null)
    const guard = view.el.querySelector('.shell-header-guard')!
    assert.ok(guard.querySelector('.kill'), 'the killswitch has its own slot')
    assert.equal(guard.closest('.shell-header-actions'), null, 'outside the button row')
    assert.equal(guard.nextElementSibling?.className, 'shell-header-actions',
      'immediately LEFT of the row, so expanding it never moves the row')
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
    assert.equal(view.el.querySelector('.shell-version'), null,
      'no version given, none shown - a browser has no packaged version')
  } finally { await view.unmount() }
})

test('the running version is on screen without a click: status strip, or Home header', async () => {
  const strip = await mountView(
    <OrgStatusBar tree={TREE} orgs={[]} error={null} appVersion="3.0.0-alpha.0"
      onOpenConnections={() => {}} />,
    (el) => el)
  try {
    const v = strip.el.querySelector('.shell-version')!
    assert.equal(v.textContent, 'Orgtree 3.0.0-alpha.0')
    assert.equal(v.closest('.shell-statusbar-chips'), null, 'pinned, not in the scrolling run')
  } finally { await strip.unmount() }
  const home = await mountView(
    <ShellHeader menu={<span />} title="Home" version="3.0.0-alpha.0" />, (el) => el)
  try {
    assert.equal(home.el.querySelector('.shell-version')?.textContent, 'Orgtree 3.0.0-alpha.0')
  } finally { await home.unmount() }
  const none = await mountView(<ShellHeader menu={<span />} title="Home" version={null} />, (el) => el)
  try {
    assert.equal(none.el.querySelector('.shell-version'), null)
  } finally { await none.unmount() }
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
