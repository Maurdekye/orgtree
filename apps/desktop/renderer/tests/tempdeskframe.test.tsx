// tempdeskframe.test.tsx — THE TEMPORARY AGENT DESK IS ON THE SHARED MODAL FRAME.
//
// USER 2026-11-13 mf430d688fdcb asked for the temporary desk to move onto the shared modal system; the design the
// user chose on 2026-11-13 (m2672b93c2df8, "A + all 5") is the HAND-OVER one:
//   A  it is the shared frame (`PinFrame` in its desk configuration, as the project desk's modal): the shared
//      backdrop, title bar, buttons and right-click menu. Its pin and pop-out hand over to the agent's REAL pinned
//      window and REAL desk window; the temporary desk itself is never a pinned or popped-out thing
//   1  a per-agent kind, one open at a time
//   2  nothing is saved: no pin row, no open row, no window-layout row
//   3  pin hands over; pop-out hands over
//   4  no Pin while the agent's desk is already pinned (the host passes no `onPin`)
//   5  the shared dim backdrop; X, Escape and a click on the backdrop close it
// The borrow, the focus handling and the dismissals themselves stay pinned by tempdesk.test.tsx.
//
// Run:  node apps/desktop/renderer/tests/run.mjs tempdeskframe

import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { resetConvos } from '../src/convo'
import { CurrentOrg } from '../src/popout'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { TempDeskModal } from '../src/canvas/tempdesk'
import { forgetModalPins } from '../src/canvas/modalpin'
import { openSurfaces } from '../src/windowlife'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const agent = (id: string): CanvasNode => ({
  id, tier: 'opus', state: 'live', generation: 0, parent: null, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode)

const pinned: Array<{ w: number; h: number }> = []
function Scene({ node, pin = true }: { node: CanvasNode; pin?: boolean }) {
  const [open, setOpen] = useState(true)
  const map = new Map([[node.id, node]])
  // inside an organization, as in the app: the frame has an org scope here, and must STILL save nothing
  return (
    <CurrentOrg.Provider value="org">
      <DeskHosts map={map} slug="org">
        {open && <TempDeskModal node={node} close={() => setOpen(false)}
          onPin={pin ? (rect) => { pinned.push({ w: rect.w, h: rect.h }); setOpen(false) } : undefined}
          desk={{ map, op, slug: 'org', toast: noop }} />}
        <div data-which="canvas">
          <DeskSlot node={node} map={map} op={op} slug="org" toast={noop} bare />
        </div>
      </DeskHosts>
    </CurrentOrg.Provider>
  )
}

const modal = () => document.querySelector('.tempdesk-panel') as HTMLElement | null
const bar = () => modal()?.querySelector(':scope > .modalpin-bar') as HTMLElement | null
const labels = () => [...(bar()?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'))
const setup = () => { localStorage.clear(); forgetModalPins(); resetConvos(); installFetch(new FakeServer()); pinned.length = 0 }
async function open(t: { after: (fn: () => void | Promise<void>) => void }, name: string, pin = true) {
  setup()
  const view = await mountView(<Scene node={agent(name)} pin={pin} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  return view
}

test('it is the shared frame: the shared backdrop and the shared title bar, as the project desk', async (t) => {
  await open(t, 'frame-agent')
  const panel = modal()
  assert.ok(panel, 'the temporary desk is open')
  assert.equal(panel!.parentElement?.classList.contains('overlay'), true, 'inside the shared backdrop')
  assert.equal(document.querySelector('.tempdesk-over'), null, 'its own backdrop is gone')
  assert.equal(document.querySelector('.tempdesk-head'), null, 'and so is its own title bar')
  assert.ok(bar()?.classList.contains('desk-title'), 'the frame\'s bar in its desk configuration is the title bar')
  assert.match(bar()!.querySelector('.modalpin-name')?.textContent ?? '', /frame-agent/)
  assert.equal(panel!.getAttribute('role'), 'dialog')
  assert.equal(panel!.getAttribute('aria-modal'), 'true')
  assert.equal(panel!.getAttribute('aria-label'), 'frame-agent · desk, opened temporarily')
  assert.ok(panel!.querySelector('textarea'), 'with the agent\'s real desk inside')
})

test('the title bar carries pop-out, pin and X, in the shared order; the desk header does not repeat the pop-out', async (t) => {
  await open(t, 'buttons-agent')
  assert.deepEqual(labels(), ['Open in new window', 'pin this to the window', 'close this window'])
  assert.equal(modal()!.querySelectorAll('[aria-label="Open in new window"]').length, 1, 'one pop-out button, not two')
})

test('no Pin when the host offers none (the agent\'s desk is already pinned)', async (t) => {
  await open(t, 'nopin-agent', false)
  assert.deepEqual(labels(), ['Open in new window', 'close this window'])
})

test('Pin hands over to the host and the frame itself pins nothing', async (t) => {
  await open(t, 'pin-agent')
  await inAct(() => { bar()!.querySelector<HTMLButtonElement>('[aria-label="pin this to the window"]')!.click() })
  await flush()
  assert.equal(pinned.length, 1, 'the host\'s pin action ran once, with the panel\'s box')
  assert.equal(modal(), null, 'and the temporary desk closed')
  assert.equal(document.querySelector('.overlay-pinned'), null, 'there is no pinned temporary desk')
  assert.deepEqual(Object.keys(localStorage), [], 'the frame saved nothing')
})

test('the bar\'s pop-out asks for the agent\'s real desk window, and a blocked window keeps the temporary desk', async (t) => {
  await open(t, 'popout-agent')
  const oldOpen = window.open
  let asked = 0
  window.open = () => { asked++; return null }
  t.after(() => { window.open = oldOpen })
  const composer = modal()!.querySelector('textarea')
  await inAct(() => { bar()!.querySelector<HTMLButtonElement>('[aria-label="Open in new window"]')!.click() })
  await flush()
  assert.equal(asked, 1, 'one window was asked for')
  assert.ok(modal(), 'blocked: the temporary desk stays')
  assert.equal(modal()!.querySelector('textarea') === composer, true, 'with the same composer')
  assert.equal(openSurfaces().some((s) => s.kind.startsWith('agent-desk-glance')), false,
    'the temporary desk itself is never a window')
})

test('the bar\'s right-click menu is the shared one: pop-out, pin, Close', async (t) => {
  await open(t, 'menu-agent')
  await inAct(() => { bar()!.dispatchEvent(new window.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
  await flush(3)
  const entries = [...document.querySelectorAll<HTMLElement>('.ctxmenu button')]
  assert.deepEqual(entries.map((b) => b.textContent?.trim()), ['Open in new window', 'Pin to window', 'Close'])
  await inAct(() => { entries[2]!.click() })
  await flush()
  assert.equal(modal(), null, 'Close closes it')
})

test('opening and closing it leaves nothing saved', async (t) => {
  await open(t, 'clean-agent')
  await inAct(() => { bar()!.querySelector<HTMLButtonElement>('[aria-label="close this window"]')!.click() })
  await flush()
  assert.equal(modal(), null)
  assert.deepEqual(Object.keys(localStorage), [], 'no pin row, no open row, no window-layout row')
})

test('a click on the shared backdrop closes it; a click inside does not', async (t) => {
  await open(t, 'backdrop-agent')
  const press = (el: Element) => inAct(() => {
    el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await press(modal()!)
  assert.ok(modal(), 'inside: still open')
  await press(modal()!.parentElement!)
  await flush()
  assert.equal(modal(), null, 'the backdrop dismisses')
})
