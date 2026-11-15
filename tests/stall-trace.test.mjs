// stall-trace.test.mjs - main/stall-trace.ts: a short Chromium trace after a long frame that
// WAITED (blocking < 50 ms, scripts < 20 % of it). Item hang-every-time-a-new-desk-loads-especially-whil
// (design desk-freeze-opus/design-B-stall-trace.md, GO @coordinator-opus md77d04632a31).
//
// TR1 the arming shape: waiting frames arm, working, short or non-loaf frames do not
// TR2 one capture: narrow categories, 20 s cap, or 3 s after the next waiting frame
// TR3 rate limit: one capture per 10 minutes, three per run; no directory means no capture
// TR4 the filter: only allowed categories, allowlisted args, no URLs or free text
// TR5 retention: three files at most, oldest out
// TR6 the written file: gzip JSON with the canvas background and both stalls, and one stall-trace log line
// TR7 stall-log: renderer-loaf keeps canvas_bg as an enum + boolean; a stall-trace line is allowlisted
// Run: node --test tests/stall-trace.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(tmpdir(), 'orgtree-stall-trace-'))
const bundle = path.join(temp, 'stall-trace.cjs'), logBundle = path.join(temp, 'stall-log.cjs')
await build({ entryPoints: ['apps/desktop/main/stall-trace.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
await build({ entryPoints: ['apps/desktop/main/stall-log.ts'], outfile: logBundle, bundle: true, platform: 'node', format: 'cjs' })
const req = createRequire(import.meta.url)
const { StallTracer, waitingFrame, filterTraceLine, pruneTraces, TRACE_CATEGORIES, TRACE_DIR, processTrace } = req(bundle)
const { StallLog } = req(logBundle)
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))

const W = '7c0e4a89-787d-412d-a45b-ca83419549d8'
const waiting = (over = {}) => ({ at_ms: 1_000_000, ms: 1000, loaf: { blocking: 0, scripts_ms: 10 }, canvas_bg: { theme: 'ascii', webgl: true }, ...over })
let roots = 0
const fresh = () => { const r = path.join(temp, `root-${++roots}`); fs.mkdirSync(r); return r }

/** a fake clock, timers and tracing; process() is recorded, not run */
function rig({ dir = fresh() } = {}) {
  const t = { now: 1_000_000, timers: [], started: [], stopped: [], processed: [], logged: [] }
  const deps = {
    now: () => t.now,
    setTimeout: (fn, ms) => { const h = { fn, at: t.now + ms, done: false }; t.timers.push(h); return h },
    clearTimeout: h => { if (h) h.done = true },
    dir: () => dir,
    tracing: { start: async cats => { t.started.push(cats) }, stop: async file => { t.stopped.push(file); return file } },
    process: async (raw, out, meta) => { t.processed.push({ raw, out, meta }); return { events: 7, bytes: 123 } },
    log: line => t.logged.push(line),
    app: () => '4.6.1-test abc1234',
  }
  const run = async ms => {
    t.now += ms
    for (const h of [...t.timers]) if (!h.done && h.at <= t.now) { h.done = true; await h.fn() }
    await new Promise(r => setImmediate(r))
  }
  return { t, deps, run, dir }
}

test('TR1 the arming shape: a long frame that waited arms; one that worked, a short one or a ping does not', () => {
  assert.equal(waitingFrame('renderer-loaf', waiting()), true)
  assert.equal(waitingFrame('renderer-loaf', waiting({ ms: 499 })), false, 'under 500 ms')
  assert.equal(waitingFrame('renderer-loaf', waiting({ loaf: { blocking: 60, scripts_ms: 10 } })), false, 'blocking 50 ms or more is work')
  assert.equal(waitingFrame('renderer-loaf', waiting({ loaf: { blocking: 0, scripts_ms: 200 } })), false, 'scripts 20 % or more of the frame is work')
  assert.equal(waitingFrame('renderer-ping', waiting()), false, 'only long-animation frames carry the shape')
  assert.equal(waitingFrame('renderer-loaf', { ms: 900 }), false, 'no loaf body, no judgement')
})

test('TR2 a capture: the narrow categories, stopped 3 s after the next waiting frame, else at 20 s', async () => {
  const { t, deps, run } = rig()
  const tr = new StallTracer(deps)
  await tr.onStall('renderer-loaf', waiting(), W)
  assert.equal(t.started.length, 1, 'the first waiting frame arms a capture')
  assert.deepEqual(t.started[0], TRACE_CATEGORIES)
  for (const c of TRACE_CATEGORIES) assert.ok(!/devtools|v8\.cpu_profiler|screenshot|blink\.console|disabled-by-default-devtools/.test(c), `category ${c} could carry page content`)
  for (const c of ['gpu', 'cc', 'viz']) assert.ok(TRACE_CATEGORIES.includes(c), `category ${c} is traced`)
  await run(1000)
  await tr.onStall('renderer-loaf', waiting({ at_ms: t.now }), W)
  await run(2999)
  assert.equal(t.stopped.length, 0, 'still recording 3 s after the second stall began')
  await run(2)
  assert.equal(t.stopped.length, 1, 'stopped 3 s after the stall it was waiting for')
  assert.equal(t.processed[0].meta.caught.ms, 1000)

  const b = rig(); const tb = new StallTracer(b.deps)
  await tb.onStall('renderer-loaf', waiting(), W)
  await b.run(19_999); assert.equal(b.t.stopped.length, 0)
  await b.run(2); assert.equal(b.t.stopped.length, 1, 'no second stall: the capture ends at 20 s')
  assert.equal(b.t.processed[0].meta.caught, null)
})

test('TR3 rate limit: one capture per 10 minutes, three a run; no data root, no capture; a tracing failure never throws', async () => {
  const { t, deps, run } = rig()
  const tr = new StallTracer(deps)
  await tr.onStall('renderer-loaf', waiting(), W); await run(20_001)
  await tr.onStall('renderer-loaf', waiting(), W)
  assert.equal(t.started.length, 1, 'a second waiting frame inside 10 minutes is not a new capture')
  for (let i = 0; i < 4; i++) { await run(10 * 60_000); await tr.onStall('renderer-loaf', waiting(), W); await run(20_001) }
  assert.equal(t.started.length, 3, 'three captures a run at most')

  const none = rig({ dir: undefined }); none.deps.dir = () => undefined
  await new StallTracer(none.deps).onStall('renderer-loaf', waiting(), W)
  assert.equal(none.t.started.length, 0)

  const bad = rig(); bad.deps.tracing.start = async () => { throw new Error('tracing busy') }
  await new StallTracer(bad.deps).onStall('renderer-loaf', waiting(), W)
  assert.equal(bad.t.logged.length, 0)
})

test('TR4 the filter keeps allowed categories, allowlisted args and names only', () => {
  const keep = filterTraceLine('{"pid":1,"tid":2,"ts":5,"ph":"X","cat":"gpu","name":"GpuChannel::ExecuteDeferredRequest","dur":40,"args":{"sequence_number":3,"url":"file:///C:/Users/x/secret.txt","data":{"html":"<b>mail body</b>"}}},')
  assert.deepEqual(JSON.parse(keep), { pid: 1, tid: 2, ts: 5, ph: 'X', cat: 'gpu', name: 'GpuChannel::ExecuteDeferredRequest', dur: 40, args: { sequence_number: 3 } })
  assert.equal(filterTraceLine('{"ph":"X","cat":"devtools.timeline","name":"FunctionCall","args":{"data":{"url":"x"}}},'), null, 'a category outside the list is dropped')
  assert.equal(JSON.parse(filterTraceLine('{"ph":"X","cat":"cc,viz","name":"Hello world, Alice: your mail","dur":1}')).name, 'other', 'a name that is not an identifier becomes other')
  const meta = JSON.parse(filterTraceLine('{"ph":"M","pid":1,"tid":3,"name":"thread_name","args":{"name":"CrRendererMain"}}'))
  assert.equal(meta.args.name, 'CrRendererMain', 'thread and process names stay, so the trace can be read')
  assert.equal(JSON.parse(filterTraceLine('{"ph":"M","pid":1,"name":"process_name","args":{"name":"C:\\\\Users\\\\x"}}')).args.name, 'other')
  assert.equal(filterTraceLine('{"traceEvents":['), null)
  assert.equal(filterTraceLine('not json'), null)
})

test('TR5 retention: three trace files at most, the oldest go first', () => {
  const dir = path.join(fresh(), TRACE_DIR); fs.mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= 5; i++) { const f = path.join(dir, `2026-11-15T10-0${i}-00Z.json.gz`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, i, i) }
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'kept')
  pruneTraces(dir, 3)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-11-15T10-03-00Z.json.gz', '2026-11-15T10-04-00Z.json.gz', '2026-11-15T10-05-00Z.json.gz', 'unrelated.txt'])
})

test('TR6 the written file is gzip JSON with the canvas background and the stalls; one stall-trace log line says where', async () => {
  const root = fresh(), raw = path.join(root, 'raw.json'), out = path.join(root, TRACE_DIR, 'a.json.gz')
  fs.writeFileSync(raw, '{"traceEvents":[\n{"ph":"X","cat":"gpu","name":"SwapBuffers","ts":1,"dur":900000,"args":{}},\n{"ph":"X","cat":"devtools.timeline","name":"x"},\n{"ph":"M","pid":1,"name":"process_name","args":{"name":"GPU Process"}}\n],\n"metadata":{"command_line":"C:/Users/x/secret --flag"}}\n')
  const meta = { v: 1, app: '4.6.1 abc1234', armed_by: { ms: 1000, blocking: 0, scripts_ms: 10, window: W }, caught: null, canvas_bg: { theme: 'ascii', webgl: true } }
  const r = await processTrace(raw, out, meta)
  assert.equal(r.events, 2)
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString('utf8'))
  assert.deepEqual(doc.meta.canvas_bg, { theme: 'ascii', webgl: true })
  assert.equal(doc.traceEvents.length, 2)
  assert.equal(JSON.stringify(doc).includes('secret'), false, 'chromium metadata (command line) never lands')
  assert.equal(fs.existsSync(raw), false, 'the unfiltered recording is deleted')

  const { t, deps, run } = rig({ dir: path.join(fresh(), TRACE_DIR) })
  const tr = new StallTracer(deps)
  await tr.onStall('renderer-loaf', waiting(), W); await run(20_001)
  assert.equal(t.logged.length, 1)
  assert.deepEqual(Object.keys(t.logged[0]).sort(), ['bytes', 'canvas_bg', 'caught', 'events', 'file', 'ms'].sort())
  assert.equal(t.logged[0].caught, false)
  assert.match(t.logged[0].file, /^[0-9TZ-]+\.json\.gz$/, 'a bare file name, no path')
})

test('TR7 stall-log: renderer-loaf keeps canvas_bg as an enum and a boolean; a stall-trace line keeps its numbers and file name only', () => {
  const file = path.join(fresh(), 'diagnostics', 'ui-stalls.jsonl')
  const log = new StallLog({ file: () => file, app: () => '4.6.1 abc1234' })
  log.write('renderer-loaf', { ms: 900, loaf: { blocking: 0 }, canvas_bg: { theme: 'ascii', webgl: true, extra: 'x' } }, { id: W, org: true })
  log.write('renderer-loaf', { ms: 900, loaf: { blocking: 0 }, canvas_bg: { theme: 'C:/Users/x', webgl: 'yes' } }, { id: W, org: true })
  log.write('stall-trace', { ms: 20000, file: '2026-11-15T10-00-00Z.json.gz', events: 5000, bytes: 12345, caught: true, canvas_bg: { theme: 'dots', webgl: false }, path: 'C:/Users/x/secret' })
  log.write('stall-trace', { ms: 1, file: '../../evil.json.gz' })
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(ls[0].canvas_bg, { theme: 'ascii', webgl: true })
  assert.deepEqual(ls[1].canvas_bg, { theme: 'other' })
  assert.equal(ls[2].src, 'stall-trace'); assert.equal(ls[2].file, '2026-11-15T10-00-00Z.json.gz'); assert.equal(ls[2].events, 5000); assert.equal(ls[2].caught, true)
  assert.equal(JSON.stringify(ls[2]).includes('secret'), false)
  assert.equal(ls[3].file, undefined, 'a file name that is not a bare trace name is dropped')
})
