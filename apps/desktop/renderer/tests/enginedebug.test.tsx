// Developer › engine debug view (enginedebug.tsx).
//
// Mounts the real components against a counting fetch stub: the view is OFF
// until its toggle is turned on (and polls nothing while off), renders the
// endpoint's raw numbers with a growing history, keeps at most one request in
// flight, and stops polling when it unmounts. Every check counts the requests
// actually made, so a view that never polled cannot pass.

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useEngineDebug, EngineDebugPanel, EngineDebugToggle, ENGINE_DEBUG_KEY, HISTORY, fmtBytes } from '../src/canvas/enginedebug'
import { WINDOW_ID } from '../src/api'
import type { EngineStats } from '../src/api'

const g = globalThis as unknown as Record<string, unknown>
const STATS = '/api/diagnostics/engine-stats'

function sample(n: number): EngineStats {
  return {
    at: 1_700_000_000 + n, pid: 4242,
    memory: { private_bytes: 2_000_000_000 + n * 10_000_000, rss_bytes: 1_500_000_000 },
    websockets: {
      queue_max: 256, send_timeout_s: 15,
      drops: { overflow: 1, stuck: 0, abort_failed: 0 },
      sockets: [
        { org: 'orgtree', window: WINDOW_ID, public: false, pending: 0, pending_bytes: 0,
          sent: 900, sent_bytes: 400_000, age_s: 120, window_connects: 1, window_drops: 0 },
        { org: 'orgtree', window: 'stuckwin', public: false, pending: 200 + n, pending_bytes: 3_276_800,
          sent: 50, sent_bytes: 20_000, age_s: 30.4, window_connects: 3, window_drops: 2 },
      ],
    },
    work_list: { full_200: 7, not_modified_304: 53, bytes_200: 265_000_000, window_s: 60,
                 cached_bodies: 1, cached_bytes: 37_969_616, cache_idle_s: 60 },
  }
}

/** a fetch stub answering the stats route; `hold` parks answers until released */
function stub(opts: { hold?: boolean } = {}) {
  const s = { calls: 0, held: [] as (() => void)[] }
  g.fetch = (input: string | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path !== STATS) return Promise.reject(new Error(`unexpected ${path}`))
    const n = s.calls++
    const answer = { ok: true, status: 200, headers: new Headers(),
                     json: () => Promise.resolve(sample(n)) }
    if (!opts.hold) return Promise.resolve(answer)
    return new Promise((resolve) => { s.held.push(() => resolve(answer)) })
  }
  return s
}

test('fmtBytes reads as raw sizes', () => {
  assert.equal(fmtBytes(512), '512 B')
  assert.equal(fmtBytes(37_969_616), '36.2 MB')
  assert.equal(fmtBytes(2_000_000_000), '1.86 GB')
  assert.equal(fmtBytes(null), '—')
})

test('the panel renders the endpoint numbers and builds a history', async () => {
  useFakeClock()
  const s = stub()
  const view = await mountView(<EngineDebugPanel />, el => el.textContent ?? '')
  try {
    await inAct(async () => { await flush(10) })
    assert.equal(s.calls, 1, 'the panel never polled')
    const text = view.last()
    assert.match(text, /pid 4242/)
    assert.match(text, /private bytes1\.86 GB/)
    assert.match(text, /rss 1\.40 GB/)
    assert.match(text, /full 200s 7/)
    assert.match(text, /304s 53/)
    assert.match(text, /cached bodies36\.2 MB/)
    assert.match(text, /1 held/)
    assert.match(text, /cap 256\/socket/)
    assert.match(text, /overflow 1/)
    assert.match(text, /200 \/ 256/, 'the stuck window row shows queued / cap')
    assert.match(text, /3\.13 MB/)
    assert.match(text, new RegExp(`${WINDOW_ID} \\(this\\)`), 'this window is not marked')
    // one sample: no line drawn yet
    assert.equal(view.el.querySelectorAll('polyline').length, 0)

    await advance(1000)
    assert.equal(s.calls, 2, 'no second poll after 1 s')
    assert.ok(view.el.querySelectorAll('polyline').length >= 4, 'no history lines after two samples')
    assert.match(view.last(), /last 2 s/)
    assert.match(view.last(), /201 \/ 256/)

    // the history is capped: drive MORE polls than it holds, counted
    for (let i = 0; i < 200 && s.calls < HISTORY + 10; i++) await advance(1000)
    assert.ok(s.calls >= HISTORY + 10, `only ${s.calls} polls ran`)
    assert.match(view.last(), new RegExp(`last ${HISTORY} s`))
    const pts = view.el.querySelector('polyline')!.getAttribute('points')!.trim().split(/\s+/)
    assert.equal(pts.length, HISTORY, 'the drawn history is not capped')
  } finally {
    await view.unmount()
    const after = s.calls
    await advance(3000)
    assert.equal(s.calls, after, 'the panel kept polling after it unmounted')
    realClock()
    delete g.fetch
  }
})

test('never more than one request in flight', async () => {
  useFakeClock()
  const s = stub({ hold: true })
  const view = await mountView(<EngineDebugPanel />, el => el.textContent ?? '')
  try {
    await inAct(async () => { await flush(10) })
    assert.equal(s.calls, 1)
    await advance(5000)
    assert.equal(s.calls, 1, 'a second poll started while the first was unanswered')
    await inAct(async () => { s.held.shift()!(); await flush(10) })
    assert.match(view.last(), /pid 4242/)
    await advance(1000)
    assert.equal(s.calls, 2)
  } finally {
    await view.unmount()
    for (const r of s.held) r()
    realClock()
    delete g.fetch
  }
})

function Host() {
  // the App wiring: the panel exists only while the toggle is on
  const on = useEngineDebug()
  return <><EngineDebugToggle />{on && <EngineDebugPanel />}</>
}

test('off by default: nothing polls until the toggle is turned on', async () => {
  localStorage.removeItem(ENGINE_DEBUG_KEY)
  useFakeClock()
  const s = stub()
  const view = await mountView(<Host />, el => el.textContent ?? '')
  try {
    await advance(3000)
    assert.equal(s.calls, 0, 'the debug view polled while off')
    assert.doesNotMatch(view.last(), /Engine debug/)
    const box = view.el.querySelector('input[role="switch"]') as HTMLInputElement
    assert.ok(box && !box.checked)
    await inAct(async () => { box.click(); await flush(10) })
    assert.equal(localStorage.getItem(ENGINE_DEBUG_KEY), '1')
    assert.match(view.last(), /Engine debug/)
    assert.ok(s.calls >= 1, 'turning it on did not start polling')
    await inAct(async () => { box.click(); await flush(10) })
    const after = s.calls
    await advance(3000)
    assert.equal(s.calls, after, 'turning it off did not stop polling')
    assert.doesNotMatch(view.last(), /Engine debug/)
  } finally {
    await view.unmount()
    localStorage.removeItem(ENGINE_DEBUG_KEY)
    realClock()
    delete g.fetch
  }
})
