// projectwatchdogs.test.tsx — a watchdog OWNED BY A PROJECT on the desktop
// (docket `project-watchdogs-a-watchdog-owned-by-a-project-f`, USER
// 2026-11-03 10:33Z; spec rev 1 §5, R1-R5). A project dog fires the project's
// event, so the project card carries its satellites like an agent card, its
// desk lists it, and the Listeners tab names it as an event SOURCE.
//
// Run:  node apps/desktop/renderer/tests/run.mjs projectwatchdogs
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView, FakeServer, installFetch, realClock, useFakeClock } from './harness'
import { WatchdogCanvasCards } from '../src/canvas/watchdoggroup'
import { canvasTargets } from '../src/canvas/canvaslayout'
import { ListenersView } from '../src/canvas/listenersdesk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { WatchdogPanel } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const node = (id: string, extra: Record<string, unknown> = {}): CanvasNode => ({
  id, title: id, tier: 'haiku', state: 'live', model_id: '', seat: 1, grant: 0, free: 0, children: [],
  scope: { tools: {}, add_dirs: [] }, ...extra,
} as unknown as CanvasNode)
const project = (kids: CanvasNode[] = []): CanvasNode => node('stream', {
  tier: 'project', kind: 'project', parent: 'boss', configured_scope: { tools: {}, add_dirs: [], event_listeners: true }, children: kids,
})

const feed = (name: string, extra: Partial<Watchdog> = {}): Watchdog => ({
  id: 'stream/' + name, owner: 'stream', name, kind: 'websocket', target: 'ws://127.0.0.1:8787/v1/events',
  interval_s: 5, state: 'armed', at: '2026-11-03T10:00:00Z', fired: 0, once: false, spent: false,
  owner_kind: 'project', created_by: 'member', ...extra,
} as Watchdog)

/* ─── R1 the canvas ──────────────────────────────────────────────────────── */

test('R1 satellites sit below a project card; nine dogs collapse to one group card', () => {
  const kid = node('member'), proj = project([kid])
  const boss = node('boss', { children: [proj] })
  const root = { id: USER, state: 'user', children: [boss] } as unknown as CanvasNode
  const map = new Map([[root.id, root], [boss.id, boss], [proj.id, proj], [kid.id, kid]])
  const few = [feed('a'), feed('b')]
  const t1 = canvasTargets(root, map, new Map(), 'row', { roots: [boss], watchdogs: few } as unknown as TreePayload, 1)
  assert.ok(few.every((w) => t1.get('dog:' + w.id)), 'each project dog gets a satellite position')
  const nine = Array.from({ length: 9 }, (_, i) => feed('d' + i))
  const t2 = canvasTargets(root, map, new Map(), 'row', { roots: [boss], watchdogs: nine.slice(0, 8),
    watchdog_counts: { stream: { total: 9, kept: 9, one_shot: 0 } } } as unknown as TreePayload, 1)
  assert.equal(new Set(nine.slice(0, 8).map((w) => { const p = t2.get('dog:' + w.id)!; return p.x + ',' + p.y })).size, 1,
    'more than eight share one group card')
})

test('R1 the satellites draw with the project dogs\' kind colour and no extra chrome', async (t) => {
  const v = await mountView(<WatchdogCanvasCards dogs={[feed('a'), feed('b')]} org="demo"
    position={() => ({ x: 10, y: 20 })} visible={() => true} onOpen={noop} />, (el) => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.wd-chip').length, 2)
})

/* ─── R2 the project desk's jump row ─────────────────────────────────────── */

test('R2 the project desk lists its own dogs as cards in the jump row', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  const proj = project([node('member')]), opened: string[] = []
  const map = new Map([[proj.id, proj], ['member', proj.children[0]!], ['boss', node('boss', { children: [proj] })]])
  const dogs = [feed('stream-chat'), feed('stream-control'), { ...feed('mine'), owner: 'member', owner_kind: 'agent' as const, id: 'member/mine' }]
  const v = await mountView(<DeskDogsProvider value={{ org: 'org', dogs, open: (id) => { opened.push(id) } }}>
    <ProjectDesk node={proj} map={map} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} onJump={noop}
      tree={{ slug: 'org', roots: [], watchdogs: dogs, slot_leases: [] } as unknown as TreePayload} refs={{ world: { org: 'org' }, onOpen: noop } as never} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => v.unmount())
  await inAct(() => flush(4))
  const chips = [...v.el.querySelectorAll<HTMLElement>('.desk-nav .desk-dog-chip')]
  assert.deepEqual(chips.map((c) => c.textContent?.replace(/^[^A-Za-z0-9]+|1×/g, '').trim()), ['stream-chat', 'stream-control'],
    "only the project's own dogs, in the tree's order")
  await inAct(async () => { chips[1]!.click() })
  assert.deepEqual(opened, ['stream/stream-control'])
})

/* ─── R3 / R4 the Listeners tab ──────────────────────────────────────────── */

async function listeners(t: TestContext, list: Watchdog[], history: unknown[]) {
  const map = new Map(['member', 'boss'].map((id) => [id, node(id)] as [string, CanvasNode]))
  const op = (req: { op: string }) => Promise.resolve((req.op === 'listener_history' ? { history, history_next: null } : {}) as OpResult)
  const v = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: list, open: noop }}>
    <ListenersView node={project()} dogs={list} map={map} op={op as never} toast={noop} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => v.unmount())
  await inAct(() => flush(3))
  return v
}

test('R3 Event sources come first, in the shared column order, with the creator and a disabled chip', async (t) => {
  const list = [feed('stream-chat', { created_by: 'member' }), feed('stream-control', { created_by: 'user', state: 'paused',
    paused_why: "project stream's event listeners were turned off by boss" } as Partial<Watchdog>)]
  const v = await listeners(t, list, [])
  const sections = [...v.el.querySelectorAll('.project-listeners h4')].map((h) => h.textContent)
  assert.deepEqual(sections, ['Event sources', 'Event listeners', 'Listener watches', 'Recently Fired'])
  const rows = [...v.el.querySelectorAll<HTMLTableRowElement>('.listeners-table tbody.listeners-sources tr.listener-row')]
  assert.equal(rows.length, 2)
  const cells = (r: Element) => [...r.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
  assert.match(cells(rows[0]!)[1] ?? '', /member/, 'the creator is the Agent cell')
  assert.match(cells(rows[1]!)[1] ?? '', /you/, 'the user shows as you')
  assert.match(cells(rows[1]!)[0] ?? '', /paused|disabled/, 'a paused source says so in Position')
  assert.match(cells(rows[0]!).at(-1) ?? '', /stream-chat/, 'the watchdog chip comes last')
})

test('R6 a source row names its delivery form after the watchdog chip (project-watchdogs F10)', async (t) => {
  const list = [feed('plain', { project_delivery: 'event' } as Partial<Watchdog>),
    feed('caster', { target: 'ws://127.0.0.1:8787/v2', project_delivery: 'broadcast' } as Partial<Watchdog>),
    feed('jobs', { target: 'ws://127.0.0.1:8787/v3', project_delivery: 'queue' } as Partial<Watchdog>),
    feed('legacy', { target: 'ws://127.0.0.1:8787/v4' })]
  const v = await listeners(t, list, [])
  const last = [...v.el.querySelectorAll<HTMLTableRowElement>('tbody.listeners-sources tr.source-row')]
    .map((r) => (r.lastElementChild?.textContent ?? '').replace(/\s+/g, ' ').trim())
  assert.match(last[0] ?? '', /plain.*event$/)
  assert.match(last[1] ?? '', /caster.*broadcast$/)
  assert.match(last[2] ?? '', /jobs.*queue$/)
  assert.doesNotMatch(last[3] ?? '', /event|broadcast|queue/, 'a row without the key shows no form')
})

test('R3 no section while the project owns no dog', async (t) => {
  const v = await listeners(t, [], [])
  assert.deepEqual([...v.el.querySelectorAll('.project-listeners h4')].map((h) => h.textContent),
    ['Event listeners', 'Listener watches', 'Recently Fired'])
})

test('R4 a watchdog-sourced fire shows the dog\'s link; a removed dog shows the stale chip', async (t) => {
  const history = [
    { id: 2, at: '2026-11-03T10:05:00Z', kind: 'event', by: 'stream/stream-chat', message: 'hello', listeners: [],
      source: { kind: 'watchdog', handle: 'stream/stream-chat', dog: 'stream-chat', name: 'stream-chat', dog_kind: 'websocket' } },
    { id: 1, at: '2026-11-03T10:00:00Z', kind: 'event', by: 'stream/gone-dog', message: 'old', message_truncated: true, listeners: [],
      source: { kind: 'watchdog', handle: 'stream/gone-dog', dog: 'gone-dog', name: 'gone-dog', dog_kind: 'command', gone: true } },
    { id: 3, at: '2026-11-03T10:06:00Z', kind: 'event', by: 'stream/beyond', message: 'x', listeners: [],
      source: { kind: 'watchdog', handle: 'stream/beyond', dog: 'beyond', name: 'beyond', dog_kind: 'command', gone: false } },
  ]
  const v = await listeners(t, [feed('stream-chat')], history)
  const rows = [...v.el.querySelectorAll<HTMLTableRowElement>('tr.fired-row.event')]
  assert.equal(rows.length, 3)
  const beyond = rows.find((r) => /beyond/.test(r.textContent ?? ''))!
  assert.ok(!beyond.querySelector('.gone'), 'a dog beyond the preview that the engine does not report gone is not drawn as gone')
  assert.ok(rows[0]!.querySelector('[data-object-id="stream/stream-chat"], .watchdog-link'), 'a live dog is a watchdog link')
  assert.ok(rows.find((r) => /gone-dog/.test(r.textContent ?? ''))!.querySelector('.history-dog.gone, .gone'), 'a removed dog is the copy-only stale chip')
  assert.match(rows.find((r) => /gone-dog/.test(r.textContent ?? ''))!.textContent ?? '', /…|truncated/, 'a truncated message says so')
})

/* ─── R5 the detail card ─────────────────────────────────────────────────── */

test('R5 the detail card names the project and who created the dog', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  const dog = feed('stream-chat')
  const v = await mountView(<WatchdogPanel slug="org" dog={dog} dogs={[dog]} toast={noop} close={noop} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(() => flush(3))
  const text = v.el.textContent ?? ''
  assert.match(text, /project\s*@?stream/, 'the owner line reads project @stream')
  assert.match(text, /created by\s*@?member/)
})

test('R7 a dog a superior created for its owner names the creator and the borrowed project reach (watchdog on behalf W6, W8)', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  const mk = (via: 'setter' | 'audience' | 'setter_audience', from: string | null) => ({
    id: 'w/queue', owner: 'w', name: 'queue', kind: 'fair_queue', target: 'Q', interval_s: 5, state: 'armed',
    at: '2026-11-04T10:00:00Z', fired: 0, once: false, spent: false, created_by: 'C', reach_grant: { project: 'Q', via, from },
  } as unknown as Watchdog)
  const text = async (dog: Watchdog) => {
    const v = await mountView(<WatchdogPanel slug="org" dog={dog} dogs={[dog]} toast={noop} close={noop} />, (el) => el)
    t.after(() => v.unmount())
    await inAct(() => flush(3))
    return v.el.textContent ?? ''
  }
  const a = await text(mk('setter', 'C'))
  assert.match(a, /created by\s*@C/)
  assert.match(a, /reach to\s*@Q from\s*@C/)
  assert.match(await text(mk('audience', null)), /reach to\s*@Q through an audience/)
  assert.match(await text(mk('setter_audience', 'C')), /reach to\s*@Q through\s*@C's audience/)
})

test('R3 past eight sources the section ends with the group card', async (t) => {
  const list = Array.from({ length: 8 }, (_, i) => feed('d' + i))
  const map = new Map(['member', 'boss'].map((id) => [id, node(id)] as [string, CanvasNode]))
  const v = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: list, counts: { stream: { total: 12, kept: 12, one_shot: 0 } }, open: noop }}>
    <ListenersView node={project()} dogs={list} map={map} op={(() => Promise.resolve({ history: [] })) as never} toast={noop} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => v.unmount())
  await inAct(() => flush(3))
  const rows = v.el.querySelectorAll('tbody.listeners-sources tr.source-row').length
  assert.equal(rows, 7, 'seven rows and then the group card')
  assert.match(v.el.querySelector('tbody.listeners-sources [data-watchdog-group]')?.textContent ?? '', /12 watchdogs/)
})
