// agentdocketsearch.test.tsx — the agent/team docket has the same search box as
// the Work docket, narrowing only the rows that view already shows.
//
// Run:  node apps/desktop/renderer/tests/run.mjs agentdocketsearch
import './harness'
import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentDocketView, buildNodeFacts } from '../src/canvas/docket'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import type { TreePayload, WorkItem } from '../src/types'

window.HTMLElement.prototype.scrollIntoView = () => {}

const item = (slug: string, title: string, o: Partial<WorkItem> = {}): WorkItem => ({
  slug, rev: 1, kind: 'code', title, objective: title + ' objective', status: 'in_progress',
  blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'worker', generation: 1 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'worker', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [], docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'worker', generation: 1 }, manual_attention: null, dismissals: [],
  questions: [], effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null, superseded_by: null,
  history: [], ...o,
} as WorkItem)

const type = async (box: HTMLInputElement, v: string) => inAct(async () => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  set.call(box, v)
  box.dispatchEvent(new window.Event('input', { bubbles: true }))
})

test('the agent docket has the work docket search box; typing narrows, clearing restores', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { realClock() })
  const mine = [item('fix-login', 'Fix login'), item('add-search', 'Add search bar'),
    item('old-one', 'Old login thing', { archived: true, status: 'done' })]
  const view = await mountView(
    <AgentDocketView slug="org" nid="worker" mine={mine} facts={buildNodeFacts([])}
      toast={() => {}} onFocusAgent={() => {}} refs={{ world: { org: 'org' }, onOpen: () => {} }} />,
    (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const box = view.el.querySelector<HTMLInputElement>('.docket-search input[type="search"]')
  assert.ok(box, 'search box present')
  const titles = () => [...view.el.querySelectorAll('.docket-row')].map((r) => r.textContent ?? '')
  assert.equal(titles().length, 2, 'archived is hidden until its box is ticked')
  await type(box!, 'login')
  assert.equal(titles().length, 1)
  assert.match(titles()[0]!, /fix-login/, 'the archived "login" ticket is not reached')
  assert.match(view.el.querySelector('.docket-search-count')?.textContent ?? '', /1 of 2 match/)
  await type(box!, 'zzz')
  assert.equal(titles().length, 0, 'no rows match the search')
  assert.match(view.el.querySelector('.docket-search-count')?.textContent ?? '', /0 of 2 match/)
  assert.equal(view.el.querySelector('.docket-pane-head b')?.textContent, 'Fix login',
    'filtering the list keeps the ticket selected on opening in its reader')
  await inAct(async () => { view.el.querySelector<HTMLElement>('.docket-search-clear')!.click() })
  assert.equal(titles().length, 2, 'clearing restores the full list')
})

test('centered agent docket Escape clears a focused nonempty search before closing', async (t) => {
  useFakeClock()
  const server = new FakeServer()
  server.workItems = [item('fix-login', 'Fix login')]
  installFetch(server)
  t.after(() => { realClock() })
  const tree = { slug: 'org', roots: [{ id: 'worker', state: 'live', tier: 'sol', generation: 1, children: [] }], tiers: { sol: 1 } } as unknown as TreePayload
  let closed = 0
  const view = await mountView(<AgentDocketModal slug="org" nid="worker" tree={tree}
    toast={() => {}} close={() => { closed++ }} refs={{ world: { org: 'org' }, onOpen: () => {} }} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  const box = view.el.querySelector<HTMLInputElement>('.docket-search-input')
  assert.ok(box, 'the centered agent docket has the shared search')
  await type(box!, 'login')
  await inAct(() => { box!.focus() })
  await inAct(() => { box!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  assert.equal(closed, 0, 'the first Escape does not close the docket')
  assert.equal(box!.value, '', 'the first Escape clears the search')
  assert.equal(view.el.querySelectorAll('.docket-row').length, 1, 'the unfiltered list returns')
  await inAct(() => { box!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  assert.equal(closed, 1, 'Escape with an empty focused search closes')
})
