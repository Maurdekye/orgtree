/** stallwatch.test.tsx - src/stallwatch.ts, the renderer half of the UI stall tooling (item
 *  ui-freezes-intermittently-for-several-seconds-at; spec ui-stall-tooling-spec rev 1.3, section R, red tests ST1-ST6, ST13).
 *  A fake clock and fake performance entries: nothing waits on real time. The main-side tests are tests/stall-*.test.mjs.
 *
 *  ST1  499 ms only counts; 500 ms is one record with the schema fields
 *  ST2  input link: overlapping keydown/input entries, target descriptor, field_len, and NO typed text anywhere
 *  ST3  (main) redaction - tests/stall-log.test.mjs
 *  ST4  in-flight engine calls: settled and aborted ones vanish, cap 32
 *  ST5  the React hook: a minimal one is installed, or the existing one still gets every call
 *  ST6  40 stalls in a minute: 30 sent, the next record carries dropped:10
 *  ST13 streamer evidence derived from the accessor's scans and masks (stubbed until the freeze fix lands)
 *  Run:  node apps/desktop/renderer/tests/run.mjs stallwatch */
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {
  StallWatch, domCensus, focusedFieldLength, installReactHook, noteDraftSave, setStallContext, registerStallCounts, stallTarget, wrapFetch,
} from '../src/stallwatch'
import type { StallEnv, StreamerStatsLike } from '../src/stallwatch'

let clock = 100_000
const sent: any[] = []
const baseEnv = (over: Partial<StallEnv> = {}): StallEnv => ({
  now: () => clock, wall: () => 1_700_000_000_000 + clock, send: r => { sent.push(r) }, doc: document,
  fetches: { open: () => [] }, commits: { count: () => 0 }, streamer: () => null, ...over,
})
const loaf = (over: Record<string, unknown> = {}) => ({
  startTime: clock - 900, duration: 900, blockingDuration: 850, renderStart: clock - 40, styleAndLayoutStart: clock - 30,
  scripts: [], ...over,
})
test.beforeEach(() => { sent.length = 0; clock = 100_000 })

test('ST1 a 499 ms frame only counts; a 500 ms frame is one record with the schema fields', () => {
  const w = new StallWatch(baseEnv())
  w.onLoaf(loaf({ duration: 499 }))
  w.onLoaf(loaf({ duration: 60 }))
  assert.equal(sent.length, 0, 'under 500 ms nothing is sent')
  w.onLoaf(loaf({
    duration: 500, startTime: clock - 500,
    scripts: [
      { invoker: 'BUTTON.onclick', invokerType: 'event-listener', sourceFunctionName: 'busy', sourceURL: 'http://127.0.0.1:1/assets/a.js', sourceCharPosition: 77, duration: 480, forcedStyleAndLayoutDuration: 12 },
      { invoker: 'x', invokerType: 'user-callback', sourceFunctionName: 'small', sourceURL: '', sourceCharPosition: 1, duration: 5, forcedStyleAndLayoutDuration: 0 },
    ],
  }))
  assert.equal(sent.length, 1)
  const r = sent[0]
  assert.equal(r.ms, 500)
  assert.equal(r.loaf_50_500, 2, 'the two shorter frames were counted (499 and 60 are both >= 50 ms)')
  assert.deepEqual(r.loaf.scripts[0], { invoker: 'BUTTON.onclick', invoker_type: 'event-listener', fn: 'busy', url: 'http://127.0.0.1:1/assets/a.js', pos: 77, ms: 480, forced_ms: 12 }, 'top script first, with attribution')
  for (const k of ['loaf', 'input', 'keys_2s', 'field_len', 'fetch', 'ws', 'react', 'ctx', 'counts', 'streamer', 'selectionchange', 'capture_ms', 'at_ms', 'dropped'])
    assert.ok(k in r, 'record has ' + k)
  assert.ok(r.capture_ms <= 20, 'capture is cheap')
  w.onLoaf(loaf({ duration: 700 }))
  assert.equal(sent[1].loaf_50_500, 0, 'the counter is reset per record')
})

test('ST2 the input link: overlapping events with their target, the focused field length, and none of the typed text', async () => {
  const v = await mountView(React.createElement('div', null,
    React.createElement('div', { 'data-stall-id': 'desk-composer' }, React.createElement('textarea', { id: 'secret-field', defaultValue: 'SECRETWORD'.repeat(40) })),
    React.createElement('input', { type: 'text', id: 'plain' })), el => el)
  try {
    const box = v.el.querySelector<HTMLTextAreaElement>('textarea')!
    box.focus()
    const w = new StallWatch(baseEnv())
    w.noteKey(clock - 2500); w.noteKey(clock - 1200); w.noteKey(clock - 1000)
    w.onEvents([
      { name: 'keydown', startTime: clock - 850, duration: 800, processingStart: clock - 840, processingEnd: clock - 100, interactionId: 7, target: box },
      { name: 'input', startTime: clock - 840, duration: 790, processingStart: clock - 830, processingEnd: clock - 120, interactionId: 8, target: box },
      { name: 'keyup', startTime: clock - 5000, duration: 40, processingStart: clock - 4990, processingEnd: clock - 4980, interactionId: 1, target: box },
    ])
    w.onLoaf(loaf({ startTime: clock - 900, duration: 900 }))
    const r = sent[0]
    assert.deepEqual(r.input.map((i: any) => i.type), ['keydown', 'input'], 'only the events overlapping the stall')
    assert.deepEqual(r.input.map((i: any) => i.target), ['desk-composer', 'desk-composer'])
    assert.equal(r.input[0].input_delay, 10); assert.equal(r.input[0].processing, 740); assert.equal(r.input[0].presentation, 50)
    assert.equal(r.field_len, 400, 'length rounded down to 100')
    assert.equal(r.keys_2s, 2, 'keydowns in the 2 s before the stall (1200 and 1000 ms before... the 2500 one is older)')
    assert.ok(!JSON.stringify(r).includes('SECRETWORD'), 'the text never leaves')
    assert.equal(stallTarget(v.el.querySelector('#plain')), 'input[text]')
    assert.equal(focusedFieldLength(document), 400)
  } finally { await v.unmount() }
})

test('ST4 only unsettled engine calls appear, never more than 32, with the query stripped', async () => {
  const resolvers: Array<(v: unknown) => void> = []
  const rejecters: Array<(e: unknown) => void> = []
  const win: any = { fetch: (_u: unknown) => new Promise((res, rej) => { resolvers.push(res); rejecters.push(rej) }) }
  const t = wrapFetch(win, () => clock)
  const a = win.fetch('/api/orgs/acme/agents?x=1')
  const b = win.fetch('/api/orgs/acme/mail', { method: 'post' })
  const c = win.fetch('/api/orgs/acme/work')
  resolvers[0]!({}); rejecters[2]!(new Error('abort')); await a; await c.catch(() => {})
  assert.deepEqual(t.open().map(f => `${f.method} ${f.route}`), ['POST /api/orgs/acme/mail'], 'settled and aborted calls are gone, no query')
  void b
  for (let i = 0; i < 40; i++) win.fetch('/api/x/' + i)
  assert.equal(t.open().length, 32, 'capped at 32, oldest dropped')
  assert.equal(t.open()[0]!.route, '/api/x/8')
})

test('ST5 React commits: a minimal hook when there is none; an existing hook still receives every call', () => {
  const fresh: any = {}
  const counter = installReactHook(fresh, () => clock)
  assert.equal(fresh.__REACT_DEVTOOLS_GLOBAL_HOOK__.supportsFiber, true)
  assert.equal(fresh.__REACT_DEVTOOLS_GLOBAL_HOOK__.inject(), 1)
  fresh.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {}); clock += 10; fresh.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {})
  assert.equal(counter.count(clock - 100, clock), 2)
  const calls: unknown[][] = []
  const other: any = { __REACT_DEVTOOLS_GLOBAL_HOOK__: { supportsFiber: true, onCommitFiberRoot(...a: unknown[]) { calls.push(a); return 'kept' } } }
  const c2 = installReactHook(other, () => clock)
  assert.equal(other.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(3, 'root', 'level'), 'kept')
  assert.deepEqual(calls, [[3, 'root', 'level']], 'the original still gets every call, with its arguments')
  assert.ok(c2.count(clock - 1, clock + 1) >= 1)
  installReactHook(other, () => clock)
  other.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(4)
  assert.equal(calls.length, 2, 'installing twice does not double-wrap')
})

test('ST6 forty stalls in a minute: thirty are sent, the next record says it dropped ten', () => {
  const w = new StallWatch(baseEnv())
  for (let i = 0; i < 40; i++) { clock += 1000; w.onLoaf(loaf()) }
  assert.equal(sent.length, 30)
  clock += 120_000
  w.onLoaf(loaf())
  assert.equal(sent.length, 31)
  assert.equal(sent[30].dropped, 10)
  assert.equal(sent[29].dropped, 0)
})

test('ST13 streamer evidence: scans and masks overlapping the stall, split by trigger, with the last-10-seconds figures', () => {
  const stats: StreamerStatsLike = {
    on: true, pace_ms: 250,
    scans: [
      { start: clock - 20_000, ms: 90, trigger: 'update', mutations: 1, nodes_walked: 10, text_nodes: 4, text_chars: 1000, ranges_after: 3 },
      { start: clock - 800, ms: 300, trigger: 'mutation', mutations: 5, nodes_walked: 4000, text_nodes: 900, text_chars: 80000, ranges_after: 40 },
      { start: clock - 400, ms: 200, trigger: 'update', mutations: 0, nodes_walked: 4000, text_nodes: 900, text_chars: 80000, ranges_after: 40 },
      { start: clock - 5000, ms: 60, trigger: 'prefs', mutations: 0, nodes_walked: 1, text_nodes: 1, text_chars: 0, ranges_after: 0 },
    ],
    masks: [{ start: clock - 700, ms: 50 }, { start: clock - 600, ms: 30 }, { start: clock - 30_000, ms: 99 }],
  }
  const w = new StallWatch(baseEnv({ streamer: () => stats }))
  w.onLoaf(loaf({ startTime: clock - 900, duration: 900 }))
  const s = sent[0].streamer
  assert.equal(s.on, true); assert.equal(s.pace_ms, 250)
  assert.equal(s.scans_in, 2); assert.equal(s.scan_ms_in, 500); assert.equal(s.max_scan_ms_in, 300)
  assert.deepEqual(s.scans_in_by_trigger, { mutation: 1, update: 1, prefs: 0, 'org-list': 0, other: 0 })
  assert.equal(s.scans_10s, 3, 'scans in the 10 s up to the end of the stall'); assert.equal(s.max_scan_ms_10s, 300)
  assert.equal(s.masks_in, 2); assert.equal(s.mask_ms_in, 80)
  assert.equal(s.scans.length, 2); assert.equal(s.scans[0].start, 100, 'scan starts are relative to the stall start')
  assert.equal(s.scans[0].text_nodes, 900)
})

test('ST13b without the accessor the record says streamer off; the other counts still work', () => {
  setStallContext({ screen: 'desk', panel: 'docket', popout: null })
  registerStallCounts({ agents: () => 121, projects: () => 3, watchdogs: () => { throw new Error('x') } })
  noteDraftSave(clock - 3000); noteDraftSave(clock - 100); noteDraftSave(clock - 60_000)
  const w = new StallWatch(baseEnv())
  w.noteSelection(clock - 1000); w.noteSelection(clock - 500); w.noteSelection(clock - 1500)
  w.onLoaf(loaf({ startTime: clock - 900, duration: 900 }))
  const r = sent[0]
  assert.deepEqual(r.streamer, { on: false })
  assert.deepEqual(r.ctx, { screen: 'desk', panel: 'docket', popout: null })
  assert.equal(r.counts.agents, 121); assert.equal(r.counts.watchdogs, null, 'a throwing getter is null, not an error')
  assert.equal(r.counts.draft_saves_10s, 2)
  assert.deepEqual(r.selectionchange, { in: 1, before_2s: 2 })
  assert.ok(r.counts.dom_nodes > 0 && r.counts.text_nodes >= 0 && r.counts.max_depth >= 1)
})

test('the DOM census counts element and text nodes and depth, and stops at its time budget', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>a<b>b</b></p><p><i><u>c</u></i></p>'
  const c = domCensus(root, 10, () => 0)
  assert.deepEqual(c, { dom_nodes: 5, text_nodes: 3, max_depth: 3, dom_partial: false })
  const big = document.createElement('div')
  for (let i = 0; i < 2000; i++) big.appendChild(document.createElement('span'))
  let t = 0
  const partial = domCensus(big, 10, () => (t += 1))
  assert.equal(partial.dom_partial, true); assert.ok(partial.dom_nodes < 2000)
})
