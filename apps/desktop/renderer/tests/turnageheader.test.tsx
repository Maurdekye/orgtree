import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { LastTurnAge, TurnStatusBanner } from '../src/canvas/desk'
import type { TurnStat } from '../src/types'

declare const __SRC_DIR__: string

const turn = (at: string, killed = false): TurnStat => ({
  at, killed, cost: 0, denials: 0,
})

test('canvas age surfaces share the authoritative completed-turn badge', async () => {
  const stamp = turn(new Date(Date.now() - 120_000).toISOString(), true)
  const view = await mountView(<>
    <div data-surface="card"><LastTurnAge turn={stamp} /></div>
    <div data-surface="map"><LastTurnAge turn={stamp} /></div>
    <div data-surface="busy"><LastTurnAge turn={stamp} busy /></div>
    <div data-surface="never"><LastTurnAge /></div>
  </>, (el) => el)
  try {
    const card = view.el.querySelector<HTMLElement>('[data-surface="card"] .turnago')!
    const map = view.el.querySelector<HTMLElement>('[data-surface="map"] .turnago')!
    assert.equal(card.textContent, map.textContent)
    assert.equal(card.title, map.title)
    assert.match(card.title, /^last turn ended .* \(killed\)$/)
    assert.equal(view.el.querySelector('[data-surface="busy"] .turnago'), null)
    assert.equal(view.el.querySelector('[data-surface="never"] .turnago'), null)
  } finally { await view.unmount() }
})

test('fresh desk banner is neutral motionless Idle with no invented age', async () => {
  const view = await mountView(<TurnStatusBanner state="idle" />, (el) => el)
  try {
    const banner = view.el.querySelector('.turn-status-banner')!
    assert.equal(banner.textContent, 'Idle—')
    assert.ok(banner.classList.contains('idle'))
    assert.equal(banner.querySelector('svg,.cc-spin'), null)
    assert.match(banner.getAttribute('aria-label') ?? '', /no completed turn yet/)
  } finally { await view.unmount() }
})

test('Idle age and Active duration advance without a tree refetch', async () => {
  const stamp = turn(new Date(Date.now() - 10_000).toISOString())
  const inflight = new Date(Date.now() - 20_000).toISOString()
  const view = await mountView(<>
    <TurnStatusBanner state="idle" turn={stamp} />
    <TurnStatusBanner state="working" inflightAt={inflight} />
  </>, (el) => el)
  try {
    const before = [...view.el.querySelectorAll('.turn-status-time')]
      .map((el) => el.textContent)
    const { act } = await import('react')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1150)) })
    const after = [...view.el.querySelectorAll('.turn-status-time')]
      .map((el) => el.textContent)
    assert.notDeepEqual(after, before, 'banner clocks stayed frozen until refetch')
    assert.equal(view.el.querySelector('.turn-status-banner.idle .cc-spin'), null)
    assert.ok(view.el.querySelector('.turn-status-banner.working .cc-spin'))
  } finally { await view.unmount() }
})

test('one persistent banner switches Active duration to Idle completion age', async () => {
  const completed = turn(new Date(Date.now() - 120_000).toISOString())
  const inflight = new Date(Date.now() - 300_000).toISOString()
  function Probe() {
    const [active, setActive] = useState(true)
    return <><button onClick={() => setActive(false)}>finish</button>
      <TurnStatusBanner state={active ? 'working' : 'idle'}
        turn={completed} inflightAt={inflight} tasks={2} /></>
  }
  const view = await mountView(<Probe />, (el) => el)
  try {
    const banner = view.el.querySelector<HTMLElement>('.turn-status-banner')!
    assert.match(banner.textContent, /Active5m/)
    assert.ok(banner.querySelector('.cc-spin'))
    const { act } = await import('react')
    await act(async () => { view.el.querySelector<HTMLButtonElement>('button')!.click() })
    assert.equal(view.el.querySelector('.turn-status-banner'), banner,
      'status/age seat was replaced rather than changed in place')
    assert.match(banner.textContent, /Idle2m/)
    assert.equal(banner.querySelector('.cc-spin'), null)
    assert.ok(banner.classList.contains('idle'))
  } finally { await view.unmount() }
})

test('the persistent banner names queued and compacting without a work spinner', async () => {
  const inflight = new Date(Date.now() - 300_000).toISOString()
  const view = await mountView(<>
    <TurnStatusBanner state="queued" inflightAt={inflight} />
    <TurnStatusBanner state="compacting" inflightAt={inflight} />
  </>, (el) => el)
  try {
    const rows = [...view.el.querySelectorAll('.turn-status-banner')]
    assert.match(rows[0]!.textContent ?? '', /Queued5m/)
    assert.match(rows[1]!.textContent ?? '', /Compacting5m/)
    assert.equal(view.el.querySelectorAll('.cc-spin').length, 0)
  } finally { await view.unmount() }
})

test('the shared live clock releases its interval after the final banner unmounts', async () => {
  const nativeSet = globalThis.setInterval
  const nativeClear = globalThis.clearInterval
  const started: unknown[] = []
  const cleared: unknown[] = []
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const handle = nativeSet(fn, ms, ...args)
    started.push(handle)
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    cleared.push(handle)
    return nativeClear(handle)
  }) as typeof clearInterval
  try {
    const view = await mountView(<TurnStatusBanner state="idle" />, (el) => el)
    await view.unmount()
    assert.ok(started.length > 0, 'banner did not subscribe to the live clock')
    assert.ok(started.some((handle) => cleared.includes(handle)),
      'last banner unmount left its live timer running')
  } finally {
    globalThis.setInterval = nativeSet
    globalThis.clearInterval = nativeClear
  }
})

test('cards retain LastTurnAge while focused desks use only the status banner', () => {
  const cards = readFileSync(path.join(__SRC_DIR__, 'canvas', 'cards.tsx'), 'utf8')
  const desk = readFileSync(path.join(__SRC_DIR__, 'canvas', 'desk.tsx'), 'utf8')
  assert.ok((cards.match(/<LastTurnAge/g) ?? []).length >= 2,
    'zoomed-out card/map stopped using the shared age badge')
  assert.match(desk, /<TurnStatusBanner state=\{turnBannerState\} turn=\{lastTurn\}/,
    'focused desk stopped using its persistent status banner')
  assert.doesNotMatch(desk, /<LastTurnAge turn=\{lastTurn\}/,
    'focused desk reintroduced a separate last-turn-age chip')
  assert.doesNotMatch(cards, /ago\(lastTurn\.at\)/,
    'card reintroduced a second formatter/update path')
})
