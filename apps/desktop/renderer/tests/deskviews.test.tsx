// deskviews.test.tsx — EVERY PLACE A DESK IS OPEN SHOWS IT, LIVE, AT ONCE.
//
// USER 2026-11-15 10:34:16Z mbf1f1ca2cfe9 (4.6.1, @item:orgtree/desks-show-in-every-place-at-once-no-more-desk-i):
// "you should no longer see \"xyz's desk is open elsewhere (bring it here)\" etc. it should always show in both
// locations at once; on the canvas, in a pinned / popped out desk, in the attention desk, etc."
//
// The conversation was already one store per node (convo.ts). What a second live desk needed was ONE composer
// state per desk identity (draftstore `useSharedComposer`): the unsent text, its attachments and reply targets.
// Per view stay scroll, open tab, focus and caret. Design: desk-parity-opus design-461-desk-views.md.
import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { resetConvos } from '../src/convo'
import { DeskHosts, DeskSlot, deskIdentity, deskShownAnywhere, revealExistingDesk } from '../src/canvas/deskhosts'
import { registerWindow } from '../src/windowlife'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const W = window as unknown as Window & typeof globalThis

const agent = (id: string): CanvasNode => ({
  id, tier: 'opus', state: 'live', generation: 0, parent: null, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode)

function places(node: CanvasNode, props: Record<string, Record<string, unknown>>) {
  const map = new Map([[node.id, node]])
  return (
    <DeskHosts map={map} slug="org">
      {Object.entries(props).map(([which, p]) => (
        <div data-which={which} key={which}>
          <DeskSlot node={node} map={map} op={op} slug="org" toast={noop} bare {...p} />
        </div>
      ))}
    </DeskHosts>
  )
}

const box = (el: HTMLElement, which: string) => el.querySelector(`[data-which="${which}"]`) as HTMLElement
const composer = (el: HTMLElement, which: string) => box(el, which).querySelector('textarea') as HTMLTextAreaElement | null
async function type(area: HTMLTextAreaElement, value: string) {
  await inAct(() => {
    Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new W.Event('input', { bubbles: true }))
  })
  await flush()
}
const setup = () => { resetConvos(); localStorage.clear(); installFetch(new FakeServer()) }

test('two places open on one agent both show its live desk, with no open-elsewhere notice', async (t: TestContext) => {
  setup()
  const n = agent('alpha')
  const view = await mountView(places(n, { card: { openIn: 'card' }, pin: { openIn: 'pin' } }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  assert.doesNotMatch(view.el.textContent ?? '', /open elsewhere/, 'no place shows the old notice')
  assert.ok(composer(view.el, 'card'), 'the card place has its own composer')
  assert.ok(composer(view.el, 'pin'), 'the pin place has its own composer')
  assert.notEqual(composer(view.el, 'card'), composer(view.el, 'pin'), 'two live desks, not one moved between them')
})

test('three places (card, pin, attention) are all live at once', async (t: TestContext) => {
  setup()
  const n = agent('beta')
  const view = await mountView(places(n, { card: { openIn: 'card' }, pin: { openIn: 'pin' },
    attention: { openIn: 'attention', claim: 'automatic' } }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  assert.equal(view.el.querySelectorAll('textarea').length, 3)
  assert.doesNotMatch(view.el.textContent ?? '', /open elsewhere|Move desk here|Show desk/)
})

test('the unsent draft is ONE per agent: typing in one place shows in every place, and clearing clears all', async (t: TestContext) => {
  setup()
  const n = agent('gamma')
  const view = await mountView(places(n, { card: {}, pin: {} }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  await type(composer(view.el, 'card')!, 'half a sentence')
  assert.equal(composer(view.el, 'pin')!.value, 'half a sentence', 'the other place shows the same draft live')
  await type(composer(view.el, 'pin')!, '')
  assert.equal(composer(view.el, 'card')!.value, '', 'clearing in one place clears it everywhere')
})

test('a place opened later starts with the draft typed elsewhere', async (t: TestContext) => {
  setup()
  const n = agent('delta')
  const view = await mountView(places(n, { card: {} }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  await type(composer(view.el, 'card')!, 'typed before the pin opened')
  await view.render(places(n, { card: {}, pin: {} }))
  await flush()
  assert.equal(composer(view.el, 'pin')!.value, 'typed before the pin opened')
})

test('re-rendering one place (hover) keeps both composers mounted and the text intact', async (t: TestContext) => {
  setup()
  const n = agent('epsilon')
  const view = await mountView(places(n, { card: {}, pin: {} }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  const card = composer(view.el, 'card')!, pin = composer(view.el, 'pin')!
  await type(card, 'keep me')
  for (let i = 0; i < 3; i++) {
    await view.render(places(n, { card: { compactAt: 0.4 + i / 100 }, pin: { compactAt: 0.5 + i / 100 } }))
    await flush()
  }
  assert.equal(composer(view.el, 'card'), card, 'the card composer was remounted')
  assert.equal(composer(view.el, 'pin'), pin, 'the pin composer was remounted')
  assert.equal(pin.value, 'keep me')
})

test('closing one place leaves the other live with the draft', async (t: TestContext) => {
  setup()
  const n = agent('zeta')
  const view = await mountView(places(n, { card: {}, pin: {} }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  const pin = composer(view.el, 'pin')!
  await type(composer(view.el, 'card')!, 'still here')
  await view.render(places(n, { pin: {} }))
  await flush()
  assert.equal(composer(view.el, 'pin'), pin, 'the remaining place was not remounted')
  assert.equal(pin.value, 'still here')
})

test('a place that is not on screen mounts no desk and draws no notice', async (t: TestContext) => {
  setup()
  const n = agent('eta')
  const view = await mountView(places(n, { card: { eligible: false }, pin: {} }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  assert.equal(composer(view.el, 'card'), null, 'the hidden place mounted a desk')
  assert.equal((box(view.el, 'card').textContent ?? '').trim(), '', 'the hidden place drew something')
  assert.ok(composer(view.el, 'pin'))
  // and it mounts once it comes on screen
  await view.render(places(n, { card: {}, pin: {} }))
  await flush()
  assert.ok(composer(view.el, 'card'), 'the place did not mount its desk on coming on screen')
})

test('a desk counts as shown anywhere while any visible place has it', async (t: TestContext) => {
  setup()
  const n = agent('theta')
  const view = await mountView(places(n, { card: { eligible: false, openIn: 'card' }, pin: { openIn: 'pin' } }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  assert.equal(deskShownAnywhere('org', n), true)
  await view.render(places(n, { card: { eligible: false, openIn: 'card' } }))
  await flush()
  assert.equal(deskShownAnywhere('org', n), false, 'only a hidden place is left')
})

// moved from deskowner.test.tsx, whose single-owner rules this change retires (4.6.1)
test('generic focus reveals only the matching already-open desk window', (t) => {
  const n = agent('already-open')
  const raised: string[] = []
  const unregister = registerWindow({
    id: 'desk-window', kind: `desk:${deskIdentity('org', n)}`, org: 'org',
    editable: true, window: window as unknown as Window,
    redock: noop, reveal: () => raised.push('desk'),
  })
  t.after(unregister)
  assert.equal(revealExistingDesk('org', n), true)
  assert.deepEqual(raised, ['desk'], 'the matching open desk is brought to the front')
  assert.equal(revealExistingDesk('another-org', n), false, 'a desk in another org is not selected')
  assert.deepEqual(raised, ['desk'], 'no unrelated window is focused')
})
