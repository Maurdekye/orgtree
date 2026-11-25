// bringtofront.test.tsx — A JUMP BRINGS ITS TARGET WINDOW TO THE FRONT (4.7.0-alpha.7).
//
// FOUND BY integ-sol-d 2026-11-25 (pre-existing at 644d177): "View in chat" chosen in a centred agent mailbox
// opened the user's chats and flashed the message, but the chats stayed BEHIND the still-open agent mailbox.
// Coordinator ruling (USER m9e3fb5560658 "fix all that for alpha 7"): every View in chat / Open chat / View in
// classic inbox / View in @agent's inbox jump brings its target window to the front, above the window it was
// chosen from, which stays open behind it. Nothing closes.
//
// Two centred windows are two `.overlay`s at the same z-index (30, styles.css), so the one later in the document
// was on top: the canvas's agent mailbox sits after the shell's chats. Every jump reaches its target through
// raisePinnedModal (the shell's mail-view request, a node panel's open), which only ever raised a PINNED window.
// jsdom draws nothing, so "on top" is read as the browser decides it: the higher z-index, and on a tie the later
// element. A key event is cancelable, as a real one is (useEsc's preventDefault is what stops a second handler).
// A pinned window lives in the pin layer (z 16, pinspace.tsx): a centred window behind it must drop
// below that layer. The capture kit checks the real hit-test.
import { flush, inAct, mountView as rawMountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { forgetModalOpenCache, forgetModalPins, PinFrame, pinModal, raisePinnedModal } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'

const ORG = 'probe'
const PIN_LAYER_Z = 16
const reset = () => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() }

async function mount(node: ReactNode) {
  const canvas = document.createElement('div'); canvas.dataset.pinOrg = ORG
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
    right: window.innerWidth, bottom: window.innerHeight, toJSON() {} })
  document.body.appendChild(canvas)
  const v = await rawMountView(<CurrentOrg.Provider value={ORG}>{node}</CurrentOrg.Provider>, el => el)
  return { ...v, unmount: async () => { await v.unmount(); canvas.remove() } }
}

// the shell's chats come first in the document, the canvas's agent mailbox after them (App.tsx, OrgCanvas.tsx)
let setChats: (v: boolean) => void = () => {}
let setAgent: (v: boolean) => void = () => {}
function Windows({ chats: c0, agent: a0 }: { chats: boolean; agent: boolean }) {
  const [chats, sc] = useState(c0); setChats = sc
  const [agent, sa] = useState(a0); setAgent = sa
  return <>
    {chats && <PinFrame kind="inbox" title="Your chats" panel="mail-modal chats-probe" close={() => sc(false)}>chats</PinFrame>}
    {agent && <PinFrame kind="node-inbox:worker" title="worker · inbox" panel="mail-modal agent-probe" close={() => sa(false)}>worker</PinFrame>}
  </>
}
const overlayOf = (cls: string) => (document.querySelector(`.${cls}`)?.closest('.overlay') ?? null) as HTMLElement | null
const zOf = (o: HTMLElement) => o.classList.contains('overlay-pinned') ? PIN_LAYER_Z : Number(o.style.zIndex || 30)
/** whether `a` is drawn over `b`, as the browser stacks two fixed overlays */
const over = (a: HTMLElement, b: HTMLElement) => zOf(a) !== zOf(b) ? zOf(a) > zOf(b)
  : !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)

test('View in chat from a centred agent mailbox: the chats open in front of it, and it stays open', async (t) => {
  reset(); t.after(reset)
  const v = await mount(<Windows chats={false} agent={true} />); t.after(() => v.unmount())
  assert.ok(overlayOf('agent-probe'), 'POSITIVE CONTROL: the agent mailbox is open, centred')
  // what the shell does for a mail-view request (App.tsx onMailViewRequest)
  await inAct(async () => { setChats(true); raisePinnedModal('inbox', ORG); await flush(4) })
  const chats = overlayOf('chats-probe')!, agent = overlayOf('agent-probe')!
  assert.ok(chats && agent, 'both windows are open: the jump closes nothing')
  assert.ok(over(chats, agent), `the chats are in front (chats z ${zOf(chats)}, agent z ${zOf(agent)})`)
})

test('View in chat while the chats are already open behind the agent mailbox: they come to the front', async (t) => {
  reset(); t.after(reset)
  const v = await mount(<Windows chats={true} agent={false} />); t.after(() => v.unmount())
  // View in @worker's inbox from the chats: the agent mailbox opens over them
  await inAct(async () => { setAgent(true); raisePinnedModal('node-inbox:worker', ORG); await flush(4) })
  assert.ok(over(overlayOf('agent-probe')!, overlayOf('chats-probe')!), 'View in @agent\'s inbox: the agent mailbox is in front')
  // then View in chat from it
  await inAct(async () => { raisePinnedModal('inbox', ORG); await flush(4) })
  const chats = overlayOf('chats-probe')!, agent = overlayOf('agent-probe')!
  assert.ok(chats && agent, 'both stay open')
  assert.ok(over(chats, agent), `the chats are in front again (chats z ${zOf(chats)}, agent z ${zOf(agent)})`)
  // and back: View in @worker's inbox from the chats
  await inAct(async () => { raisePinnedModal('node-inbox:worker', ORG); await flush(4) })
  assert.ok(over(overlayOf('agent-probe')!, overlayOf('chats-probe')!), 'the agent mailbox comes in front again')
})

test('Escape closes the window in front, not the one behind it', async (t) => {
  reset(); t.after(reset)
  const v = await mount(<Windows chats={true} agent={true} />); t.after(() => v.unmount())
  await inAct(async () => { raisePinnedModal('inbox', ORG); await flush(4) })
  assert.ok(over(overlayOf('chats-probe')!, overlayOf('agent-probe')!), 'POSITIVE CONTROL: the chats are in front')
  await inAct(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush(4) })
  assert.equal(overlayOf('chats-probe'), null, 'Escape closed the chats')
  const agent = overlayOf('agent-probe')
  assert.ok(agent, 'the agent mailbox behind is still open')
  assert.equal(zOf(agent!), 30, 'and back at the ordinary centred level once nothing is in front of it')
})

test('a jump to a PINNED window: the centred window it came from steps below the pin layer', async (t) => {
  reset(); t.after(reset)
  pinModal('inbox', { x: 40, y: 40, w: 500, h: 400 }, ORG)
  const v = await mount(<Windows chats={true} agent={true} />); t.after(() => v.unmount())
  const chats = overlayOf('chats-probe')!
  assert.ok(chats?.classList.contains('overlay-pinned'), 'POSITIVE CONTROL: the chats are pinned')
  await inAct(async () => { raisePinnedModal('inbox', ORG); await flush(4) })
  const agent = overlayOf('agent-probe')!
  assert.ok(agent, 'the centred agent mailbox stays open')
  assert.ok(zOf(agent) < PIN_LAYER_Z, `it sits under the pinned chats (agent z ${zOf(agent)}, pin layer ${PIN_LAYER_Z})`)
})

test('without a jump, two centred windows keep the ordinary level (no inline z-index)', async (t) => {
  reset(); t.after(reset)
  const v = await mount(<Windows chats={true} agent={false} />); t.after(() => v.unmount())
  assert.equal(overlayOf('chats-probe')!.style.zIndex, '', 'a lone centred window has no inline z-index')
})
