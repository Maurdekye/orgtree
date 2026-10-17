// projectdesk.test.tsx — the PROJECT DESK (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 5, user
// 2026-10-17 19:38Z: "give them a zoomed-in desk view, similar to agents, with
// tabs for the various things you can view in them").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a focused project card opens a desk in the agent desk's frame: its
//      header names the project, its tabs are what a project holds (mail,
//      docket, presented, members, about) and there is no chat, composer or
//      turn state; an unfocused card has none;
//   §2 mail: the fair-queue watchers on the project and the mail waiting;
//   §3 members: the nodes directly under it, each one a jump;
//   §4 about: the whole description, named as the standing charter of the
//      agents under it, and the settings and folder actions;
//   §5 bare (a pinned window) draws the same desk unscaled, and pin is offered
//      only where a pin handler is given.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectdesk

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { ProjectSquare } from '../src/canvas/projectcard'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

function project(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    charter: 'The company website.\nDeploy from main only.',
    children: [
      { id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', children: [] },
      { id: 'ui', title: 'ui', tier: 'project', kind: 'project', state: 'live', children: [] },
    ],
    lineage: [], turns: [], audiences_held: [], mail_pending: 2,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}

const tree = {
  slug: 'org', roots: [],
  watchdogs: [
    { id: 'w1', owner: 'dev1', name: 'web-queue', kind: 'fair_queue', target: 'website', state: 'armed', interval_s: 0, at: '', fired: 0 },
    { id: 'w2', owner: 'dev2', name: 'web-queue', kind: 'fair_queue', target: 'website', state: 'paused', interval_s: 0, at: '', fired: 0 },
    { id: 'w3', owner: 'dev1', name: 'other', kind: 'fair_queue', target: 'docs', state: 'armed', interval_s: 0, at: '', fired: 0 },
    { id: 'w4', owner: 'dev1', name: 'logs', kind: 'file', target: 'website', state: 'armed', interval_s: 0, at: '', fired: 0 },
  ],
} as unknown as TreePayload

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

async function desk(t: TestContext, h: { jump?: (id: string) => void; settings?: () => void;
  pin?: () => void; bare?: boolean } = {}) {
  serve(t)
  const nd = project()
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={new Map([[nd.id, nd]])}
    toast={noop} refs={refs} bare={h.bare} onJump={h.jump} onSettings={h.settings} onPin={h.pin} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  return view.el
}

const tabs = (el: Element) => [...el.querySelectorAll('.cc-tabs button')].map((b) => b.getAttribute('data-tab'))
async function open(el: Element, tab: string) {
  const b = el.querySelector<HTMLButtonElement>(`.cc-tabs button[data-tab="${tab}"]`)
  assert.ok(b, `a ${tab} tab`)
  await inAct(() => { b.click() })
  await flush(2)
}

/* ─── §1 the desk ───────────────────────────────────────────────────────── */

test('§1a the project desk: the agent desk frame, the project\'s name, its own tabs and no chat', async (t) => {
  const el = await desk(t)
  assert.ok(el.querySelector('.desk-over .desk-inner.desk-body .cc-head'), 'the agent desk\'s frame and header')
  assert.equal(el.querySelector('.cc-head-left .name')?.textContent, 'website')
  assert.ok(el.querySelector('.cc-head-left .project-mark svg'), 'the folder mark')
  assert.deepEqual(tabs(el), ['mail', 'docket', 'presented', 'members', 'about'])
  assert.equal(el.querySelector('.cc-tabs button[data-tab="mail"]')?.classList.contains('on'), true, 'it opens on its mail')
  assert.equal(el.querySelector('.cc-tabs button[data-tab="mail"] .tab-count')?.textContent, '2')
  assert.equal(el.querySelector('textarea') === null, true, 'no composer: a project takes no turns')
  assert.equal(el.querySelector('.cc-tabs button[data-tab="chat"]') === null, true, 'no chat tab')
})

const square = (focused: boolean) => mountView(<ProjectSquare node={project()} pos={{ x: 0, y: 0 }} lod="norm"
  focused={focused} dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
  toast={noop} zoom={8} hire={{}} seats={{}} tree={tree} map={new Map()} refs={refs}
  onHire={noop} onNewProject={noop} onInbox={noop}
  onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)

test('§1b a focused project card is a desk; an unfocused one is a card', async (t) => {
  serve(t)
  const on = await square(true)
  t.after(() => on.unmount())
  const sq = on.el.querySelector('.sq.project')
  assert.ok(sq?.classList.contains('desk'), 'the focused card takes the desk class')
  assert.ok(sq?.querySelector('.desk-over .cc-tabs'), 'and holds the desk')
  const off = await square(false)
  t.after(() => off.unmount())
  assert.equal(off.el.querySelector('.desk-over') === null, true, 'no desk on an unfocused card')
})

/* ─── §2 mail ───────────────────────────────────────────────────────────── */

test('§2 mail: the fair-queue watchers on this project and the mail waiting for them', async (t) => {
  const el = await desk(t)
  const fq = el.querySelector('.project-fairqueue')
  assert.ok(fq, 'the fair-queue line')
  const text = fq.textContent ?? ''
  assert.match(text, /2 waiting/)
  assert.match(text, /dev1/)
  assert.match(text, /dev2 \(paused\)/)
  assert.equal(/other|logs/.test(text), false, 'only fair_queue dogs on THIS project')
})

/* ─── §3 members ────────────────────────────────────────────────────────── */

test('§3 members: the nodes under it, each a jump', async (t) => {
  const jumped: string[] = []
  const el = await desk(t, { jump: (id) => jumped.push(id) })
  await open(el, 'members')
  const rows = [...el.querySelectorAll<HTMLButtonElement>('.project-members button.member')]
  assert.deepEqual(rows.map((r) => r.dataset.member), ['dev1', 'ui'])
  assert.ok(rows[1]!.querySelector('svg'), 'a nested project shows the folder mark')
  await inAct(() => { rows[0]!.click() })
  assert.deepEqual(jumped, ['dev1'])
})

/* ─── §4 about ──────────────────────────────────────────────────────────── */

test('§4 about: the whole description as the standing charter, with settings', async (t) => {
  let settings = 0
  const el = await desk(t, { settings: () => { settings++ } })
  await open(el, 'about')
  const about = el.querySelector('.project-about')
  assert.ok(about)
  assert.equal(about.querySelector('.project-description')?.textContent, 'The company website.\nDeploy from main only.')
  assert.match(about.textContent ?? '', /standing charter/)
  const btn = [...about.querySelectorAll('button')].find((b) => /settings/i.test(b.textContent ?? ''))!
  await inAct(() => { btn.click() })
  assert.equal(settings, 1)
})

/* ─── §5 bare and pin ───────────────────────────────────────────────────── */

test('§5 bare draws it unscaled; pin only where a pin handler is given', async (t) => {
  let pinned = 0
  const el = await desk(t, { pin: () => { pinned++ } })
  const pin = el.querySelector<HTMLButtonElement>('button.cc-pin')!
  assert.ok(pin, 'a pin button')
  await inAct(() => { pin.click() })
  assert.equal(pinned, 1)
  const bare = await desk(t, { bare: true })
  assert.ok(bare.querySelector('.desk-bare .desk-body .cc-tabs'), 'the bare frame')
  assert.equal(bare.querySelector('.desk-over') === null, true)
  assert.equal(bare.querySelector('button.cc-pin') === null, true, 'no pin without a handler')
})
