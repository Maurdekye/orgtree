// agefmt.test.tsx — every age in Orgtree is read on one scale (USER 2026-10-29
// m1baa42b32cb6 "do this", after UX symmetry audit #7, USER m019c9500d23a). The
// older ago() counted hours forever, so the tray, a pile row and an idle or
// halted clock read "72h" or "480h" where every list now reads "3d" or "3w"
// (timefmt.fmtAge). Each of those cells also carries the full local date and
// time as its hover (the list rule, canvas/listage.tsx), and ago() is gone so
// no new surface can bring the second format back. The Changelog keeps its
// release date (USER m134c95331ab0): it never used ago().
import './harness'
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { AgentWorkstate, LastTurnAge, MapTurnAge, TrayStatus, TurnStatusBanner } from '../src/canvas/desk'
import { AgentTray } from '../src/canvas/agenttray'
import { fmtFull } from '../src/timefmt'
import type { CanvasNode } from '../src/canvas/shared'

declare const __SRC_DIR__: string

const NOW = Date.parse('2026-10-14T12:00:00Z')
const DAY = 86_400
const at = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()
const node = (extra: Record<string, unknown> = {}): CanvasNode => ({ id: 'fixture', tier: 'haiku', state: 'live',
  children: [], lineage: [], turns: [], halt: null, frozen: null, busy: false, waiting: false, occupancy: null,
  context_window: null, last_status: null, prev_status: null, ...extra } as unknown as CanvasNode)
const turnAt = (seconds: number, killed = false) => ({ at: at(seconds), killed, cost: 0, denials: 0 })
const ended = (seconds: number) => 'last turn ended ' + fmtFull(at(seconds))

test('the tray row reads an old turn and an old halt in days and weeks, with the full time on hover', async t => {
  t.mock.method(Date, 'now', () => NOW)
  const v = await mountView(<TrayStatus node={node()} turn={turnAt(3 * DAY)} />, el => el)
  t.after(() => v.unmount())
  const idle = v.el.querySelector('.tray-status-time')!
  assert.equal(idle.textContent?.trim(), '3d')
  assert.equal(idle.getAttribute('title'), ended(3 * DAY))
  assert.equal(idle.getAttribute('aria-label'), ended(3 * DAY))
  const halt = { phase: 'halted' as const, requested_at: at(21 * DAY), at: at(20 * DAY), by: 'user' }
  await v.render(<TrayStatus node={node({ halt })} />)
  const halted = v.el.querySelector('.tray-status-time')!
  assert.equal(halted.textContent?.trim(), '3w')
  assert.equal(halted.getAttribute('title'), 'Halted since ' + fmtFull(halt.at))
  assert.equal(halted.getAttribute('aria-label'), 'Halted since ' + fmtFull(halt.at))
})

test('a turn that has run for days reads in days, and says when it started on hover', async t => {
  t.mock.method(Date, 'now', () => NOW)
  const inflight = at(2 * DAY)
  const v = await mountView(<TrayStatus node={node({ busy: true, inflight_at: inflight })} />, el => el)
  t.after(() => v.unmount())
  const time = v.el.querySelector('.tray-status-time')!
  assert.equal(time.textContent?.trim(), '2d')
  assert.equal(time.getAttribute('title'), 'active since ' + fmtFull(inflight))
  assert.equal(v.el.querySelector('.tray-status-label')?.getAttribute('title'), 'active for 2d')
})

test('the zoom card and the desk header read idle and halted clocks the same way', async t => {
  t.mock.method(Date, 'now', () => NOW)
  const turn = turnAt(3 * DAY, true)
  const halt = { phase: 'halted' as const, requested_at: at(21 * DAY), at: at(20 * DAY), by: 'user' }
  const v = await mountView(<>
    <div data-s="idle"><AgentWorkstate node={node()} turn={turn} /></div>
    <div data-s="halted"><AgentWorkstate node={node({ halt })} turn={turn} /></div>
    <div data-s="banner-idle"><TurnStatusBanner state="idle" turn={turn} /></div>
    <div data-s="banner-halted"><TurnStatusBanner state="idle" turn={turn} halted haltedAt={halt.at} /></div>
    <div data-s="banner-active"><TurnStatusBanner state="working" inflightAt={at(2 * DAY)} /></div>
  </>, el => el)
  t.after(() => v.unmount())
  const cell = (s: string, sel: string) => v.el.querySelector<HTMLElement>(`[data-s="${s}"] ${sel}`)!
  assert.equal(cell('idle', '.sq-idle-time').textContent, '3d')
  assert.equal(cell('idle', '.sq-idle-time').getAttribute('title'), ended(3 * DAY) + ' (killed)')
  assert.equal(cell('halted', '.sq-halt-status .sq-idle-time').textContent, '3w')
  assert.equal(cell('halted', '.sq-halt-status .sq-idle-time').getAttribute('title'), 'Halted since ' + fmtFull(halt.at))
  assert.equal(cell('banner-idle', '.turn-status-time').textContent, '3d')
  assert.equal(cell('banner-halted', '.turn-status-time').textContent, '3w')
  assert.equal(cell('banner-halted', '.turn-status-banner').getAttribute('aria-label'), 'Halted for 3w')
  assert.equal(cell('banner-active', '.turn-status-time').textContent, '2d')
})

test('a map clock and a card badge read an old turn in days, with the full time on hover', async t => {
  t.mock.method(Date, 'now', () => NOW)
  const turn = turnAt(3 * DAY)
  const v = await mountView(<>
    <div data-s="map"><MapTurnAge node={node()} turn={turn} /></div>
    <div data-s="map-running"><MapTurnAge node={node({ busy: true, inflight_at: at(2 * DAY) })} turn={turn} /></div>
    <div data-s="badge"><LastTurnAge turn={turn} /></div>
    <div data-s="inline"><LastTurnAge turn={turn} variant="inline" /></div>
  </>, el => el)
  t.after(() => v.unmount())
  const map = v.el.querySelector<HTMLElement>('[data-s="map"] .map-ago')!
  assert.equal(map.textContent, '3d')
  assert.equal(map.getAttribute('title'), ended(3 * DAY))
  const running = v.el.querySelector<HTMLElement>('[data-s="map-running"] .map-ago')!
  assert.equal(running.textContent, '2d')
  assert.equal(running.getAttribute('title'), 'running since ' + fmtFull(at(2 * DAY)))
  for (const s of ['badge', 'inline']) {
    const cell = v.el.querySelector<HTMLElement>(`[data-s="${s}"] span`)!
    assert.equal(cell.textContent, '3d', s)
    assert.equal(cell.getAttribute('title'), ended(3 * DAY), s)
  }
})

test('the agents tray says how long ago a status was written in days, with the full time on hover', async t => {
  t.mock.method(Date, 'now', () => NOW)
  const last = { status: 'idle', summary: 'Retained last status', at: at(3 * DAY) }
  const nodes = [node({ id: 'old-status', last_status: last })]
  const v = await mountView(<AgentTray map={new Map(nodes.map(n => [n.id, n]))} rows={nodes.map(n => ({ node: n, depth: 0 }))}
    query="" onQuery={() => {}} archived={false} onArchived={() => {}} onPick={() => {}} />, el => el)
  t.after(() => v.unmount())
  const when = v.el.querySelector<HTMLElement>('.tray-sum-at')!
  assert.equal(when.textContent, ' · 3d ago')
  assert.equal(when.getAttribute('title'), fmtFull(last.at))
  assert.equal(when.getAttribute('aria-label'), fmtFull(last.at))
  assert.equal(v.el.querySelector('.tray-sum')?.getAttribute('title'), last.summary, 'the summary keeps its own hover')
})

/** Every .ts/.tsx under the renderer's src folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(name) ? [full] : []
  })
}

test('ago() is gone: no surface counts hours forever, and none can bring the second format back', () => {
  const shared = readFileSync(path.join(__SRC_DIR__, 'canvas', 'shared.ts'), 'utf8')
  assert.doesNotMatch(shared, /export const ago\b/, 'canvas/shared.ts still exports ago()')
  const stragglers = sources(__SRC_DIR__).flatMap((file) => {
    const text = readFileSync(file, 'utf8'), name = path.relative(__SRC_DIR__, file).replace(/\\/g, '/')
    const calls = text.split('\n').flatMap((line, i) => (/(^|[^\w.$])ago\(/.test(line) ? [`${name}:${i + 1} calls ago()`] : []))
    // an import list can span lines, so it is judged on the whole file
    return /\bimport\s*(?:type\s*)?\{[^}]*\bago\b[^}]*\}/.test(text) ? [...calls, `${name} imports ago`] : calls
  })
  assert.deepEqual(stragglers, [], 'these still use ago() instead of fmtAge')
})
