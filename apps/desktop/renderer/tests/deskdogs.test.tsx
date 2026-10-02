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
import { DESK_JUMP_FOLD_LIMIT, JUMP_FOLD_KEY } from '../src/canvas/shared'
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
        slug="org" toast={() => {}} bare onJump={onJump} />
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

const N = DESK_JUMP_FOLD_LIMIT + 1

test('more than 16 jump cards fold behind one counted button; opening it lists every card and they still work', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  localStorage.removeItem(JUMP_FOLD_KEY)
  t.after(() => { resetConvos(); realClock() })
  const kids = Array.from({ length: N - 2 }, (_, i) => node('kid' + i))
  const me = node('lead', kids)
  const opened: string[] = []
  const jumped: string[] = []
  const view = await desk(me, [dog('w1', 'lead', 'a'), dog('w2', 'lead', 'b')], opened, (id) => jumped.push(id))
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const row = view.el.querySelector('.desk-nav')!
  const fold = row.querySelector<HTMLElement>('[data-audience-fold]')
  assert.ok(fold, 'the fold button shows at 17 cards')
  assert.match(fold!.textContent ?? '', new RegExp(`${N} jump cards`))
  assert.equal(row.querySelectorAll('.desk-nav-chip').length, 0, 'no card is visible while folded')
  await inAct(async () => { fold!.click() })
  assert.equal(row.querySelectorAll('.desk-nav-chip').length, N, 'every card is listed')
  await inAct(async () => { row.querySelectorAll<HTMLElement>('.desk-nav-chip')[0]!.click() })
  assert.deepEqual(jumped, ['kid0'])
  await inAct(async () => { row.querySelector<HTMLElement>('.desk-dog-chip')!.click() })
  assert.deepEqual(opened, ['w1'])
})

test('exactly 16 jump cards are all shown, and turning the setting off shows 17 unfolded', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  localStorage.removeItem(JUMP_FOLD_KEY)
  t.after(() => { localStorage.removeItem(JUMP_FOLD_KEY); resetConvos(); realClock() })
  let view = await desk(node('lead', Array.from({ length: N - 3 }, (_, i) => node('kid' + i))),
    [dog('w1', 'lead', 'a'), dog('w2', 'lead', 'b')], [], () => {})
  await inAct(async () => { await flush(4) })
  assert.equal(view.el.querySelector('[data-audience-fold]'), null, '16 is not "more than 16"')
  assert.equal(view.el.querySelectorAll('.desk-nav .desk-nav-chip, .desk-nav .desk-dog-chip').length, DESK_JUMP_FOLD_LIMIT)
  await view.unmount()
  localStorage.setItem(JUMP_FOLD_KEY, '0')
  view = await desk(node('lead', Array.from({ length: N - 2 }, (_, i) => node('kid' + i))),
    [dog('w1', 'lead', 'a'), dog('w2', 'lead', 'b')], [], () => {})
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  assert.equal(view.el.querySelector('[data-audience-fold]'), null, 'setting off never folds')
  assert.equal(view.el.querySelectorAll('.desk-nav .desk-nav-chip, .desk-nav .desk-dog-chip').length, N)
})

test('below the threshold the jump cards show unfolded', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { resetConvos(); realClock() })
  const me = node('lead', [node('kid')])
  const view = await desk(me, [dog('w1', 'lead', 'a')], [], () => {})
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  assert.equal(view.el.querySelector('[data-audience-fold]'), null)
  assert.equal(view.el.querySelectorAll('.desk-nav .desk-nav-chip').length, 2)
})

test('below the threshold the footer order is live reports, retired controls, then watchdogs', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { resetConvos(); realClock() })
  const gone = { ...node('old'), state: 'retired' } as CanvasNode
  const me = node('lead', [node('kid'), gone])
  const view = await desk(me, [dog('w1', 'lead', 'a')], [], () => {})
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const labels = [...view.el.querySelectorAll('.desk-nav .desk-nav-chip')].map((c) => c.textContent ?? '')
  const at = (re: RegExp) => labels.findIndex((l) => re.test(l))
  assert.ok(at(/kid/) >= 0 && at(/retired/) > at(/kid/) && at(/a/) > at(/retired/), labels.join(' | '))
})
