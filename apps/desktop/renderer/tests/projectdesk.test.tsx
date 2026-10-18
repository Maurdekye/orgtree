// projectdesk.test.tsx — the PROJECT DESK (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 5, user
// 2026-10-17 19:38Z: "give them a zoomed-in desk view, similar to agents, with
// tabs for the various things you can view in them").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a focused project card opens a desk in the agent desk's frame: the
//      header names the project, the tabs are desk, inbox, docket,
//      presented and Team (user 2026-10-18 10:53Z), and there is no chat
//      tab (its message box broadcasts: §9); an unfocused card has none; the
//      presented tab counts AND
//      shows the subtree's documents (review P2);
//   §2 the main tab: jump cards up to the parent and down to the members
//      (the chat desk's NavChip), and the description editor: Markdown while
//      not focused, monospace text while focused, saved by set_description on
//      leaving it, dropped by Escape (user 20:06Z); a click puts the caret at about
//      the clicked spot, and at rest it has no border or background (user
//      2026-10-18 07:14Z);
//   §3 the header: active/hired agents under it, nested projects crossed but
//      not counted, and the spinner while any is active (20:08Z);
//   §4 halt all and dissolve project (20:09Z) open the agent paths' own
//      confirmations; the gear opens settings (20:09:45Z);
//   §5 bare (a pinned window) draws the same desk unscaled, and pin is offered
//      only where a pin handler is given; the agent desk's pop-out button
//      likewise, also on the focused card's desk (user 2026-10-18 07:15Z).
//   §6 project settings carry the agent settings' items that apply (name,
//      description, peer mail, actions) and none of the turn-only ones.
//   §8 last activity, in the agent card's words and style (user 2026-10-18
//      07:42Z-07:43Z): "Active <age>" from when the project became active,
//      or "Idle <age>" from the newest turn's end under
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
import { ProjectDesk, ProjectDeskModal, sourceOffset } from '../src/canvas/projectdesk'
import { AgentGalleryView } from '../src/canvas/gallery'
import { pinAccentClass } from '../src/canvas/pins'
import { CurrentOrg } from '../src/popout'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeConfig } from '../src/canvas/modals'
import { ActiveAgentSummary } from '../src/shell/treeinfo'
import { readHistory } from '../src/composerhistory'
import { draftKey } from '../src/draftstore'
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
  const inner = globalThis.fetch
  // The generic FakeServer fallback is {ok:true}, not an inbox response.
  // Both the live window and its explicit history page use the folder contract.
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://fixture.invalid').pathname
    if ((init?.method ?? 'GET') === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(path)) {
      return Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [], next_cursor: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

async function desk(t: TestContext, h: { jump?: (id: string) => void; config?: () => void;
  pin?: () => void; popout?: () => void; bare?: boolean; node?: CanvasNode; ops?: OpRequest[]
  toast?: (lines: string[]) => void; openDoc?: (id: string) => void } = {}) {
  serve(t)
  const nd = h.node ?? project()
  const ops = h.ops ?? []
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={new Map([[nd.id, nd], ['boss', boss]])}
    op={(b) => { ops.push(b); return Promise.resolve({} as OpResult) }}
    toast={h.toast ?? noop} refs={refs} bare={h.bare} onJump={h.jump} onConfig={h.config} onPin={h.pin} onPopout={h.popout}
    onOpenDoc={h.openDoc} />, (el) => el)
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
  assert.equal(el.querySelector('.cc-head-left .name')?.getAttribute('title'), 'project website',
    'the project desk name carries the same identity hover as its project card')
  assert.deepEqual(tabs(el), ['desk', 'inbox', 'docket', 'presented', 'team'])
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

test('project presentation Reply context action stages the document target and focuses the project composer', async (t) => {
  const doc = { id: 'p1', title: 'Release plan', at: new Date().toISOString(), node: 'website' }
  const el = await desk(t, { node: project({ documents: [doc] } as never), openDoc: noop })
  const card = el.querySelector<HTMLElement>('.desk-docs [data-doc-id="p1"]')!
  assert.ok(card, 'the project header presentation card')
  await inAct(() => {
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
  })
  const reply = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
    .find((item) => item.textContent?.trim() === 'Reply')
  assert.ok(reply, 'project presentation cards offer a Reply action')
  await inAct(() => { reply!.click() })
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  assert.equal(document.activeElement, box, 'choosing Reply focuses the project composer')
  assert.equal(el.querySelector('.project-reply-target')?.textContent?.includes('Release plan'), true,
    'the project composer shows the staged presentation target')
})

test('project presentation reader can broadcast a reply while preserving its document target', async (t) => {
  serve(t)
  const row = { id: 'p1', node: 'website', title: 'Release plan', at: new Date().toISOString(),
    evicted: false, node_state: 'live', tier: 'project', format: 'markdown' }
  const calls: { path: string; body?: unknown }[] = []
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://fixture.invalid').pathname
    // Keep the list request pending so this test exercises the desk's normal
    // node-payload bootstrap rows, just as the project opens before its poll.
    if (path === '/api/orgs/org/documents' && !init?.method) return new Promise<Response>(() => {})
    if (path === '/api/orgs/org/documents/p1' && !init?.method)
      return Promise.resolve(new Response(JSON.stringify({ ...row, body: 'Plan body' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    if (init?.method === 'POST' && path === '/api/orgs/org/nodes/website/broadcast') {
      calls.push({ path, body: JSON.parse(String(init.body)) })
      return Promise.resolve(new Response(JSON.stringify({ accepted: true, project: 'website', notice: false,
        sent: [{ to: 'dev1' }], refused: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
  const el = await desk(t, { node: project({ documents: [row] } as never) })
  await inAct(() => { el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="presented"]')!.click() })
  await inAct(async () => { await flush(5) })
  const gallery = el.querySelector('.desk-presented')!
  const card = gallery.querySelector<HTMLElement>('.doc-gallery-row')
  assert.equal(card?.querySelector('.mfrom')?.textContent, 'Release plan', 'the presented tab has the document card')
  assert.ok(card)
  await inAct(() => { card!.click() })
  await inAct(async () => { await flush(4) })
  const reply = gallery.querySelector<HTMLTextAreaElement>('.mailer-read textarea')
  assert.ok(reply, 'the selected presentation has a reply box')
  const broadcast = gallery.querySelector<HTMLButtonElement>('.mailer-read .cc-broadcast-toggle')
  assert.ok(broadcast, 'project presentation replies offer the broadcast option')
  await inAct(() => { reply!.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, bubbles: true, cancelable: true })) })
  assert.equal(broadcast.getAttribute('aria-pressed'), 'true', 'Alt+B arms broadcast on the presentation reply')
  await inAct(() => { setText(reply!, 'Replying to the plan') })
  await inAct(() => { reply!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await flush(5)
  assert.deepEqual(calls, [{ path: '/api/orgs/org/nodes/website/broadcast', body: {
    text: 'Replying to the plan', targets: [{ kind: 'document', org: 'org', id: 'p1' }],
  } }], 'broadcast replies retain the document target for recipients')
  assert.equal(broadcast.getAttribute('aria-pressed'), 'false', 'successful broadcast disarms the option')
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

const square = (focused: boolean, onFocus: () => void = noop) => mountView(<ProjectSquare node={project()} pos={{ x: 0, y: 0 }} lod="norm"
  focused={focused} dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
  toast={noop} zoom={8} hire={{}} seats={{}} tree={tree} map={new Map()} refs={refs} onFocus={onFocus}
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

test('clicking an already-open project desk focuses it again', async (t) => {
  serve(t)
  let focuses = 0
  const view = await square(true, () => { focuses++ })
  t.after(() => view.unmount())
  await inAct(() => { view.el.querySelector('.sq.project')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(focuses, 1, 'clicking the existing project desk requests focus again')
  assert.equal(view.el.querySelectorAll('.desk-over').length, 1, 'the existing desk remains a single instance')
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
  assert.equal(el.querySelector('textarea.project-description-edit') === null, true, 'the editor is not open yet')
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

test('§2d a click opens the editor with the caret at about the clicked spot (user 2026-10-18 07:14Z)', async (t) => {
  const el = await desk(t)
  const shown = el.querySelector<HTMLElement>('.project-description-md')!
  // jsdom has no layout: the browser's caret lookup answers "after 'ma' in **main**"
  const strong = shown.querySelector('strong')!.firstChild!
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  const had = doc.caretRangeFromPoint
  doc.caretRangeFromPoint = () => { const r = document.createRange(); r.setStart(strong, 2); r.collapse(true); return r }
  t.after(() => { doc.caretRangeFromPoint = had })
  await inAct(() => {
    shown.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 40, clientY: 60 }))
    shown.focus()
    shown.click()
  })
  await flush(2)
  const box = el.querySelector<HTMLTextAreaElement>('textarea.project-description-edit')!
  assert.ok(box, 'the editor opened')
  // '# The site\n\nDeploy from **ma|in** only.'
  assert.equal(box.value.slice(0, box.selectionStart), '# The site\n\nDeploy from **ma', 'the caret sits where the click was')
  assert.equal(box.selectionEnd, box.selectionStart, 'a caret, not a selection')
})

test('§2e the source offset steps over markup and skips what the source lacks', () => {
  const src = '# Title\n\nSee [the docs](https://x.y/z) and **bold** text.'
  assert.equal(sourceOffset(src, ''), 0)
  assert.equal(src.slice(0, sourceOffset(src, 'Title\nSee the d')), '# Title\n\nSee [the d')
  assert.equal(src.slice(0, sourceOffset(src, 'Title\nSee the docs and bo')), '# Title\n\nSee [the docs](https://x.y/z) and **bo')
  assert.equal(src.slice(0, sourceOffset(src, 'Title… See')), '# Title\n\nSee', 'a rendered-only character is skipped')
})

/** styles.css as rules, comments dropped; `cssLast` is the last value a rule
 *  naming exactly `sel` gives `prop` */
const cssRules = () => [...readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }))
const cssLast = (prop: string, sel: string) => cssRules().filter((r) => r.sel.split(',').some((s) => s.trim() === sel))
  .map((r) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(r.body)?.[1]?.trim()).filter(Boolean).pop()

test('§2f the description has no border or background while not edited; the editor keeps its look (user 07:14Z)', () => {
  const rules = cssRules()
  const last = cssLast
  const md = '.project-desk .project-description-md'
  assert.equal(last('background', md), 'transparent', 'no background at rest')
  assert.equal(last('border-color', md), 'transparent', 'no border at rest')
  assert.equal(rules.some((r) => r.sel.includes('.project-description-md:hover') && /border/.test(r.body)), false, 'no hover border either')
  const ed = '.project-desk .project-description-edit'
  assert.equal(last('background', ed), 'var(--input)', 'the editor keeps its background')
  assert.match(last('border', ed) ?? '', /1px solid/, 'and its border')
})

/* ─── §10 the message box ─────────────────────────────────────────────────── */

test("§10 the desk's message box: by default one mail to the project's own inbox; with the megaphone on, one broadcast to every agent under it (user 2026-10-18 07:33Z, 07:43Z)", async (t) => {
  const el = await desk(t)
  const sent: { path: string; body: unknown }[] = []
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname
    if (init?.method === 'POST' && /\/nodes\/website\/(message|broadcast)$/.test(path)) {
      sent.push({ path, body: JSON.parse(String(init.body)) })
      const answer = path.endsWith('/broadcast')
        ? { accepted: true, project: 'website', notice: false, sent: [{ to: 'dev1' }, { to: 'dev2' }], refused: [] }
        : { accepted: true, id: 'm1', delivery: 'queued in project website' }
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
  const composer = () => el.querySelector<HTMLElement>('.project-composer')!
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')
  assert.ok(box, 'a message box on the desk')
  assert.ok(composer().querySelector('button.cc-attach'), 'an attach button')
  const enter = () => inAct(() => { box!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  // the default: the project's own mailbox, which one agent under it claims
  assert.equal(box!.placeholder, 'message project website: one agent under it takes it…')
  await inAct(() => { composer().querySelector<HTMLButtonElement>('button.cc-notice-toggle')!.click() })
  await inAct(() => { setText(box!, 'Who can take this?') })
  await enter()
  await flush(4)
  assert.deepEqual(sent, [{ path: '/api/orgs/org/nodes/website/message', body: { text: 'Who can take this?', notice: true } }],
    'one mail to the project, as a notice')
  assert.equal(box!.value, '', 'the box is cleared')
  // the megaphone: everyone under it
  const mega = composer().querySelector<HTMLButtonElement>('button.cc-broadcast-toggle')!
  assert.ok(mega, 'a megaphone toggle')
  assert.equal(mega.getAttribute('aria-pressed'), 'false')
  await inAct(() => { mega.click() })
  assert.equal(mega.getAttribute('aria-pressed'), 'true')
  assert.ok(composer().classList.contains('broadcast-armed'), 'the box shows it is armed')
  assert.equal(box!.placeholder, 'message all 2 agents under website…', 'the live agents under it, nested included')
  await inAct(() => { setText(box!, 'Status, everyone?') })
  await enter()
  await flush(4)
  assert.deepEqual(sent.slice(1), [{ path: '/api/orgs/org/nodes/website/broadcast', body: { text: 'Status, everyone?' } }], 'one broadcast')
  assert.equal(mega.getAttribute('aria-pressed'), 'false', 'a successful broadcast disarms the megaphone')
  await inAct(() => { el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="inbox"]')!.click() })
  await flush(2)
  assert.ok(el.querySelector('.project-composer textarea'), 'under every tab, as on an agent desk')
  assert.equal(el.textContent!.includes('Could not load older mail'), false, 'the inbox fixture implements live and history response shapes')
})

test('§10d project message history recalls sent messages with Up/Down and restores the unsent draft after leaving the desk', async (t) => {
  localStorage.clear()
  serve(t)
  const node = project()
  const view = (current: CanvasNode) => <ProjectDesk node={current} slug="org" tree={tree}
    map={new Map([[current.id, current], ['boss', boss]])} op={async () => ({} as OpResult)} toast={noop}
    refs={refs} bare />
  const mount = () => mountView(view(node), el => el)
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://fixture.invalid').pathname
    if (init?.method === 'POST' && path === '/api/orgs/org/nodes/website/message')
      return Promise.resolve(new Response(JSON.stringify({ accepted: true, id: 'm1', delivery: 'queued' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })

  const first = await mount()
  const box = () => first.el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  try {
    assert.ok(box())
    await inAct(() => { setText(box(), 'sent from project') })
    await inAct(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await flush(4)
    assert.deepEqual(readHistory('org', 'website'), [{ text: 'sent from project', delivered: true }],
      'project sends use the shared bounded composer history keyed by project identity')
    assert.equal(localStorage.getItem(draftKey('org', 'project:website', 0)), null,
      'a successful send clears the saved project draft')
    await inAct(() => { setText(box(), 'unfinished\nproject draft') })
  } finally { await first.unmount() }

  const second = await mount()
  try {
    const restored = second.el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
    assert.equal(restored.value, 'unfinished\nproject draft', 'the per-project draft survives the composer unmount')
    restored.selectionStart = restored.selectionEnd = restored.value.indexOf('project') + 2
    const middleUp = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    await inAct(() => { restored.dispatchEvent(middleUp) })
    assert.equal(middleUp.defaultPrevented, false, 'Up within a multiline draft remains native caret movement')
    assert.equal(restored.value, 'unfinished\nproject draft')
    restored.selectionStart = restored.selectionEnd = 0
    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    await inAct(() => { restored.dispatchEvent(up) })
    await flush(2)
    assert.equal(up.defaultPrevented, true, 'Up at the first line recalls history')
    assert.equal(restored.value, 'sent from project')
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    restored.selectionStart = restored.selectionEnd = restored.value.length
    await inAct(() => { restored.dispatchEvent(down) })
    await flush(2)
    assert.equal(restored.value, 'unfinished\nproject draft', 'Down past newest restores the draft that was present before recall')
    await second.render(view(project({ id: 'another' })))
    assert.equal(second.el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!.value, '',
      'another project never inherits this project\'s draft')
    await second.render(view(node))
    assert.equal(second.el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!.value,
      'unfinished\nproject draft', 'switching back restores the original project\'s draft')
  } finally { await second.unmount() }
})

test('§10e Alt+B toggles project broadcast mode and is shown in its tooltip without disturbing Alt+N', async (t) => {
  const el = await desk(t)
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  const mega = el.querySelector<HTMLButtonElement>('button.cc-broadcast-toggle')!
  const notice = el.querySelector<HTMLButtonElement>('button.cc-notice-toggle')!
  const press = (key: string) => inAct(() => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))
  })
  await press('b')
  assert.equal(mega.getAttribute('aria-pressed'), 'true', 'Alt+B arms broadcast')
  assert.match(mega.title, /Alt\+B/, 'the broadcast tooltip documents its shortcut')
  await press('n')
  assert.equal(notice.classList.contains('armed'), true, 'Alt+N retains the notice toggle')
  await press('B')
  assert.equal(mega.getAttribute('aria-pressed'), 'false', 'Alt+B disarms broadcast')
})

test('§10f a rejected project broadcast keeps broadcast mode armed', async (t) => {
  const el = await desk(t)
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://fixture.invalid').pathname
    if (init?.method === 'POST' && path === '/api/orgs/org/nodes/website/broadcast')
      return Promise.resolve(new Response(JSON.stringify({ error: 'rejected' }), { status: 500 }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  const mega = el.querySelector<HTMLButtonElement>('button.cc-broadcast-toggle')!
  await inAct(() => { mega.click() })
  await inAct(() => { setText(box, 'try broadcast') })
  await inAct(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await flush(4)
  assert.equal(mega.getAttribute('aria-pressed'), 'true', 'a failed send does not disarm broadcast')
})

test("§10c a failed audience grant after delivery says so in the toast (coordinator 2026-10-18 09:43Z)", async (t) => {
  const toasts: string[][] = []
  const el = await desk(t, { toast: (l) => toasts.push(l) })
  const inner = globalThis.fetch
  const failed = { granted: false, error: 'delivered but audience grant failed: boom' }
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname
    if (init?.method === 'POST' && /\/nodes\/website\/(message|broadcast)$/.test(path)) {
      const answer = path.endsWith('/broadcast')
        ? { accepted: true, project: 'website', notice: false, sent: [{ to: 'dev1' }], refused: [], audience_grant: failed }
        : { accepted: true, id: 'm1', delivery: 'queued in project website', audience_grant: failed }
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  const enter = () => inAct(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await inAct(() => { setText(box, 'hello') })
  await enter()
  await flush(4)
  await inAct(() => { el.querySelector<HTMLButtonElement>('button.cc-broadcast-toggle')!.click() })
  await inAct(() => { setText(box, 'all of you') })
  await enter()
  await flush(4)
  assert.equal(toasts.length, 2, 'one toast per send')
  for (const lines of toasts) {
    assert.ok(lines.some((l) => l.startsWith("sent, but the project's user audience couldn't be granted")),
      JSON.stringify(lines))
  }
})

test('§10b the megaphone border brightens over the plain and focused box', () => {
  assert.ok(cssLast('box-shadow', '.cc-composer.project-composer.broadcast-armed'), 'a glow while armed')
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

test("§5b the agent desk's pop-out button, where a pop-out handler is given (user 2026-10-18 07:15Z)", async (t) => {
  let popped = 0
  const el = await desk(t, { popout: () => { popped++ } })
  const btn = el.querySelector<HTMLButtonElement>('.cc-head button.popout-button')
  assert.ok(btn, 'a pop-out button in the header')
  assert.equal(btn!.getAttribute('aria-label'), 'Open in new window', "labelled as the agent desk's")
  assert.equal(btn!.textContent, '↗')
  await inAct(() => { btn!.click() })
  assert.equal(popped, 1, 'it pops the desk out')
  const none = await desk(t)
  assert.equal(none.querySelector('button.popout-button') === null, true, 'none without a handler')
})

test("§5c the focused project card's desk carries the card's pop-out", async (t) => {
  serve(t)
  let popped = 0
  const view = await mountView(<ProjectSquare node={project()} pos={{ x: 0, y: 0 }} lod="norm"
    focused dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} zoom={8} hire={{}} seats={{}} tree={tree} map={new Map()} refs={refs}
    onHire={noop} onNewProject={noop} onInbox={noop} onPopout={() => { popped++ }}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const btn = view.el.querySelector<HTMLButtonElement>('.desk-over .cc-head button.popout-button')
  assert.ok(btn, 'the desk shows it')
  await inAct(() => { btn!.click() })
  assert.equal(popped, 1)
})

test('§5d an empty project docket says it lists the tickets of the agents under the project (user 2026-10-18 07:26Z)', async (t) => {
  const el = await desk(t)
  await inAct(() => { el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="docket"]')!.click() })
  await flush(6)
  const empty = el.querySelector('.desk-tabpanel .dim.pad')?.textContent ?? ''
  assert.match(empty, /agents under website/, 'names whose tickets these are')
  assert.equal(/assignment is ownership/.test(empty), false, 'not the agent wording')
})

test('§5e a pinned project window takes the org theme, not a provider colour (user 2026-10-18 07:24Z)', () => {
  assert.equal(pinAccentClass(project()), 'pin-project')
  assert.equal(pinAccentClass(boss), 'prov-claude', 'an agent keeps its provider')
  for (const sel of ['.pinwin.pin-project', '.pin-snap-preview.pin-project'])
    assert.equal(cssLast('--accent', sel), 'var(--org-accent)', sel)
})

test("§5f a desk tab's first row clears the tab's pin/pop-out/mail corner, the inbox's Transfers box too (user 2026-10-18 07:27Z)", () => {
  assert.ok(cssLast('margin-right', '.desk-tabpanel > .mailwrap > .mail-transfers'), 'the Transfers box stops short of the corner')
})

test("§6c settings leave the frame's pop-out and pin room beside the header buttons (user 2026-10-18 07:24Z)", () => {
  const sel = '.settings.cfg:not(.modalpin-win):not(.modalpin-detached) > .agent-settings-header'
  assert.ok(cssLast('padding-right', sel), "the header reserves the bar's width")
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
  for (const want of ['Name', 'Project actions', 'Summary', 'Subordinates may message each other', 'dissolve'])
    assert.ok(text.includes(want), `has "${want}"`)
  for (const not of ['Model', 'Visible agents', 'File and command access', 'Instructions', 'rescind'])
    assert.equal(text.includes(not), false, `no "${not}" on a project`)
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project Summary"]')!
  assert.equal(box.value, '# The site\n\nDeploy from **main** only.')
  await inAct(() => { setText(box, 'New text.') })
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'save')!
  await inAct(async () => { save.click(); await flush(4) })
  assert.deepEqual(ops, [{ op: 'set_description', node: 'website', description: 'New text.' }])
})

test('§6b open settings follow the project: a remote description change is not reverted by save, a remote rename shows the new name (final round, derived ①)', async (t) => {
  serve(t)
  const ops: OpRequest[] = []
  const cfg = (nd: CanvasNode) => <NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={tree} slug="org"
    op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />
  const view = await mountView(cfg(project()), (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  // an agent under it rewrites the description while the panel is open
  await view.render(cfg(project({ charter: 'Rewritten by dev1.' })))
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project Summary"]')!
  assert.equal(box.value, 'Rewritten by dev1.', 'the untouched box shows the current description')
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'save')!
  await inAct(async () => { save.click(); await flush(4) })
  assert.deepEqual(ops, [], 'nothing edited, nothing sent: the remote change stands')
  // renamed elsewhere: the untouched name field follows, and offers no rename back
  await view.render(cfg(project({ id: 'site', title: 'site' } as never)))
  const name = document.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!
  assert.equal(name.value, 'site')
  assert.equal([...document.querySelectorAll('button')].some((b) => b.textContent === 'rename'), false)
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

/** dev1 has been in a turn for 2m; dev2 (nested) ran a turn that ended 1m ago
 *  after 5m, so the project has been active without a gap for 6m. With
 *  `gap`, dev2's turn ended 3m ago instead: the project was idle between, and
 *  its active run is dev1's 2m. */
const active = (gap = false) => project({ children: [
  { id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', busy: true,
    inflight_at: new Date(Date.now() - 120_000).toISOString(), turns: [], children: [] },
  { id: 'ui', title: 'ui', tier: 'project', kind: 'project', state: 'live', children: [
    { id: 'dev2', title: 'dev2', tier: 'sonnet', state: 'live', busy: false,
      turns: [{ at: new Date(Date.now() - (gap ? 180_000 : 60_000)).toISOString(), ms: 300_000, cost: 0, denials: 0 }], children: [] },
  ] },
] } as never)
const said = (el: Element | null | undefined) => el && [el.querySelector('.sq-idle')?.className,
  el.querySelector('.sq-idle')?.textContent, el.querySelector('.sq-idle-time')?.textContent]

test("§8a while any agent under it works: 'Active <age>' in the agent card's active style, from when the project became active", async (t) => {
  const el = await desk(t, { node: active() })
  assert.deepEqual(said(el.querySelector('.cc-head .project-last-activity')), ['sq-idle working active', 'Active', '6m'],
    "dev2's turn overlapped dev1's, so the run began 6m ago")
  const gapped = await desk(t, { node: active(true) })
  assert.deepEqual(said(gapped.querySelector('.cc-head .project-last-activity')), ['sq-idle working active', 'Active', '2m'],
    'a turn that ended before the run began does not extend it')
})

test("§8b otherwise 'Idle <age>' in the agent card's idle style, from the newest turn under it, nested included", async (t) => {
  const el = await desk(t, { node: quiet(300) })
  assert.deepEqual(said(el.querySelector('.cc-head .project-last-activity')), ['sq-idle idle', 'Idle', '5m'],
    "dev2 (in nested ui) ended 5m ago, newer than dev1's hour")
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
  assert.deepEqual(said(meta.querySelector('.project-last-activity')), ['sq-idle idle', 'Idle', '5m'])
})

test("§7d the zoom card shows no preview of the project's description (user 2026-10-18 08:50Z)", async (t) => {
  serve(t)
  const view = await mountView(<ProjectSquare node={project()} pos={{ x: 0, y: 0 }} lod="norm"
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} zoom={1.2} hire={{}} seats={{}}
    onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const sq = view.el.querySelector('.sq.project')!
  assert.equal(sq.querySelector('.project-desc') === null, true, 'no description line')
  assert.equal((sq.textContent ?? '').includes('The site'), false, 'the description is on the desk only')
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
  // the canvas desk's look, as an agent's temporary desk has (user 2026-10-18
  // 08:25Z): its frame, not a settings panel's larger type and buttons
  assert.equal(panel!.classList.contains('settings'), false, 'not a settings panel')
  assert.ok(panel!.classList.contains('tempdesk-panel'), 'the temporary desk frame')
  assert.ok(panel!.classList.contains('pin-project'), 'in the org theme, as a pinned project window')
  assert.equal(panel!.querySelector('.cc-head-left .name')?.textContent, 'website', 'holding the project desk')
  assert.deepEqual([...panel!.querySelectorAll('.cc-tabs button')].map((b) => b.getAttribute('data-tab')),
    ['desk', 'inbox', 'docket', 'presented', 'team'])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flush(1)
  assert.equal(closed, 1, 'Escape closes a centred modal')
})

test("§11a the temporary project desk has the agent desk's ONE title bar: folder and name, pin and close; the pop-out in the desk's own header (user 2026-10-18 11:14Z)", async (t) => {
  serve(t)
  let closed = 0
  const nd = project()
  // inside an org, as on the canvas: only an org's surfaces pin and pop out
  const view = await mountView(<CurrentOrg.Provider value="org"><ProjectDeskModal node={nd} slug="org" tree={tree}
    map={new Map([[nd.id, nd], ['boss', boss]])} op={() => Promise.resolve({} as OpResult)} toast={noop} refs={refs}
    close={() => { closed++ }} /></CurrentOrg.Provider>, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  const bar = document.querySelector('.project-desk-modal > .modalpin-bar')!
  assert.ok(bar.classList.contains('desk-title'), 'a title bar while centred, not a strip of icons')
  const name = bar.querySelector('.modalpin-name')
  assert.ok(name?.querySelector('.project-mark'), 'the folder mark')
  assert.equal(name?.textContent, 'website', 'the name')
  assert.ok(bar.querySelector('button.modalpin-btn[aria-label="pin this to the window"]'), 'pin')
  assert.equal(bar.querySelector('button.popout-button') === null, true, 'no pop-out in the title bar')
  assert.ok(document.querySelector('.project-desk-modal .cc-head-right button.popout-button'), 'the pop-out beside the tabs, as on the agent desk')
  const x = bar.querySelector<HTMLButtonElement>('button.modalpin-x')
  assert.ok(x, 'close')
  await inAct(() => { x!.click() })
  assert.equal(closed, 1)
})

test("§11d the temporary project desk's pin makes the same pinned window an agent's does, and its title is the agent desk's name (user 11:47:14Z: as similar as possible)", async (t) => {
  serve(t)
  const pinned: unknown[] = []
  const nd = project()
  const view = await mountView(<CurrentOrg.Provider value="org"><ProjectDeskModal node={nd} slug="org" tree={tree}
    map={new Map([[nd.id, nd], ['boss', boss]])} op={() => Promise.resolve({} as OpResult)} toast={noop} refs={refs}
    close={noop} pinAsWindow={(rect) => { pinned.push(rect) }} /></CurrentOrg.Provider>, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  const bar = document.querySelector('.project-desk-modal > .modalpin-bar')!
  assert.ok(bar.querySelector('.modalpin-name .cc-name'), "the agent desk's name component (AgentName), not a copy")
  await inAct(() => { bar.querySelector<HTMLButtonElement>('button.modalpin-btn[aria-label="pin this to the window"]')!.click() })
  assert.equal(pinned.length, 1, 'pinned as a window, through the agent pin layer')
  assert.equal(document.querySelector('.project-desk-modal.modalpin-win') === null, true, 'not a pinned modal of its own')
})

test("§11b no second name in the desk under a title bar: temporary, pinned and popped-out windows; the name never wraps (user 11:14Z)", () => {
  for (const host of ['.project-desk-modal:not(.modalpin-detached)', '.pinwin-body'])
    for (const part of ['.project-mark', '.name'])
      assert.equal(cssLast('display', `${host} .project-desk .cc-head-left > ${part}`), 'none', `${host} ${part}`)
  assert.equal(cssLast('white-space', '.project-desk .cc-head-left .name'), 'nowrap')
  assert.equal(cssLast('cursor', '.project-desk-modal > .modalpin-bar.desk-title'), 'default', 'a centred title bar is not a drag handle')
})

test("§11c the editable description shows it is clickable: the theme's hover background and a pointer, on hover and keyboard focus (user 11:14Z)", () => {
  const md = '.project-desk .project-description-md[role="textbox"]'
  assert.equal(cssLast('cursor', md), 'pointer')
  for (const state of [':hover', ':focus-visible'])
    assert.equal(cssLast('background', md + state), 'var(--panel-2)', state)
})

declare const __SRC_DIR__: string
test("§8g the activity line stays inside the card: the meta row wraps, and the word truncates before the clock (user 2026-10-18 10:51Z)", () => {
  assert.equal(cssLast('flex-wrap', '.sq.project .project-meta'), 'wrap', "'Active 80s' drops under the chip instead of running off the card")
  assert.equal(cssLast('min-width', '.project-last-activity'), '0')
  assert.equal(cssLast('max-width', '.project-last-activity'), '100%')
  assert.equal(cssLast('overflow', '.project-last-activity'), 'hidden', 'alone on its line and still too long: clipped, never past the edge')
})

test("§8f the word and its age keep the agent card's own spacing and colours (user 2026-10-18 07:42Z: 'in the same style')", () => {
  assert.equal(cssRules().some((r) => r.sel.split(',').some((s) => s.trim().startsWith('.project-last-activity .sq-idle'))), false,
    'no project override of .sq-idle or .sq-idle-time')
})
