// jumppassthrough.test.tsx — DESK JUMP CARDS PASS THROUGH PROJECTS (Orgtree
// 4.4.0; docket `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 20,
// user 2026-10-17 22:13Z: "agents under a project get up jump cards both for
// all projects above them up to the nearest superior, and that superior / and
// superiors with projects under them get jump cards for every project and all
// direct subordinates of that project, all the way through" — "projects are
// 'passthrough' in this sense").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 up: one card per project between an agent and its nearest agent
//      superior, plus that superior, read top-down (superior first, then the
//      projects outermost to innermost); an agent directly under an agent
//      keeps its single card;
//   §2 down: every project among the reports and every direct member of it,
//      recursing through nested live projects, in tree order beside the
//      ordinary reports; the desk then splits them into live cards and the
//      retired controls, so retired members inside projects stay reachable
//      (rig-sol-b review of 93d9bfa);
//   §3 on a real desk: the up and down rows carry exactly those cards, a
//      project's card shows the folder mark, and a click jumps to it.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs jumppassthrough

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { downJumpTargets, upJumpTargets } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'

// boss
// ├── lead (agent)
// ├── site (project)
// │   ├── dev1
// │   ├── ui (project)
// │   │   ├── dev2
// │   │   └── gone (archived)
// │   └── old (archived)
// └── docs (project, empty)
function org() {
  const n = (id: string, parent: string, extra: Record<string, unknown> = {}): CanvasNode => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', parent, seat: 1, grant: 0, free: 0,
    children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 0, charter: null,
    scope: { tools: {}, add_dirs: [] }, generation: 1, ...extra,
  } as unknown as CanvasNode)
  const proj = (id: string, parent: string) => n(id, parent, { kind: 'project', tier: 'project', model_id: '', seat: 0 })
  const boss = n('boss', 'eye', { tier: 'opus' })
  const lead = n('lead', 'boss')
  const site = proj('site', 'boss')
  const dev1 = n('dev1', 'site')
  const ui = proj('ui', 'site')
  const dev2 = n('dev2', 'ui', { tier: 'sonnet' })
  const gone = n('gone', 'ui', { state: 'archived' })
  const old = n('old', 'site', { state: 'archived' })
  const docs = proj('docs', 'boss')
  ui.children = [dev2, gone]
  site.children = [dev1, ui, old]
  boss.children = [lead, site, docs]
  const map = new Map([boss, lead, site, dev1, ui, dev2, gone, old, docs].map((x) => [x.id, x]))
  return { map, boss, dev1, dev2, lead, site }
}
const ids = (xs: CanvasNode[]) => xs.map((x) => x.id)

/* ─── §1 up ─────────────────────────────────────────────────────────────── */

test('§1 up: the nearest agent superior, then every project down to the agent', () => {
  const { map, dev1, dev2, lead } = org()
  assert.deepEqual(ids(upJumpTargets(dev2, map)), ['boss', 'site', 'ui'], 'nested: superior, outer, inner')
  assert.deepEqual(ids(upJumpTargets(dev1, map)), ['boss', 'site'])
  assert.deepEqual(ids(upJumpTargets(lead, map)), ['boss'], 'an agent under an agent: one card, as before')
})

/* ─── §2 down ───────────────────────────────────────────────────────────── */

test('§2 down: each project and its members, through nested live projects, in tree order', () => {
  const { boss } = org()
  assert.deepEqual(ids(downJumpTargets(boss.children)),
    ['lead', 'site', 'dev1', 'ui', 'dev2', 'gone', 'old', 'docs'], 'retired members included, for the retired controls')
})

/* ─── §3 on a desk ──────────────────────────────────────────────────────── */

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}
async function desk(t: TestContext, node: CanvasNode, map: Map<string, CanvasNode>, jumped: string[]) {
  serve(t)
  const view = await mountView(<DeskChat node={node} map={map} op={async () => ({})} slug="org"
    toast={() => {}} bare onJump={(id) => jumped.push(id)} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  return view.el
}
const rows = (el: Element) => [...el.querySelectorAll('.desk-nav')].map((row) =>
  [...row.querySelectorAll('button.desk-nav-chip')].map((b) => b.getAttribute('data-copy-agent-name')))

test('§3a an agent in a nested project: up cards for its superior and both projects', async (t) => {
  const { map, dev2 } = org()
  const jumped: string[] = []
  const el = await desk(t, dev2, map, jumped)
  assert.deepEqual(rows(el)[0], ['boss', 'site', 'ui'])
  const ui = el.querySelector<HTMLButtonElement>('.desk-nav button.desk-nav-chip[data-copy-agent-name="ui"]')!
  assert.ok(ui.querySelector('svg'), 'a project card shows the folder mark')
  await inAct(() => { ui.click() })
  assert.deepEqual(jumped, ['ui'])
})

test('§3b a superior with projects below: down cards through them', async (t) => {
  const { map, boss } = org()
  const el = await desk(t, boss, map, [])
  const all = rows(el)
  assert.deepEqual(all[all.length - 1], ['lead', 'site', 'dev1', 'ui', 'dev2', 'docs'])
})

test('§3c retired members inside projects are behind the superior\'s retired control (review of 93d9bfa)', async (t) => {
  const { map, boss } = org()
  const jumped: string[] = []
  const el = await desk(t, boss, map, jumped)
  const toggle = [...el.querySelectorAll<HTMLButtonElement>('.desk-nav button.desk-nav-chip')]
    .find((b) => /retired/.test(b.textContent ?? ''))
  assert.ok(toggle, 'a retired control on boss\'s down row')
  assert.equal(toggle.textContent, 'show 2 retired', 'old (in site) and gone (in ui)')
  await inAct(() => { toggle.click() })
  await flush(2)
  const all = rows(el)
  assert.deepEqual(all[all.length - 1], ['lead', 'site', 'dev1', 'ui', 'dev2', 'docs', null, 'gone', 'old'],
    'the live row, the hide control, then the retired members')
  const gone = el.querySelector<HTMLButtonElement>('.desk-nav button.desk-nav-chip[data-copy-agent-name="gone"]')!
  await inAct(() => { gone.click() })
  assert.deepEqual(jumped, ['gone'])
})
