import './harness'
import { FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestStream, refreshConvo, loadOlder, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'

const SL = 'org'
const ND = 'starve'
const LATENCY = 900     // one getChat round trip
const CADENCE = 300     // one websocket event every 300 ms  (< LATENCY)

test('slow transcript fetches keep installing during continuous streaming', { timeout: 8_000 }, async (t) => {
  useFakeClock()
  const s = new FakeServer()
  s.latency = LATENCY
  installFetch(s)
  s.assistantMsg('turn 1')

  let snap: Convo | null = null
  let installs = 0, lastChat: unknown = undefined
  function Probe() { snap = useConvo(SL, ND)
    if (snap.chat !== lastChat) { lastChat = snap.chat; if (snap.chat) installs++ }
    return null }
  const v = await mountView(<Probe />, (h) => h)
  t.after(async () => { await v.unmount(); resetConvos(); realClock() })

  // ── settle the initial load, so we are measuring a FREEZE, not a cold start
  await advance(6_000)   // beat's first tick is BUSY_POLL_MS (2.5s), then one round trip
  const n0 = snap!.chat?.messages.length ?? 0
  console.log('BASELINE loaded:', snap!.loaded, 'messages:', n0,
              'chat requests:', s.requests.length)
  assert.ok(snap!.loaded && n0 > 0, 'positive control: the initial payload installed')

  // ── the server now has MORE to say than the desk is showing
  s.assistantMsg('turn 2 — the row the user never saw')
  s.assistantMsg('turn 3 — nor this one')
  const target = n0 + 2
  const reqAtStormStart = s.requests.length
  const installsAtStart = installs

  // ── the storm: a durable row lands every CADENCE ms, as during a busy turn
  const STORM_MS = 20_000
  for (let t0 = 0; t0 < STORM_MS; t0 += CADENCE) {
    await inAct(() => { ingestStream(SL, { node: ND, kind: 'text', text: 'row', t: Date.now() } as never) })
    await advance(CADENCE)
  }
  const during = snap!.chat?.messages.length ?? 0
  console.log('STORM WALL-CLOCK ms:', STORM_MS, '| installs during storm:', installs - installsAtStart)
  console.log('DURING STORM messages:', during, 'want', target,
              '| chat requests issued during storm:', s.requests.length - reqAtStormStart,
              '| loaded:', snap!.loaded)

  // ── CONTROL: same fixture, same server, same latency — just stop the events
  await advance(6_000)
  const after = snap!.chat?.messages.length ?? 0
  console.log('AFTER STORM messages:', after, 'want', target)

  console.log('VERDICT starved =', during < target && after === target)
  assert.equal(during, target, 'the view must catch up while events continue')
  assert.ok(installs > installsAtStart, 'payloads install during the storm')
  assert.equal(after, target, 'control: the same server still loads after the storm')
})

test('an older response landing last must not overwrite the newer one', { timeout: 8_000 }, async (t) => {
  useFakeClock()
  const s = new FakeServer()
  const f = installFetch(s)
  s.assistantMsg('row 1')

  let snap: Convo | null = null
  function Probe() { snap = useConvo(SL, 'order'); return null }
  const v = await mountView(<Probe />, (h) => h)
  t.after(async () => { await v.unmount(); resetConvos(); realClock() })

  await advance(6_000)
  assert.equal(snap!.chat?.messages.length, 1, 'positive control: the baseline installed')

  f.holdAll = true
  // request A — issued now, so its body is the ONE-row snapshot
  await inAct(() => { void refreshConvo(SL, 'order', { force: true }) })
  await flush()
  // the server grows, then request B is issued with the THREE-row snapshot
  s.assistantMsg('row 2'); s.assistantMsg('row 3')
  await inAct(() => { void refreshConvo(SL, 'order', { force: true }) })
  await flush()
  console.log('held responses:', f.held.length, '(want 2: A then B)')

  // release B (newer) first …
  await inAct(() => { f.releaseLast() })
  await flush(10)
  const afterNewer = snap!.chat?.messages.length ?? 0
  console.log('after releasing the NEWER response:', afterNewer)

  // … then A (older). This is the moment the guard exists for.
  await inAct(() => { f.release() })
  await flush(10)
  const afterOlder = snap!.chat?.messages.length ?? 0
  console.log('after the OLDER response lands last:', afterOlder)

  assert.equal(afterNewer, 3, 'the newer response installed')
  assert.equal(afterOlder, 3,
    `the older response overwrote the newer one — transcript went ${afterNewer} → ${afterOlder}`)
})

for (const newerFirst of [false, true]) {
  test(`paging responses obey installed freshness, newer first=${newerFirst}`, { timeout: 8_000 }, async (t) => {
    useFakeClock()
    const server = new FakeServer()
    server.cursorPages = true
    for (let i = 0; i < 16; i++) server.assistantMsg(`initial ${i}`)
    const transport = installFetch(server)
    let snap: Convo | null = null
    function Probe() { snap = useConvo(SL, 'paging'); return null }
    const view = await mountView(<Probe />, h => h)
    t.after(async () => { await view.unmount(); resetConvos(); realClock() })
    await advance(6_000)
    await inAct(() => { assert.equal(loadOlder(SL, 'paging', 8), true) })
    await flush(10)
    assert.equal(snap!.paged, true)
    assert.equal(snap!.chat!.messages.length, 16, 'control: earlier history loaded')
    for (let i = 0; i < 9; i++) server.assistantMsg(`burst ${i}`)
    transport.holdAll = true
    await inAct(() => { void refreshConvo(SL, 'paging', { force: true }) })
    await flush(10)
    await inAct(() => { transport.release(1) }) // A tail resolves, its page waits
    await flush(10)
    assert.equal(transport.held.length, 1, 'A has a real pagination await')
    await advance(50)
    server.assistantMsg('newest')
    await inAct(() => { void refreshConvo(SL, 'paging', { force: true }) })
    await flush(10)
    await inAct(() => { transport.releaseLast() }) // B tail resolves, its page waits
    await flush(10)
    assert.equal(transport.held.length, 2, 'both responses await pages')
    await inAct(() => { if (newerFirst) transport.releaseLast(); else transport.release(1) })
    await flush(10)
    assert.equal(snap!.chat!.messages.length, newerFirst ? 26 : 25,
      'an in-flight newer response cannot suppress an older complete update')
    await inAct(() => { transport.release() })
    await flush(10)
    assert.equal(snap!.chat!.messages.length, 26, 'late older pages cannot undo a newer install')
  })
}
