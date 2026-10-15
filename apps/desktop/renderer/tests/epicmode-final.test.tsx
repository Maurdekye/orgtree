// EPIC Mode — what the final version folded into the Opus take
// (docs/rust-engine/epic-mode-final.md).
//
// The Opus take's suites carry the switch (epicmode-switch), the off contract
// (epicmode-off) and the engine room (epicmode-engine). This suite covers the
// pieces brought over from the other three takes, each through the real
// module it lives in: the combo (count, ranks, milestones, meter, pitch ladder
// — Wonder Full, Argon, Astra), the agent's name under every word (Argon,
// Astra), the crystal ice spike (Argon), streamed text as pentatonic runs
// (Argon), a refused change and an interrupt that only celebrates once the
// engine accepted it (Astra, through the real api.ts), other organizations'
// notices and a 100% usage reading that never says LIMIT (Wonder Full and
// Astra, through the real app feed), the canvas pixel budget (Astra),
// popped-out windows getting their own stage, and the native preferences
// file keeping the switch across a restart (Astra).
//
// Absence checks compare booleans: a failing assertion handed a rendered
// element exhausts the reporter's memory (team notes, rig-opus 2026-10-14).

import { flush, JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  COMBO_DECAY_MS, METER_FROM, MILESTONES, RANKS, climbFor, noteRatio, rankOf, startEpic,
} from '../src/epic/director'
import { EpicSynth } from '../src/epic/audio'
import { MAX_DPR, MAX_PIXELS, Stage } from '../src/epic/stage'
import type { Spot } from '../src/epic/locate'
import * as taps from '../src/epic/tap'
import { interruptNode, req } from '../src/api'
import { registerWindow } from '../src/windowlife'
import { Preferences } from '../../main/preferences'
import type { TreeNode, TreePayload } from '../src/types'
import { fakeAudio, recordCanvas } from './epicmode-fakes'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const at = (x: number, y: number, doc: Document = document): Spot => ({ x, y, rect: null, el: null, doc })
const g = globalThis as unknown as { fetch: typeof fetch; WebSocket: unknown }
/** a fetch stub for one test: the app feed's capability probe is answered as
 *  a legacy engine (501: no socket, no retries), everything else by `answer` */
const engine = (answer: (path: string) => Response): typeof fetch => (async (input: RequestInfo | URL) => {
  const p = new URL(String(input), 'http://localhost').pathname
  return p === '/api/app/records'
    ? new Response(JSON.stringify({ detail: 'fixture: legacy engine' }), { status: 501 })
    : answer(p)
}) as typeof fetch
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('the combo ladder: ranks, milestones, the pitch ladder and each agent\'s pentatonic run', () => {
  assert.deepEqual(MILESTONES, [10, 25, 50, 100, 200, 400])
  assert.equal(RANKS.length, MILESTONES.length + 1)
  assert.deepEqual([1, 9, 10, 25, 50, 100, 200, 4000].map(n => rankOf(n).name), [
    'SPECTACLE ONLINE', 'SPECTACLE ONLINE', 'HYPER-STREAK', 'OVERDRIVE', 'HYPERDRIVE', 'SUPERNOVA',
    'ABSOLUTE CHAOS', 'CACOPHONY MAXIMA',
  ])
  assert.equal(climbFor(0), 1)
  assert.equal(climbFor(36), 2, 'an octave at 36 events')
  assert.equal(climbFor(500), 2, 'and no further')
  assert.equal(climbFor(18) > 1 && climbFor(18) < 2, true)
  const run = Array.from({ length: 14 }, (_, i) => noteRatio('alice', i))
  for (let i = 1; i < 8; i++) assert.equal(run[i]! > run[i - 1]!, true, `step ${i} climbs the scale`)
  for (let i = 8; i < 14; i++) assert.equal(run[i]! < run[i - 1]!, true, `step ${i} comes back down`)
  assert.equal(noteRatio('alice', 14), noteRatio('alice', 0), 'and the run repeats')
  const roots = new Set(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace'].map(a => noteRatio(a, 0)))
  assert.equal(roots.size > 1, true, 'agents start on their own degrees, so writers sound like a chord')
})

test('every staged event feeds one combo: the meter shows from the third, a milestone announces the rank, and it all drops after the decay', async () => {
  const rec = recordCanvas()
  const show = startEpic({ audio: null, greet: 'none' })
  try {
    show.cue('click', { spot: at(100, 100) })
    show.cue('click', { spot: at(110, 100) })
    assert.equal(show.combo, 2)
    assert.equal(show.metering, false, 'no meter for two events')
    for (let i = 0; i < 10; i++) show.cue('click', { spot: at(120 + i, 100) })
    assert.equal(show.combo, 12)
    assert.equal(show.combo >= METER_FROM && show.metering, true, 'the meter is up')
    await wait(90)
    for (const word of ['HYPER-STREAK!', 'COMBO ×10', 'COMBO', 'HYPER-STREAK', '×12']) {
      assert.equal(rec.texts.includes(word), true, `drew ${word}`)
    }
    await wait(COMBO_DECAY_MS + 700)
    assert.equal(show.combo, 0, 'the combo dropped')
    assert.equal(show.metering, false, 'and the meter faded out')
  } finally { show.stop(); rec.restore() }
})

test('two ranks reached in one burst: the newer title replaces the older instead of printing over it', async () => {
  const rec = recordCanvas()
  const show = startEpic({ audio: null, greet: 'none' })
  try {
    for (let i = 0; i < 26; i++) show.cue('click', { spot: at(100 + i, 300) })
    await wait(90)
    assert.equal(rec.texts.includes('OVERDRIVE!'), true, 'the 25th event announced OVERDRIVE')
    assert.equal(rec.texts.includes('HYPER-STREAK!'), false, 'and the HYPER-STREAK title it overtook never drew')
    assert.equal(rec.texts.includes('×26'), true)
  } finally { show.stop(); rec.restore() }
})

test('the meter keeps the frame loop alive only while its combo lasts, then lets it sleep', () => {
  const pending: ((t: number) => void)[] = []
  const view = window as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
  view.requestAnimationFrame = (cb: (t: number) => void) => { pending.push(cb); return pending.length }
  view.cancelAnimationFrame = () => {}
  const stage = new Stage(document)
  let reading: { n: number; rank: string; color: string; left: number; heat: number } | null =
    { n: 30, rank: 'OVERDRIVE', color: '#ff3b3b', left: 1, heat: 0.75 }
  try {
    stage.meter(() => reading)
    stage.meter(() => reading)
    assert.equal(pending.length, 1, 'one frame requested, one meter')
    let t = 1000
    for (let i = 0; i < 20; i++) { const run = pending.splice(0); for (const cb of run) cb(t += 16) }
    assert.equal(pending.length, 1, 'a live combo keeps one frame coming')
    assert.equal(stage.metering, true)
    reading = null
    for (let i = 0; i < 60 && pending.length; i++) { const run = pending.splice(0); for (const cb of run) cb(t += 16) }
    assert.equal(stage.metering, false, 'the dropped combo\'s meter faded out')
    assert.equal(pending.length, 0, 'and nothing asks for frames any more')
  } finally {
    stage.destroy()
    delete view.requestAnimationFrame
    delete view.cancelAnimationFrame
  }
})

test('the little sounds climb with the combo; the big ones keep their own pitch', () => {
  const audio = fakeAudio()
  const plays: { name: string; pitch: number | undefined }[] = []
  const original = EpicSynth.prototype.play
  EpicSynth.prototype.play = function (this: EpicSynth, name, opts = {}) {
    plays.push({ name, pitch: opts.pitch })
    return original.call(this, name, opts)
  }
  const show = startEpic({ audio: audio.Ctor, greet: 'none' })
  try {
    for (let i = 0; i < 30; i++) show.cue('click', { spot: at(10, 10) })
    show.cue('hire', { spot: at(10, 10) })
    const clicks = plays.filter(p => p.name === 'click').map(p => p.pitch ?? 1)
    assert.equal(clicks.length, 30)
    assert.equal(clicks[29]! > clicks[0]! * 1.4, true, `the 30th click is far higher than the first (${clicks[0]} → ${clicks[29]})`)
    assert.equal(plays.find(p => p.name === 'hire')?.pitch === undefined, true, 'the hire fanfare keeps its pitch')
    assert.equal(plays.filter(p => p.name === 'combo').length >= 2, true, 'the milestones at 10 and 25 played their fanfares')
  } finally { show.stop(); EpicSynth.prototype.play = original }
})

test('streamed text plays each agent\'s pentatonic run, one note per gap', async () => {
  const audio = fakeAudio()
  const notes: number[] = []
  const original = EpicSynth.prototype.play
  EpicSynth.prototype.play = function (this: EpicSynth, name, opts = {}) {
    if (name === 'note') notes.push(opts.pitch ?? 0)
    return original.call(this, name, opts)
  }
  const show = startEpic({ audio: audio.Ctor, greet: 'none' })
  try {
    for (let i = 0; i < 4; i++) {
      taps.epic?.frame('acme', { type: 'node_stream', node: 'alice', kind: 'delta', text: 'never retained' })
      taps.epic?.frame('acme', { type: 'node_stream', node: 'alice', kind: 'delta', text: 'gated' })
      await wait(260)
    }
    assert.equal(notes.length, 4, 'one note per gap, not one per token')
    assert.equal(notes[1]! > notes[0]! && notes[2]! > notes[1]! && notes[3]! > notes[2]!, true, `the run climbs (${notes.join(', ')})`)
  } finally { show.stop(); EpicSynth.prototype.play = original }
})

test('the words name who it happened to — never the user, the org inbox or a watchdog\'s id', async () => {
  const rec = recordCanvas()
  const show = startEpic({ audio: null, greet: 'none' })
  try {
    show.cue('freeze', { node: 'alice' })
    show.cue('halt', { node: 'bob' })
    show.cue('interrupt', { node: 'carol' })
    show.cue('bark', { node: 'dog:7' })
    show.cue('toUser', { node: '@user', other: 'dave' })
    await wait(90)
    for (const word of ['FROZEN!', 'ALICE', 'HALTED', 'BOB', 'STOP', 'CAROL', 'WOOF!', 'FOR YOU!']) {
      assert.equal(rec.texts.includes(word), true, `drew ${word}`)
    }
    for (const word of ['DOG:7', '@USER', 'USER']) assert.equal(rec.texts.includes(word), false, `never names ${word}`)
  } finally { show.stop(); rec.restore() }
})

test('the hands: a confirming click, an Undo button and keyboard navigation each get their own effect; typing stays typing', async () => {
  const rec = recordCanvas()
  const audio = fakeAudio()
  const sounds: string[] = []
  const original = EpicSynth.prototype.play
  EpicSynth.prototype.play = function (this: EpicSynth, name, opts = {}) { sounds.push(name); return original.call(this, name, opts) }
  const show = startEpic({ audio: audio.Ctor, greet: 'none' })
  const box = document.createElement('div')
  box.innerHTML = '<button type="button">Save changes</button><button type="button" title="Undo">↶</button><textarea></textarea>'
  document.body.append(box)
  const press = (el: Element) => el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }))
  const key = (el: Element, k: string) => el.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: k }))
  try {
    const [save, undo] = [...box.querySelectorAll('button')]
    press(save!)
    assert.equal(sounds.includes('confirm'), true, 'a confirming click dings its coins')
    press(undo!)
    await wait(90)
    assert.equal(rec.texts.includes('UNDO!'), true, 'an Undo button gets the undo vortex and its word')
    const before = show.staged
    key(document.body, 'ArrowDown')
    assert.equal(show.staged, before + 1, 'moving with the arrow keys is staged')
    assert.equal(sounds.at(-1), 'warp', 'with its warp')
    key(document.body, 'q')
    assert.equal(show.staged, before + 1, 'a plain letter outside a field is not')
    key(box.querySelector('textarea')!, 'ArrowDown')
    assert.equal(show.staged, before + 1, 'and arrows inside a text field are the field\'s own')
  } finally { box.remove(); show.stop(); rec.restore(); EpicSynth.prototype.play = original }
})

test('the ice spike: a crown of crystals erupts, then shatters into shards', async () => {
  const rec = recordCanvas()
  const stage = new Stage(document)
  try {
    stage.crystal(300, 400, { size: 180 })
    await wait(70)
    assert.equal(rec.calls.filter(c => c === 'fill').length >= 5, true, 'the five crystals are drawn')
    assert.equal(stage.particleCount, 0, 'nothing has shattered yet')
    await wait(1350)
    assert.equal(stage.particleCount > 0, true, 'the crown shattered into shards')
  } finally { stage.destroy(); rec.restore() }
})

test('a change the engine refuses gets REFUSED, never the success it asked for; reads and expected answers stay quiet', async () => {
  const rec = recordCanvas()
  const before = g.fetch
  g.fetch = engine(() => json({ detail: 'refused by the fixture' }, 409))
  const show = startEpic({ audio: null, greet: 'none' })
  try {
    await assert.rejects(req('/api/orgs/acme/ops', { method: 'POST', body: JSON.stringify({ op: 'hire', name: 'newbie' }) }))
    await wait(90)
    assert.equal(rec.texts.includes('REFUSED!'), true, 'the refusal has its alarm')
    assert.equal(rec.texts.includes('HTTP 409'), true, 'and says what the engine answered')
    assert.equal(rec.texts.includes('HIRED!'), false, 'the hire it asked for is never celebrated')
    const staged = show.staged
    await wait(450)
    await assert.rejects(req('/api/orgs/acme/tree'))
    await req('/api/orgs/acme/ops', { method: 'POST', body: '{}' }, undefined, [409])
    await wait(30)
    assert.equal(show.staged, staged, 'a failed read and an expected answer stage nothing')
  } finally { show.stop(); g.fetch = before; rec.restore() }
})

test('an interrupt gets its stop sign only once the engine accepted it', async () => {
  const rec = recordCanvas()
  const before = g.fetch
  let answer: Record<string, unknown> = { interrupted: false, reason: 'no turn is running' }
  g.fetch = engine(() => json(answer))
  const show = startEpic({ audio: null, greet: 'none' })
  try {
    assert.deepEqual(await interruptNode('acme', 'alice'), answer)
    await wait(90)
    assert.equal(rec.texts.includes('STOP'), false, 'nothing was running: no stop sign')
    answer = { interrupted: true }
    assert.deepEqual(await interruptNode('acme', 'alice'), answer)
    await wait(90)
    assert.equal(rec.texts.includes('STOP'), true, 'an accepted interrupt slams the stop sign down')
  } finally { show.stop(); g.fetch = before; rec.restore() }
})

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

test('other orgs\' notices play in the window the user is looking at; this window\'s own org is left to its tree; a 100% reading never says LIMIT', async () => {
  const rec = recordCanvas()
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
  const epoch = 'epic-final-feed'
  const registry = { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'a', incarnation: 'i', rev: 1 }, records: [
    { entity: 'registry_org', id: '1', body: { org_id: 1, slug: 'acme', org_uuid: 'u1', state: 'active' } },
    { entity: 'registry_org', id: '2', body: { org_id: 2, slug: 'other', org_uuid: 'u2', state: 'active' } },
  ] }
  const notices = (orgId: number, uuid: string, seq: number, rows: unknown[]) =>
    ({ type: 'org_notices', epoch, seq, org_id: orgId, org_uuid: uuid, incarnation: 'i', rev: seq, notices: rows })
  const row = (org: string, id: string, kind: string, agent?: string) => ({ org, id, kind, agent, title: id, body: 'b' })
  const usage = (seq: number, percent: number) => ({ epoch, seq, value: { available: true, provider: 'claude', limits: [{ kind: 'session', percent }] } })
  const copy = {
    type: 'app_snapshot', epoch, seq: 1, registry, summaries: {},
    notices: { 2: notices(2, 'u2', 1, [row('other', 'waiting-before', 'question', 'zed')]) },
    runtime: { values: { usage_peek: usage(1, 80) }, orgs: {} },
  }
  g.WebSocket = FeedSocket
  g.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), '/api/app/records')
    return new Response(JSON.stringify(copy), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  let looking = true
  const hasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => looking })
  const show = startEpic({ audio: null, greet: 'none' })
  try {
    await flush(10)
    assert.equal(sockets.length, 1, 'the show shares the one app feed socket')
    sockets[0]!.frame(copy)
    await flush(5)
    const quiet = show.staged
    // this window draws `acme`: its tree is the source for acme's events
    taps.epic?.tree('acme', { slug: 'acme', name: 'Acme', roots: [node('boss')], watchdogs: [], audiences: [] } as unknown as TreePayload)
    sockets[0]!.frame(notices(2, 'u2', 2, [row('other', 'waiting-before', 'question', 'zed'), row('other', 'q2', 'question', 'bob')]))
    await flush(5)
    await wait(90)
    assert.equal(show.staged, quiet + 1, 'one new notice from another org, one effect; what waited before is history')
    assert.equal(rec.texts.includes('?'), true, 'staged as a question')
    assert.equal(rec.texts.includes('BOB · OTHER'), true, 'named: who, and which org')
    assert.equal(rec.texts.includes('ZED · OTHER'), false)
    sockets[0]!.frame(notices(1, 'u1', 3, [row('acme', 'mine', 'agent-frozen', 'boss')]))
    await flush(5)
    assert.equal(show.staged, quiet + 1, 'this window\'s own org is staged from its tree, not twice')
    looking = false
    sockets[0]!.frame(notices(2, 'u2', 4, [row('other', 'q2', 'question', 'bob'), row('other', 'q3', 'urgent-mail', 'eve')]))
    await flush(5)
    assert.equal(show.staged, quiet + 1, 'a window nobody is looking at leaves other orgs\' notices to the one they are')
    looking = true
    sockets[0]!.frame({ type: 'app_runtime', epoch, seq: 5, values: { usage_peek: usage(5, 100) } })
    await flush(5)
    await wait(90)
    assert.equal(rec.texts.includes('CLAUDE 100%!'), true, 'the reading pegs the meter')
    assert.equal(rec.texts.some(t => /LIMIT/.test(t)), false, 'and a reading never says LIMIT')
  } finally {
    show.stop()
    if (hasFocus) Object.defineProperty(document, 'hasFocus', hasFocus)
    else delete (document as unknown as { hasFocus?: unknown }).hasFocus
    Object.assign(g, before)
    rec.restore()
  }
})

test('the canvas keeps to its pixel budget on a big, dense screen', () => {
  const props = ['innerWidth', 'innerHeight', 'devicePixelRatio'] as const
  const saved = props.map(p => Object.getOwnPropertyDescriptor(window, p))
  const set = (p: string, value: number) => Object.defineProperty(window, p, { configurable: true, value })
  try {
    set('innerWidth', 3840); set('innerHeight', 2160); set('devicePixelRatio', 2)
    const big = new Stage(document)
    assert.equal(big.pixels <= MAX_PIXELS, true, `${big.pixels} device pixels`)
    assert.deepEqual(big.size, { w: 3840, h: 2160 }, 'it still covers the whole window')
    big.destroy()
    set('innerWidth', 1000); set('innerHeight', 700); set('devicePixelRatio', 3)
    const dense = new Stage(document)
    assert.equal(dense.canvas.width <= Math.ceil(1000 * MAX_DPR), true, `at most ${MAX_DPR} device pixels per CSS pixel`)
    dense.destroy()
  } finally {
    props.forEach((p, i) => {
      if (saved[i]) Object.defineProperty(window, p, saved[i]!)
      else delete (window as unknown as Record<string, unknown>)[p]
    })
  }
})

test('a popped-out window gets its own stage: an effect lands where its agent is drawn, and leaves with the window', async () => {
  const dom = new JSDOM('<!doctype html><body><div class="sq" data-first-use-agent="alice">alice</div></body>', { url: 'http://localhost/' })
  const popout = dom.window as unknown as Window
  const words: string[] = []
  ;(dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => new Proxy({}, {
    get: (_t, key) => key === 'createLinearGradient' || key === 'createRadialGradient' ? () => ({ addColorStop() {} })
      : key === 'measureText' ? (s: string) => ({ width: s.length * 7 })
      : key === 'then' ? undefined
      : (...args: unknown[]) => { if ((key === 'fillText' || key === 'strokeText') && typeof args[0] === 'string') words.push(args[0]) },
    set: () => true,
  })
  const card = popout.document.querySelector('[data-first-use-agent="alice"]')!
  ;(card as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ left: 100, top: 100, right: 224, bottom: 224, width: 124, height: 124, x: 100, y: 100 }) as DOMRect
  ;(popout as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16)
  ;(popout as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: number) => clearTimeout(id)
  const main = recordCanvas()
  const show = startEpic({ audio: null, greet: 'none' })
  let unregister: (() => void) | null = null
  try {
    assert.equal(popout.document.querySelectorAll('canvas.epic-stage').length, 0)
    unregister = registerWindow({ id: 'epic-final-popout', kind: 'desk', org: 'acme', editable: false, window: popout, redock: () => {} })
    assert.equal(popout.document.querySelectorAll('canvas.epic-stage').length, 1, 'the popped-out window has its own stage')
    taps.epic?.frame('acme', { type: 'node_event', node: 'alice', event: 'frozen' })
    await wait(90)
    assert.equal(words.includes('FROZEN!'), true, 'the freeze played in the popped-out window, where alice is drawn')
    assert.equal(main.texts.includes('FROZEN!'), false, 'and not in the main window')
    unregister()
    unregister = null
    assert.equal(popout.document.querySelectorAll('canvas.epic-stage').length, 0, 'and its stage left with it')
  } finally {
    unregister?.()
    show.stop()
    main.restore()
    dom.window.close()
  }
})

test('the native preferences file keeps the switch across a restart, beside the other settings', () => {
  const dir = fs.mkdtempSync(path.join(process.env.EPIC_TMP || os.tmpdir(), 'epic-preferences-'))
  const file = path.join(dir, 'preferences.json')
  try {
    const first = new Preferences(file)
    assert.equal(first.get().epicMode === true, false, 'a fresh install is off')
    first.set({ epicMode: true })
    first.set({ exitOnClose: true })
    const restart = new Preferences(file)
    assert.equal(restart.get().epicMode, true, 'on survives a new process reading the file')
    assert.equal(restart.get().exitOnClose, true, 'without disturbing the setting written after it')
    restart.set({ epicMode: false })
    assert.equal(new Preferences(file).get().epicMode, false, 'and so does off')
    fs.writeFileSync(file, JSON.stringify({ epicMode: 'yes' }))
    assert.equal(new Preferences(file).get().epicMode === true, false, 'a corrupt value reads as off')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
