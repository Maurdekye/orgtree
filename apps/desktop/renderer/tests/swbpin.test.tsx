// swbpin.test.tsx — user ruling 2026-09-05: THE SWITCHBOARD MUST NOT MOUNT A
// SECOND VIEW OF A PINNED AGENT. It should focus the pin that already exists.
//
// This is the same ruling pins.test.tsx §B3 already holds for the CANVAS
// ("PINNED MEANS PINNED": zooming onto a pinned card opens no second desk).
// The switchboard was the surface that never got the guard: `EyeDesk` built
// its panel list from `agents.filter(!minned)` and knew nothing about pins, so
// a pinned agent got a pinned window AND a switchboard panel. Two mounted
// chats for one node share one `orgtree-draft-<slug>-<nid>` composer key and
// fight over it silently, which is why the count — not the appearance — is the
// thing asserted here.
//
// ⚠ WHAT THIS FILE COUNTS, AND WHY THAT IS THE HONEST MEASURE. `desksFor`
// counts REAL MOUNTED chats for one agent anywhere in the host, by the desk
// header's `.cc-name`. It is not a class check on the tab and not a look at
// props: a fix that hid the panel with CSS, or that rendered it and merely
// styled it away, would still be counted here as two. §A is the positive
// control — with no pins the same counter reports the switchboard's panel — so
// a zero in §B cannot be a selector that stopped matching.
//
// ⚠ WHAT jsdom CANNOT DO HERE. It lays nothing out; every rect is 0×0. The
// viewport is stubbed explicitly (as pins.test.tsx does) so the camera and the
// pin layer have real numbers to work with. Where a pinned window actually
// PAINTS, and whether the raised window is visibly on top, are browser
// questions and are not claimed by this file.
//
// Run:  cd frontend && node tests/run.mjs swbpin

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { addPin, forgetPins, readPins, removePin } from '../src/canvas/pins'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

function tree(nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: nodeIds.map(mk), cost_usd_total: 0,
    audit: { live_nodes: nodeIds.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

const settle = (ms: number) => advance(ms, 16)

/** how many live chats exist for `id` anywhere in the host — pinned window
 *  and switchboard panel alike. The number the user's ruling caps at one. */
const desksFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.desk-body .cc-name')]
    // ⚠ NOT the tab strip. Since the switchboard tab's name became its own
    // navigation control it is a `.cc-name` too, and it sits inside the
    // switchboard's `.desk-body` — but a tab is a label and a link, not a
    // mounted chat. Counting it would report two chats for every open agent
    // and this suite would fail while nothing was wrong. The check that this
    // exclusion did not blind the counter is §B's mutant: restore the old
    // `open` filter and §B still reports the real duplicate.
    .filter((n) => !n.closest('.eye-tab-id'))
    .filter((n) => (n.textContent ?? '').trim() === id).length
/** the same count, restricted to the SWITCHBOARD's own panel row */
const panelsFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.eye-panels .cc-name')]
    .filter((n) => (n.textContent ?? '').trim() === id).length
const tabFor = (el: HTMLElement, id: string): HTMLElement => {
  const tab = [...el.querySelectorAll('.eye-tab')].find((t) =>
    (t.querySelector('.eye-tab-id')?.textContent ?? '').includes(id))
  assert.ok(tab, `no switchboard tab for "${id}"`)
  return tab as HTMLElement
}
const tabMain = (el: HTMLElement, id: string) =>
  tabFor(el, id).querySelector('.eye-tab-main') as HTMLElement
const minnedIds = () =>
  JSON.parse(localStorage.getItem('orgtree-eyemin-mine') || '[]') as string[]

// -------------------------------------------------------------------- rig
let canvasMod: typeof import('../src/canvas/OrgCanvas') | null = null

function makeHost() {
  const box: { set?: (t: TreePayload) => void } = {}
  const Host = ({ initial }: { initial: TreePayload }) => {
    const [t, setT] = useState(initial)
    box.set = setT
    const { OrgCanvas } = canvasMod!
    return <OrgCanvas tree={t} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />
  }
  return { Host, box }
}

type Mount = (el: React.ReactElement) => Promise<{ el: HTMLElement; unmount: () => Promise<void> }>

function uiTest(name: string, body: (k: { mount: Mount }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    localStorage.clear()
    forgetPins()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
      localStorage.clear()
      forgetPins()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el, unmount: v.unmount }
      },
    })
  })
}

const AGENTS = ['ceo', 'cto', 'qa']

/** mount the canvas, give jsdom a measured viewport (it has none of its own),
 *  and open the SWITCHBOARD through the HUD eye button — the same control the
 *  product offers, not a prop poke. */
async function switchboard(mount: Mount) {
  canvasMod = await import('../src/canvas/OrgCanvas')
  const { Host } = makeHost()
  const { el } = await mount(<Host initial={tree(AGENTS)} />)
  await flush()
  const viewport = el.querySelector('.viewport') as HTMLElement
  assert.ok(viewport, 'the canvas viewport rendered')
  Object.defineProperty(viewport, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1300, bottom: 850,
      width: 1300, height: 850, toJSON: () => ({}) }),
  })
  await settle(2500)
  const eye = el.querySelector('.hud-eye') as HTMLElement | null
  assert.ok(eye, 'the HUD eye button rendered')
  await inAct(() => { eye!.click() })
  await settle(1500)
  assert.ok(el.querySelector('.eye-desk'),
    'the switchboard did not open — nothing below would mean anything')
  return { el, viewport }
}

/** pin `id` at an explicit rect (jsdom cannot measure a card) and settle */
async function pin(id: string) {
  await inAct(() => { addPin('mine', id, { x: 60, y: 60, w: 320, h: 240 }) })
  await flush()
}
async function unpin(id: string) {
  await inAct(() => { removePin('mine', id) })
  await flush()
}

// ---------------------------------------------------------------------------
uiTest('§A CONTROL — unpinned, the switchboard mounts exactly one chat per line',
  async ({ mount }) => {
    const { el } = await switchboard(mount)
    for (const id of AGENTS) {
      assert.equal(panelsFor(el, id), 1,
        `${id} must have a switchboard panel when nothing is pinned`)
      assert.equal(desksFor(el, id), 1, `${id} must have exactly one chat`)
    }
    assert.equal(el.querySelectorAll('.pinwin').length, 0, 'no pins yet')
  })

uiTest('§B THE RULING — a pinned agent gets its window, not a second panel',
  async ({ mount }) => {
    const { el } = await switchboard(mount)
    assert.equal(desksFor(el, 'cto'), 1, 'precondition: one chat before pinning')
    await pin('cto')

    assert.equal(desksFor(el, 'cto'), 1,
      'PINNED MEANS PINNED: a pinned agent must have exactly ONE mounted chat, '
      + 'and the switchboard was the surface that mounted the second one')
    assert.equal(panelsFor(el, 'cto'), 0,
      'the switchboard must not render a panel for a pinned agent')
    const win = el.querySelector('.pinwin[data-id="cto"]')
    assert.ok(win, 'the pinned window exists')
    assert.ok(win!.querySelector('.desk-body .cc-name'),
      '…and it is the surviving chat — the one chat must be the PIN, not the panel')

    // the other lines are untouched: this is a per-agent rule, not a mode
    for (const id of ['ceo', 'qa']) {
      assert.equal(panelsFor(el, id), 1, `${id} keeps its panel`)
    }
    // the tab is still there and says what it now does
    const tab = tabFor(el, 'cto')
    assert.ok(tab.className.includes('pinned'), 'the pinned tab is marked')
    assert.match(tabMain(el, 'cto').title, /pinned window/,
      'the tab says it will raise the window rather than open a chat')
  })

uiTest('§C the pinned tab RAISES the window; a normal tab still toggles',
  async ({ mount }) => {
    const { el } = await switchboard(mount)
    await pin('cto')
    await pin('qa')
    // cto is the older pin, so it sits BELOW qa
    const zOf = (id: string) => readPins('mine').find((p) => p.id === id)!.z
    assert.ok(zOf('cto') < zOf('qa'),
      'precondition: the tab we are about to click is the buried window')

    await inAct(() => { tabMain(el, 'cto').click() })
    await flush()
    assert.ok(zOf('cto') > zOf('qa'),
      'clicking a pinned tab must RAISE that window')
    assert.equal(panelsFor(el, 'cto'), 0,
      'and must NOT open a duplicate panel in the switchboard')
    assert.equal(desksFor(el, 'cto'), 1, 'still exactly one chat for cto')

    // POSITIVE CONTROL for the click plumbing: an UNPINNED tab still
    // minimizes. Without this, "no panel appeared" above could just as well
    // mean the click never reached anything.
    assert.equal(panelsFor(el, 'ceo'), 1)
    await inAct(() => { tabMain(el, 'ceo').click() })
    await flush()
    assert.equal(panelsFor(el, 'ceo'), 0,
      'CONTROL BROKEN: an ordinary tab click did nothing, so §C proves nothing')
    assert.deepEqual(minnedIds(), ['ceo'],
      'and it is the minimize path that ran, not something else')
  })

uiTest('§D pin/unpin transfers cleanly: minimize choices and drafts survive',
  async ({ mount }) => {
    const { el } = await switchboard(mount)
    // the reader minimizes ceo and starts typing to cto
    await inAct(() => { tabMain(el, 'ceo').click() })
    await flush()
    assert.deepEqual(minnedIds(), ['ceo'])
    const composer = [...el.querySelectorAll('textarea')].find(t => t.placeholder.includes('cto'))!
    assert.ok(composer, 'a real composer receives the draft before moving')
    Object.getOwnPropertyDescriptor(composer.constructor.prototype, 'value')!.set!.call(composer, 'half-written thought')
    await inAct(() => { composer.dispatchEvent(new Event('input', { bubbles: true })) })
    await flush()

    await pin('cto')
    assert.deepEqual(minnedIds(), ['ceo'],
      'pinning must not write into the minimize set — it is the reader\'s '
      + 'own open/closed choice, not a slot the pin may borrow')
    assert.equal(localStorage.getItem('orgtree-draft-v2-["mine","cto",0]'),
      'half-written thought', 'the draft is keyed per NODE, not per surface')

    await unpin('cto')
    assert.equal(panelsFor(el, 'cto'), 1,
      'unpinning returns the panel — the tab state it left was preserved')
    assert.equal(panelsFor(el, 'ceo'), 0,
      'and ceo is still minimized: the transfer erased nothing')
    assert.deepEqual(minnedIds(), ['ceo'])
    const ta = [...el.querySelectorAll('.eye-panels textarea')]
      .find((t) => (t as HTMLTextAreaElement).placeholder.includes('cto'))
    assert.ok(ta, 'the returned panel has its composer')
    assert.equal((ta as HTMLTextAreaElement).value, 'half-written thought',
      'and the draft came back with it')
  })

uiTest('§E every line pinned: the empty state names the right absence',
  async ({ mount }) => {
    const { el } = await switchboard(mount)
    for (const id of AGENTS) await pin(id)
    assert.equal(el.querySelectorAll('.eye-panels .cc-name').length, 0)
    const msg = (el.querySelector('.eye-panels .dim.pad')?.textContent ?? '')
    assert.match(msg, /pinned window/,
      `the switchboard says "${msg}" — with every chat PINNED, telling the `
      + 'reader they are all minimized sends them looking for a tab to '
      + 'un-minimize that does not exist')
    // and every tab is still a live route to its window
    for (const id of AGENTS) {
      assert.ok(tabFor(el, id).className.includes('pinned'))
    }
  })

uiTest('§F the tab NAME navigates; the panel toggle beside it does not',
  async ({ mount }) => {
    // user rule 2026-09-05: an agent's name is clickable everywhere except
    // inside that agent's own focused desk. The switchboard tab used to put
    // the name INSIDE the minimize button, so clicking the name minimized a
    // chat; the only route to the agent was a ⌖ arrow that does not contain
    // the name, which is not the name being a link.
    const { el } = await switchboard(mount)
    const xf = () => (el.querySelector('.space') as HTMLElement).style.transform

    const id = tabFor(el, 'cto').querySelector('.eye-tab-id')
    assert.ok(id, 'the tab renders the name as its own element')
    const link = id!.querySelector('button.cc-name.cc-name-jump')
    assert.ok(link, 'and that name is a navigation control, not plain text')
    assert.equal(link!.textContent, 'cto')
    assert.ok(id!.querySelector('.tier'),
      'the model chip sits with the name, as it does on every other surface')

    // the PANEL TOGGLE must not navigate — same two actions as before, just
    // no longer sharing one hit target
    const before = xf()
    await inAct(() => { (tabMain(el, 'cto')).click() })
    await flush()
    assert.equal(xf(), before, 'the panel toggle moved the camera')
    assert.equal(panelsFor(el, 'cto'), 0, 'and it did minimize the panel')

    // the NAME does navigate. ⚠ POSITIVE CONTROL FOR THE ASSERTION ABOVE: if
    // this one does not move the camera either, then "the toggle did not
    // navigate" is a statement about a broken rig, not about the toggle.
    await inAct(() => { (link as HTMLElement).click() })
    await settle(1500)
    assert.notEqual(xf(), before,
      'clicking the agent NAME did not move the camera — the name is not a '
      + 'route to the agent, which is the whole rule')
  })
