// The turn-limit banner and setting (user ruling 2026-09-26).
//
// When more agents want to run than the machine-wide concurrent-turn limit
// allows, a selected QUEUED agent says why it is not running and points at
// the setting; the setting itself is a live number field, default 16.

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat, TurnSlotQueuedBanner } from '../src/canvas/desk'
import { TurnLimitSetting } from '../src/canvas/accounts'
import { OPEN_APP_SETTINGS_EVENT } from '../src/canvas/settingskit'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, RuntimeSettingsPayload } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const queued = { since: 1790420000, limit: 16, waiting: 3 }

function node(id: string, props: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, title: id, state: 'live', tier: 'haiku', model_id: 'haiku',
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false,
    mail_pending: 0, last_status: null, prev_status: null, inflight_at: null,
    last_denials: [], occupancy: null, context_window: null, busy: true,
    proc_warm: false, proc_live: false, isBearerOf: null,
    generation: 0,
    ...props,
  } as unknown as CanvasNode
}

test('§1 the banner shows only for a live queued agent, names the limit and opens Settings', async () => {
  const view = await mountView(<TurnSlotQueuedBanner queued={null} live />, (el) => el)
  const banner = () => view.el.querySelector('.slot-queued-warning')
  const asked: unknown[] = []
  const listen = (e: Event) => asked.push((e as CustomEvent).detail)
  window.addEventListener(OPEN_APP_SETTINGS_EVENT, listen)
  try {
    assert.equal(banner(), null, 'not queued → no banner')
    await view.render(<TurnSlotQueuedBanner queued={queued} live />)
    assert.ok(banner(), 'queued → banner')
    const text = banner()!.textContent!
    assert.match(text, /agent concurrency limit \(16\) is reached/)
    assert.match(text, /change it in Settings/)
    assert.match(text, /2 others were waiting/)
    await inAct(() => {
      banner()!.querySelector<HTMLButtonElement>('button.slot-queued-open')!.click()
    })
    assert.deepEqual(asked, [{ tab: 'runtime', focus: 'max_concurrent_turns' }],
      'the button asks the shell to open Settings at Runtime')
    await view.render(<TurnSlotQueuedBanner queued={queued} live={false} />)
    assert.equal(banner(), null, 'a retired desk never wears it')
  } finally {
    window.removeEventListener(OPEN_APP_SETTINGS_EVENT, listen)
    await view.unmount()
  }
})

test('§2 the desk shows the banner for a queued node and not for a running one', async () => {
  installFetch(new FakeServer())
  const waiting = node('worker', { waiting: true, queued_for_slot: queued })
  const view = await mountView(
    <DeskChat node={waiting} map={new Map([[waiting.id, waiting]])} slug="busy-org"
      op={op} toast={noop} pub={false} bare />, (el) => el)
  try {
    await flush()
    assert.ok(view.el.querySelector('.slot-queued-warning'), 'queued desk shows it')
    const running = node('worker', { waiting: false, queued_for_slot: null })
    await view.render(
      <DeskChat node={running} map={new Map([[running.id, running]])} slug="busy-org"
        op={op} toast={noop} pub={false} bare />)
    await flush()
    assert.equal(view.el.querySelector('.slot-queued-warning'), null,
      'admitted → the banner is gone')
  } finally { await view.unmount() }
})

test('§3 the setting shows the live limit and saves a valid new one', async () => {
  const runtime = {
    max_concurrent_turns: 16,
    turn_slots: { limit: 16, held: 16, waiting: 4, waiting_by_org: { a: 4 } },
  } as unknown as RuntimeSettingsPayload
  const saved: number[] = []
  const view = await mountView(
    <TurnLimitSetting runtime={runtime} busy={false} onSave={n => saved.push(n)} />,
    (el) => el)
  const input = () => view.el.querySelector<HTMLInputElement>(
    'input[aria-label="most agent turns running at once"]')!
  const type = async (value: string) => inAct(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    set.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  const enter = async () => inAct(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  try {
    assert.equal(input().value, '16')
    assert.match(view.el.textContent!, /16 running, 4 waiting/)
    await type('0'); await enter()
    await type('600'); await enter()
    assert.deepEqual(saved, [], 'out of range is never sent')
    await type('40'); await enter()
    assert.deepEqual(saved, [40])
    await view.render(<TurnLimitSetting runtime={{} as RuntimeSettingsPayload}
      busy={false} onSave={noop} />)
    assert.equal(view.el.querySelector('input'), null,
      'an older engine without the setting shows no field')
  } finally { await view.unmount() }
})
