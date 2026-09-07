/** freezelog.test.tsx — src/freezelog.ts (the passive freeze recorder) and
 *  src/FreezeLogPage.tsx (the /debug/freezes page).
 *
 * The recorder takes its frame source and clock by injection, so every case
 * here drives frames by hand with a fake clock: nothing waits on real time,
 * and a gap is exactly the number this file says it is.
 *
 * ⚠ ANTI-VACUITY. The cheap wrong recorder is one that never records, and a
 * suite of "healthy frames leave nothing" cases is green against it. §1 pins
 * both sides in one test: sub-threshold gaps leave nothing AND a gap at the
 * threshold is recorded with its size. §3 checks the visibility carve-out the
 * same way — the hidden gap is skipped, the next real gap is not.
 *
 * §0 install writes a start entry naming the path, and the entry has the tab
 * §1 frame gaps: below threshold nothing, at/above threshold one entry, ms exact
 * §2 the ring holds the last 200 and drops the oldest first
 * §2b churn (visibility/lifecycle) is evicted before any gap or longtask
 * §2c a refused write keeps the newest few, never nothing
 * §3 the hidden interval is never measured; returning-to-first-frame is, attributed
 * §3b a lifecycle event starts an attributed interval too
 * §3c a frame delivered while hidden only resets the interval start
 * §3d a freeze the user switched away from mid-block is measured on the hide side
 * §4 lifecycle events (pagehide/pageshow/freeze/resume) are recorded
 * §5 stop() detaches: no frames and no events are recorded afterwards
 * §6 corrupt storage reads as empty rather than throwing
 * §6b two tabs write their own rings: neither can drop the other's entry; merge is by time; legacy key cleared
 * §6c retention: stale rings and rings beyond the 10 most recent are pruned at install
 * §7 the page: newest first, the empty state, Clear empties storage
 * §8 the path test: /debug/freezes with and without the kiosk prefix
 * §9 a denied localStorage getter (SecurityError) does not make install/read/clear/page throw (recorder only)
 *
 * Run:  cd frontend && node tests/run.mjs freezelog
 */
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FREEZE_LOG_CAP, FREEZE_LOG_PREFIX, FREEZE_LOG_TABS_KEPT, FREEZE_LOG_MAX_AGE_MS,
  clearFreezeLog, freezeLogKey, installFreezeLog, pruneFreezeLog, readFreezeLog, readTabFreezeLog,
} from '../src/freezelog'
import FreezeLogPage, { isFreezeLogPath } from '../src/FreezeLogPage'

/** A hand-cranked frame source: `tick(ms)` advances the clock and delivers
 *  the pending frame callback, exactly once, at the new time. */
// every recorder a test installs is stopped after it, so a failing assertion
// before its own stop() cannot leak listeners into the next test
const active: Array<() => void> = []
test.afterEach(() => {
  for (const s of active.splice(0)) s()
  // a case that fails while it has the document 'hidden' must not leave it so
  Object.defineProperty(document, 'visibilityState', { value: 'prerender', configurable: true })
})

function rig(opts: { thresholdMs?: number; cap?: number } = {}) {
  let t = 1000
  let pending: ((t: number) => void) | null = null
  const stop = installFreezeLog({
    ...opts,
    now: () => t,
    raf: (cb) => { pending = cb; return 1 },
    caf: () => { pending = null },
  })
  const tick = (ms: number) => {
    t += ms
    const cb = pending
    pending = null
    cb?.(t)
  }
  // time passes and NO frame is delivered — what a browser does while the
  // tab is hidden (redteam-opus R2: a rig that ticks a frame while hidden
  // refreshes `last` itself and hides a missing reset)
  const advance = (ms: number) => { t += ms }
  active.push(stop)
  return { tick, advance, stop, hasPendingFrame: () => pending !== null }
}

test.beforeEach(() => {
  clearFreezeLog()
  window.sessionStorage.removeItem('orgtree.freezes-tab')
})

test('§0 install writes a start entry with the path and a tab id', () => {
  const r = rig()
  const log = readFreezeLog()
  assert.equal(log.length, 1)
  assert.equal(log[0]!.kind, 'start')
  assert.equal(log[0]!.detail, location.pathname)
  assert.ok(log[0]!.tab.length > 0)
  assert.equal(log[0]!.vis, document.visibilityState)
  r.stop()
})

test('§1 sub-threshold gaps leave nothing; a gap at the threshold is recorded with its size', () => {
  const r = rig({ thresholdMs: 250 })
  for (let i = 0; i < 50; i++) r.tick(16)
  r.tick(249)
  assert.deepEqual(readFreezeLog().map((e) => e.kind), ['start'], 'healthy frames must record nothing')
  r.tick(250)
  let log = readFreezeLog()
  assert.equal(log.length, 2)
  assert.equal(log[1]!.kind, 'gap')
  assert.equal(log[1]!.ms, 250)
  assert.match(log[1]!.detail, /250 ms between frames/)
  r.tick(16)
  r.tick(1234)
  log = readFreezeLog()
  assert.equal(log.length, 3)
  assert.equal(log[2]!.ms, 1234)
  assert.ok(r.hasPendingFrame(), 'the loop re-arms after every frame')
  r.stop()
})

test('§2 the ring keeps the last 200 and drops the oldest first', () => {
  const r = rig({ thresholdMs: 100 })
  for (let i = 0; i < FREEZE_LOG_CAP + 25; i++) r.tick(100 + i)   // distinct sizes
  const log = readFreezeLog()
  assert.equal(log.length, FREEZE_LOG_CAP)
  assert.ok(log.every((e) => e.kind === 'gap'), 'the start entry was the oldest and is gone')
  assert.equal(log[0]!.ms, 100 + 25, 'the 25 oldest gaps were dropped')
  assert.equal(log[log.length - 1]!.ms, 100 + FREEZE_LOG_CAP + 24)
  r.stop()
})

test('§2b over cap, visibility and lifecycle entries are evicted before any gap', () => {
  const r = rig({ thresholdMs: 100, cap: 50 })
  r.tick(802)   // the freeze the log exists to keep
  for (let i = 0; i < 210; i++) document.dispatchEvent(new Event('visibilitychange'))
  let log = readFreezeLog()
  assert.equal(log.length, 50)
  assert.ok(log.some((e) => e.kind === 'gap' && e.ms === 802), 'the freeze survived 210 visibility events')
  assert.ok(log.some((e) => e.kind === 'start'), 'the start entry survived too')
  assert.equal(log.filter((e) => e.kind === 'visibility').length, 48)
  // and when only high-value entries remain, the oldest of them goes
  for (let i = 0; i < 60; i++) r.tick(100 + i)
  log = readFreezeLog()
  assert.equal(log.length, 50)
  assert.equal(log.filter((e) => e.kind === 'visibility').length, 0)
  assert.ok(!log.some((e) => e.kind === 'start'), 'start was the oldest high-value entry and went first')
  assert.ok(!log.some((e) => e.ms === 802), 'then the 802 ms gap, the next oldest')
  r.stop()
})

test('§2c when storage refuses the write, the newest few entries are kept rather than none', () => {
  let refuse = false
  const inner = localStorage
  const flaky: Storage = {
    get length() { return inner.length },
    key: (i) => inner.key(i),
    getItem: (k) => inner.getItem(k),
    removeItem: (k) => inner.removeItem(k),
    clear: () => inner.clear(),
    setItem: (k, v) => {
      if (refuse && v.length > 3000) throw new Error('QuotaExceededError')
      inner.setItem(k, v)
    },
  }
  let t = 1000
  let pending: ((t: number) => void) | null = null
  const stop = installFreezeLog({ thresholdMs: 100, storage: flaky, now: () => t, raf: (cb) => { pending = cb; return 1 }, caf: () => { pending = null } })
  active.push(stop)
  const tick = (ms: number) => { t += ms; const cb = pending; pending = null; cb?.(t) }
  for (let i = 0; i < 40; i++) tick(150)
  assert.equal(readFreezeLog().length, 41)
  refuse = true
  tick(777)
  const log = readFreezeLog()
  assert.equal(log.length, 20, 'fell back to the newest 20')
  assert.equal(log[log.length - 1]!.ms, 777, 'and the entry being recorded is among them')
  stop()
})

test('§3 the hidden interval is never a gap; the interval from returning to the first frame is, and says so', () => {
  const r = rig({ thresholdMs: 250 })
  const doc = document as unknown as { visibilityState: string }
  r.tick(16)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  r.advance(3_600_000)   // an hour in the background: NO frames are painted while hidden
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  let log = readFreezeLog()
  assert.deepEqual(log.slice(1).map((e) => `${e.kind}:${e.detail}`), ['visibility:hidden', 'visibility:visible'],
    `nothing may be measured across a hidden tab, got ${log.map((e) => e.detail).join(' | ')}`)
  r.tick(3000)   // first frame after coming back: three seconds late IS a freeze, attributed — and it is 3 s, not an hour
  log = readFreezeLog()
  const back = log[log.length - 1]!
  assert.equal(back.kind, 'gap')
  assert.equal(back.ms, 3000)
  assert.equal(back.detail, '3000 ms from visibility visible to the first frame')
  r.tick(16)
  r.tick(400)
  const next = readFreezeLog().pop()!
  assert.equal(next.detail, '400 ms between frames', 'an ordinary gap afterwards is unattributed')
  assert.equal(doc.visibilityState, 'visible')
  r.stop()
})

test('§3c a frame that arrives while hidden only resets the interval start', () => {
  const r = rig({ thresholdMs: 250 })
  r.tick(16)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  r.tick(5000)   // not something a browser does, but if it did: no gap
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  r.tick(16)
  assert.deepEqual(readFreezeLog().map((e) => e.kind), ['start', 'visibility', 'visibility'])
  r.stop()
})

test('§3d a freeze the user switched away from is measured on the hide side', () => {
  const r = rig({ thresholdMs: 250 })
  r.tick(16)
  r.advance(5000)   // the page blocks for five seconds; mid-block the user switches tabs
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  const e = readFreezeLog()
  assert.deepEqual(e.slice(1).map((x) => `${x.kind}:${x.detail}`), ['gap:5000 ms before the tab was hidden', 'visibility:hidden'])
  assert.equal(e[1]!.ms, 5000)
  // and a short visible interval before hiding records nothing extra
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  r.tick(16)
  r.tick(16)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  assert.deepEqual(readFreezeLog().slice(3).map((x) => x.kind), ['visibility', 'visibility'])
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  r.stop()
})

test('§3b a lifecycle event also starts an attributed interval', () => {
  const r = rig({ thresholdMs: 250 })
  r.tick(16)
  window.dispatchEvent(new Event('resume'))
  r.tick(900)
  const e = readFreezeLog().pop()!
  assert.equal(e.kind, 'gap')
  assert.equal(e.detail, '900 ms from resume to the first frame')
  r.stop()
})

test('§4 lifecycle events are recorded with their type and persisted flag', () => {
  const r = rig()
  window.dispatchEvent(new Event('pagehide'))
  const show = new Event('pageshow')
  Object.defineProperty(show, 'persisted', { value: true })
  window.dispatchEvent(show)
  window.dispatchEvent(new Event('freeze'))
  window.dispatchEvent(new Event('resume'))
  const details = readFreezeLog().filter((e) => e.kind === 'lifecycle').map((e) => e.detail)
  assert.deepEqual(details, ['pagehide', 'pageshow persisted=true', 'freeze', 'resume'])
  r.stop()
})

test('§5 stop() detaches everything: frames and events after it record nothing', () => {
  const r = rig({ thresholdMs: 100 })
  r.tick(500)
  assert.equal(readFreezeLog().length, 2)
  r.stop()
  assert.ok(!r.hasPendingFrame(), 'the frame loop is cancelled')
  r.tick(900)
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(readFreezeLog().length, 2, 'nothing may be recorded after stop()')
})

test('§6 corrupt or foreign storage reads as empty and is overwritten, never thrown on', () => {
  localStorage.setItem(freezeLogKey('bad1'), '{not json')
  assert.deepEqual(readFreezeLog(), [])
  localStorage.setItem(freezeLogKey('bad2'), '{"a":1}')
  assert.deepEqual(readFreezeLog(), [])
  const r = rig()
  assert.equal(readFreezeLog().length, 1)
  r.stop()
})

test('§6b two tabs keep separate rings, and reading merges them by time', () => {
  // tab A installs and records; then tab B (a different sessionStorage id)
  // installs and records; A's entry must still be there afterwards
  const a = rig({ thresholdMs: 100 })
  a.tick(300)
  const tabA = readFreezeLog()[0]!.tab
  a.stop()
  window.sessionStorage.removeItem('orgtree.freezes-tab')   // a new tab mints a new id
  const b = rig({ thresholdMs: 100 })
  b.tick(500)
  b.stop()
  const tabB = readTabFreezeLog(tabA).length ? readFreezeLog().find((e) => e.tab !== tabA)!.tab : ''
  assert.notEqual(tabA, tabB)
  assert.deepEqual(readTabFreezeLog(tabA).map((e) => e.kind), ['start', 'gap'], "tab A's ring is intact after tab B wrote")
  assert.deepEqual(readTabFreezeLog(tabB).map((e) => e.kind), ['start', 'gap'])
  assert.equal(readFreezeLog().length, 4, 'the merged view has both')
  assert.equal(readTabFreezeLog(tabB).find((e) => e.kind === 'gap')!.ms, 500)
  // merge order is BY TIME, not by key: interleave the two rings and read
  const mk = (tab: string, at: number, ms: number) => ({ at, kind: 'gap' as const, detail: `${ms}`, vis: 'visible', tab, ms })
  localStorage.setItem(freezeLogKey(tabA), JSON.stringify([mk(tabA, 10, 1), mk(tabA, 30, 3)]))
  localStorage.setItem(freezeLogKey(tabB), JSON.stringify([mk(tabB, 20, 2), mk(tabB, 40, 4)]))
  assert.deepEqual(readFreezeLog().map((e) => e.ms), [1, 2, 3, 4], 'merged by time across tabs')
  // the retired shared key of the first build is cleared too, and at install
  localStorage.setItem('orgtree.freezes', '[{"at":1,"kind":"gap","detail":"legacy","vis":"visible","tab":"x"}]')
  clearFreezeLog()
  assert.equal(localStorage.getItem(freezeLogKey(tabA)), null, 'Clear removes every tab ring')
  assert.equal(localStorage.getItem(freezeLogKey(tabB)), null)
  assert.equal(localStorage.getItem('orgtree.freezes'), null, 'Clear removes the legacy shared ring')
  localStorage.setItem('orgtree.freezes', '[]')
  const c = rig()
  assert.equal(localStorage.getItem('orgtree.freezes'), null, 'install removes the legacy shared ring')
  c.stop()
})

test('§6c retention at install: rings older than 7 days go, only the 10 most recent tabs stay, the installing tab is never pruned', () => {
  const now = Date.now()
  const seed = (tab: string, at: number) =>
    localStorage.setItem(freezeLogKey(tab), JSON.stringify([{ at, kind: 'start', detail: '/', vis: 'visible', tab }]))
  seed('stale', now - FREEZE_LOG_MAX_AGE_MS - 1)
  seed('me', now - FREEZE_LOG_MAX_AGE_MS - 5000)   // the installing tab's own: stale AND oldest of all
  for (let i = 0; i < 12; i++) seed(`t${i}`, now - (i + 1) * 1000)   // t0 newest ... t11 oldest
  pruneFreezeLog(localStorage, now, 'me')
  const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
    .filter((k) => k.startsWith(FREEZE_LOG_PREFIX)).sort()
  assert.ok(!left.includes(freezeLogKey('stale')), 'the stale ring is gone')
  assert.ok(left.includes(freezeLogKey('me')), "the installing tab's own ring is never pruned, however old")
  assert.equal(left.length, FREEZE_LOG_TABS_KEPT, 'nine others stay beside the installing tab')
  assert.ok(!left.includes(freezeLogKey('t9')) && !left.includes(freezeLogKey('t11')), 'the oldest were dropped')
  assert.ok(left.includes(freezeLogKey('t0')) && left.includes(freezeLogKey('t8')))
  // and install itself prunes: a fresh tab installing over 10 present rings leaves 9 + its own
  const r = rig()
  const after = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
    .filter((k) => k.startsWith(FREEZE_LOG_PREFIX))
  assert.equal(after.length, FREEZE_LOG_TABS_KEPT)
  assert.ok(!after.includes(freezeLogKey('me')), "'me' was the oldest ring and this fresh tab is not 'me'")
  r.stop()
})

test('§7 the page lists entries newest first, shows an empty state, and Clear empties storage', async () => {
  const empty = await mountView(<FreezeLogPage />, (el) => el.querySelector('[data-testid=freeze-empty]'))
  assert.ok(empty.frames[0], 'empty state shown when nothing is recorded')

  const r = rig({ thresholdMs: 100 })
  r.tick(300)
  r.tick(16)
  r.tick(700)
  r.stop()
  const view = await mountView(<FreezeLogPage />, (el) =>
    Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.getAttribute('data-kind')))
  assert.deepEqual(view.frames[0], ['gap', 'gap', 'start'], 'newest first')
  const cells = Array.from(view.el.querySelectorAll('tbody tr td:nth-child(3)')).map((td) => td.textContent)
  assert.deepEqual(cells, ['700', '300', ''])
  const { act } = await import('react')
  const clear = Array.from(view.el.querySelectorAll('button')).find((b) => b.textContent === 'Clear')!
  await act(async () => { clear.click() })
  assert.equal(readFreezeLog().length, 0, 'Clear removes the stored rings')
  assert.ok(view.el.querySelector('[data-testid=freeze-empty]'), 'and the page shows the empty state')
})

test('§9 a denied storage getter does not make the recorder throw: install, read, clear and the page survive it', async () => {
  // main.tsx installs the recorder BEFORE React mounts. Chromium throws from
  // the localStorage GETTER itself when storage is blocked for the origin,
  // so this is the control for that exact shape (coordinator review).
  // ⚠ WHAT THIS DOES NOT SHOW: whether the APP starts on such a browser. In
  // this rig window !== globalThis, so the bare `localStorage` identifier
  // other startup code uses keeps working here; and crashReporter's
  // flushPendingReports, which main.tsx calls first, is unguarded (a
  // separate item). Only a real browser can answer the app-level question
  // (redteam-opus measured it at b86ec41: the app still does not start).
  const real = window.localStorage
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    get() { throw new DOMException('Failed to read the localStorage property from Window: Access is denied', 'SecurityError') },
    configurable: true,
  })
  try {
    assert.throws(() => window.localStorage, /SecurityError|denied/, 'the control: the getter really throws')
    let stop: (() => void) | undefined
    assert.doesNotThrow(() => { stop = installFreezeLog() }, 'install must not throw into the page')
    assert.equal(typeof stop, 'function')
    assert.doesNotThrow(() => stop!())
    assert.deepEqual(readFreezeLog(), [], 'reading is empty, not an error')
    assert.doesNotThrow(() => clearFreezeLog())
    // the debug page renders its empty state rather than crashing
    const view = await mountView(<FreezeLogPage />, (el) => el.querySelector('[data-testid=freeze-empty]'))
    assert.ok(view.frames[0])
    // an explicitly supplied storage still works when the window's is denied
    const mem = new Map<string, string>()
    const given: Storage = {
      get length() { return mem.size }, key: (i) => [...mem.keys()][i] ?? null,
      getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v) },
      removeItem: (k) => { mem.delete(k) }, clear: () => mem.clear(),
    }
    let t = 0
    let pending: ((t: number) => void) | null = null
    const s2 = installFreezeLog({ storage: given, thresholdMs: 100, now: () => t, raf: (cb) => { pending = cb; return 1 }, caf: () => { pending = null } })
    t += 500; pending!(t)
    assert.equal(readFreezeLog(given).map((e) => e.kind).join(','), 'start,gap')
    s2()
  } finally {
    if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
    else delete (window as unknown as Record<string, unknown>)['localStorage']
    assert.equal(window.localStorage, real, 'the real storage is back for the remaining tests')
  }
})

test('§8 the debug path is recognised with and without the kiosk prefix, and nowhere else', () => {
  assert.equal(isFreezeLogPath('/debug/freezes'), true)
  assert.equal(isFreezeLogPath('/debug/freezes/'), true)
  assert.equal(isFreezeLogPath('/k/abc123/debug/freezes'), true)
  assert.equal(isFreezeLogPath('/o/orgtree'), false)
  assert.equal(isFreezeLogPath('/debug/freezes-not'), false)
  assert.equal(isFreezeLogPath('/'), false)
})
