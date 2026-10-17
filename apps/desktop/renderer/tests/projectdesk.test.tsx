// projectdesk.test.tsx — the PROJECT DESK (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 5, user
// 2026-10-17 19:38Z: "give them a zoomed-in desk view, similar to agents, with
// tabs for the various things you can view in them").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a focused project card opens a desk in the agent desk's frame: the
//      header names the project, the tabs are desk, inbox, docket and
//      presented (the agent desk's three, user 20:07Z) and there is no chat
//      or composer; an unfocused card has none;
//   §2 the main tab: jump cards up to the parent and down to the members
//      (the chat desk's NavChip), and the description editor: Markdown while
//      not focused, monospace text while focused, saved by set_description on
//      leaving it, dropped by Escape (user 20:06Z);
//   §3 the header: active/hired agents under it, nested projects crossed but
//      not counted, and the spinner while any is active (20:08Z);
//   §4 halt all and dissolve project (20:09Z) open the agent paths' own
//      confirmations; the gear opens settings (20:09:45Z);
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
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

function project(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, parent: 'boss',
    charter: '# The site\n\nDeploy from **main** only.',
    children: [
      { id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', busy: true, children: [] },
      { id: 'ui', title: 'ui', tier: 'project', kind: 'project', state: 'live', children: [
        { id: 'dev2', title: 'dev2', tier: 'sonnet', state: 'live', busy: false, children: [] },
        { id: 'old', title: 'old', tier: 'haiku', state: 'archived', children: [] },
      ] },
    ],
    lineage: [], turns: [], audiences_held: [], mail_pending: 2,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}
const boss = { id: 'boss', title: 'boss', tier: 'opus', state: 'live', children: [] } as unknown as CanvasNode

const tree = {
  slug: 'org', roots: [],
} as unknown as TreePayload

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

async function desk(t: TestContext, h: { jump?: (id: string) => void; config?: () => void;
  pin?: () => void; bare?: boolean; node?: CanvasNode; ops?: OpRequest[] } = {}) {
  serve(t)
  const nd = h.node ?? project()
  const ops = h.ops ?? []
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={new Map([[nd.id, nd], ['boss', boss]])}
    op={(b) => { ops.push(b); return Promise.resolve({} as OpResult) }}
    toast={noop} refs={refs} bare={h.bare} onJump={h.jump} onConfig={h.config} onPin={h.pin} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  return view.el
}

const tabs = (el: Element) => [...el.querySelectorAll('.cc-tabs button')].map((b) => b.getAttribute('data-tab'))
const setText = (box: HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}
const cancelDialog = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'cancel')?.click()

/* ─── §1 the desk ───────────────────────────────────────────────────────── */

test('§1a the project desk: the agent desk frame, the project\'s name, the agent desk\'s tabs and no chat', async (t) => {
  const el = await desk(t)
  assert.ok(el.querySelector('.desk-over .desk-inner.desk-body .cc-head'), 'the agent desk\'s frame and header')
  assert.equal(el.querySelector('.cc-head-left .name')?.textContent, 'website')
  assert.ok(el.querySelector('.cc-head-left .project-mark svg'), 'the folder mark')
  assert.deepEqual(tabs(el), ['desk', 'inbox', 'docket', 'presented'])
  assert.equal(el.querySelector('.cc-tabs button[data-tab="desk"]')?.classList.contains('on'), true, 'it opens on its main tab')
  assert.equal(el.querySelector('.cc-tabs button[data-tab="inbox"] .tab-count')?.textContent, '2')
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

/* ─── §2 the main tab ───────────────────────────────────────────────────── */

test('§2a jump cards up to the parent and down to its members', async (t) => {
  const jumped: string[] = []
  const el = await desk(t, { jump: (id) => jumped.push(id) })
  const navs = [...el.querySelectorAll('.desk-nav')]
  assert.equal(navs.length, 2, 'one row up, one row down')
  const names = (row: Element) => [...row.querySelectorAll('button.desk-nav-chip')].map((b) => b.getAttribute('data-copy-agent-name'))
  assert.deepEqual(names(navs[0]!), ['boss'])
  assert.deepEqual(names(navs[1]!), ['dev1', 'ui'])
  await inAct(() => { navs[1]!.querySelector<HTMLButtonElement>('button.desk-nav-chip')!.click() })
  assert.deepEqual(jumped, ['dev1'])
  assert.equal(el.querySelector('textarea') === null, true, 'no composer, and the editor is not open yet')
})

test('§2b the description: Markdown until focused, monospace while edited, saved on leaving', async (t) => {
  const ops: OpRequest[] = []
  const el = await desk(t, { ops })
  const shown = el.querySelector<HTMLElement>('.project-description-md')!
  assert.ok(shown.querySelector('h1'), 'Markdown: the heading renders')
  assert.equal(shown.querySelector('strong')?.textContent, 'main')
  await inAct(() => { shown.click() })
  await flush(2)
  const box = el.querySelector<HTMLTextAreaElement>('textarea.project-description-edit')!
  assert.ok(box, 'focused, it is a text box')
  assert.equal(box.value, '# The site\n\nDeploy from **main** only.', 'the raw text')
  assert.equal(document.activeElement, box)
  await inAct(() => { setText(box, '# The site\n\nShip it.') })
  await inAct(() => { box.blur() })
  await flush(2)
  assert.deepEqual(ops, [{ op: 'set_description', node: 'website', description: '# The site\n\nShip it.' }])
  assert.ok(el.querySelector('.project-description-md'), 'back to Markdown')
})

test('§2c Escape drops an edit; an unchanged one saves nothing', async (t) => {
  const ops: OpRequest[] = []
  const el = await desk(t, { ops })
  await inAct(() => { el.querySelector<HTMLElement>('.project-description-md')!.click() })
  await flush(2)
  const box = el.querySelector<HTMLTextAreaElement>('textarea.project-description-edit')!
  await inAct(() => { setText(box, 'scrap') })
  await inAct(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await flush(2)
  await inAct(() => { el.querySelector<HTMLElement>('.project-description-md')!.click() })
  await flush(2)
  const again = el.querySelector<HTMLTextAreaElement>('textarea.project-description-edit')!
  assert.equal(again.value, '# The site\n\nDeploy from **main** only.', 'the edit was dropped')
  await inAct(() => { again.blur() })
  await flush(2)
  assert.deepEqual(ops, [], 'nothing saved')
})

/* ─── §3 the header count ───────────────────────────────────────────────── */

test('§3 active/hired agents under the project, nested crossed, projects not counted, spinner while active', async (t) => {
  const el = await desk(t)
  assert.equal(el.querySelector('.cc-head .project-counts')?.textContent, '1/2', 'dev1 active, dev1+dev2 hired')
  assert.ok(el.querySelector('.cc-head .working-ct svg.cc-spin'), 'the spinner')
  const idle = await desk(t, { node: project({ children: [{ id: 'dev1', tier: 'haiku', state: 'live', busy: false, children: [] }] as never }) })
  assert.equal(idle.querySelector('.cc-head .project-counts')?.textContent, '0/1')
  assert.equal(idle.querySelector('.cc-head .working-ct') === null, true, 'no spinner when nobody is active')
})

/* ─── §4 halt all, dissolve, gear ───────────────────────────────────────── */

test('§4 halt all and dissolve project open the agent confirmations; the gear opens settings', async (t) => {
  let config = 0
  const el = await desk(t, { config: () => { config++ } })
  const halt = el.querySelector<HTMLButtonElement>('button[data-action="halt-all"]')!
  assert.equal(halt.textContent, 'halt all')
  await inAct(() => { halt.click() })
  await flush(2)
  assert.match(document.body.textContent ?? '', /halt all agents under project website\?/)
  assert.match(document.body.textContent ?? '', /Halt 2 live agents/)
  await inAct(() => { cancelDialog() })
  await flush(2)
  const dissolve = el.querySelector<HTMLButtonElement>('button[data-action="dissolve"]')!
  await inAct(() => { dissolve.click() })
  await flush(2)
  assert.match(document.body.textContent ?? '', /dissolve website\?/)
  await inAct(() => { cancelDialog() })
  await flush(2)
  const gear = el.querySelector<HTMLButtonElement>('button.cc-icon[aria-label="settings for website"]')!
  await inAct(() => { gear.click() })
  assert.equal(config, 1)
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
