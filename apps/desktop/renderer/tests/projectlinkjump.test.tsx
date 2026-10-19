// projectlinkjump.test.tsx — an agent link on a PROJECT desk's tables
// jumps like every other agent link (user bug 2026-10-19 21:17:25Z,
// alpha.13: "on a project desk's inbox Listeners tab, clicking an agent link
// breaks the canvas: the focused project returns to its near-zoom view and
// the desk fades, but the camera does not move to the agent, and the canvas
// can no longer be dragged until the page is refreshed").
//
// The whole canvas, as eyepressleak.test.tsx drives it: under jsdom no rect
// has a size, so a focus lands the camera on a transform that names the card
// it focused, and §REF records the one a plain card click produces. Each
// case focuses the project (its desk opens), opens one surface, clicks the
// agent link there, and holds the result to the reference: that agent's desk
// open at the reference camera, and a drag on the empty canvas still pans it.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectlinkjump

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { Z_DESK } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}

function mk(id: string, parent: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: id, parent, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 1, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}

const at = '2026-10-19T07:00:00.000Z'
const dog = (kind: string, owner: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'build', interval_s: 5, state: 'armed',
    at, fired: 0, once: false, spent: false, ...extra })

/** boss over project build, whose worker listens for its mail and its
 *  event and holds its one concurrency slot */
function tree(): TreePayload {
  const worker = mk('worker', 'build')
  const helper = mk('helper', 'build')
  const build = mk('build', 'boss', { kind: 'project', tier: 'project', model_id: '',
    configured_scope: { tools: {}, add_dirs: [], slots_capacity: 1 }, children: [worker, helper] })
  const boss = mk('boss', null, { children: [build] })
  return {
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: [boss], cost_usd_total: 0,
    audit: { live_nodes: 3, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
    watchdogs: [dog('fair_queue', 'worker', 'mail'), dog('project_listener', 'worker', 'ready')],
    slot_leases: [lease],
  } as unknown as TreePayload
}
const lease = { project: 'build', agent: 'worker', slot: 1, lease: 'l1', since: at }
/** the engine's answers the desk asks for: the Slots tab's slot_status */
const op = (b: { op: string }) => Promise.resolve((b.op === 'slot_status'
  ? { project: 'build', slots: 1, held: 1, holders: [lease], line: [], history: [], history_next: null } : {}) as never)

// jsdom has PointerEvent but no pointer capture (eyepressleak.test.tsx)
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = noop
  proto.releasePointerCapture = noop
  proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

const W = () => globalThis as unknown as { window: { PointerEvent: typeof PointerEvent } }
function pointer(type: string, x: number, y: number): Event {
  return new (W().window.PointerEvent)(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1, clientX: x, clientY: y,
  })
}

type Cam = { x: number; y: number; z: number }
function cam(host: HTMLElement): Cam {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}
const same = (a: Cam, b: Cam) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01
const show = (c: Cam) => `(${c.x.toFixed(2)}, ${c.y.toFixed(2)}) @${c.z.toFixed(3)}`

/** a card's agent (a focused card, the desk, drops data-copy-agent-name) */
const nameOf = (c: Element) => c.getAttribute('data-copy-agent-name') ?? c.getAttribute('data-first-use-agent') ?? null
const card = (host: HTMLElement, id: string) => {
  const el = [...host.querySelectorAll('.sq')].find((c) => nameOf(c) === id)
  assert.ok(el, `no card for ${id}`)
  return el
}
/** the agents whose desk is open */
const desks = (host: HTMLElement) => [...host.querySelectorAll('.sq.desk:not(.user)')].map(nameOf)

/** click a card the way a mouse does: press and release without moving */
async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1200)          // the glide, and the desk it opens
}

/** click a link the way a mouse does: press, release, click */
async function clickLink(el: HTMLElement): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 300, 300)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 300, 300)) })
  await inAct(() => { el.click() })
  await flush()
  await advance(1200)
}

/** a drag on the empty canvas */
async function dragCanvas(viewport: HTMLElement): Promise<void> {
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 460, 340)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 460, 340)) })
  await flush()
}

const tab = (host: HTMLElement, name: string) => inAct(async () => {
  const b = host.querySelector<HTMLButtonElement>(`.project-desk .cc-tabs button[data-tab="${name}"]`)
  assert.ok(b, `no ${name} tab on the project desk`)
  b!.click(); await flush(4)
})

function uiTest(name: string, body: (k: { host: HTMLElement; viewport: HTMLElement }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    installFetch(new FakeServer())
    const unstub = stubPointerCapture()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unstub()
      resetConvos()
      realClock()
    })
    const v = await mountView(<OrgCanvas tree={tree()} op={op}
      slug="mine" toast={noop} mailEvt={null} />, (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    await advance(2500)       // the opening drift
    await body({ host: v.el, viewport })
  })
}

let refCam: Cam | null = null
uiTest('§REF a plain click on the worker card focuses it', async ({ host }) => {
  await clickCard(card(host, 'worker'))
  assert.deepEqual(desks(host), ['worker'], 'the worker desk opened')
  refCam = cam(host)
  assert.ok(refCam.z >= Z_DESK, `focused at ${show(refCam)}, under Z_DESK`)
})

/** focus the project, open a surface on its desk, click worker's link there */
function linkCase(name: string, open: (host: HTMLElement) => Promise<HTMLElement>) {
  uiTest(name, async ({ host, viewport }) => {
    assert.ok(refCam, '§REF did not run')
    await clickCard(card(host, 'build'))
    assert.ok(host.querySelector('.sq.project .project-desk'), 'the project desk opened')
    const link = await open(host)
    assert.equal(link.tagName, 'BUTTON', 'a live agent link')
    await clickLink(link)
    const after = cam(host)
    assert.deepEqual(desks(host), ['worker'], `the link opened no worker desk (camera ${show(after)})`)
    assert.ok(same(after, refCam!), `the link landed at ${show(after)}, a card click lands at ${show(refCam!)}`)
    assert.equal(host.querySelector('.project-desk'), null, 'the project desk closed')
    await dragCanvas(viewport)
    const dragged = cam(host)
    assert.ok(Math.abs(dragged.x - after.x - 60) < 0.01 && Math.abs(dragged.y - after.y - 40) < 0.01,
      `a drag on the empty canvas moved the camera from ${show(after)} to ${show(dragged)}, not by (60, 40)`)
  })
}

linkCase("§1 the inbox's Listeners folder", async (host) => {
  await tab(host, 'inbox')
  const folder = [...host.querySelectorAll<HTMLButtonElement>('.project-desk .mail-folders button')]
    .find((b) => b.textContent?.startsWith('listeners'))
  assert.ok(folder, 'the listeners folder')
  await inAct(async () => { folder!.click(); await flush(3) })
  const link = host.querySelector<HTMLElement>('.project-desk .mail-listeners-table [data-copy-agent-name="worker"]')
  assert.ok(link, "worker's link in the mail listeners table")
  return link!
})

linkCase('§2 the event Listeners tab', async (host) => {
  await tab(host, 'listeners')
  // any markup the tab has had: its old rows and its table name the agent alike
  const link = host.querySelector<HTMLElement>('.project-desk .project-listeners [data-copy-agent-name="worker"]')
  assert.ok(link, "worker's link on the event Listeners tab")
  return link!
})

linkCase('§3 the Slots tab', async (host) => {
  await tab(host, 'slots')
  const link = host.querySelector<HTMLElement>('.project-desk .project-slots [data-copy-agent-name="worker"]')
  assert.ok(link, "worker's link in the slots table")
  return link!
})

linkCase("§4 CONTROL: the members' jump card", async (host) => {
  const link = host.querySelector<HTMLElement>('.project-desk .desk-nav [data-copy-agent-name="worker"]')
  assert.ok(link, "worker's jump card")
  return link!
})
