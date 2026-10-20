// The per-target instance rules themselves (docket
// several-instances-of-the-same-modal-team-slots-i): the list hook every
// per-target surface uses (canvas/modalinstances.ts) and the placement,
// template, cap and rename rules of the stores (canvas/modalpin.tsx,
// windowlayout.ts). Defaults approved by the coordinator 2026-10-20 18:58:51Z.
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { CurrentOrg } from '../src/popout'
import { CASCADE_STEP, cascadeRect, forgetModalOpenCache, forgetModalPins, KEPT_PLACEMENTS, modalPinKey,
  modalTemplate, PinFrame, pinModal, readModalOpen, readModalPins, rememberModalOpen, renameModalInstances,
  unpinModal, commitModalRect } from '../src/canvas/modalpin'
import { useModalInstances } from '../src/canvas/modalinstances'
import type { ModalInstances } from '../src/canvas/modalinstances'
import { instanceKind } from '../src/modalkinds'
import { registerWindow } from '../src/windowlife'
import { renameWindowRows, savedWindows, WINDOW_LAYOUT_KEY, windowLayoutKey } from '../src/windowlayout'
import { readPinSurfaces, removePinSurface } from '../src/canvas/pinspace'

const org = 'hook', noop = () => {}
const R = { x: 40, y: 50, w: 520, h: 360 }
const pinOf = (kind: string) => readModalPins()[modalPinKey(kind, org)]?.rect ?? null

function setup(t: TestContext) {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  t.after(async () => {
    for (const s of readPinSurfaces().filter(s => s.org === org)) removePinSurface(s.key)
    await inAct(async () => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() })
  })
}

/** one per-target kind's windows, as the canvas holds them */
async function host(t: TestContext, kind = 'agent-team') {
  let api: ModalInstances
  function Host() {
    const list = useModalInstances(kind, org, (id) => ({ agent: id, generation: 1 }))
    api = list
    return <>{list.ids.map(id => <PinFrame key={id} kind={instanceKind(kind, id)} title={`${id} · ${kind}`}
      dialogLabel={`${id} · ${kind}`} restore={{ agent: id, generation: 1 }} panel="settings" close={() => list.close(id)}>
      <p>{id}</p></PinFrame>)}</>
  }
  const view = await mountView(<CurrentOrg.Provider value={org}><Host /></CurrentOrg.Provider>, el => el)
  t.after(() => view.unmount())
  const shown = () => [...document.querySelectorAll('[role="dialog"]')].map(d => d.getAttribute('aria-label') ?? '')
    .filter(l => l.endsWith(` · ${kind}`)).map(l => l.slice(0, -` · ${kind}`.length)).sort()
  return {
    api: () => api!,
    shown,
    act: async (fn: (api: ModalInstances) => void) => inAct(async () => { fn(api!); await flush(4) }),
  }
}

// ------------------------------------------------------------ the list hook
test('§1 a node\'s own button hides only its own pinned window, and brings it back in place', async t => {
  setup(t); pinModal(instanceKind('agent-team', 'worker'), R, org)
  const h = await host(t)
  await h.act(a => a.restore(['worker']))
  await h.act(a => a.open('report', { ensureOpen: true }))
  assert.deepEqual(h.shown(), ['report', 'worker'])
  await h.act(a => a.open('worker'))   // the card's button: no ensureOpen
  assert.deepEqual(h.shown(), ['report'], 'worker\'s pinned window hides; report\'s stays')
  assert.equal(readModalOpen(org).some(o => o.kind === 'agent-team:worker'), false, 'the close is durable')
  assert.deepEqual(pinOf('agent-team:worker'), R, 'its placement is kept')
  await h.act(a => a.open('worker'))
  assert.deepEqual(h.shown(), ['report', 'worker'], 'the same button reopens it')
  assert.deepEqual(pinOf('agent-team:worker'), R, 'where it was')
  await h.act(a => a.open('worker', { ensureOpen: true }))
  assert.deepEqual(h.shown(), ['report', 'worker'], 'a menu entry never closes')
})

test('§2 a centred window gives way to a new target; a popped-out one stays and is revealed', async t => {
  setup(t)
  const h = await host(t)
  await h.act(a => a.open('worker', { ensureOpen: true }))
  await h.act(a => a.open('report', { ensureOpen: true }))
  assert.deepEqual(h.shown(), ['report'], 'one centred instance per kind')
  let raised = 0
  t.after(registerWindow({ id: 'popped', kind: instanceKind('agent-team', 'report'), org, editable: false,
    window: { closed: false, focus: noop } as unknown as Window, redock: noop, reveal: () => { raised++ } }))
  await h.act(a => a.open('intern', { ensureOpen: true }))
  assert.deepEqual(h.api().ids, ['report', 'intern'], 'the popped-out window is kept')
  await h.act(a => a.open('report', { ensureOpen: true }))
  assert.equal(raised, 1, 'and opening it again raises its window')
  assert.deepEqual(h.api().ids, ['report', 'intern'], 'without a second instance')
})

test('§3 a pinned instance is remembered as open; a centred one is not; a close forgets it', async t => {
  setup(t); pinModal(instanceKind('agent-team', 'worker'), R, org)
  const h = await host(t)
  await h.act(a => a.open('worker', { ensureOpen: true }))
  await h.act(a => a.open('intern', { ensureOpen: true, place: false }))
  assert.deepEqual(readModalOpen(org).map(o => o.kind), ['agent-team:worker'])
  assert.deepEqual(readModalOpen(org)[0]!.restore, { agent: 'worker', generation: 1 })
  await h.act(a => a.close('worker'))
  assert.deepEqual(readModalOpen(org), [], 'closed')
})

test('§4 a rename carries the instance, its pin, its marker and its window row', async t => {
  setup(t)
  const rect = { x: 10, y: 10, width: 700, height: 500 }
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{ key: windowLayoutKey('node-inbox:worker', org),
    kind: 'node-inbox:worker', org, open: true, rect, restore: { agent: 'worker', generation: 1 } }]))
  pinModal(instanceKind('agent-team', 'worker'), R, org)
  rememberModalOpen(instanceKind('agent-team', 'worker'), org, { agent: 'worker', generation: 1 })
  const h = await host(t)
  await h.act(a => a.restore(['worker']))
  await h.act(a => { renameModalInstances(org, 'worker', 'lead'); renameWindowRows(org, 'worker', 'lead'); a.rename('worker', 'lead') })
  assert.deepEqual(h.api().ids, ['lead'])
  assert.deepEqual(pinOf('agent-team:lead'), R); assert.equal(pinOf('agent-team:worker'), null)
  assert.deepEqual(readModalOpen(org).map(o => [o.kind, o.restore?.agent]), [['agent-team:lead', 'lead']])
  assert.deepEqual(savedWindows().map(r => [r.key, r.kind, r.restore?.agent]),
    [[windowLayoutKey('node-inbox:lead', org), 'node-inbox:lead', 'lead']])
})

// --------------------------------------------------------- the placement
test('§5 pinning sets the kind\'s template, a move moves it, an unpin clears it', t => {
  setup(t)
  assert.equal(modalTemplate('agent-team', org), null, 'never placed: centred')
  pinModal(instanceKind('agent-team', 'worker'), R, org)
  assert.deepEqual(modalTemplate('agent-team', org), R)
  commitModalRect(instanceKind('agent-team', 'worker'), { ...R, x: 200 }, org)
  assert.deepEqual(modalTemplate('agent-team', org), { ...R, x: 200 })
  unpinModal(instanceKind('agent-team', 'worker'), org)
  assert.equal(modalTemplate('agent-team', org), null, 'the kind opens centred again')
  pinModal('usage', R, org)
  assert.equal(modalTemplate('usage', org), null, 'a single-instance kind has no template')
})

test('§6 the cascade steps 28 px past open siblings and wraps inside the canvas', () => {
  assert.equal(CASCADE_STEP, 28)
  assert.deepEqual(cascadeRect(R, [], { w: 1000, h: 700 }), R, 'a free spot is used as it is')
  assert.deepEqual(cascadeRect(R, [R, { ...R, x: 68, y: 78 }], { w: 1000, h: 700 }), { ...R, x: 96, y: 106 })
  const edge = { ...R, x: 460, y: 300 }   // one more step leaves the 1000 x 700 canvas
  assert.deepEqual(cascadeRect(edge, [edge], { w: 1000, h: 700 }), { ...edge, x: 0, y: 0 }, 'back to the top left')
})

test('§7 new targets follow the template, cascaded; automatic placement never moves the template', async t => {
  setup(t); pinModal(instanceKind('agent-team', 'worker'), R, org)
  const h = await host(t)
  await h.act(a => a.restore(['worker']))
  await h.act(a => a.open('report', { ensureOpen: true }))
  await h.act(a => a.open('intern', { ensureOpen: true }))
  assert.deepEqual(pinOf('agent-team:report'), { ...R, x: R.x + 28, y: R.y + 28 })
  assert.deepEqual(pinOf('agent-team:intern'), { ...R, x: R.x + 56, y: R.y + 56 })
  assert.deepEqual(modalTemplate('agent-team', org), R, 'the template is where the user put it')
  await h.act(a => { a.close('worker'); a.close('report'); a.close('intern') })
  await h.act(a => a.open('fourth', { ensureOpen: true }))
  assert.deepEqual(pinOf('agent-team:fourth'), R, 'with nothing open there, the template spot itself')
  await h.act(a => a.open('fifth', { ensureOpen: true, place: false }))
  assert.equal(pinOf('agent-team:fifth'), null, 'the corner\'s own pin / pop-out route places nothing')
})

test('§8 placements of closed instances keep the newest twenty; open ones are never dropped', t => {
  setup(t)
  assert.equal(KEPT_PLACEMENTS, 20)
  rememberModalOpen(instanceKind('agent-team', 'open-0'), org, { agent: 'open-0', generation: 1 })
  pinModal(instanceKind('agent-team', 'open-0'), R, org)
  for (let i = 1; i <= 25; i++) pinModal(instanceKind('agent-team', `closed-${i}`), R, org)
  // the window being pinned is on screen, so it is never the one dropped
  pinModal(instanceKind('agent-team', 'open-1'), R, org)
  const kept = Object.keys(readModalPins()).map(k => JSON.parse(k)[1] as string).sort()
  assert.equal(kept.includes('agent-team:open-0'), true, 'the open one stays')
  assert.equal(kept.includes('agent-team:open-1'), true, 'the one just pinned stays')
  assert.equal(kept.filter(k => k.startsWith('agent-team:closed-')).length, 20, 'twenty closed placements')
  assert.equal(kept.includes('agent-team:closed-25'), true, 'the newest stays')
  assert.equal(kept.includes('agent-team:closed-5'), false, 'the oldest go')
  assert.equal(kept.includes('agent-team:closed-6'), true)
})
