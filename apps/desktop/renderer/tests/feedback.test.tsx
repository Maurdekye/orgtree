import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { AccountsPanel } from '../src/canvas/accounts'
import { feedbackService } from './feedback-fixture'

const label = 'Suggest agents to give feedback to Orgtree'
const find = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.set-row')]
  .find(row => row.querySelector('.set-label')?.textContent === label)!
async function mount() {
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="runtime" />, el => el)
  await inAct(async () => { await flush(20) })
  return view
}
test('feedback defaults on, is last in Runtime, saves off and stays off when reopened', async () => {
  const service = feedbackService()
  let view = await mount()
  try {
    const panel = view.el.querySelector('#app-settings-panel-runtime') ?? view.el.querySelector('[role="tabpanel"]:not([hidden])')!
    const row = find(view.el)
    assert.ok(row, 'feedback control rendered')
    const control = row.querySelector<HTMLInputElement>('[role="switch"]')!
    assert.equal(control.checked, true)
    assert.equal([...panel.querySelectorAll('.set-row')].at(-1) === row, true)
    assert.match(row.textContent ?? '', /connected GitHub account.*github.com\/Maurdekye\/orgtree.*under that account/)
    assert.match(row.textContent ?? '', /redacted draft.*wait for your OK/)
    await inAct(async () => { control.click(); await flush(20) })
    assert.deepEqual(service.writes, [{ suggest_agent_feedback_enabled: false }])
    assert.equal(control.checked, false)
    await view.unmount()
    view = await mount()
    assert.equal(find(view.el).querySelector<HTMLInputElement>('[role="switch"]')?.checked, false)
  } finally { await view.unmount() }
})
test('feedback save failures keep the confirmed value and display the error', async () => {
  const service = feedbackService(false)
  service.refuse(true)
  const view = await mount()
  try {
    const control = find(view.el).querySelector<HTMLInputElement>('[role="switch"]')!
    await inAct(async () => { control.click(); await flush(20) })
    assert.equal(control.checked, false)
    assert.match(view.el.textContent ?? '', /Synthetic save refused/)
  } finally { await view.unmount() }
})
