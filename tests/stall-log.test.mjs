// UI stall log (apps/desktop/main/stall-log.ts; spec ui-stall-tooling-spec rev 1.3 sections 2-3): ST3 redaction, ST6 the main-side
// rate cap, ST7 rotation and truncation. Item ui-freezes-intermittently-for-several-seconds-at.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(tmpdir(), 'orgtree-stall-log-'))
const bundle = path.join(temp, 'stall-log.cjs')
await build({ entryPoints: ['apps/desktop/main/stall-log.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
const { StallLog, STALL_LOG, redactFree, redactRoute, redactUrl } = createRequire(import.meta.url)(bundle)
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))

let roots = 0
const fresh = () => { const root = path.join(temp, `root-${++roots}`); fs.mkdirSync(root); return root }
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const clockAt = t => () => new Date(t.now)

test('the file is diagnostics/ui-stalls.jsonl and a record is one allowlisted v:1 line', () => {
  assert.equal(STALL_LOG, path.join('diagnostics', 'ui-stalls.jsonl'))
  const file = path.join(fresh(), STALL_LOG), t = { now: Date.parse('2026-11-04T19:00:00Z') }
  const log = new StallLog({ file: () => file, clock: clockAt(t), app: () => '4.5.5-alpha.4 fa64d93' })
  log.write('renderer-loaf', { at_ms: Date.parse('2026-11-04T18:59:59Z'), ms: 912.34, unknown_key: 'dropped', loaf: { blocking: 800, scripts: [{ fn: 'busy', ms: 700, extra: 1 }] },
    ctx: { screen: 'nonsense', panel: 'docket', popout: null }, input: [{ type: 'weird', target: 'desk-composer' }], dropped: 2 }, { id: 'w1', org: true })
  const [r] = lines(file)
  assert.equal(r.v, 1); assert.equal(r.src, 'renderer-loaf'); assert.equal(r.at, '2026-11-04T18:59:59.000Z'); assert.equal(r.ms, 912.3)
  assert.equal(r.window, 'w1'); assert.equal(r.org_window, true); assert.equal(r.app, '4.5.5-alpha.4 fa64d93'); assert.equal(r.dropped, 2); assert.equal(r.truncated, false)
  assert.equal('unknown_key' in r, false, 'unknown keys are dropped')
  assert.equal(r.loaf.scripts[0].extra, undefined)
  assert.deepEqual(r.ctx, { screen: 'other', panel: 'docket', popout: null }, 'an enum value outside its enum becomes other')
  assert.equal(r.input[0].type, 'other'); assert.equal(r.input[0].target, 'desk-composer')
})

test('ST3 paths, free strings and routes are redacted before anything is written', () => {
  assert.equal(redactUrl('file:///C:/Users/x/AppData/Local/Programs/Orgtree/resources/app/x.js?v=1#frag'), 'app:/x.js')
  assert.equal(redactUrl('file:///C:/Users/x/AppData/.../app/x.js'), 'app:/x.js')
  assert.equal(redactUrl('http://127.0.0.1:5173/assets/a.js?q=1'), 'app:/assets/a.js')
  assert.equal(redactRoute('/api/orgs/acme/agents/bob/mail?x=1'), '/api/orgs/<org>/agents/<id>/mail')
  assert.equal(redactRoute('http://127.0.0.1:9/api/orgs/acme/work/ticket-1/diff'), '/api/orgs/<org>/work/<id>/diff')
  const frame = redactFree('at send (a@b.com) Bearer abcdefghijklmnop D:\\a\\b ok')
  assert.ok(!frame.includes('a@b.com') && !frame.includes('abcdefghijklmnop') && !frame.includes('D:\\a'), frame)
  assert.match(frame, /<redacted:emails>/); assert.match(frame, /<redacted:secrets>/); assert.match(frame, /<redacted:paths>/)
  const file = path.join(fresh(), STALL_LOG)
  const log = new StallLog({ file: () => file })
  log.write('renderer-loaf', { ms: 900, loaf: { scripts: [{ fn: 'f (D:\\Users\\bob\\x.js)', url: 'file:///C:/Users/x/AppData/.../app/x.js' }] },
    fetch: [{ route: '/api/orgs/acme/agents/bob/mail?x=1', method: 'GET', age_ms: 5 }] })
  log.write('renderer-ping', { blocked_ms: 900, stacks: ['at busy (file:///C:/Users/x/AppData/.../app/x.js:10:5)\nat k (D:\\a\\b:1:1)', 'unavailable:no-api'] })
  log.write('main-lag', { lag_ms: 800, main_stack: 'unavailable:not-attempted' })
  const [loaf, ping, lag] = lines(file)
  assert.equal(loaf.loaf.scripts[0].url, 'app:/x.js'); assert.ok(loaf.loaf.scripts[0].fn.includes('<redacted:paths>'))
  assert.equal(loaf.fetch[0].route, '/api/orgs/<org>/agents/<id>/mail')
  assert.deepEqual(ping.stacks[0], ['at busy (app:/x.js:10:5)', 'at k (<redacted:paths>:1:1)'])
  assert.equal(ping.stacks[1], 'unavailable:no-api'); assert.equal(lag.main_stack, 'unavailable:not-attempted')
  assert.ok(!fs.readFileSync(file, 'utf8').includes('bob'), 'no name survives')
})

test('ST6 the writer allows 30 lines a minute and counts what it dropped on the next line', () => {
  const file = path.join(fresh(), STALL_LOG), t = { now: 1_800_000_000_000 }
  const log = new StallLog({ file: () => file, clock: clockAt(t) })
  for (let i = 0; i < 40; i++) { t.now += 1000; log.write('sync-ipc', { ms: 150, channel: 'c' + i }) }
  assert.equal(lines(file).length, 30)
  t.now += 120_000
  log.write('sync-ipc', { ms: 150, channel: 'later' })
  const all = lines(file)
  assert.equal(all.length, 31); assert.equal(all[30].dropped, 10); assert.equal(all[29].dropped, 0)
})

test('ST7 rotation keeps three files at most; an oversize record is truncated to 16 KB; a bad directory never throws', () => {
  const root = fresh(), file = path.join(root, STALL_LOG), t = { now: 1_800_000_000_000 }
  const log = new StallLog({ file: () => file, clock: clockAt(t), maxBytes: 2000 })
  for (let i = 0; i < 24; i++) { t.now += 5000; log.write('main-lag', { lag_ms: 800, main_stack: Array.from({ length: 6 }, (_, k) => `fn${i}_${k} (app:/a.js:${k}:1)`) }) }
  const present = fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('ui-stalls.jsonl')).sort()
  assert.deepEqual(present, ['ui-stalls.jsonl', 'ui-stalls.jsonl.1', 'ui-stalls.jsonl.2'])
  const big = path.join(fresh(), STALL_LOG)
  const log2 = new StallLog({ file: () => big, clock: clockAt({ now: 5 }) })
  log2.write('renderer-ping', { blocked_ms: 900, stacks: [Array.from({ length: 3000 }, (_, k) => 'fn' + k + ' (app:/' + 'a'.repeat(150) + '.js:1:' + k + ')'), 'x'.repeat(5000)] })
  const raw = fs.readFileSync(big, 'utf8')
  assert.ok(Buffer.byteLength(raw) <= 16 * 1024 + 1, 'at most 16 KB: ' + raw.length)
  const [r] = lines(big)
  assert.equal(r.truncated, true); assert.ok(r.stacks[0].length <= 40, 'stacks are cut first (40 frames)')
  const blocker = path.join(fresh(), 'afile'); fs.writeFileSync(blocker, 'x')
  const bad = new StallLog({ file: () => path.join(blocker, 'sub', STALL_LOG) })
  assert.doesNotThrow(() => bad.write('sync-ipc', { ms: 200, channel: 'c' }))
  assert.doesNotThrow(() => new StallLog({ file: () => undefined }).write('sync-ipc', {}))
})
