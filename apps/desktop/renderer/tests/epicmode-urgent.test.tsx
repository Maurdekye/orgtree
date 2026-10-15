// EPIC Mode — urgent mail is the loudest moment in the show (docket
// epic-mode-make-urgent-mail-s-effect-much-more-ey; user 2026-10-15 14:47Z:
// "yep, it has an effect, but it's not significantly more impressive or eye
// catching than anything else"; 14:48Z: "could be a massive blaring alarm that
// tints and fades the entire screen", "not excessively loud but very attention
// demanding and obnoxious").
//
// What the user asked for, as behaviour these tests can see:
// - the whole window is tinted, in every window showing the org, and the tint
//   fades in and out in SLOW pulses: each at least 0.4 s apart and never more
//   than three in a second (never a strobe), lasting seconds, not a blink;
// - an insistent alarm sound that repeats while it lasts, at EPIC's normal
//   level (no gain above 1);
// - it ends when the urgent mail is read, or by itself within a bounded time;
// - it plays once per urgent message and never for ordinary mail.
//
// Each window's stage draws on a recording context that remembers its
// globalAlpha and notes, frame by frame (a frame starts at the stage's
// clearRect), the strongest fill that covers the whole window: that is the
// tint's level over time. Real pictures are checked in Electron by
// tools/rig/epic-mode-visual.mjs (the urgent scene).

import { flush, JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { startEpic } from '../src/epic/director'
import type { EpicShow } from '../src/epic/director'
import * as taps from '../src/epic/tap'
import { registerWindow } from '../src/windowlife'
import type { TreeNode, TreePayload } from '../src/types'
import { fakeAudio } from './epicmode-fakes'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// ------------------------------------------------------------------ fixture
function node(id: string): TreeNode {
  return {
    id, title: id, tier: 'opus', model_id: 'claude-opus', state: 'live', seat: 5, grant: 10, free: 0,
    ui_order: 1, created: new Date(Date.now() - 3_600_000).toISOString(), cost_usd: 0, occupancy: 0.2,
    context_window: 200000, charter: null, mail_pending: 0, limit_locked: false, resumable: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [], turns: [], frozen: null,
    audiences_held: [], bearer_state: null, generation: 1, children: [], lineage: [], busy: false,
    proc_warm: false, proc_live: false, waiting: false, responding: false, phase: null, queued: 0,
    last_error: null, activity: { phase: 'idle' },
  } as unknown as TreeNode
}
/** the org with `inbox` unread messages for the user, `urgent` of them urgent */
function tree(inbox: number, urgent: number): TreePayload {
  return {
    slug: 'acme', name: 'Acme', roots: [node('boss'), node('alice')],
    work_items_summary: { attention: 0, active: 0, raises: [] },
    user_inbox_count: inbox, urgent_unread: urgent, org_inbox: { unread: 0 }, watchdogs: [], audiences: [],
    credit_requests: [], cost_usd_total: 0, killswitch: null, dirs: [],
  } as unknown as TreePayload
}

// ------------------------------------------------------------- recording
interface Frame { t: number; level: number }

/** Every stage made in `win` from now on draws on a context that records,
 *  per frame, the most opaque fill covering the whole window. */
function recordTint(win: Window): { frames: Frame[]; restore: () => void } {
  const frames: Frame[] = []
  const proto = (win as unknown as { HTMLCanvasElement: { prototype: { getContext: unknown } } }).HTMLCanvasElement.prototype
  const had = proto.getContext
  proto.getContext = () => {
    let alpha = 1
    const saved: number[] = []
    return new Proxy({}, {
      get(_target, key) {
        if (key === 'globalAlpha') return alpha
        if (key === 'save') return () => { saved.push(alpha) }
        if (key === 'restore') return () => { alpha = saved.pop() ?? 1 }
        if (key === 'clearRect') return () => { frames.push({ t: performance.now(), level: 0 }) }
        if (key === 'fillRect') {
          return (x: number, y: number, w: number, h: number) => {
            const frame = frames[frames.length - 1]
            if (frame && x <= 0 && y <= 0 && w >= win.innerWidth && h >= win.innerHeight) frame.level = Math.max(frame.level, alpha)
          }
        }
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} })
        if (key === 'measureText') return (s: string) => ({ width: String(s).length * 7 })
        if (key === 'then') return undefined
        return () => undefined
      },
      set(_target, key, value) { if (key === 'globalAlpha') alpha = Number(value); return true },
    })
  }
  return { frames, restore: () => { proto.getContext = had } }
}

/** every sound the show plays, when, and how loud it was asked to be */
function recordSounds(show: EpicShow): { name: string; t: number; gain: number }[] {
  const heard: { name: string; t: number; gain: number }[] = []
  const s = show as unknown as { sound: (name: string, c: unknown, opts?: { gain?: number }) => void }
  const sound = s.sound.bind(show)
  s.sound = (name, c, opts = {}) => {
    heard.push({ name, t: performance.now(), gain: opts.gain ?? 1 })
    sound(name, c, opts)
  }
  return heard
}

/** the strongest tint in frames drawn between `from` and `to` (ms) */
const strongest = (frames: Frame[], from: number, to: number): number =>
  Math.max(0, ...frames.filter(f => f.t >= from && f.t <= to).map(f => f.level))

/** When each pulse of the tint rose: a pulse is counted when the level climbs
 *  past 80% of the strongest level seen, after having fallen below 45% of it. */
function pulses(frames: Frame[], from: number): number[] {
  const after = frames.filter(f => f.t >= from)
  const top = Math.max(0, ...after.map(f => f.level))
  const rises: number[] = []
  let low = true
  for (const f of after) {
    if (low && f.level >= top * 0.8) { rises.push(f.t); low = false }
    else if (!low && f.level < top * 0.45) low = true
  }
  return rises
}

interface Run { show: EpicShow; main: Frame[]; heard: { name: string; t: number; gain: number }[]; end: () => void }

/** a show over a quiet org: the first tree is the baseline */
function run(): Run {
  const tint = recordTint(window)
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  const heard = recordSounds(show)
  taps.epic!.tree('acme', tree(2, 0))
  return { show, main: tint.frames, heard, end: () => { show.stop(); tint.restore() } }
}

/** the sounds heard from `from` on, by name */
const countOf = (heard: Run['heard'], from: number) => {
  const n = new Map<string, number>()
  for (const h of heard) if (h.t >= from) n.set(h.name, (n.get(h.name) ?? 0) + 1)
  return n
}
/** the sound the alarm repeats: the most frequent one since it began */
const alarmSound = (heard: Run['heard'], from: number) =>
  [...countOf(heard, from)].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]

// ------------------------------------------------------------------ the tests
test('urgent mail tints the whole window in slow pulses, for seconds, in every window showing the org', async () => {
  const dom = new JSDOM('<!doctype html><body><div class="sq" data-first-use-agent="alice">alice</div></body>', { url: 'http://localhost/' })
  const popout = dom.window as unknown as Window
  ;(popout as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16)
  ;(popout as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: number) => clearTimeout(id)
  const other = recordTint(popout)
  const r = run()
  const unregister = registerWindow({ id: 'epic-urgent-popout', kind: 'desk', org: 'acme', editable: false, window: popout, redock: () => {} })
  try {
    const at = performance.now()
    taps.epic!.tree('acme', tree(3, 1))
    await wait(3300)
    assert.equal(strongest(r.main, at, at + 1000) >= 0.15, true, `the window is tinted, strongly (at most ${strongest(r.main, at, at + 1000)})`)
    assert.equal(strongest(r.main, at + 2600, at + 3300) > 0.05, true, 'and still tinted almost three seconds on: an alarm, not a blink')
    const rises = pulses(r.main, at)
    assert.equal(rises.length >= 3, true, `the tint pulses (${rises.length} pulses)`)
    const gaps = rises.slice(1).map((t, i) => Math.round(t - rises[i]!))
    assert.equal(gaps.every(g => g >= 400), true, `each pulse at least 0.4 s after the one before, never a strobe: gaps ${gaps.join(', ')} ms`)
    const busiest = Math.max(...rises.map(t => rises.filter(u => u >= t && u < t + 1000).length))
    assert.equal(busiest <= 3, true, `no more than three pulses in any second (${busiest})`)
    assert.equal(strongest(other.frames, at, at + 3300) >= 0.15, true, 'the popped-out window showing the org is tinted too')
  } finally {
    unregister()
    r.end()
    other.restore()
    dom.window.close()
  }
})

test('its alarm repeats while it lasts, insistently, at EPIC\'s normal level', async () => {
  const r = run()
  try {
    const at = performance.now()
    taps.epic!.tree('acme', tree(3, 1))
    await wait(3300)
    const [name, times] = alarmSound(r.heard, at)
    assert.equal(times >= 4, true, `one sound repeats as the alarm: "${name}" played ${times} times in 3.3 s`)
    const loud = r.heard.filter(h => h.t >= at && h.gain > 1)
    assert.deepEqual(loud.map(h => h.name), [], 'and nothing is played louder than EPIC\'s normal level')
  } finally { r.end() }
})

test('reading the urgent mail ends the alarm', async () => {
  const r = run()
  try {
    const at = performance.now()
    taps.epic!.tree('acme', tree(3, 1))
    await wait(1300)
    assert.equal(strongest(r.main, at + 1000, at + 1300) > 0.05, true, 'the alarm is still on after a second')
    const [name] = alarmSound(r.heard, at)
    const read = performance.now()
    taps.epic!.tree('acme', tree(2, 0))
    await wait(1300)
    assert.equal(strongest(r.main, read + 900, read + 1300), 0, 'within a second of the mail being read the tint is gone')
    assert.equal(r.heard.filter(h => h.name === name && h.t > read + 100).length, 0, `and "${name}" stopped`)
  } finally { r.end() }
})

test('unread, the alarm still ends by itself within ten seconds', async () => {
  const r = run()
  try {
    const at = performance.now()
    taps.epic!.tree('acme', tree(3, 1))
    await wait(4000)
    assert.equal(strongest(r.main, at + 3500, at + 4000) > 0.05, true, 'the alarm lasts for seconds')
    const [name] = alarmSound(r.heard, at)
    await wait(6200)
    assert.equal(strongest(r.main, at + 9800, at + 10200), 0, 'ten seconds on, the tint is gone')
    assert.equal(r.heard.filter(h => h.name === name && h.t > at + 9500).length, 0, `and "${name}" has stopped`)
  } finally { r.end() }
})

test('ordinary mail never sounds the alarm', async () => {
  const r = run()
  try {
    const at = performance.now()
    taps.epic!.tree('acme', tree(3, 0))
    await wait(1500)
    assert.equal(strongest(r.main, at, at + 1500), 0, 'no tint over the window')
    const [name, times] = alarmSound(r.heard, at)
    assert.equal(times <= 1, true, `no sound repeats ("${name}" ${times} times)`)
  } finally { r.end() }
})

test('the same urgent mail, delivered again, does not sound it again', async () => {
  const r = run()
  try {
    const before = r.show.staged
    taps.epic!.tree('acme', tree(3, 1))
    await wait(300)
    const once = r.show.staged
    assert.equal(once > before, true, 'the urgent mail played')
    taps.epic!.tree('acme', tree(3, 1))
    taps.epic!.tree('acme', tree(3, 1))
    await wait(300)
    assert.equal(r.show.staged, once, 'the same tree again stages nothing more')
  } finally { r.end() }
})

// Another org's urgent mail comes as an app-feed notice (in the window the
// user is looking at) and sounds the same alarm. Reading THAT mail, which
// takes its notice off the feed, ends it; another notice going does not
// (rig-sol-b's review of slice 1 and the coordinator's ruling, 2026-10-15).
test('another org\'s urgent mail: reading it ends its own alarm, and another notice going does not', async () => {
  const g = globalThis as unknown as { fetch: typeof fetch; WebSocket: unknown }
  const before = { fetch: g.fetch, WebSocket: g.WebSocket }
  const sockets: FeedSocket[] = []
  class FeedSocket {
    onmessage: ((e: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const epoch = 'epic-urgent-feed'
  const registry = { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'a', incarnation: 'i', rev: 1 }, records: [
    { entity: 'registry_org', id: '1', body: { org_id: 1, slug: 'acme', org_uuid: 'u1', state: 'active' } },
    { entity: 'registry_org', id: '2', body: { org_id: 2, slug: 'other', org_uuid: 'u2', state: 'active' } },
  ] }
  const notices = (seq: number, rows: unknown[]) =>
    ({ type: 'org_notices', epoch, seq, org_id: 2, org_uuid: 'u2', incarnation: 'i', rev: seq, notices: rows })
  const urgent = (id: string, agent: string) => ({ org: 'other', id, kind: 'urgent-mail', agent, title: id, body: 'b' })
  const copy = { type: 'app_snapshot', epoch, seq: 1, registry, summaries: {}, notices: { 2: notices(1, []) }, runtime: { values: {}, orgs: {} } }
  g.WebSocket = FeedSocket
  g.fetch = (async () => new Response(JSON.stringify(copy), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const hasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  const r = run()
  try {
    await flush(10)
    assert.equal(sockets.length, 1, 'the show reads the app feed')
    sockets[0]!.frame(copy)
    await flush(5)
    sockets[0]!.frame(notices(2, [urgent('m1', 'eve')]))
    await flush(5)
    await wait(300)
    // bob's urgent mail comes in: its alarm takes over from eve's
    sockets[0]!.frame(notices(3, [urgent('m1', 'eve'), urgent('m2', 'bob')]))
    await flush(5)
    const second = performance.now()
    await wait(300)
    // eve's mail is read: her notice goes, and bob's alarm sounds on
    sockets[0]!.frame(notices(4, [urgent('m2', 'bob')]))
    await flush(5)
    const other = performance.now()
    await wait(1300)
    assert.equal(strongest(r.main, other + 900, other + 1300) > 0.05, true, 'another notice going leaves the alarm sounding')
    const [name] = alarmSound(r.heard, second)
    // bob's mail is read: its own notice goes, and its alarm ends
    const read = performance.now()
    sockets[0]!.frame(notices(5, []))
    await flush(5)
    await wait(1300)
    assert.equal(strongest(r.main, read + 900, read + 1300), 0, 'within a second of its mail being read the tint is gone')
    assert.equal(r.heard.filter(h => h.name === name && h.t > read + 100).length, 0, `and "${name}" stopped`)
  } finally {
    r.end()
    if (hasFocus) Object.defineProperty(document, 'hasFocus', hasFocus)
    else delete (document as unknown as { hasFocus?: unknown }).hasFocus
    Object.assign(g, before)
  }
})
