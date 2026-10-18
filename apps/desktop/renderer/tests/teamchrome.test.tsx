import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { TeamChromeFixture, CHROME_ORG } from './teamchrome-fixture'
import { forgetModalPins, forgetModalOpenCache, pinModal } from '../src/canvas/modalpin'
import { resetConvos } from '../src/convo'

async function panels(t: TestContext, pinned = true) {
  const oldFetch = globalThis.fetch
  installFetch(new FakeServer()); localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); resetConvos()
  if (pinned) {
    pinModal('agent-list', { x: 20, y: 30, w: 420, h: 560 }, CHROME_ORG)
    pinModal('agent-team', { x: 460, y: 30, w: 420, h: 560 }, CHROME_ORG)
  }
  let closed = 0
  const view = await mountView(<TeamChromeFixture onClose={() => closed++} />, el => el)
  t.after(async () => { await view.unmount(); resetConvos(); globalThis.fetch = oldFetch
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache() })
  if (pinned) await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.tray-toggle')!.click(); await flush(2) })
  const team = () => document.querySelector<HTMLElement>('.team-panel')!
  const agents = () => document.querySelector<HTMLElement>('.tray-panel:not(.team-panel)')!
  return { team, agents, closed: () => closed }
}

test('pinned Team uses the canonical Agents frame rather than settings chrome', async t => {
  const p = await panels(t)
  assert.equal(p.agents().classList.contains('tray-panel'), true, 'actual Agents frame is mounted')
  assert.equal(p.team().classList.contains('tray-panel'), true, 'same shared frame classes')
  assert.equal(p.team().classList.contains('settings'), false, 'no settings input/font overrides')
})

test('pinned Team puts its working Active control in the same header as Agents', async t => {
  const p = await panels(t)
  const selector = '.modalpin-bar .modalpin-actions [aria-label="Only active agents"]'
  assert.equal(!!p.agents().querySelector(selector), true)
  const active = p.team().querySelector<HTMLInputElement>(selector)
  assert.equal(!!active, true, 'Team Active is in its frame header')
  await inAct(() => active!.click())
  const rows = [...p.team().querySelectorAll('.tray-row')].map(e => e.getAttribute('data-copy-agent-name'))
  assert.deepEqual(rows, ['build-team', 'layout-author'], 'active filter remains scoped with ancestor context')
  assert.equal(p.agents().querySelector<HTMLInputElement>(selector)!.checked, false, 'global filter remains independent')
})

test('pinned Team has the same flat list child and no bottom modal Close button', async t => {
  const p = await panels(t)
  assert.equal(!!p.agents().querySelector(':scope > .tray'), true)
  assert.equal(!!p.team().querySelector(':scope > .tray'), true, 'shared borderless/padding-free tray rule applies directly')
  assert.equal([...p.team().querySelectorAll('button')].some(e => e.textContent === 'Close'), false)
})

test('modal Team also has no nested list frame/padding or bottom Close button', async t => {
  const p = await panels(t, false)
  assert.equal([...p.team().querySelectorAll('button')].some(e => e.textContent === 'Close'), false)
  assert.equal(p.team().classList.contains('tray-panel'), true)
  assert.equal(!!p.team().querySelector(':scope > .tray'), true)
})

test('modal Team still closes with Escape', async t => {
  const p = await panels(t, false)
  await inAct(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(p.closed(), 1)
  assert.equal(p.team() === null, true)
})

test('modal Team still closes with the existing backdrop', async t => {
  const p = await panels(t, false)
  await inAct(() => p.team().closest<HTMLElement>('.overlay')!.click())
  assert.equal(p.closed(), 1)
  assert.equal(p.team() === null, true)
})

test('filter input and its value survive Team pin/unpin without remounting', async t => {
  const p = await panels(t, false)
  const filter = p.team().querySelector<HTMLInputElement>('.tray-filter')!
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(filter, 'layout')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
  })
  for (let i = 0; i < 2; i++) {
    await inAct(() => p.team().querySelector<HTMLButtonElement>('.modalpin-btn')!.click())
    assert.equal(p.team().querySelector('.tray-filter'), filter, 'same real input DOM')
    assert.equal(filter.value, 'layout')
  }
})
