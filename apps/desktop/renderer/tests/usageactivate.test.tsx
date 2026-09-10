// usageactivate.test.tsx — a header button that toggles a PINNED modal must
// bring it to the FRONT (user ruling 2026-09-10 16:36). The trap is the
// already-open-behind sequence: the pinned window sits behind another pinned
// surface, the user clicks the button to bring it up, and a plain toggle
// CLOSES the hidden window — the click looks like it did nothing, and a
// second click is needed before the window appears. modalToggleAction owns
// the three-way rule (open / raise / close) and raisePinnedModal performs
// the raise in both stacking stores; App.tsx's usage buttons route through
// them.
//
// Run:  cd frontend && node tests/run.mjs usageactivate

import { flush, inAct, mountView as rawMountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  forgetModalOpenCache, forgetModalPins, isModalPinned, MODAL_Z_TOP,
  modalToggleAction, PinFrame, raisePinnedModal, toggleOrRaiseModal,
} from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import type { ReactNode } from 'react'

const noop = () => {}
const ORG = 'probe'

async function mountFrame(kind: string) {
  const canvases = [ORG].map((org) => {
    const el = document.createElement('div'); el.dataset.pinOrg = org
    el.style.border = '0px solid transparent'
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight,
      toJSON() {} }) as DOMRect
    document.body.appendChild(el); return el
  })
  const node: ReactNode = (
    <CurrentOrg.Provider value={ORG}>
      <PinFrame kind={kind} title={kind} panel="settings" close={noop}>
        <h3>{kind}</h3>
      </PinFrame>
    </CurrentOrg.Provider>
  )
  const existing = new Set(document.querySelectorAll('.movable-surface'))
  const v = await rawMountView(node, (el) => el)
  await flush()
  // a pinned surface is adopted into a .movable-surface outside the host
  const roots = () => [v.el,
    ...[...document.querySelectorAll<HTMLElement>('.movable-surface')]
      .filter((el) => !existing.has(el))]
  const q = (sel: string) =>
    roots().map((el) => el.querySelector<HTMLElement>(sel)).find(Boolean) ?? null
  const z = () => Number(q('.overlay-pinned')?.style.zIndex ?? NaN)
  const unmount = async () => { await v.unmount(); canvases.forEach((el) => el.remove()) }
  return { q, z, unmount }
}

test('open-behind activation raises the pinned window instead of closing it', async () => {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const usage = await mountFrame('usage')
  const docket = await mountFrame('docket')
  await inAct(async () => {
    (usage.q('button[aria-label="pin this to the window"]') as HTMLElement).click()
    await flush()
  })
  await inAct(async () => {
    (docket.q('button[aria-label="pin this to the window"]') as HTMLElement).click()
    await flush()
  })
  assert.equal(isModalPinned('usage', ORG), true, 'control: usage is pinned')
  assert.equal(isModalPinned('docket', ORG), true, 'control: docket is pinned')
  // control: usage genuinely sits BEHIND the later-pinned docket — without
  // this the 'raise' claims below could pass vacuously
  assert.ok(usage.z() < docket.z(),
    `usage (${usage.z()}) starts behind docket (${docket.z()})`)

  // the decision: open-and-behind is an activation, never a close
  assert.equal(modalToggleAction('usage', true, ORG), 'raise')
  await inAct(async () => { raisePinnedModal('usage', ORG); await flush() })
  assert.ok(usage.z() > docket.z(),
    `after activation usage (${usage.z()}) is above docket (${docket.z()})`)
  // the shared band is preserved: nothing climbed over the HUD layers
  assert.ok(usage.z() <= MODAL_Z_TOP && docket.z() <= MODAL_Z_TOP,
    'both windows stay inside the pinned band, below canvas HUD')

  // on top, the same click means what it always meant: toggle off
  assert.equal(modalToggleAction('usage', true, ORG), 'close')
  // and closed means open, front by fresh registration
  assert.equal(modalToggleAction('usage', false, ORG), 'open')
  // an unpinned surface keeps the buttons' historical answer
  assert.equal(modalToggleAction('gallery', true, ORG), 'open')

  await docket.unmount(); await usage.unmount()
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
})

test('toggleOrRaiseModal is kind-agnostic: every toggle button gets the same rule', async () => {
  // representative pair from the OTHER buttons the ruling covers (docket,
  // presented-gallery, inboxes…) — the helper must behave identically for
  // any kind, not only usage
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const docket = await mountFrame('docket')
  const gallery = await mountFrame('gallery')
  await inAct(async () => {
    (docket.q('button[aria-label="pin this to the window"]') as HTMLElement).click()
    await flush()
  })
  await inAct(async () => {
    (gallery.q('button[aria-label="pin this to the window"]') as HTMLElement).click()
    await flush()
  })
  assert.ok(docket.z() < gallery.z(), 'control: docket starts behind gallery')

  const sets: boolean[] = []
  // open-behind: the click raises and NEVER touches the open state
  await inAct(async () => {
    toggleOrRaiseModal('docket', true, (v) => sets.push(v), ORG)
    await flush()
  })
  assert.deepEqual(sets, [], 'raise leaves the open state untouched')
  assert.ok(docket.z() > gallery.z(), 'the docket window came to the front')
  // on top: the click means close, exactly as before
  toggleOrRaiseModal('docket', true, (v) => sets.push(v), ORG)
  assert.deepEqual(sets, [false], 'on top, the toggle still closes')
  // closed: the click opens
  toggleOrRaiseModal('docket', false, (v) => sets.push(v), ORG)
  assert.deepEqual(sets, [false, true], 'closed, the toggle opens')
  await gallery.unmount(); await docket.unmount()
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
})

test('reopening a closed pinned window mounts it on top of the band', async () => {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const usage = await mountFrame('usage')
  const docket = await mountFrame('docket')
  await inAct(async () => {
    (usage.q('button[aria-label="pin this to the window"]') as HTMLElement).click()
    await flush()
  })
  await inAct(async () => {
    (docket.q('button[aria-label="pin this to the window"]') as HTMLElement).click()
    await flush()
  })
  assert.ok(usage.z() < docket.z(), 'control: usage starts behind')
  // close (unmount) and reopen (remount) — the toggle-ON path for a window
  // that was actually closed: fresh registration lands on top
  await usage.unmount()
  await flush()
  const reopened = await mountFrame('usage')
  await inAct(async () => { await flush() })
  assert.equal(isModalPinned('usage', ORG), true, 'still pinned after reopen')
  assert.ok(reopened.z() > docket.z(),
    `reopened usage (${reopened.z()}) mounts above docket (${docket.z()})`)
  await docket.unmount(); await reopened.unmount()
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
})
