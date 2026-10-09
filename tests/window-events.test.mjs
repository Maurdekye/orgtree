// The window log (decision 60): every main window's minimize, restore, show,
// hide and focus, and the Orgtree actions behind them, one JSON line each in
// diagnostics/desktop-windows.jsonl, so a repeat of "my window got minimized"
// shows whether Orgtree did it. Cheap (no per-frame events, rotated) and best
// effort (never throws).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(tmpdir(), 'orgtree-window-events-'))
const bundle = path.join(temp, 'window-events.cjs')
await build({ entryPoints: ['apps/desktop/main/window-events.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
const { WindowEventLog, watchWindowEvents, WINDOW_EVENT_TYPES, WINDOW_EVENTS_LOG } = createRequire(import.meta.url)(bundle)
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))

let roots = 0
const freshRoot = () => { const root = path.join(temp, `root-${++roots}`); fs.mkdirSync(root); return root }
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

test('each event and each Orgtree action is one line with the time, the window and its organization', () => {
  const root = freshRoot(), file = path.join(root, WINDOW_EVENTS_LOG)
  const log = new WindowEventLog(() => file, undefined, () => new Date('2026-10-09T07:47:33.000Z'))
  log.record('w1', { kind: 'org', org: 'maurdekye-works' }, { action: 'reveal' })
  log.record('w1', { kind: 'org', org: 'maurdekye-works' }, { event: 'show' })
  log.record('w2', { kind: 'org', org: 'orgtree' }, { event: 'minimize' })
  assert.equal(WINDOW_EVENTS_LOG, path.join('diagnostics', 'desktop-windows.jsonl'))
  assert.deepEqual(lines(file), [
    { at: '2026-10-09T07:47:33.000Z', window: 'w1', kind: 'org', org: 'maurdekye-works', action: 'reveal' },
    { at: '2026-10-09T07:47:33.000Z', window: 'w1', kind: 'org', org: 'maurdekye-works', event: 'show' },
    { at: '2026-10-09T07:47:33.000Z', window: 'w2', kind: 'org', org: 'orgtree', event: 'minimize' },
  ])
})

test('exactly minimize, restore, show, hide and focus are watched: nothing per frame', () => {
  assert.deepEqual([...WINDOW_EVENT_TYPES], ['minimize', 'restore', 'show', 'hide', 'focus'])
  const root = freshRoot(), file = path.join(root, WINDOW_EVENTS_LOG)
  const window = new EventEmitter()
  let facts = { kind: 'homepage' }
  watchWindowEvents(window, 'w3', () => facts, new WindowEventLog(() => file))
  assert.deepEqual(window.eventNames().sort(), ['focus', 'hide', 'minimize', 'restore', 'show'])
  for (const busy of ['move', 'moved', 'resize', 'resized', 'blur']) assert.equal(window.listenerCount(busy), 0, `${busy} is not watched`)
  window.emit('show'); window.emit('focus')
  facts = { kind: 'org', org: 'unity' }   // the Homepage bound an organization
  window.emit('minimize'); window.emit('restore'); window.emit('hide')
  window.emit('move'); window.emit('resize')
  assert.deepEqual(lines(file).map(l => [l.event, l.kind, l.org]), [
    ['show', 'homepage', undefined], ['focus', 'homepage', undefined],
    ['minimize', 'org', 'unity'], ['restore', 'org', 'unity'], ['hide', 'org', 'unity'],
  ], 'facts are read at event time')
})

test('the file is rotated past its cap, so it never grows without bound', () => {
  const root = freshRoot(), file = path.join(root, WINDOW_EVENTS_LOG)
  const log = new WindowEventLog(() => file, 400)
  for (let i = 0; i < 40; i++) log.record(`w${i}`, { kind: 'org', org: 'orgtree' }, { event: 'focus' })
  assert.ok(fs.statSync(file).size <= 400 + 200, 'the live file stays near the cap')
  assert.ok(fs.existsSync(file + '.1'), 'one previous file is kept')
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['desktop-windows.jsonl', 'desktop-windows.jsonl.1'], 'and only one')
  assert.equal(lines(file).at(-1).window, 'w39', 'the newest line is in the live file')
})

test('best effort: no data root yet, or an unwritable one, never throws', () => {
  assert.doesNotThrow(() => new WindowEventLog(() => undefined).record('w1', undefined, { event: 'show' }))
  const root = freshRoot()
  fs.writeFileSync(path.join(root, 'diagnostics'), 'a file where the folder should be')
  const blocked = path.join(root, WINDOW_EVENTS_LOG)
  assert.doesNotThrow(() => new WindowEventLog(() => blocked).record('w1', { kind: 'org', org: 'orgtree' }, { event: 'minimize' }))
  assert.doesNotThrow(() => new WindowEventLog(() => { throw new Error('no root') }).record('w1', undefined, { event: 'hide' }))
})

test('main/index.ts logs every main window and each Orgtree cause before it acts', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(main, /const windowEvents = new WindowEventLog\(\(\) =>\s*engineRestartOptions\?\.dataRoot \? path\.join\(engineRestartOptions\.dataRoot, WINDOW_EVENTS_LOG\) : undefined\)/,
    'the log lives in the engine data root\'s diagnostics folder')
  assert.match(main, /const windowFacts = \(id: string\) => \{ const entry = windows\.get\(id\); return entry && \{ kind: entry\.kind, org: entry\.org \} \}/,
    'facts come from windows.get, which does not reconcile notification ownership')
  assert.match(main, /records\.set\(id, record\)\s*if \(registerNow\) windows\.register\([^\n]*\)\s*watchWindowEvents\(window, id, \(\) => windowFacts\(id\), windowEvents\)/,
    'every main window is watched from the moment it is built')
  assert.match(main, /windowEvents\.record\(record\.id, windowFacts\(record\.id\), \{ action: 'reveal' \}\)\s*revealOnly\(record\)/, 'a reveal is logged before it happens')
  assert.match(main, /windowEvents\.record\(caller\.id, windowFacts\(caller\.id\), \{ action: 'minimize-button' \}\)\s*caller\.window\.minimize\(\)/, 'so is the minimize button')
  assert.match(main, /hide: \(\) => \{ windowEvents\.record\(id, windowFacts\(id\), \{ action: 'close-hide' \}\); window\.hide\(\) \}/, 'and the close that hides')
})
