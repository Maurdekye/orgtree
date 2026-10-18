// projectdesk.test.tsx — the PROJECT DESK (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 5, user
// 2026-10-17 19:38Z: "give them a zoomed-in desk view, similar to agents, with
// tabs for the various things you can view in them").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a focused project card opens a desk in the agent desk's frame: the
//      header names the project, the tabs are desk, inbox, docket and
//      presented (the agent desk's three, user 20:07Z) and there is no chat
//      or composer; an unfocused card has none; the presented tab counts AND
//      shows the subtree's documents (review P2);
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
//   §6 project settings carry the agent settings' items that apply (name,
//      description, peer mail, actions) and none of the turn-only ones.
//   §8 last activity: active now, or quiet for the newest turn's age under
//      the project, on the desk header and the middle-zoom card;
//   §7 the middle-zoom card shows the header chip (spinner, active/hired);
//      the app header counts agents, not project nodes; zoomed out the card
//      is its folder (the stripe and size are measured by projectnode-visual).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectdesk

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk, ProjectDeskModal } from '../src/canvas/projectdesk'
import { AgentGalleryView } from '../src/canvas/gallery'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeConfig } from '../src/canvas/modals'
import { ActiveAgentSummary } from '../src/shell/treeinfo'
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

test('§1c the presented tab counts the project\'s OWN documents (point 27, replacing point 8\'s subtree count)', async (t) => {
  const nd = project({ documents_count: 1, children: [
    { id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', documents_count: 2, children: [] },
    { id: 'ui', title: 'ui', tier: 'project', kind: 'project', state: 'live', children: [
      { id: 'dev2', title: 'dev2', tier: 'sonnet', state: 'live', documents_count: 4, children: [] },
    ] },
  ] } as never)
  const el = await desk(t, { node: nd })
  assert.equal(el.querySelector('.cc-tabs button[data-tab="presented"] .tab-count')?.textContent, '1')
})

test('§1d point 27: the project\'s own gallery is the cards the engine attributes to it, a renamed project\'s too; its TEAM gallery the subtree\'s as well', async (t) => {
  const had = globalThis.fetch
  const at = new Date().toISOString()
  // presented under the project while it was still called website; the
  // project has since been renamed to site (the engine reads it by id)
  const own = [{ id: 'p1', node: 'website', title: 'Website plan', at, evicted: false, node_state: 'live', tier: 'project' }]
  const team = [...own,
    { id: 'a1', node: 'dev1', title: 'Dev notes', at, evicted: false, node_state: 'live', tier: 'haiku' },
    { id: 'a2', node: 'dev2', title: 'UI sketch', at, evicted: false, node_state: 'live', tier: 'sonnet' },
  ]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input)
    const docs = u.includes('team=1') ? team : own
    const body = u.includes('/documents?') ? { documents: docs, total: docs.length, next_offset: null, offset: 0 } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = had })
  const titles = (el: Element) => [...el.querySelectorAll('.doc-gallery-row .mfrom')].map((r) => r.textContent)
  const site = project({ id: 'site', title: 'site' } as never)
  const ownView = await mountView(<AgentGalleryView slug="org" nid="site" node={site} toast={noop} />, (el) => el)
  t.after(() => ownView.unmount())
  await inAct(async () => { await flush(6) })
  assert.deepEqual(titles(ownView.el), ['Website plan'], 'the card presented under its old name stays')
  const teamView = await mountView(<AgentGalleryView slug="org" nid="site" node={site} toast={noop} team />, (el) => el)
  t.after(() => teamView.unmount())
  await inAct(async () => { await flush(6) })
  assert.deepEqual(titles(teamView.el).sort(), ['Dev notes', 'UI sketch', 'Website plan'], 'and the members\' cards')
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

/* ─── §6 project settings ───────────────────────────────────────────────── */
// USER 2026-10-17 20:10Z: project settings have the agent settings' items
// where they apply or have a parallel; turn-only items are left out.

test('§6 project settings: name, description, peer mail, actions; no turn-only items; save sends set_description', async (t) => {
  serve(t)
  const ops: OpRequest[] = []
  const nd = project()
  const view = await mountView(<NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={tree} slug="org"
    op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  const text = document.body.textContent ?? ''
  for (const want of ['Name', 'Project actions', 'Description', 'Subordinates may message each other', 'dissolve project'])
    assert.ok(text.includes(want), `has "${want}"`)
  for (const not of ['Model', 'Visible agents', 'File and command access', 'Instructions', 'rescind'])
    assert.equal(text.includes(not), false, `no "${not}" on a project`)
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project description"]')!
  assert.equal(box.value, '# The site\n\nDeploy from **main** only.')
  await inAct(() => { setText(box, 'New text.') })
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'save')!
  await inAct(async () => { save.click(); await flush(4) })
  assert.deepEqual(ops, [{ op: 'set_description', node: 'website', description: 'New text.' }])
})

/* ─── §7 the card's count and the app header ────────────────────────────── */
// USER 2026-10-17 21:21Z: the middle-zoom card shows active/hired like the header.

test('§7a the middle-zoom project card shows the header\'s chip: spinner and active/hired', async (t) => {
  serve(t)
  const view = await mountView(<ProjectSquare node={project()} pos={{ x: 0, y: 0 }} lod="norm"
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} zoom={1.2} hire={{}} seats={{}}
    onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const chip = view.el.querySelector('.sq.project .sq-head .chip.agents.project-activity')
  assert.ok(chip, 'the activity chip on the card')
  assert.equal(chip.querySelector('.org-counts')?.textContent, '1/2')
  assert.ok(chip.querySelector('.working-ct svg.cc-spin'), 'the spinner while dev1 works')
})

test('§7b the app header counts agents only, never project nodes', async (t) => {
  serve(t)
  const view = await mountView(<ActiveAgentSummary tree={{ slug: 'org', name: 'Org', roots: [project()] } as unknown as TreePayload} />, (el) => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.org-counts')?.textContent, '1/2', 'website and ui are not hired agents')
})

test('§7c zoomed out, a project is its folder: no tier stripe class hook, the large folder', async (t) => {
  serve(t)
  const view = await mountView(<ProjectSquare node={project()} pos={{ x: 0, y: 0 }} lod="mini"
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} zoom={0.4} hire={{}} seats={{}}
    onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const sq = view.el.querySelector('.sq.project.mini')!
  assert.ok(sq.querySelector('.project-mini svg'), 'the folder')
  assert.equal(sq.querySelector('.project-activity') === null, true, 'no count at far zoom')
  // jsdom applies no stylesheet: the stripe and size are held by the capture
  // (projectnode-visual.mjs), which measures ::before and the icon's size
})

/* ─── §8 last activity ──────────────────────────────────────────────────── */
// USER 2026-10-17 22:21Z: "active / quiet time makes sense, add that". From
// the newest turn activity of any agent under the project; on the desk header
// and on the middle-zoom card beside the active/hired chip.

const quiet = (secondsAgo: number) => project({ children: [
  { id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', busy: false,
    turns: [{ at: new Date(Date.now() - 3600_000).toISOString(), cost: 0, denials: 0 }], children: [] },
  { id: 'ui', title: 'ui', tier: 'project', kind: 'project', state: 'live', children: [
    { id: 'dev2', title: 'dev2', tier: 'sonnet', state: 'live', busy: false,
      turns: [{ at: new Date(Date.now() - secondsAgo * 1000).toISOString(), cost: 0, denials: 0 }], children: [] },
  ] },
] } as never)

test('§8a the desk header says active now while any agent under the project works', async (t) => {
  const el = await desk(t)
  assert.equal(el.querySelector('.cc-head .project-last-activity')?.textContent, 'active now')
})

test('§8b otherwise quiet for the age of the newest turn under it, nested included', async (t) => {
  const el = await desk(t, { node: quiet(300) })
  assert.equal(el.querySelector('.cc-head .project-last-activity')?.textContent, 'quiet for 5m',
    'dev2 (in nested ui) ended 5m ago, newer than dev1\'s hour')
})

test('§8c the middle-zoom card carries it beside the active/hired chip', async (t) => {
  serve(t)
  const view = await mountView(<ProjectSquare node={quiet(300)} pos={{ x: 0, y: 0 }} lod="norm"
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} zoom={1.2} hire={{}} seats={{}}
    onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const meta = view.el.querySelector('.sq.project .project-meta')!
  assert.ok(meta.querySelector('.project-activity'), 'the chip')
  assert.equal(meta.querySelector('.project-last-activity')?.textContent, 'quiet for 5m')
})

test('§8d a project whose agents never ran a turn shows no activity card', async (t) => {
  const el = await desk(t, { node: project({ children: [] }) })
  assert.equal(el.querySelector('.project-last-activity') === null, true)
})

// coordinator visual review of the activity capture, 2026-10-17 23:25Z

test('§8e an idle chip keeps no empty spinner slot; an active one has its spinner', async (t) => {
  const idle = await desk(t, { node: quiet(300) })
  assert.equal(idle.querySelector('.cc-head .project-activity .org-activity') === null, true, 'no gap where the spinner sits')
  assert.equal(idle.querySelector('.cc-head .project-activity')?.textContent, '0/2', 'dev1 and the nested dev2, no slot before them')
  const busy = await desk(t)
  assert.ok(busy.querySelector('.cc-head .project-activity .org-activity .cc-spin'), 'the spinner while active')
})

test('§9 Open desk: the project desk as a temporary modal that pins and pops out like any panel (point 27, user 23:29:47Z)', async (t) => {
  serve(t)
  let closed = 0
  const nd = project()
  const view = await mountView(<ProjectDeskModal node={nd} slug="org" tree={tree} map={new Map([[nd.id, nd], ['boss', boss]])}
    op={() => Promise.resolve({} as OpResult)} toast={noop} refs={refs} close={() => { closed++ }} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  const panel = document.querySelector('.project-desk-modal')
  assert.ok(panel, 'a modal panel')
  assert.equal(panel!.querySelector('.cc-head-left .name')?.textContent, 'website', 'holding the project desk')
  assert.deepEqual([...panel!.querySelectorAll('.cc-tabs button')].map((b) => b.getAttribute('data-tab')),
    ['desk', 'inbox', 'docket', 'presented'])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flush(1)
  assert.equal(closed, 1, 'Escape closes a centred modal')
})

declare const __SRC_DIR__: string
test('§8f "quiet for 7m" is one font: the label wears the age\'s font, as an agent card\'s state word does', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = /\n\.project-last-activity \{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the .project-last-activity rule')
  assert.match(rule[1]!, /font:\s*600 10px\/1 var\(--mono\)/, 'the .sq-idle / .sq-idle-time font')
})
