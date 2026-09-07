// pinloop.test.tsx — the ↑-you chip must not change the predicate that shows it.
//
// React #185 report, 2026-08-30: DeskChat's layout effect calculated whether a
// user row was above the scrollport, then mounted a sticky chip IN FRONT of
// that row. At the boundary, that extra in-flow height moved the row on-screen;
// the next layout effect removed the chip; then the row moved above again.
// Layout effects run before paint, so the UI never settled and React stopped it
// after 50 nested commits.
//
// jsdom has no layout. This fixture therefore supplies the measured geometry
// explicitly: the row sits at bottom 0 without the chip and bottom 5 with it;
// the chip itself is 5px high. That is the real feedback shape in its smallest
// form. A test that merely sees no error has no witness — this one makes the
// old predicate alternate every commit and asserts the fixed predicate keeps
// the target stable after the chip has entered flow.

import './harness'
import { FakeServer, fireResize, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

const node = (id: string): CanvasNode => ({
  id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
})

const rect = (top: number, bottom: number) => ({
  top, bottom, left: 0, right: 240, width: 240, height: bottom - top,
  x: 0, y: top, toJSON: () => ({}),
})

test('a sticky ↑-you chip keeps its target at the flow boundary',
  { timeout: 3_000 }, async (t: TestContext) => {
    useFakeClock()
    const s = new FakeServer()
    const slug = 'pin-loop'
    const nid = 'desk'
    installFetch(s)
    // One human turn is enough. The envelope is important: assistant or peer
    // rows must not participate in this chip's scan.
    s.userMsg(`FROM ${USER} (user)\n\nplease inspect this`)
    await inAct(async () => { await refreshConvo(slug, nid) })

    const proto = (globalThis as unknown as {
      HTMLElement: { prototype: HTMLElement }
    }).HTMLElement.prototype
    const saved = proto.getBoundingClientRect
    let userReads = 0
    proto.getBoundingClientRect = function(this: HTMLElement) {
      if (this.classList.contains('msgs')) return rect(0, 400) as DOMRect
      if (this.classList.contains('pinuser')) return rect(0, 5) as DOMRect
      // calcPin measures the transcript ROW wrapper, whose sole child is Msg's
      // `.msg.user` element — it intentionally does not measure that child.
      const child = this.firstElementChild as HTMLElement | null
      if (this.children.length === 1 && child?.classList.contains('msg')
          && child.classList.contains('user')) {
        userReads += 1
        // The old in-flow chip moved the row by its height PLUS `.msgs`' 7px
        // flex gap. Its height-only compensation therefore still alternated
        // in this band. The overlay fix is outside `.msgs`, so it contributes
        // exactly zero regardless of its height, gap, margins or wrapping.
        const msgs = document.querySelector('.msgs')
        const pin = document.querySelector('.pinuser')
        return rect(0, msgs && pin && msgs.contains(pin) ? 12 : 0) as DOMRect
      }
      return saved.call(this)
    }

    let open: { el: HTMLElement; unmount: () => Promise<void> } | null = null
    t.after(async () => {
      proto.getBoundingClientRect = saved
      if (open) await open.unmount()
      resetConvos()
      realClock()
    })

    open = await mountView(
      <DeskChat node={node(nid)} map={new Map([[nid, node(nid)]])} op={op}
        slug={slug} toast={noop} pub={false} bare />,
      (host) => host,
    )
    await flush() // lets the harness deliver the observer's initial callback
    // Mount calculates before this fixture's pin has become an in-flow DOM
    // sibling. A real reflow delivers a ResizeObserver callback at that point;
    // deliver its exact test-double equivalent so both sides of the boundary
    // are actually exercised, rather than assuming a second layout pass.
    const msgs = open.el.querySelector('.msgs')
    assert.ok(msgs, 'the desk did not render its transcript scroller')
    await inAct(() => { fireResize(msgs!) })
    await flush()
    assert.ok(open.el.querySelector('.pinuser'),
      'the chip must remain mounted; removing it re-arms the exact same boundary')
    assert.equal(open.el.querySelector('.msgs')?.contains(open.el.querySelector('.pinuser')), false,
      'the pin must be an overlay outside the geometry it uses as its predicate')
    assert.ok(userReads >= 2,
      `the fixture did not observe both the pre-pin and post-pin geometries (saw ${userReads})`)
  })
