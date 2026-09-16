// panelcorner.test.tsx — the agent desk tab's pin / pop-out / modal corner
// (user request 2026-09-16, extended the same day to the docket and inbox tabs).
//
// THE NATIVE PROBE OWNS THE LOOK; THIS FILE OWNS THE WIRING. What a real window
// proves — the split, the buttons being in the corner, a pinned window actually
// appearing — is in tests/panelcorner-native.probe.ts, because jsdom has no
// layout and no windows. What is asserted HERE is the part that is pure
// plumbing and that a refactor could silently break without moving a pixel:
//
//   §1 a corner with no shell routes renders NOTHING (a dead button is worse
//      than an absent one)
//   §2 three buttons, in the stated order, naming this tab's own surface
//   §3 the modal button takes the SHELL'S OWN opener — the same callback the
//      agent's right-click entry is given — with this tab's kind and agent
//   §4 pin opens the surface first (it cannot measure a panel that is not
//      there) and leaves a pin request the mounting surface claims
//   §5 pin on an ALREADY-PINNED surface releases it, and leaves no request
//   §6 pop-out does the same as §4 for its own action
//   §7 a request is claimed ONCE, and only by the surface it names
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs panelcorner

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claimSurfaceRequests, forgetModalPins, forgetSurfaceRequests, isModalPinned,
  pinModal, requestSurfaceAction,
} from '../src/canvas/modalpin'
import { AgentSurfaceRoutesProvider, PanelCorner } from '../src/canvas/panelcorner'
import type { AgentPanelKind } from '../src/canvas/panelcorner'

const SLUG = 'demo'
const NID = 'desk-panels'

interface Calls { open: [AgentPanelKind, string][]; show: [AgentPanelKind, string][] }

async function corner(kind: AgentPanelKind) {
  // ⚠ INSIDE act. `mountView` leaves each test's tree mounted, and
  // `forgetModalPins` notifies the pin store — so resetting outside act makes
  // the PREVIOUS test's buttons re-render unwrapped, which React reports as a
  // warning against this file for a state change that is the harness's.
  await inAct(async () => {
    localStorage.clear(); forgetModalPins(); forgetSurfaceRequests()
  })
  const calls: Calls = { open: [], show: [] }
  const routes = {
    open: (k: AgentPanelKind, id: string) => { calls.open.push([k, id]) },
    show: (k: AgentPanelKind, id: string) => { calls.show.push([k, id]) },
  }
  const view = await mountView(
    <AgentSurfaceRoutesProvider value={routes}>
      <PanelCorner kind={kind} slug={SLUG} nid={NID} />
    </AgentSurfaceRoutesProvider>,
    (el) => [...el.querySelectorAll('button')] as HTMLButtonElement[])
  const press = async (i: number) => {
    await inAct(async () => { view.last()[i]!.click() })
    await flush()
  }
  return { calls, view, press }
}

test('§1 no shell routes, no buttons — the corner never draws a control it cannot honour', async () => {
  await inAct(async () => { forgetModalPins(); forgetSurfaceRequests() })
  const view = await mountView(
    <PanelCorner kind="agent-gallery" slug={SLUG} nid={NID} />,
    (el) => el.innerHTML)
  assert.equal(view.last(), '',
    'outside the shell (a component test, a surface mounted elsewhere) it renders nothing')
})

test('§2 three buttons together, in order, naming this tab\'s own surface', async () => {
  for (const [kind, noun] of [
    ['agent-gallery', 'presented documents'],
    ['agent-docket', 'docket'],
    ['node-inbox', 'inbox'],
  ] as const) {
    const { view } = await corner(kind)
    const labels = view.last().map((b) => b.getAttribute('aria-label') ?? '')
    assert.equal(labels.length, 3, `${kind}: all three are present together`)
    assert.match(labels[0]!, /^pin /, `${kind}: pin first, got ${labels[0]}`)
    assert.match(labels[1]!, /in a new window$/, `${kind}: pop-out second, got ${labels[1]}`)
    assert.match(labels[2]!, /as a standalone modal$/, `${kind}: modal third, got ${labels[2]}`)
    for (const label of labels) {
      assert.ok(label.includes(noun), `${kind}: "${label}" names its own surface (${noun})`)
      assert.ok(label.includes(NID), `${kind}: "${label}" names its own agent`)
    }
  }
})

test('§3 the modal button is the shell\'s own opener — the right-click entry\'s route', async () => {
  for (const kind of ['agent-gallery', 'agent-docket', 'node-inbox'] as const) {
    const { calls, press } = await corner(kind)
    await press(2)
    assert.deepEqual(calls.open, [[kind, NID]],
      `${kind}: the modal button ran open(kind, agent) and nothing else`)
    assert.deepEqual(calls.show, [], `${kind}: and did NOT take the pin/popout route`)
    // ⚠ `open`, NOT `show`: the ticket asks for "the same result the user gets
    // by right-clicking the agent", and that entry's toggle-off rule is part of
    // the result. Swapping this for `show` would quietly make the button
    // un-toggleable where the menu entry is not.
  }
})

test('§4 pin opens the surface, then asks THAT surface to pin itself', async () => {
  const { calls, press } = await corner('agent-gallery')
  await press(0)
  assert.deepEqual(calls.show, [['agent-gallery', NID]],
    'it took the non-toggling route — a pin must not close what it is about to measure')
  assert.deepEqual(calls.open, [], 'and not the toggling one')
  // the surface mounts a moment later and claims what was left for it
  const got: string[] = []
  claimSurfaceRequests('agent-gallery', SLUG, (r) => got.push(r))
  await flush()
  assert.deepEqual(got, ['pin'],
    'the request waited for the surface and was delivered on mount')
})

test('§5 pin on an already-pinned surface releases it, and leaves no request behind', async () => {
  const { calls, press, view } = await corner('agent-docket')
  // inside act: the pin store notifies through useSyncExternalStore, so this
  // re-renders the mounted button
  await inAct(async () => { pinModal('agent-docket', { x: 10, y: 10, w: 600, h: 400 }, SLUG) })
  await flush()
  assert.equal(isModalPinned('agent-docket', SLUG), true, 'pinned to begin with')
  assert.equal(view.last()[0]!.getAttribute('aria-pressed'), 'true',
    'and the button says so, read live from the pin store')

  await press(0)
  assert.equal(isModalPinned('agent-docket', SLUG), false, 'the press released the pin')
  assert.deepEqual(calls.show, [],
    'releasing needs no panel to measure, so it opened nothing')
  // ⚠ AND NOTHING IS LEFT QUEUED. A stale 'pin' sitting in the channel would
  // fire the next time this surface mounted for any other reason and re-pin a
  // window the user had just unpinned.
  const got: string[] = []
  claimSurfaceRequests('agent-docket', SLUG, (r) => got.push(r))
  await flush()
  assert.deepEqual(got, [], 'no request was queued by an unpin')
})

test('§6 pop-out opens the surface, then asks THAT surface to open its window', async () => {
  const { calls, press } = await corner('node-inbox')
  await press(1)
  assert.deepEqual(calls.show, [['node-inbox', NID]], 'the non-toggling route again')
  const got: string[] = []
  claimSurfaceRequests('node-inbox', SLUG, (r) => got.push(r))
  await flush()
  assert.deepEqual(got, ['popout'], 'and the pop-out request was waiting for it')
})

test('§7 a request is claimed once, and only by the surface it names', async () => {
  await inAct(async () => { forgetModalPins(); forgetSurfaceRequests() })
  requestSurfaceAction('agent-docket', SLUG, 'pin')

  // the WRONG surface must not take it — three tabs share this channel, and a
  // docket pin swallowed by the gallery is the bug this keying exists to stop
  const wrongKind: string[] = []
  claimSurfaceRequests('agent-gallery', SLUG, (r) => wrongKind.push(r))
  const wrongOrg: string[] = []
  claimSurfaceRequests('agent-docket', 'other-org', (r) => wrongOrg.push(r))
  await flush()
  assert.deepEqual(wrongKind, [], 'another tab\'s surface did not claim it')
  assert.deepEqual(wrongOrg, [], 'another organization\'s surface did not either')

  const right: string[] = []
  const release = claimSurfaceRequests('agent-docket', SLUG, (r) => right.push(r))
  await flush()
  assert.deepEqual(right, ['pin'], 'the surface it named did')

  // …and a remount does not replay it
  release()
  const again: string[] = []
  claimSurfaceRequests('agent-docket', SLUG, (r) => again.push(r))
  await flush()
  assert.deepEqual(again, [], 'the request was consumed, not left in the channel')

  // a request made while the surface is ALREADY mounted runs at once, with no
  // wait — that is the already-open case, and it must not need a remount
  const live: string[] = []
  claimSurfaceRequests('node-inbox', SLUG, (r) => live.push(r))
  requestSurfaceAction('node-inbox', SLUG, 'popout')
  assert.deepEqual(live, ['popout'], 'delivered synchronously to a mounted surface')
})
