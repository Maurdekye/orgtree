// contextmenu.test.tsx — THE APPLICATION CONTEXT MENU (user request 2026-09-07:
// application objects showed the browser's default menu rather than their own
// actions). Two halves:
//
//   A. THE MECHANISM (src/canvas/contextmenu.tsx), on a small fixture object:
//      it opens and takes the event; it stands aside — no menu, no
//      preventDefault — for an editable field, a live selection and a nested
//      link (§A2, with §A1 as the positive control that the same press on
//      plain text DOES open it); it offers nothing when there is nothing to
//      offer; an item runs its handler and closes; Escape closes it WITHOUT
//      reaching the surface's own Escape (§A5, whose control shows that same
//      Escape does reach the surface once the menu is gone); an outside press
//      closes it without being prevented; the arrow keys walk enabled items;
//      the box is clamped into the viewport; a press outside the object's box
//      anchors at the box (the keyboard case); focus returns on close; and it
//      lives in the document body, outside the object's own subtree.
//
//   B. THE OBJECTS, each on the REAL component: the agent card, the mail row,
//      the presentation card and gallery row, the ticket row, the pinned modal
//      bar and the agent pin window's title. Each checks that a right-click
//      does NOT activate the object (the camera stays, the row stays
//      unselected), that the entries follow the object's state, and that an
//      entry calls the handler the visible control calls — retire opens the
//      card's own confirm dialog, dismiss sends the same DELETE.
//
// Under jsdom every box is 0×0 and offsetWidth is 0; the tests that need a
// size stub it on the prototype for their own duration and say so.
//
// Run:  cd frontend && node tests/run.mjs contextmenu

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { nativeMenuPreferred, useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'
import { useEsc } from '../src/canvas/shared'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { InboxView, MailList } from '../src/canvas/mail'
import { PresentationCard, presentationMenu } from '../src/canvas/docs'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { DocketModal } from '../src/canvas/docket'
import { PinFrame, MODAL_PINS_KEY } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { PinLayer, addPin, forgetPins, readPins } from '../src/canvas/pins'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import type { TreePayload, WorkItem } from '../src/types'

const noop = () => {}
const W = window as unknown as Window & typeof globalThis
const menuEl = () => document.querySelector('.ctxmenu') as HTMLElement | null
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => (b as HTMLButtonElement).textContent ?? '')
const itemNamed = (label: string) => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .find((b) => b.textContent === label) as HTMLButtonElement | undefined

/** a right-click as the browser dispatches it: `contextmenu`, bubbling and
 *  cancelable, button 2. Returns whether the app took it (preventDefault). */
async function rightClick(el: Element, at: { x: number; y: number } = { x: 40, y: 30 }): Promise<boolean> {
  const ev = new W.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: at.x, clientY: at.y,
  })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  return ev.defaultPrevented
}
async function pick(label: string) {
  const b = itemNamed(label)
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => { b!.click() })
  await flush(2)
}
async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  const ev = new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  await inAct(() => { target.dispatchEvent(ev) })
  await flush(2)
  return ev
}
function stubClipboard(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const nav = W.navigator as unknown as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } },
  })
  return { writes, restore: () => {
    if (had) Object.defineProperty(nav, 'clipboard', had)
    else delete nav.clipboard
  } }
}

// ------------------------------------------------------------ A. mechanism

function Fixture({ entries, onEsc }: { entries: MenuEntry[] | (() => MenuEntry[]); onEsc?: () => void }) {
  const menu = useContextMenu()
  // the surface beneath: a modal's own Escape, registered the way every
  // panel registers it (shared.ts useEsc)
  useEsc(onEsc ?? noop, Boolean(onEsc))
  return (
    <div className="obj" onContextMenu={(e) => menu.open(e, entries)}>
      <span className="plain">plain text</span>
      <textarea className="edit" defaultValue="x" />
      <a className="lnk" href="https://example.invalid/">a link</a>
      <button className="btn">focusable</button>
      {menu.node}
    </div>
  )
}
const THREE: MenuEntry[] = [
  { label: 'One', onSelect: noop },
  'sep',
  { label: 'Two', onSelect: noop, disabled: true },
  { label: 'Three', onSelect: noop, danger: true },
]

function uiTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    try { await body(t) } finally { realClock() }
  })
}

uiTest('§A1 a right-click on plain text opens the menu, takes the event, lists the entries in order', async (t) => {
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  const took = await rightClick(v.el.querySelector('.plain')!)
  assert.equal(took, true, 'the browser menu is suppressed')
  const m = menuEl()
  assert.ok(m, 'a .ctxmenu is in the document')
  assert.equal(m!.getAttribute('role'), 'menu')
  assert.deepEqual(labels(), ['One', 'Two', 'Three'])
  assert.equal(m!.querySelectorAll('[role="separator"]').length, 1)
  assert.equal((itemNamed('Two') as HTMLButtonElement).disabled, true)
  assert.ok(itemNamed('Three')!.classList.contains('danger'))
  // outside the object's subtree: fixed positioning must not inherit the
  // canvas/desk transforms the object may sit under
  assert.ok(!v.el.contains(m), 'the menu is not a DOM descendant of the object')
  assert.equal(m!.parentElement, document.body)
})

uiTest('§A2 the browser keeps its menu for an editable field, a nested link and a live selection', async (t) => {
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  assert.equal(await rightClick(v.el.querySelector('.edit')!), false, 'textarea: not taken')
  assert.equal(menuEl(), null, 'textarea: no menu')
  assert.equal(await rightClick(v.el.querySelector('.lnk')!), false, 'nested link: not taken')
  assert.equal(menuEl(), null, 'nested link: no menu')
  // a selection spanning the plain text
  const sel = W.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(v.el.querySelector('.plain')!)
  sel.removeAllRanges(); sel.addRange(range)
  assert.equal(sel.isCollapsed, false, 'fixture: the selection is live')
  assert.equal(await rightClick(v.el.querySelector('.plain')!), false, 'selection: not taken')
  assert.equal(menuEl(), null, 'selection: no menu')
  // …and a selection ELSEWHERE is no reason to withhold this object's menu
  const other = document.createElement('p'); other.textContent = 'elsewhere'
  document.body.appendChild(other)
  t.after(() => other.remove())
  range.selectNodeContents(other); sel.removeAllRanges(); sel.addRange(range)
  assert.equal(await rightClick(v.el.querySelector('.plain')!), true, 'foreign selection: taken')
  assert.ok(menuEl(), 'foreign selection: menu opens')
  sel.removeAllRanges()
})

uiTest('§A2b nativeMenuPreferred is a pure predicate on target/currentTarget', async () => {
  const obj = document.createElement('div')
  obj.innerHTML = '<span></span><input><a href="/x"><b></b></a>'
  const link = document.createElement('a'); link.href = '/self'
  link.innerHTML = '<i></i>'
  assert.equal(nativeMenuPreferred({ target: obj.querySelector('span'), currentTarget: obj }), false)
  assert.equal(nativeMenuPreferred({ target: obj.querySelector('input'), currentTarget: obj }), true)
  assert.equal(nativeMenuPreferred({ target: obj.querySelector('b'), currentTarget: obj }), true, 'inside a nested link')
  assert.equal(nativeMenuPreferred({ target: link.querySelector('i'), currentTarget: link }), false, 'the object IS the link')
})

uiTest('§A3 nothing to offer is not a menu — the browser menu stands', async (t) => {
  const v = await mountView(<Fixture entries={['sep']} />, (h) => h)
  t.after(() => v.unmount())
  assert.equal(await rightClick(v.el.querySelector('.plain')!), false)
  assert.equal(menuEl(), null)
})

uiTest('§A4 choosing an item runs its handler once and closes the menu', async (t) => {
  let n = 0
  const v = await mountView(<Fixture entries={[{ label: 'Go', onSelect: () => { n++ } }]} />, (h) => h)
  t.after(() => v.unmount())
  await rightClick(v.el.querySelector('.plain')!)
  await pick('Go')
  assert.equal(n, 1)
  assert.equal(menuEl(), null)
})

uiTest('§A5 Escape closes the menu and does NOT reach the surface beneath; once closed, it does', async (t) => {
  let escapes = 0
  const v = await mountView(<Fixture entries={THREE} onEsc={() => { escapes++ }} />, (h) => h)
  t.after(() => v.unmount())
  await rightClick(v.el.querySelector('.plain')!)
  assert.ok(menuEl())
  await key(document.body, 'Escape')
  assert.equal(menuEl(), null, 'Escape closed the menu')
  assert.equal(escapes, 0, 'the surface did not also close')
  // control: the same key now reaches the surface
  await key(document.body, 'Escape')
  assert.equal(escapes, 1)
})

uiTest('§A6 a press outside closes the menu without being prevented; a press inside keeps it', async (t) => {
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  await rightClick(v.el.querySelector('.plain')!)
  const inside = new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
  await inAct(() => { itemNamed('One')!.dispatchEvent(inside) })
  await flush(2)
  assert.ok(menuEl(), 'inside: still open')
  const outside = new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
  await inAct(() => { document.body.dispatchEvent(outside) })
  await flush(2)
  assert.equal(menuEl(), null, 'outside: closed')
  assert.equal(outside.defaultPrevented, false, 'the outside press still does what it does')
})

uiTest('§A7 the arrow keys walk the ENABLED items and wrap; Home/End jump; Tab closes', async (t) => {
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  // unmeasured boxes → the press reads as keyboard-raised → first item focused
  await rightClick(v.el.querySelector('.plain')!)
  const m = menuEl()!
  assert.equal(document.activeElement, itemNamed('One'), 'keyboard open: first item focused')
  await key(m, 'ArrowDown')
  assert.equal(document.activeElement, itemNamed('Three'), 'the disabled item is skipped')
  await key(m, 'ArrowDown')
  assert.equal(document.activeElement, itemNamed('One'), 'wraps')
  await key(m, 'ArrowUp')
  assert.equal(document.activeElement, itemNamed('Three'))
  await key(m, 'Home')
  assert.equal(document.activeElement, itemNamed('One'))
  await key(m, 'End')
  assert.equal(document.activeElement, itemNamed('Three'))
  await key(m, 'Tab')
  assert.equal(menuEl(), null)
})

/** a 200×100 menu, for the geometry checks */
function stubMenuSize(): () => void {
  const proto = W.HTMLElement.prototype
  const w = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
  const h = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  Object.defineProperty(proto, 'offsetWidth', { configurable: true,
    get(this: HTMLElement) { return this.classList.contains('ctxmenu') ? 200 : 0 } })
  Object.defineProperty(proto, 'offsetHeight', { configurable: true,
    get(this: HTMLElement) { return this.classList.contains('ctxmenu') ? 100 : 0 } })
  return () => {
    if (w) Object.defineProperty(proto, 'offsetWidth', w)
    if (h) Object.defineProperty(proto, 'offsetHeight', h)
  }
}
/** the object measures 100×50 at (20,20) */
function stubObjectRect(el: Element): () => void {
  const had = el.getBoundingClientRect
  el.getBoundingClientRect = () => ({ left: 20, top: 20, right: 120, bottom: 70,
    width: 100, height: 50, x: 20, y: 20, toJSON: () => ({}) }) as DOMRect
  return () => { el.getBoundingClientRect = had }
}

uiTest('§A8 the menu is clamped into the viewport; a fitting anchor stands as is', async (t) => {
  t.after(stubMenuSize())
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  const obj = v.el.querySelector('.obj')!
  t.after(stubObjectRect(obj))
  // jsdom's window is 1024×768
  assert.equal(W.innerWidth, 1024); assert.equal(W.innerHeight, 768)
  await rightClick(v.el.querySelector('.plain')!, { x: 60, y: 40 })
  assert.equal(menuEl()!.style.left, '60px'); assert.equal(menuEl()!.style.top, '40px')
  await key(document.body, 'Escape')
  // an anchor near the corner: the box is pulled back by its own size + gap
  const far = document.createElement('div')
  // move the object to the far corner so the press counts as inside it
  obj.getBoundingClientRect = () => ({ left: 900, top: 700, right: 1024, bottom: 768,
    width: 124, height: 68, x: 900, y: 700, toJSON: () => ({}) }) as DOMRect
  await rightClick(v.el.querySelector('.plain')!, { x: 1000, y: 750 })
  assert.equal(menuEl()!.style.left, `${1024 - 200 - 4}px`)
  assert.equal(menuEl()!.style.top, `${768 - 100 - 4}px`)
  far.remove()
})

uiTest('§A9 a press whose pointer is outside the object box anchors at the box and focuses the first item (keyboard)', async (t) => {
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  const obj = v.el.querySelector('.obj')!
  t.after(stubObjectRect(obj))
  await rightClick(v.el.querySelector('.plain')!, { x: 0, y: 0 })
  assert.equal(menuEl()!.style.left, '20px', 'anchored at the box left')
  assert.equal(menuEl()!.style.top, '70px', 'anchored at the box bottom')
  assert.equal(document.activeElement, itemNamed('One'))
  await key(document.body, 'Escape')
  // control: a press INSIDE the box anchors at the pointer and focuses the menu itself
  await rightClick(v.el.querySelector('.plain')!, { x: 50, y: 40 })
  assert.equal(menuEl()!.style.left, '50px')
  assert.equal(document.activeElement, menuEl())
})

uiTest('§A10 focus returns to where it was when the menu closes', async (t) => {
  const v = await mountView(<Fixture entries={THREE} />, (h) => h)
  t.after(() => v.unmount())
  const btn = v.el.querySelector('.btn') as HTMLButtonElement
  btn.focus()
  assert.equal(document.activeElement, btn)
  await rightClick(btn)
  assert.notEqual(document.activeElement, btn, 'the menu took focus')
  await key(document.body, 'Escape')
  assert.equal(document.activeElement, btn)
})

// -------------------------------------------------------------- B. objects

// --- the agent card, on the real canvas (fixture after eyepressleak.test) ---
const asTree = (v: unknown) => v as TreePayload
function mkNode(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}
function tree(roots: unknown[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}
const camera = (el: HTMLElement) => (el.querySelector('.space') as HTMLElement | null)?.style.transform ?? ''

async function mountCanvas(t: TestContext, roots: unknown[]) {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const v = await mountView(
    <OrgCanvas tree={tree(roots)} slug="mine" op={() => Promise.resolve({} as never)} toast={noop}
      mailEvt={null} onOpenAgentGallery={noop} />,
    (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  return v
}

uiTest('§B1 agent card: right-click opens the card menu and does NOT move the camera; Retire… opens the card\'s own confirm', async (t) => {
  const v = await mountCanvas(t, [mkNode('worker', { documents: [{ id: 'd1', title: 'Plan', at: '2026-09-07T10:00:00Z' }], lineage: ['worker@1'] })])
  const card = v.el.querySelector('.sq.live') as HTMLElement
  assert.ok(card, 'positive control: the card rendered')
  const before = camera(v.el)
  assert.equal(await rightClick(card), true)
  await advance(400, 50)
  assert.equal(camera(v.el), before, 'a right-click is not a click: the camera did not move')
  const have = labels()
  for (const l of ['Open desk', 'Open inbox', 'Open docket', 'Open presentations', 'Show lineage',
    'Settings', 'Pin desk as a window', 'Hire a subordinate…', 'Retire…']) {
    assert.ok(have.includes(l), `entry "${l}" — have ${JSON.stringify(have)}`)
  }
  assert.ok(!have.includes('Dissolve suborganization…'), 'no live reports: retire, not dissolve')
  await pick('Retire…')
  const dlg = document.querySelector('.overlay h3, .overlay [role="dialog"], .confirm')
  assert.match(document.body.textContent ?? '', /retire worker\?/, 'the card\'s ConfirmModal, by its title')
  assert.ok(dlg || /retire worker\?/.test(document.body.textContent ?? ''))
})

uiTest('§B1b agent card: a card with live reports offers Dissolve; a retired card offers neither', async (t) => {
  const v = await mountCanvas(t, [
    mkNode('boss', { children: [mkNode('kid', { parent: 'boss' })] }),
    mkNode('gone', { state: 'archived' }),
  ])
  const boss = [...v.el.querySelectorAll('.sq')].find((c) => c.textContent?.includes('boss')) as HTMLElement
  assert.ok(boss)
  await rightClick(boss)
  assert.ok(labels().includes('Dissolve suborganization…'), JSON.stringify(labels()))
  assert.ok(!labels().includes('Retire…'))
  await key(document.body, 'Escape')
  const gone = [...v.el.querySelectorAll('.sq')].find((c) => c.textContent?.includes('gone')) as HTMLElement
  assert.ok(gone, 'positive control: the archived card rendered')
  await rightClick(gone)
  const have = labels()
  assert.ok(have.includes('Open inbox'), 'an archived card still has a menu')
  assert.ok(!have.includes('Retire…') && !have.includes('Dissolve suborganization…') && !have.includes('Hire a subordinate…'))
})

uiTest('§B1c agent card: Hire a subordinate… reveals the bottom hire chips until the pointer leaves', async (t) => {
  const v = await mountCanvas(t, [mkNode('worker')])
  const card = v.el.querySelector('.sq.live') as HTMLElement
  await rightClick(card)
  await pick('Hire a subordinate…')
  assert.ok(card.classList.contains('hire-reveal'))
  // React derives onPointerLeave from the native pointerout pair
  await inAct(() => { card.dispatchEvent(new W.PointerEvent('pointerout',
    { bubbles: true, relatedTarget: document.body })) })
  await flush(2)
  assert.ok(!card.classList.contains('hire-reveal'))
})

// --- the mail row ---
const ROW = (o: Partial<MailRow> & { id: string }): MailRow => ({
  from: 'peer-one', to: 'me', at: '2026-09-05T09:00:00.000Z', kind: 'message',
  body: 'hello there', read: true, ...o,
} as unknown as MailRow)

uiTest('§B2 mail row: right-click does not select; entries follow the row; Copy reference copies the exact @mail token', async (t) => {
  const clip = stubClipboard(); t.after(clip.restore)
  const toasts: string[][] = []
  const v = await mountView(
    <MailList org="org" delivered={[ROW({ id: 'm1' })]} toast={(l) => { toasts.push(l ?? []) }}
      refOf={(m) => `@mail:org/node/me/${m.id}`} />,
    (h) => h)
  t.after(() => v.unmount())
  const row = v.el.querySelector('.mailrow') as HTMLElement
  assert.ok(row)
  assert.equal(await rightClick(row), true)
  assert.ok(!row.classList.contains('on'), 'the row was not selected by the right-click')
  assert.deepEqual(labels(), ['Open', 'Copy message text', 'Copy reference'])
  assert.equal(itemNamed('Copy reference')!.title, '@mail:org/node/me/m1')
  await pick('Copy reference')
  assert.deepEqual(clip.writes, ['@mail:org/node/me/m1'])
  assert.match(toasts.at(-1)?.[0] ?? '', /copied the reference @mail:org\/node\/me\/m1/)
  await rightClick(row)
  await pick('Copy message text')
  assert.equal(clip.writes.at(-1), 'hello there')
  await rightClick(row)
  await pick('Open')
  assert.ok(row.classList.contains('on'), 'Open selects the row')
  await rightClick(row)
  assert.equal(labels()[0], 'Close')
})

uiTest('§B2b mail row: Reply, Mark as read and Retract appear only with their handlers and state, and call them', async (t) => {
  const read: string[] = []; const retracted: string[] = []; const replies: string[] = []
  const v = await mountView(
    <MailList org="org" pending={[ROW({ id: 'p1', _wait: true, read: false })]}
      delivered={[ROW({ id: 'm1' })]}
      onRead={(m) => { read.push(m.id!) }} onRetract={(m) => { retracted.push(m.id!) }}
      onReply={(m, text) => { replies.push(`${m.id}:${text}`) }} />,
    (h) => h)
  t.after(() => v.unmount())
  const rows = [...v.el.querySelectorAll('.mailrow')] as HTMLElement[]
  const pending = rows.find((r) => r.classList.contains('unread'))!
  const delivered = rows.find((r) => !r.classList.contains('unread'))!
  await rightClick(pending)
  assert.deepEqual(labels(), ['Open', 'Reply', 'Mark as read', 'Retract (undelivered)', 'Copy message text'])
  await pick('Mark as read')
  assert.deepEqual(read, ['p1'])
  await rightClick(pending)
  await pick('Retract (undelivered)')
  assert.deepEqual(retracted, ['p1'])
  await rightClick(delivered)
  assert.deepEqual(labels(), ['Open', 'Reply', 'Copy message text'], 'a delivered row: no read/retract')
  await pick('Reply')
  await flush(3)
  assert.ok(delivered.classList.contains('on'), 'Reply selected the row')
  const ta = v.el.querySelector('.mailer-read .mail-reply textarea') as HTMLTextAreaElement
  assert.ok(ta, 'the reply box rendered')
  assert.equal(document.activeElement, ta, 'and holds the caret')
})

uiTest('§B2c mail row: a Sent list (no refOf) offers no reference; an outgoing row offers no Reply', async (t) => {
  const v = await mountView(
    <MailList org="org" outgoing delivered={[ROW({ id: 's1' })]} onReply={noop} />, (h) => h)
  t.after(() => v.unmount())
  await rightClick(v.el.querySelector('.mailrow')!)
  assert.deepEqual(labels(), ['Open', 'Copy message text'])
})

uiTest('§B2d the node inbox wires the node-box reference; the desk\'s scaled row still gets a body-level menu', async (t) => {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(String(url).includes('/inbox')
      ? { delivered: [ROW({ id: 'm9' })], pending: [], sent: [] } : {}),
  })) as unknown as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const v = await mountView(<InboxView slug="org" nid="me" tier={null} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(200, 16); await flush()
  const row = v.el.querySelector('.mailer-list .mailrow') as HTMLElement
  assert.ok(row, 'positive control: the fake inbox produced a row')
  await rightClick(row)
  assert.equal(itemNamed('Copy reference')?.title, '@mail:org/node/me/m9')
  assert.equal(menuEl()!.parentElement, document.body)
})

// --- presentations ---
uiTest('§B3 presentation card: markdown offers reader/copy/download, HTML offers the mockup instead; Open reader calls onOpen', async (t) => {
  const clip = stubClipboard(); t.after(clip.restore)
  const opened: string[] = []
  const v = await mountView(<>
    <PresentationCard slug="org" doc={{ id: 'd1', title: 'The Plan', at: '2026-09-07T10:00:00Z' }}
      className="doc-badge" onOpen={(id) => { opened.push(id) }}>md</PresentationCard>
    <PresentationCard slug="org" doc={{ id: 'd2', title: 'Mock', at: '2026-09-07T10:00:00Z', format: 'html' }}
      className="doc-badge" onOpen={(id) => { opened.push(id) }}>html</PresentationCard>
  </>, (h) => h)
  t.after(() => v.unmount())
  const [md, html] = [...v.el.querySelectorAll('.doc-badge')] as HTMLElement[]
  await rightClick(md!)
  assert.deepEqual(labels(), ['Open reader', 'Copy title', 'Copy reference', 'Download as Markdown'])
  assert.equal(itemNamed('Copy reference')!.title, '@doc:org/d1')
  await pick('Copy title')
  assert.deepEqual(clip.writes, ['The Plan'])
  await rightClick(md!)
  await pick('Open reader')
  assert.deepEqual(opened, ['d1'])
  // the mockup card IS a link, so the object's menu applies (not the browser's)
  assert.equal(html!.tagName, 'BUTTON')
  assert.equal(await rightClick(html!), true)
  assert.deepEqual(labels(), ['Open reader', 'Open HTML mockup in a new tab', 'Copy title', 'Copy reference', 'Download HTML prototype'])
})

uiTest('§B3b gallery row: Dismiss runs the pane\'s dismiss — the same DELETE; an evicted card offers neither dismiss nor download', async (t) => {
  // the lists never show an evicted row (both galleries filter them), so the
  // evicted shape is checked on the shared builder the rows use
  const gone = presentationMenu(null, 'org', { id: 'd2', title: 'Old', evicted: true }, { toast: noop, dismiss: noop, open: noop })
  const goneLabels = gone.filter((e) => e !== 'sep').map((e) => (e as { label: string }).label)
  assert.deepEqual(goneLabels, ['Open reader', 'Copy title', 'Copy reference'])
  const calls: { method: string; url: string }[] = []
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) })
    const docs = { documents: [
      { id: 'd1', node: 'me', title: 'Live doc', at: '2026-09-07T10:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
    ] }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(String(url).includes('/documents') && (init?.method ?? 'GET') === 'GET' ? docs : {}) })
  }) as unknown as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const v = await mountView(<AgentGalleryView slug="org" nid="me" node={undefined} toast={noop} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(200, 16); await flush()
  const rows = [...v.el.querySelectorAll('.doc-gallery-row')] as HTMLElement[]
  assert.equal(rows.length, 1, 'positive control: the row rendered')
  await rightClick(rows[0]!)
  assert.deepEqual(labels(), ['Open', 'Copy title', 'Copy reference', 'Download as Markdown', 'Dismiss'])
  assert.ok(!rows[0]!.classList.contains('on'), 'not selected by the right-click')
  await pick('Dismiss')
  await flush(3)
  const del = calls.find((c) => c.method === 'DELETE')
  assert.ok(del, 'the existing dismiss path: DELETE /documents/d1')
  assert.match(del!.url, /\/documents\/d1$/)
})

uiTest('§B3c org gallery row: Close closes the OPEN document and nothing else — '
  + 'the other rows keep their state, no card is deleted, the panel stays up', async (t) => {
  // The entry that says Close must DO the close. It said Close and left the
  // document open (user report 2026-09-12): the label flipped on selection but
  // the action re-selected the row it was already on, so the menu shut and
  // nothing moved. Both halves are pinned here — the label AND the effect.
  const calls: { method: string; url: string }[] = []
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  const docs = [
    { id: 'd1', node: 'me', title: 'First plan', at: '2026-09-07T10:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
    { id: 'd2', node: 'you', title: 'Second plan', at: '2026-09-07T09:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
  ]
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    calls.push({ method, url: path })
    const one = path.match(/\/documents\/([^/?]+)$/)
    const body = method !== 'GET' ? {}
      : one ? { ...docs.find((d) => d.id === one[1]!), body: `the body of ${one[1]}` }
        : { documents: docs, total: docs.length }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  let closedPanel = 0
  const v = await mountView(
    <DocGalleryModal slug="org" toast={noop} close={() => { closedPanel += 1 }} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(200, 16); await flush()
  const rows = () => [...v.el.querySelectorAll('.doc-gallery-row')] as HTMLElement[]
  assert.equal(rows().length, 2, 'positive control: both rows rendered')
  const pane = () => v.el.querySelector('.mailer-read')!.textContent ?? ''

  await rightClick(rows()[0]!)
  assert.equal(labels()[0], 'Open', 'an unselected row offers Open')
  await pick('Open')
  await flush(3)
  assert.ok(rows()[0]!.classList.contains('on'), 'Open selected the row')

  // the second row is NOT swept along: it is still its own unselected self
  await rightClick(rows()[1]!)
  assert.equal(labels()[0], 'Open', 'the row that is not open still says Open')
  await key(document.body, 'Escape')

  await rightClick(rows()[0]!)
  assert.equal(labels()[0], 'Close', 'the open row offers Close')
  await pick('Close')
  await flush(3)
  assert.ok(!rows()[0]!.classList.contains('on'), 'Close deselected the open document')
  assert.match(pane(), /select a document to read it/,
    'and the reading pane went back to its empty state')
  assert.equal(rows().length, 2, 'both cards are still listed — Close is not Dismiss')
  assert.ok(!rows()[1]!.classList.contains('on'), 'the other document was not opened by it')
  assert.equal(calls.find((c) => c.method === 'DELETE'), undefined,
    'Close deletes nothing — the card survives')
  assert.equal(closedPanel, 0, 'and the gallery itself stayed open')
})

// --- the ticket row ---
const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'fix-the-thing', rev: 1, kind: 'code', title: 'Fix the thing', objective: 'x',
  status: 'in_progress', blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'agent1', generation: 1 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [], docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 }, manual_attention: null, dismissals: [],
  questions: [], effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null, superseded_by: null, history: [],
  ...o,
} as unknown as WorkItem)
function mockWork(items: WorkItem[]): { method: string; url: string }[] {
  const calls: { method: string; url: string }[] = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url) })
    const body = String(url).includes('/work-items')
      ? { items, counts: { attention: 0, active: items.length, archived: 0, backlogged: 0 }, now: '2026-09-05T10:00:00.000Z' }
      : String(url).includes('/inbox') ? { pending: [], delivered: [], sent: [] } : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  return calls
}
const docketTree = (): TreePayload => ({
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1,
  roots: [{ id: 'agent1', tier: 'haiku', generation: 1, state: 'live', children: [] }],
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0,
  user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

uiTest('§B4 ticket row: right-click does not select; Copy slug copies the exact slug with the bubble; Copy reference is @item:org/slug; Open owner jumps', async (t) => {
  const clip = stubClipboard(); t.after(clip.restore)
  window.localStorage.removeItem('orgtree.docket.group')
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  mockWork([
    mkItem({ slug: 'parent-item', title: 'Parent' }),
    mkItem({ slug: 'child-item', title: 'Child', parent: 'parent-item' } as Partial<WorkItem>),
    mkItem({ slug: 'flagged-item', title: 'Flagged', effective_attention: true,
      attention_sources: ['manual'],
      manual_attention: { reason: 'look', by: { node: 'agent1', generation: 1 }, set_rev: 3, at: '2026-09-05T09:00:00.000Z' } } as Partial<WorkItem>),
  ])
  const focused: string[] = []; let closed = 0
  const v = await mountView(
    <DocketModal slug="org1" toast={noop} close={() => { closed++ }} jumpTo={null}
      tree={docketTree()} onFocusAgent={(id) => { focused.push(id) }} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(200, 16); await flush()
  const rowNamed = (s: string) => [...v.el.querySelectorAll('.docket-row')]
    .find((r) => r.querySelector('.docket-rowname')?.textContent === s) as HTMLElement
  const parent = rowNamed('parent-item'); const flagged = rowNamed('flagged-item')
  assert.ok(parent && flagged, 'positive control: rows rendered')
  assert.equal(await rightClick(parent), true)
  assert.ok(!parent.classList.contains('on'), 'not selected by the right-click')
  const have = labels()
  assert.deepEqual(have, ['Open details', 'Hide 1 sub-item', 'Open owner (agent1)', 'Copy slug', 'Copy reference'])
  assert.equal(itemNamed('Copy reference')!.title, '@item:org1/parent-item')
  await pick('Copy slug')
  await flush(3)
  assert.deepEqual(clip.writes, ['parent-item'])
  assert.ok(parent.querySelector('.docket-copied'), 'the double-click\'s Copied! bubble')
  await rightClick(parent)
  await pick('Hide 1 sub-item')
  assert.equal(rowNamed('child-item'), undefined, 'folded away')
  await rightClick(parent)
  assert.ok(labels().includes('Show 1 sub-item'))
  await pick('Open owner (agent1)')
  assert.deepEqual(focused, ['agent1']); assert.equal(closed, 1, 'closes first, as the actor line does')
  await rightClick(flagged)
  assert.ok(labels().includes('Dismiss attention flag'), JSON.stringify(labels()))
  assert.ok(!labels().includes('Hide 1 sub-item'))
})

// --- the pinned modal bar ---
uiTest('§B5 pinned modal bar: Pin/Unpin says its effect, Close closes the surface', async (t) => {
  window.localStorage.removeItem(MODAL_PINS_KEY)
  let closed = 0
  const v = await mountView(
    <CurrentOrg.Provider value="mine"><PinFrame kind="ctx-test" title="A panel" panel="settings" close={() => { closed++ }}>
      <p>body</p>
    </PinFrame></CurrentOrg.Provider>, (h) => h)
  t.after(() => v.unmount())
  const bar = () => document.querySelector('.modalpin-bar') as HTMLElement
  assert.ok(bar(), 'positive control: the bar rendered')
  await rightClick(bar())
  assert.deepEqual(labels(), ['Open in new window', 'Pin to window', 'Close'])
  await pick('Pin to window')
  await flush(3)
  assert.ok(bar().classList.contains('on'), 'pinned')
  await rightClick(bar())
  assert.deepEqual(labels(), ['Open in new window', 'Unpin', 'Close'])
  await pick('Close')
  assert.equal(closed, 1)
  window.localStorage.removeItem(MODAL_PINS_KEY)
})

// --- the agent pin window's title ---
uiTest('§B6 agent pin window title: Show on canvas jumps; Unpin removes the pin', async (t) => {
  forgetPins('mine')
  addPin('mine', 'worker', { x: 10, y: 10, w: 400, h: 300 })
  const node = mkNode('worker') as CanvasNode
  const map = new Map<string, CanvasNode>([['worker', node]])
  const jumped: string[] = []
  const shown: string[] = []
  const vp = { current: null as HTMLDivElement | null }
  resetConvos()
  const hadFetch = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = hadFetch })
  const v = await mountView(
    <div ref={(el) => { vp.current = el }}>
      <PinLayer slug="mine" map={map} viewportRef={vp} targetOf={() => null}
        op={() => Promise.resolve({} as never)} toast={noop} pub={false} maxTop={100} pxc={1}
        onMailLink={noop} onWorkLink={noop} onOpenDoc={noop} onLineage={noop} onConfig={noop}
        onJump={(id) => { jumped.push(id) }}
        onShowOnCanvas={(id) => { shown.push(id) }} />
    </div>, (h) => h)
  t.after(() => { v.unmount(); forgetPins('mine') })
  await flush(); await advance(200, 16); await flush()
  const title = document.querySelector('.pin-layer .pinwin-title') as HTMLElement
  assert.ok(title, 'positive control: the pinned window rendered')
  await rightClick(title)
  assert.deepEqual(labels(), ['Show on canvas', 'Unpin'])
  await pick('Show on canvas')
  // user bug 2026-09-11: this entry takes the CANVAS route, never the generic
  // jump - a generic jump to a pinned agent raises the window the reader is
  // already looking at, which is the whole complaint
  assert.deepEqual(shown, ['worker'])
  assert.deepEqual(jumped, [], 'Show on canvas must not take the generic jump')
  await rightClick(title)
  await pick('Unpin')
  await flush(3)
  assert.equal(readPins('mine').length, 0, 'the pin is gone through PinLayer\'s own unpin')
})
