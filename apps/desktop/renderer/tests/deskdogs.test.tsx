// deskdogs.test.tsx — a jump card on an agent's desk for each of ITS
// watchdogs, opening that watchdog's modal (user 2026-09-29, docket
// v3-desk-jump-cards-add-a-card-per-watchdog-that).
//
// Run:  node apps/desktop/renderer/tests/run.mjs deskdogs
import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, Watchdog } from '../src/types'

const node = (id: string, children: CanvasNode[] = []): CanvasNode => ({
  id, state: 'live', tier: 'haiku', model_id: 'haiku', children, seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] },
} as unknown as CanvasNode)

const dog = (id: string, owner: string, name: string, patch: Partial<Watchdog> = {}): Watchdog => ({
  id, owner, name, kind: 'file', target: 'x.log', interval_s: 30, state: 'armed',
  at: '2026-09-29T00:00:00Z', fired: 0, once: false, spent: false, ...patch,
})

async function desk(me: CanvasNode, dogs: Watchdog[], opened: string[], onJump?: (id: string) => void) {
  const map = new Map<string, CanvasNode>([[me.id, me], ...me.children.map((c) => [c.id, c] as [string, CanvasNode])])
  return mountView(
    <DeskDogsProvider value={{ dogs, open: (id) => opened.push(id) }}>
      <DeskChat node={me} map={map} op={() => Promise.resolve({} as OpResult)}
        slug="org" toast={() => {}} pub={false} bare onJump={onJump} />
    </DeskDogsProvider>, (el) => el)
}

test('the desk shows one card per watchdog IT owns, after its reports, and a card opens that dog', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { resetConvos(); realClock() })
  const me = node('lead', [node('kid')])
  const opened: string[] = []
  const view = await desk(me, [
    dog('w1', 'lead', 'build-done'),
    dog('w2', 'someone-else', 'not-mine'),
    dog('w3', 'lead', 'log-errors', { state: 'paused', once: true }),
    dog('w4', 'lead', 'already-fired', { once: true, spent: true, state: 'spent' }),
  ], opened, () => {})
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const row = view.el.querySelector('.desk-nav')!
  assert.ok(row, 'the bottom jump row renders')
  const chips = [...row.querySelectorAll<HTMLElement>('.desk-nav-chip')]
  const labels = chips.map((c) => c.textContent?.trim())
  assert.match(labels[0] ?? '', /kid/, 'reports come first')
  const dogs = chips.filter((c) => c.classList.contains('desk-dog-chip'))
  assert.deepEqual(dogs.map((c) => c.textContent?.replace(/[◉◫✕]|1×/g, '').trim()),
    ['build-done', 'log-errors'],
    'only this agent\'s dogs, in the tree\'s order; another agent\'s dog and a spent one-shot get none')
  assert.ok(dogs[0]!.classList.contains('armed'))
  assert.ok(dogs[1]!.classList.contains('paused'))
  assert.match(dogs[1]!.getAttribute('title') ?? '', /one-shot dog "log-errors"/)
  await inAct(async () => { dogs[1]!.click() })
  assert.deepEqual(opened, ['w3'], 'clicking a card opens THAT watchdog')
})

test('an agent with dogs but no reports still gets the row; one with neither gets none', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { resetConvos(); realClock() })
  const opened: string[] = []
  let view = await desk(node('solo'), [dog('w1', 'solo', 'watch')], opened, () => {})
  await inAct(async () => { await flush(4) })
  assert.equal(view.el.querySelectorAll('.desk-nav .desk-dog-chip').length, 1)
  await view.unmount()
  view = await desk(node('solo'), [dog('w1', 'other', 'watch')], opened, () => {})
  await inAct(async () => { await flush(4) })
  assert.equal(view.el.querySelector('.desk-nav'), null, 'no dogs and no reports: no row at all')
  await view.unmount()
})
