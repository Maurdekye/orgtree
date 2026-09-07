// ctxwheel.test.tsx — what the context wheel says about a COMPACTED agent.
//
// USER BUG 2026-08-20: an agent that had just been compacted went on reporting
// the fill it had BEFORE, until its next turn. The backend now answers with the
// post-compaction figure at once — but that figure is usually an ESTIMATE (the
// CLI writes no record of the prompt it has just built, so nothing has measured
// it yet), and an estimate the UI presents as measured is the same lie in a
// smaller font. These pin the three things the wheel owes the operator:
//
//   1. an estimate is VISIBLY one — the tooltip says so, the arc is dimmed
//   2. the desk takes the number and the flag from the SAME source, so it can
//      never draw a measured-looking arc over an estimated number
//   3. no compact button on a session that holds only its own summary: the
//      endpoint refuses it (422), so offering it is offering a dead click
//
// Run:  cd frontend && node tests/run.mjs ctxwheel

import { inAct, installFetch, FakeServer, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ContextWheel, DeskChat } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku', ...extra,
  }
}

interface Kit {
  /** the chat payload the backend would return for this node — the desk reads
   *  its occupancy from the convo store, never from a prop */
  s: FakeServer
  slug: string
  /** mount a desk for `nd` with the FakeServer's chat already fetched */
  desk: (nd: CanvasNode) => Promise<HTMLElement>
  mount: (el: React.ReactElement) => Promise<HTMLElement>
}

function wheelTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const slug = 'org'
    const s = new FakeServer()
    installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    const mount = async (el: React.ReactElement) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    }
    await body({
      s, slug, mount,
      desk: async (nd) => {
        await inAct(async () => { await refreshConvo(slug, nd.id) })
        return mount(
          <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={slug}
            toast={noop} pub={false} bare />)
      },
    })
  })
}

const wheel = (el: HTMLElement) => el.querySelector('svg.ctxwheel')
const tip = (el: HTMLElement) => el.querySelector('svg.ctxwheel title')?.textContent ?? ''

wheelTest('a measured fill is drawn plainly and says nothing about estimation',
  async ({ mount }) => {
    const el = await mount(<ContextWheel occ={58_078} cw={200_000} compactAt={0.8} />)
    assert.equal(wheel(el)?.classList.contains('est'), false)
    assert.match(tip(el), /context: 58k \/ 200k \(29%\)/)
    assert.doesNotMatch(tip(el), /estimated/)
    assert.doesNotMatch(tip(el), /≈/)
  })

wheelTest('an ESTIMATED fill wears the marker in the tooltip AND on the arc',
  async ({ mount }) => {
    const el = await mount(<ContextWheel occ={50_764} cw={200_000} compactAt={0.8} est />)
    // the class the half-opacity rule hangs on (.ctxwheel.est .fill) — jsdom
    // does no CSS, so the hook is what is assertable, and it is what the
    // stylesheet actually selects
    assert.equal(wheel(el)?.classList.contains('est'), true)
    assert.match(tip(el), /≈51k \/ 200k/)
    assert.match(tip(el), /estimated after compaction, until its next turn/)
  })

wheelTest('an unmeasured fresh session keeps a truthful empty wheel slot',
  async ({ mount }) => {
    const el = await mount(<ContextWheel occ={undefined} cw={200_000}
      compactAt={0.8} persistent />)
    assert.ok(wheel(el), 'fresh agent lost the permanent context slot')
    assert.match(tip(el), /context: empty — no completed turn has measured this session yet/)
    assert.match(tip(el), /capacity 200k/)
    assert.equal(el.querySelector('.ctxbtn'), null,
      'fresh session was offered an ineligible compact action')
  })

wheelTest('an authoritative zero is explicit and remains non-clickable',
  async ({ mount }) => {
    const el = await mount(<ContextWheel occ={0} cw={200_000}
      compactAt={0.8} persistent />)
    assert.ok(wheel(el))
    assert.match(tip(el), /0k \/ 200k \(0%\) — empty session/)
    assert.equal(el.querySelector('.ctxbtn'), null)
  })

wheelTest('a missing context-window size renders unknown rather than vanishing',
  async ({ mount }) => {
    const el = await mount(<ContextWheel occ={0} cw={undefined}
      compactAt={0.8} persistent />)
    assert.ok(wheel(el))
    assert.match(tip(el), /context: unavailable — context-window size not reported/)
  })

wheelTest('overview cards retain their established omit-if-empty behavior',
  async ({ mount }) => {
    const el = await mount(<ContextWheel occ={undefined} cw={200_000}
      compactAt={0.8} />)
    assert.equal(wheel(el), null)
  })

wheelTest('the desk takes the number and the flag from ONE source, so a live '
  + 'chat reading cannot be drawn with the doc\'s stale flag',
  async ({ s, desk }) => {
    // the doc still carries the estimate a compaction left; the chat has since
    // MEASURED the new session. The measured number must not inherit the flag.
    s.occupancy = 58_078
    s.occupancy_estimated = false
    const el = await desk(node(`w${++_n}`, { occupancy: 50_764,
      occupancy_est: true, context_window: 200_000 }))
    assert.match(tip(el), /58k/)
    assert.equal(wheel(el)?.classList.contains('est'), false)
  })

wheelTest('…and the reverse: a chat that reports an ESTIMATE is drawn as one, '
  + 'over a doc that still holds the pre-compaction number',
  async ({ s, desk }) => {
    s.occupancy = 50_764
    s.occupancy_estimated = true
    const el = await desk(node(`w${++_n}`, { occupancy: 212_859,
      context_window: 200_000 }))
    assert.match(tip(el), /≈51k/)
    assert.equal(wheel(el)?.classList.contains('est'), true)
  })

wheelTest('the CARD wheel carries the estimate too — it is the surface an '
  + 'operator watches while an agent runs, and the desk is not open',
  async ({ mount }) => {
    // zoomed out, the card is the only place the fill appears. Its wheel takes
    // `est` from the doc (there is no chat payload at this zoom), so reverting
    // that one prop would leave a compacted agent's estimate looking measured
    // on every card in the org — and nothing at all covered it.
    const nd = node(`c${++_n}`, { occupancy: 50_764, occupancy_est: true,
      context_window: 200_000 })
    const el = await mount(
      <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
        dragging={false} isDrop={false} seats={{ used: 1, total: 4 }}
        map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
        pxc={1} zoom={1} compactAt={0.8} pub={false} maxTop={0}
        kioskRemaining={null} cascadeAlloc={true}
        onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
        onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
        onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
        onDragEnd={noop} onDragCancel={noop} />)
    assert.equal(wheel(el)?.classList.contains('est'), true)
    assert.match(tip(el), /≈51k \/ 200k/)
    // …and the card's wheel is a passive indicator: no click-to-compact here
    assert.doesNotMatch(tip(el), /click to compact now/)
  })

wheelTest('a compacted-but-unrun node is offered NO compact button — the '
  + 'endpoint refuses it, so the click would only ever raise a 422',
  async ({ s, desk }) => {
    // the chat has nothing to say, so both wheels below read the DOC — which
    // is the surface a compaction writes to before any turn runs
    s.occupancy = null
    const el0 = await desk(node(`w${++_n}`, { occupancy: 190_000,
      context_window: 200_000 }))
    // the control: without the marker the same node DOES offer it, so the
    // assertion below is about the marker and not about the fixture
    assert.match(tip(el0), /click to compact now/)

    const el = await desk(node(`w${++_n}`, { occupancy: 50_764,
      occupancy_est: true, context_window: 200_000, compacted_unrun: true }))
    assert.equal(wheel(el)?.classList.contains('est'), true)
    assert.doesNotMatch(tip(el), /click to compact now/)
  })
