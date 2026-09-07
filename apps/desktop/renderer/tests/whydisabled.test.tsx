// wcc848de4 — a disabled control must say WHY it is disabled.
//
// The three sites here were found by `frontend/audit_disabled.py` and then
// confirmed by reading: of 72 disabled controls in the app, most are fine —
// the gate is a transient `busy`, or an empty field the user is looking at,
// or the reason is already printed next to the control. These are the ones
// where a dead button explains nothing.
//
// ⚠ WHAT THIS FILE IS FOR, AND WHY IT MOUNTS REAL COMPONENTS. A pure test of
// `stepDownWhy`/`stepUpWhy` proves the sentences are right and NOTHING about
// whether any button asks for them — delete both `title=` attributes and a
// helper-only file stays green. So every site is mounted from its own real
// component and read out of the DOM, and each check has its live-control
// counterpart: a title that appears on an ENABLED control is its own defect
// (a tooltip explaining a limit the user has not hit), so "absent when
// enabled" is asserted everywhere too.
//
// Run: cd frontend && node tests/run.mjs whydisabled

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepDownWhy, stepUpWhy } from '../src/canvas/asks'
import { DraftNode } from '../src/canvas/cards'
import { FolderPickerHost, pickFolder } from '../src/picker'
import type { DraftState } from '../src/canvas/shared'
import type { FsPayload, TreePayload } from '../src/types'

const noop = () => {}

// ------------------------------------------------------ §1 the two sentences
//
// Pure, so the wording and the boundary can be pinned exactly. The rendering
// checks below are what prove anyone calls them.

test('§1 the floor sentence names the credits that are actually committed',
  () => {
    assert.equal(stepDownWhy(4, 4),
      "4 credits are already committed to this agent's own reports "
      + '— take those back first to offer less')
    // singular reads as English, not as "1 credits are"
    assert.equal(stepDownWhy(1, 1),
      "1 credit is already committed to this agent's own reports "
      + '— take those back first to offer less')
  })

test('§2 with nothing committed the floor is zero, and says so', () => {
  // ⚠ THIS IS THE CASE THE OBVIOUS IMPLEMENTATION GETS WRONG. Interpolating
  // `committed` unconditionally produces "0 credits are already committed",
  // which is both false and useless: the button is dead because a grant
  // cannot be negative, not because anything is held below.
  assert.equal(stepDownWhy(0, 0), 'a grant cannot go below zero')
  assert.ok(!/committed/.test(stepDownWhy(0, 0) ?? ''),
    'the zero floor blamed a commitment that does not exist')
})

test('§3 neither helper speaks while its button is still live', () => {
  assert.equal(stepDownWhy(5, 4), undefined)      // one step of room left
  assert.equal(stepUpWhy(9, 10), undefined)
  // no cap set at all — the ＋ is unbounded and must stay silent
  assert.equal(stepUpWhy(1_000_000, undefined), undefined)
})

test('§4 the ceiling sentence quotes the org setting by its own name', () => {
  assert.equal(stepUpWhy(50, 50),
    "the offer stops at this org's top-level grant cap of 50")
  // at, not merely near: the bound is >=, matching the button's own disabled
  // expression, so a grandfathered over-cap grant is covered too
  assert.equal(stepUpWhy(51, 50),
    "the offer stops at this org's top-level grant cap of 50")
})

// ------------------------------------------------- §5 the draft hire button
//
// DraftNode's hire button is dead until the agent has a name. The name field
// is the very next thing above it, but nothing connects the two — the button
// simply does not respond, with no cursor, no message and no focus move.

const tree = { cascade_hire: true } as unknown as TreePayload

async function draftCard() {
  const state: DraftState = { parent: null, tier: 'haiku' }
  return mountView(
    <DraftNode pos={{ x: 0, y: 0 }} draft={state} map={new Map()}
      seats={{ haiku: 1 }} maxTop={100} defaultTop={0}
      kioskRemaining={null} tree={tree} zoom={1} pxc={1}
      onConfirm={noop} onCancel={noop} />,
    (el) => el,
  )
}

const hireButton = (el: HTMLElement) =>
  [...el.querySelectorAll('.df-foot button')]
    .find((b) => /hire/.test(b.textContent ?? '')) as HTMLButtonElement

test('§5 the unnamed draft says what the hire button is waiting for',
  async () => {
    const view = await draftCard()
    const btn = hireButton(view.el)
    assert.ok(btn, 'no hire button in the draft footer')
    assert.equal(btn.disabled, true, 'a nameless draft was hireable')
    assert.equal(btn.getAttribute('title'), 'give the agent a name first')
  })

test('§5b …and stops saying it the moment the draft has a name', async () => {
  // THE CONTROL. Without this, a `title` hard-coded on the element — no
  // condition at all — passes §5 while permanently tooltipping a live button.
  const view = await draftCard()
  const input = view.el.querySelector('input.df-name')
    ?? view.el.querySelector('input[type="text"]') as HTMLInputElement | null
  assert.ok(input, 'no name field on the draft card')
  await inAct(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'scout')
    ;(input as HTMLInputElement)
      .dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const btn = hireButton(view.el)
  assert.equal(btn.disabled, false, 'a named draft was still not hireable')
  assert.equal(btn.getAttribute('title'), null,
    'the live hire button still explains a limit the user has not hit')
})

// -------------------------------------------------- §6 the folder picker
//
// "select this folder" is dead in TWO states that look identical on screen —
// the path readout beside it is empty in both. One is the drive list (open a
// drive), the other is the first listing still loading (wait). Telling them
// apart is the whole point of the tooltip, so a single generic sentence
// would not be an improvement.

const fs = (path: string, parent: string | null,
  dirs: { name: string; path: string }[] = []): FsPayload =>
  ({ path, parent, dirs })

const fsReply = (payload: FsPayload) => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((r) => { release = () => r() })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => {
      assert.match(String(url), /\/api\/fs\?/)
      return gate.then(() => ({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(payload),
      }))
    }) as unknown as typeof fetch
  return { release: () => release?.() }
}

const selectButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')]
    .find((b) => b.textContent === 'select this folder') as HTMLButtonElement

async function openPicker(payload: FsPayload) {
  const gate = fsReply(payload)
  const view = await mountView(<FolderPickerHost />, (el) => el)
  await inAct(async () => { void pickFolder() })
  return { view, gate }
}

test('§6 while the listing is still in flight it says so, not "open a drive"',
  async () => {
    const { view } = await openPicker(fs('', null))
    // the reply is held: this is the pre-first-listing frame
    const btn = selectButton(view.el)
    assert.ok(btn, 'the picker did not open')
    assert.equal(btn.disabled, true)
    assert.equal(btn.getAttribute('title'), 'still reading the folder list')
  })

test('§6b at the drive list it names the actual obstacle', async () => {
  const { view, gate } = await openPicker(
    fs('', null, [{ name: 'C:', path: 'C:\\' }]))
  await inAct(async () => { gate.release(); await Promise.resolve() })
  const btn = selectButton(view.el)
  assert.equal(btn.disabled, true, 'the drive list offered itself as a folder')
  assert.equal(btn.getAttribute('title'),
    'this is the drive list, not a folder — open a drive to choose a folder '
    + 'inside it')
})

test('§6c inside a real folder the button is live and silent', async () => {
  // THE CONTROL for §6/§6b, and the one that fails a hard-coded title.
  const { view, gate } = await openPicker(fs('C:\\work', 'C:\\'))
  await inAct(async () => { gate.release(); await Promise.resolve() })
  const btn = selectButton(view.el)
  assert.equal(btn.disabled, false, 'a real folder could not be selected')
  assert.equal(btn.getAttribute('title'), null,
    'the live select button carries a tooltip about a state it is not in')
})
