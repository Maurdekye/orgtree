import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { ProjectDraftNode, projectDraftSteps } from '../src/canvas/newproject'

test('project draft gear stages each policy change immediately and submits it with creation', async t => {
  const calls: unknown[][] = []
  let cancelled = 0
  const view = await mountView(<ProjectDraftNode pos={{ x: 0, y: 0 }}
    onConfirm={(...args) => calls.push(args)} onCancel={() => { cancelled++ }} />, el => el)
  t.after(() => view.unmount())
  const gear = view.el.querySelector<HTMLButtonElement>('.df-gear')
  assert.equal(!!gear, true, 'project draft has the same gear entry as an agent draft')
  const input = (selector: string, value: string) => {
    const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }
  await inAct(() => input('.df-name', 'website'))
  await inAct(() => gear!.click())
  const dialog = () => document.querySelector<HTMLElement>('[aria-label="Draft project settings"]')!
  assert.equal(!!dialog(), true)
  await inAct(() => input('[aria-label="Concurrency slots"]', '4'))
  await inAct(() => input('[aria-label="Mail queue"]', 'ack'))
  const toggle = (label: string) => [...dialog().querySelectorAll<HTMLInputElement>('input[role="switch"]')]
    .find(el => el.getAttribute('aria-label') === label || el.closest('.set-row')?.textContent?.includes(label))!
  // Use accessible switch names, as in the live project settings.
  await inAct(() => toggle('Subordinates may message each other').click())
  const button = (text: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
  assert.equal(button('save'), undefined, 'draft settings have no Save step')
  assert.ok(dialog(), 'editing keeps the menu open')
  await inAct(() => button('Close').click())
  assert.equal(dialog() == null, true)
  assert.equal(calls.length, 0, 'saving draft settings never creates a project')
  await inAct(() => gear!.click())
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Concurrency slots"]')!.value, '4')
  await inAct(() => input('[aria-label="Concurrency slots"]', '8'))
  await inAct(() => button('Close').click())
  await inAct(() => gear!.click())
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Concurrency slots"]')!.value, '8')
  await inAct(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(cancelled, 0, 'Escape closes settings without discarding the draft')
  await inAct(() => view.el.querySelector<HTMLButtonElement>('.df-foot .primary')!.click())
  assert.equal(calls.length, 1)
  assert.equal(calls[0]![0], 'website')
  assert.equal(calls[0]![2] != null, true)
  const settings = calls[0]![2] as Record<string, unknown>
  assert.equal(settings.slots, 8)
  assert.equal(settings.mail_queue, 'ack')
  assert.equal(settings.peer_mail, false)
  assert.deepEqual(projectDraftSteps({ parent: 'user', tier: 'project', project: true }, 'website', '', settings as never),
    [{ op: 'create_project', name: 'website', parent: 'user', settings }])
})
