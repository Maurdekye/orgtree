// The Display setting's row (USER 2026-11-27 m56eddd849c57; wording proposed by @coordinator-opus): a toggle, on by
// default, browser-local like its Desk siblings, saved at once.
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FitAroundPinsSetting, forgetFitAroundPins } from '../src/canvas/fitpins'

const LABEL = 'Fit the view around pinned windows'
test('the row is on by default, saves its choice and says what it does', async (t) => {
  localStorage.clear(); forgetFitAroundPins()
  const v = await mountView(<FitAroundPinsSetting />, el => el)
  t.after(async () => { await v.unmount(); localStorage.clear(); forgetFitAroundPins() })
  const box = v.el.querySelector<HTMLInputElement>(`input[aria-label="${LABEL}"]`)
  assert.ok(box, 'the toggle is labelled')
  assert.equal(box.checked, true, 'on by default: today’s behaviour')
  assert.match(v.el.textContent ?? '', /pinned windows are ignored and the view uses the whole canvas/, 'its description')
  await inAct(() => box.click())
  assert.equal(box.checked, false)
  assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-fit-around-pins') ?? 'null'), { enabled: false }, 'saved at once, browser-local')
})
