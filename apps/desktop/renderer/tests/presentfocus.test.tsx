// presentfocus.test.tsx — clicking a presentation card whose document is
// ALREADY in a popped-out window must surface that window instead of doing
// nothing (user report: the click looked dead) or mounting a second reader for
// the same document.
//
//   §1  identity is the document's own id, within its own organization
//   §2  identity is read LIVE, not snapshotted when the window opened
//   §3  a closed window stops answering; reopening answers again
//   §4  a surface HOSTED in someone else's window reveals that window's owner
//   §5  ROUTING: the real canvas, the real card — an already-popped-out
//       document is revealed and NO reader is opened for it
//   §6  ROUTING: a document that is NOT popped out opens exactly as before
//   §7  WIRING: a real pop-out registers a live identity and a native reveal
//   §8  THE REAL READER: identity follows the row picked INSIDE the window
//   §9  a match that cannot be raised is not a handled click
//
// ⚠ WHY §1-§4 DRIVE THE REGISTRY DIRECTLY, AND WHAT §7 ADDS. §1-§4 register the
// same `WindowSurface` records `MovableSurface` registers, through the real
// `registerWindow`, and ask the real lookup: they are the RULES for deciding
// which window a click means. §7 then pops a real `MovableSurface` out, so the
// rules are not being asked about records only the test knows how to build.
//
// ⚠ WHAT jsdom CANNOT DO. It has no native window behind any of this, so what
// a raise actually DOES to a real popped-out window — restore it if minimized,
// then show and focus it, in that order — is not observable here. That is the
// main process's `revealPopout`, measured in tests/popout-windows.test.mjs.
// What §7 does show is that the renderer asks for it, by the frame name that
// is the only handle on that window.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs presentfocus

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { detachedDocument, openSurfaces, registerWindow, revealDetachedDocument, revealSurface } from '../src/windowlife'
import type { WindowSurface } from '../src/windowlife'
import { CurrentOrg, PopoutButton } from '../src/popout'
import { DocReader } from '../src/canvas/docs'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { TreePayload } from '../src/types'

/** A registered surface reduced to what the lookup reads. `document` is a
 *  function argument rather than a stored value on purpose: §2 needs to change
 *  it after registration, exactly as a popped-out reader does. */
function surface(over: Partial<WindowSurface> & { id: string }): WindowSurface {
  return {
    kind: 'doc', org: 'alpha', editable: false, redock: () => {},
    // a real Window always has focus(); a stub without one is not a window a
    // reveal could ever succeed against, and `revealSurface` now says so
    window: { focus() {} } as unknown as Window, ...over,
  }
}

const clean = (offs: (() => void)[]) => () => { for (const off of offs.splice(0).reverse()) off() }

test('§1 the window is found by the document\'s id, within its own organization', (t) => {
  const offs: (() => void)[] = []
  t.after(clean(offs))
  const revealed: string[] = []
  offs.push(registerWindow(surface({ id: 'a', identity: () => ({ document: 'd1' }), reveal: () => revealed.push('a') })))
  offs.push(registerWindow(surface({ id: 'b', identity: () => ({ document: 'd2' }), reveal: () => revealed.push('b') })))
  offs.push(registerWindow(surface({ id: 'c', org: 'beta', identity: () => ({ document: 'd3' }), reveal: () => revealed.push('c') })))

  assert.equal(detachedDocument('alpha', 'd1')?.id, 'a')
  assert.equal(detachedDocument('alpha', 'd2')?.id, 'b',
    'several presentations open at once must each resolve to their OWN window')

  // the organization boundary, from both sides
  assert.equal(detachedDocument('alpha', 'd3'), undefined,
    'another organization\'s window is never this organization\'s answer')
  assert.equal(detachedDocument('beta', 'd1'), undefined)
  assert.equal(detachedDocument('beta', 'd3')?.id, 'c')

  assert.equal(revealDetachedDocument('alpha', 'd2'), true)
  assert.deepEqual(revealed, ['b'], 'and only that window is surfaced')

  // a document nobody has popped out, and the empty id a loading reader can
  // hold, are both "no window" — never "the first window"
  assert.equal(revealDetachedDocument('alpha', 'never-presented'), false)
  assert.equal(revealDetachedDocument('alpha', ''), false)
  assert.deepEqual(revealed, ['b'], 'a miss must surface nothing at all')
})

test('§2 the document a window is showing is read live, not snapshotted', (t) => {
  const offs: (() => void)[] = []
  t.after(clean(offs))
  // A popped-out reader registers ONCE and is then re-pointed at other
  // documents — the canvas has exactly one reader, so opening a second
  // presentation swaps the document inside the window it already is in. A
  // snapshot would keep naming the first document forever, which would both
  // surface the wrong window and refuse to open the right one.
  let showing = 'd1'
  offs.push(registerWindow(surface({ id: 'a', identity: () => ({ document: showing }) })))
  assert.equal(detachedDocument('alpha', 'd1')?.id, 'a')

  showing = 'd2'
  assert.equal(detachedDocument('alpha', 'd2')?.id, 'a', 'the window now shows d2 and must answer for it')
  assert.equal(detachedDocument('alpha', 'd1'), undefined,
    'and must no longer answer for the document it left behind, or d1 could never be opened again')
})

test('§3 a closed window stops answering, and reopening answers again', (t) => {
  const offs: (() => void)[] = []
  t.after(clean(offs))
  const off = registerWindow(surface({ id: 'a', identity: () => ({ document: 'd1' }) }))
  offs.push(off)
  assert.equal(revealDetachedDocument('alpha', 'd1'), true)

  off()   // the window is closed, or returned to the main window
  assert.equal(revealDetachedDocument('alpha', 'd1'), false,
    'a window that is gone must not swallow the click that would reopen the reader')
  assert.equal(openSurfaces().some((s) => s.id === 'a'), false)

  offs.push(registerWindow(surface({ id: 'a2', identity: () => ({ document: 'd1' }) })))
  assert.equal(revealDetachedDocument('alpha', 'd1'), true, 'and popping it out again is found again')
})

test('§4 a surface hosted in another window reveals that window\'s owner', (t) => {
  const offs: (() => void)[] = []
  t.after(clean(offs))
  const revealed: string[] = []
  const focused: string[] = []
  const shared = { focus: () => focused.push('shared') } as unknown as Window
  const lonely = { focus: () => focused.push('lonely') } as unknown as Window

  // the desk that owns the window, and a reader placed inside it that does not
  const owner = surface({ id: 'owner', kind: 'desk', window: shared,
    identity: () => ({ agent: 'a1' }), reveal: () => revealed.push('owner') })
  const guest = surface({ id: 'guest', window: shared, identity: () => ({ document: 'd1' }) })
  offs.push(registerWindow(owner), registerWindow(guest))

  assert.equal(revealDetachedDocument('alpha', 'd1'), true)
  assert.deepEqual(revealed, ['owner'],
    'the guest has no frame name of its own, so the owner of its window is what gets raised')
  assert.deepEqual(focused, [], 'and the native raise is used in preference to a plain focus()')

  // with no owner registered at all there is still the browser's own answer,
  // which is everything a plain (non-Electron) browser ever had
  const orphan = surface({ id: 'orphan', window: lonely, identity: () => ({ document: 'd9' }) })
  offs.push(registerWindow(orphan))
  revealSurface(orphan)
  assert.deepEqual(focused, ['lonely'])
})

// ------------------------------------------------------------ the real canvas
const SLUG = 'presentfocus'
const DOCS = [
  { id: 'd1', title: 'Already in a window', at: '2026-09-14T00:00:00Z' },
  { id: 'd2', title: 'Not popped out', at: '2026-09-14T00:00:00Z' },
]
const agent = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: DOCS,
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
const tree = (): TreePayload => ({ slug: SLUG, name: SLUG, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [], tiers: { haiku: 1 },
  audiences: [], roots: [agent('a1')], cost_usd_total: 0,
  audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, spend_frozen: false,
  storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [] } as unknown as TreePayload)

/** The canvas, with one agent carrying the two presentation cards above, and
 *  `d1` already open in a (recorded) popped-out window. Returns the chips by
 *  document id, the reveals that happened, and the documents actually fetched
 *  — a fetch for a document's body is what "a reader was opened for it" looks
 *  like from outside. */
async function canvas(t: { after: (fn: () => void | Promise<void>) => void }) {
  const revealed: string[] = []
  const fetched: string[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    const path = String(url)
    const doc = path.match(/\/documents\/([^/?]+)$/)?.[1]
    if (doc) fetched.push(doc)
    return { ok: true, status: 200, headers: new Headers(), json: async () => doc
      ? { id: doc, node: 'a1', title: doc, body: 'body', at: DOCS[0]!.at }
      : { documents: [], total: 0 } } as Response
  }) as typeof fetch
  /** ⚠ GIVE THE CANVAS A REAL VIEWPORT. jsdom reports every rect as 0x0, so
   *  the opening camera's fit lands on a degenerate zoom and the canvas can
   *  settle BELOW `Z_MINI`, where the product deliberately renders the chips
   *  as inert spans with no click handler. The click then does nothing and
   *  the test blames the product for a dead click it never made. Measured:
   *  that alone accounted for 9 failures in 60 idle runs. Same stub as
   *  fitview.test.tsx. */
  const realRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('viewport')
      ? ({ x: 0, y: 0, left: 0, top: 0, width: 1400, height: 900, right: 1400, bottom: 900,
          toJSON: () => ({}) } as DOMRect)
      : realRect.call(this)
  }
  const off = registerWindow({ id: 'popped-d1', kind: 'doc', org: SLUG, editable: false,
    window: {} as unknown as Window, redock: () => {},
    identity: () => ({ document: 'd1' }), reveal: () => revealed.push('d1') })
  const view = await mountView(
    <OrgCanvas tree={tree()} op={() => Promise.resolve({} as never)} slug={SLUG}
      toast={() => {}} mailEvt={null} />, (el) => el)
  t.after(async () => { off(); await view.unmount(); globalThis.fetch = oldFetch
    window.HTMLElement.prototype.getBoundingClientRect = realRect; localStorage.clear() })
  await inAct(async () => { await flush(10) })
  const chips = [...view.el.querySelectorAll('.doc-chip')] as HTMLElement[]
  assert.equal(chips.length, DOCS.length, 'both presentation cards must be on the canvas to be clicked')
  /** Click the nth card the way a user does: whatever node is ON SCREEN at
   *  that moment. ⚠ DO NOT hold an element across a click and press it again.
   *  A re-render between the two presses replaces the chip's DOM node, and a
   *  click on the detached one never reaches React's delegated listener — so
   *  the test sees no second reveal and blames the product. That was a real
   *  flake here: 10 failures in 60 idle runs, 36 in 60 under load, and every
   *  single failure had `isConnected === false` on the held node. The
   *  assertion below is what keeps it from coming back silently. */
  const clickChip = async (n: number) => {
    let chip: HTMLElement | undefined
    for (let tries = 0; tries < 20; tries++) {
      const live = [...view.el.querySelectorAll('.doc-chip')] as HTMLElement[]
      chip = live[n]
      if (chip?.isConnected && !chip.classList.contains('inert')) break
      chip = undefined
      await inAct(async () => { await flush(10) })
    }
    assert.ok(chip, `card ${n} never became a live, non-inert chip to click`)
    // nothing may be awaited between the query and the press, or the node
    // this resolved can be replaced before it is clicked
    await inAct(async () => { chip.click(); await flush(10) })
  }
  return { view, chips, clickChip, revealed, fetched }
}

test('§5 a presentation already in a window is revealed, and no second reader opens', async (t) => {
  const { view, clickChip, revealed, fetched } = await canvas(t)
  await clickChip(0)

  assert.deepEqual(revealed, ['d1'], 'the click must surface the window that already has this presentation')
  assert.equal(fetched.includes('d1'), false,
    'and must NOT also open a reader here — that is the duplicate window this exists to prevent')
  assert.equal(view.el.querySelector('.gallery-modal'), null, 'so no reader is on screen')

  // clicking it again is the reported dead click: it must keep working, not
  // become a no-op because some state already says d1
  await clickChip(0)
  assert.deepEqual(revealed, ['d1', 'd1'], 'every click must raise the window, not just the first')
})

test('§6 a presentation with no window of its own opens exactly as before', async (t) => {
  const { view, clickChip, revealed, fetched } = await canvas(t)
  await clickChip(1)

  assert.equal(fetched.includes('d2'), true, 'the reader must open here, as it always has')
  assert.ok(view.el.querySelector('.gallery-modal'), 'and be on screen')
  assert.deepEqual(revealed, [], 'and no unrelated window is disturbed')
})

// ----------------------------------------------- what a real pop-out registers
/** A stand-in for the browser window `window.open` hands back.
 *
 *  ⚠ ITS DOCUMENT IS FROM THIS SAME jsdom REALM. `MovableSurface` physically
 *  re-parents the live surface into the new window's document, and a node can
 *  only be adopted between documents of one realm — a second JSDOM would throw
 *  instead of modelling anything. So this is a real second Document with a
 *  hand-built Window around it, which is exactly the pair the opener touches. */
function stubWindow(): Window & { closed: boolean; focused: number } {
  const doc = document.implementation.createHTMLDocument('popout')
  const w = {
    document: doc, closed: false, focused: 0,
    focus() { w.focused++ }, close() { w.closed = true },
    screenX: 0, screenY: 0, outerWidth: 900, outerHeight: 760,
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  }
  Object.defineProperty(doc, 'defaultView', { value: w, configurable: true })
  return w as unknown as Window & { closed: boolean; focused: number }
}

test('§7 a real pop-out registers a LIVE identity and a native reveal', async (t) => {
  const { MovableSurface } = await import('../src/popout')
  const realOpen = window.open
  const bridgeHost = window as Window & { orgtreeDesktop?: unknown }
  const realBridge = bridgeHost.orgtreeDesktop
  // jsdom HAS one, but the harness does not lift it onto globalThis and the
  // style mirror inside `open()` constructs one unqualified.
  const g = globalThis as Record<string, unknown>
  const realMO = g.MutationObserver
  g.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver
  const child = stubWindow()
  const focusedNames: string[] = []
  window.open = (() => child) as typeof window.open
  bridgeHost.orgtreeDesktop = { focusPopout: (name: string) => { focusedNames.push(name); return Promise.resolve() } }

  // the surface is re-pointed at a second document while it stays popped out,
  // which is exactly what the canvas's single reader does
  let restore = { document: 'first' }
  const Host = ({ restoreValue }: { restoreValue: { document: string } }) =>
    <CurrentOrg.Provider value="alpha">
      <MovableSurface kind="doc" title="Presented documents" org="alpha" restore={restoreValue}>
        <PopoutButton />
      </MovableSurface>
    </CurrentOrg.Provider>

  const view = await mountView(<Host restoreValue={restore} />, (el) => el)
  t.after(async () => {
    await view.unmount(); window.open = realOpen
    if (realBridge === undefined) delete bridgeHost.orgtreeDesktop
    else bridgeHost.orgtreeDesktop = realBridge
    if (realMO === undefined) delete g.MutationObserver; else g.MutationObserver = realMO
    localStorage.clear()
  })
  await inAct(async () => { await flush() })
  const popout = view.el.querySelector('[aria-label="Open in new window"]') as HTMLElement | null
  assert.ok(popout, 'the surface offers a pop-out control')
  await inAct(async () => { popout!.click(); await flush() })

  const registered = openSurfaces().find((s) => s.kind === 'doc' && s.org === 'alpha')
  assert.ok(registered, 'popping out must register the surface, or nothing can ever find its window')
  assert.equal(registered!.identity?.().document, 'first')
  assert.equal(detachedDocument('alpha', 'first')?.id, registered!.id,
    'and the real registration must be findable by the document it is showing')

  // THE MUTATION THIS SECTION EXISTS FOR: a snapshot taken at pop-out time
  // would still say "first" here, so the window would be surfaced for the
  // wrong document and the right one could never be opened.
  restore = { document: 'second' }
  await inAct(async () => { view.render(<Host restoreValue={restore} />); await flush() })
  assert.equal(registered!.identity?.().document, 'second',
    'the identity must be read live — a popped-out reader is re-pointed without re-registering')
  assert.equal(detachedDocument('alpha', 'first'), undefined)

  assert.equal(revealDetachedDocument('alpha', 'second'), true)
  assert.ok(child.focused > 0, 'reveal focuses the child window the browser handed back')
  assert.equal(focusedNames.length, 1,
    'and asks the native side to restore/raise it by frame name — the renderer alone cannot')
  assert.match(focusedNames[0]!, /^orgtree-popout-\d+$/)
})

// ------------------------------------------------- the real reader's identity
/** THE DEFECT §8 EXISTS FOR, in one sentence: a popped-out reader used to
 *  publish the document it was OPENED on rather than the one it is SHOWING.
 *
 *  Found by team-docket reviewing the first candidate, with an executable
 *  probe; this section is that probe kept as a permanent test. §7 could not
 *  catch it — §7 drives `restore` from the test, so it proves the getter is
 *  live when the restore prop changes, and says nothing about whether the real
 *  reader's restore prop changes when its content does. That was the whole gap.
 *
 *  Why it is not a corner: THE READER IS THE GALLERY. `DocReader` renders an
 *  `AgentGalleryModal`, whose left-hand list sits beside the reading pane, and
 *  picking a row from it is the surface's primary interaction. */
const READER_ROWS = [
  { id: 'd1', node: 'a1', title: 'First doc', at: '2026-09-14T00:00:00Z', format: 'md', bytes: 4, evicted: false, node_state: 'live', tier: 'haiku' },
  { id: 'd2', node: 'a1', title: 'Second doc', at: '2026-09-14T00:00:01Z', format: 'md', bytes: 4, evicted: false, node_state: 'live', tier: 'haiku' },
]

/** Like `stubWindow`, plus the two globals the style mirror reaches for on the
 *  CHILD window when a real reader (rather than a bare fixture) is adopted. */
function readerWindow(): Window & { closed: boolean } {
  const doc = document.implementation.createHTMLDocument('popout')
  const w = {
    document: doc, closed: false,
    focus() {}, close() { w.closed = true },
    screenX: 0, screenY: 0, outerWidth: 900, outerHeight: 760,
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    MutationObserver: (window as unknown as Record<string, unknown>).MutationObserver,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
  }
  Object.defineProperty(doc, 'defaultView', { value: w, configurable: true })
  return w as unknown as Window & { closed: boolean }
}

test('§8 the identity follows the row the user picks INSIDE the popped-out reader', async (t) => {
  const realOpen = window.open
  const bridgeHost = window as Window & { orgtreeDesktop?: unknown }
  const realBridge = bridgeHost.orgtreeDesktop
  const g = globalThis as Record<string, unknown>
  const realMO = g.MutationObserver
  g.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver
  const child = readerWindow()
  window.open = (() => child) as typeof window.open
  bridgeHost.orgtreeDesktop = { focusPopout: () => Promise.resolve() }
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    const id = String(url).match(/\/documents\/([^/?]+)$/)?.[1]
    const body = id ? { ...READER_ROWS.find((r) => r.id === id), body: `body of ${id}` }
      : { documents: READER_ROWS, total: READER_ROWS.length }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body } as Response
  }) as typeof fetch

  // exactly what `openDocView('d1')` mounts on the canvas
  const view = await mountView(
    <CurrentOrg.Provider value="alpha">
      <DocReader slug="alpha" docId="d1" toast={() => {}} close={() => {}} />
    </CurrentOrg.Provider>, (el) => el)
  t.after(async () => {
    await view.unmount(); window.open = realOpen
    if (realBridge === undefined) delete bridgeHost.orgtreeDesktop
    else bridgeHost.orgtreeDesktop = realBridge
    if (realMO === undefined) delete g.MutationObserver; else g.MutationObserver = realMO
    globalThis.fetch = oldFetch; localStorage.clear()
  })
  await inAct(async () => { await flush(12) })
  const popout = view.el.querySelector('[aria-label="Open in new window"]') as HTMLElement | null
  assert.ok(popout, 'the reader offers a pop-out control')
  await inAct(async () => { popout!.click(); await flush(12) })

  const reg = openSurfaces().find((s) => s.org === 'alpha')
  assert.ok(reg, 'popping the reader out registers it')
  assert.equal(reg!.identity?.().document, 'd1', 'baseline: it publishes the document it was opened on')

  // the list is inside the popped-out window now, so the row is clicked there
  const doc = child.document
  const rowD2 = [...doc.querySelectorAll('.doc-gallery-row')]
    .find((r) => (r.textContent ?? '').includes('Second doc')) as HTMLElement | undefined
  assert.ok(rowD2, 'the reader lists the other presentation as a row to click')
  await inAct(async () => { rowD2!.click(); await flush(12) })

  const showing = doc.querySelector('.mailer-read')?.textContent ?? ''
  assert.match(showing, /Second doc/, 'precondition: the window is now SHOWING d2')
  assert.doesNotMatch(showing, /body of d1/,
    'precondition: and not d1 any anymore — otherwise this proves nothing')

  assert.equal(detachedDocument('alpha', 'd2')?.id, reg!.id,
    'a click on the card for d2 must surface the window that is showing d2, not open a second reader for it')
  assert.equal(detachedDocument('alpha', 'd1'), undefined,
    'and this window must stop answering for d1 — otherwise clicking d1 raises a window where d1 is not, '
    + 'AND swallows the click, so d1 can never be opened at all. That is worse than the bug being fixed.')
})

test('§9 a match that cannot be raised is not a handled click', (t) => {
  const offs: (() => void)[] = []
  t.after(clean(offs))
  // Nothing has reproduced a registration outliving its window — a surface
  // unregisters on redock and on unmount, and Electron does fire pagehide. It
  // is guarded because of HOW it would fail: the lookup would match, the click
  // would count as handled, and the document would become silently unopenable.
  offs.push(registerWindow(surface({ id: 'dead', identity: () => ({ document: 'd1' }),
    window: { closed: true, focus() {} } as unknown as Window })))
  assert.equal(detachedDocument('alpha', 'd1'), undefined, 'a closed window is not a destination')
  assert.equal(revealDetachedDocument('alpha', 'd1'), false,
    'so the click falls through and the reader opens, rather than being swallowed')

  // and a live surface whose focus throws is likewise not a handled click
  offs.push(registerWindow(surface({ id: 'hostile', identity: () => ({ document: 'd2' }),
    window: { focus() { throw new Error('window is gone') } } as unknown as Window })))
  assert.equal(revealDetachedDocument('alpha', 'd2'), false)
})
