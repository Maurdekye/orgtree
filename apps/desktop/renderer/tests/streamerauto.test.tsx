// Streamer mode turns on while a streaming app runs (USER 2026-11-03
// m66c298e7345c "can you detect when obs is running and automatically enable
// streamer mode"; Discord-style auto enable/disable). Docket
// streamer-mode-turns-on-automatically-while-obs-i.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM, flush, inAct, mountView } from './harness'
import { StreamerAuto, STARTUP_CAP_MS, settleStartupVerdict, STREAMING_APPS, STREAMING_APP_LABEL, detectStreamingApp, listProcessNames, parsePs, parseTasklist, streamingAppRunning, type AutoPrefs } from '../../main/streamer-auto'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { AccountsPanel } from '../src/canvas/accounts'
import type { NativePreferences } from '../src/desktop'
import { startStreamerMode } from '../src/streamer'
import { installStreamerBoundary } from '../src/streamer-boundary'

/** A StreamerAuto over a fake preference store; `user` plays hand-made toggles
 *  the way the app's setPreferences treats them (they clear the auto flag). */
function rig(initial: AutoPrefs = {}) {
  const prefs: AutoPrefs = { ...initial }
  const writes: object[] = []
  const auto = new StreamerAuto({
    list: async () => new Set(['explorer.exe']), prefs: () => ({ ...prefs }),
    apply: patch => { writes.push(patch); Object.assign(prefs, patch) },
  })
  const user = { on() { prefs.streamerMode = true; prefs.streamerAutoActive = false }, off() { prefs.streamerMode = false; prefs.streamerAutoActive = false } }
  return { prefs, writes, auto, user }
}

test('process names: the streaming apps are matched case-insensitively from tasklist CSV, an unreadable listing is no verdict', () => {
  const csv = '"System","4","Services","0","12 K"\r\n"OBS64.exe","100","Console","1","90,000 K"\r\n"Streamlabs Desktop.exe","7","Console","1","1 K"\r\n'
  const names = parseTasklist(csv)!
  assert.equal(streamingAppRunning(names), true)
  // Discord's list, exactly (liaison m3669936358cc)
  assert.deepEqual([...STREAMING_APPS].sort(), ['bebo.exe', 'gamecaster.exe', 'obs', 'obs.exe', 'obs32.exe', 'obs64.exe', 'streamlabs desktop.exe', 'streamlabs obs.exe', 'twitchstudio.exe', 'xsplit.core.exe', 'xsplit.gamecaster.exe'])
  assert.equal(streamingAppRunning(new Set(['twitchstudio.exe'])), true)
  assert.equal(streamingAppRunning(new Set(['notobs64.exe', 'obs64.exe.bak'])), false, 'a suffix match is at a separator boundary, never inside a name')
  assert.deepEqual([...parsePs('/usr/bin/obs\n/sbin/init\n')!].sort(), ['init', 'obs'])
  assert.equal(streamingAppRunning(parseTasklist('"explorer.exe","1","Console","1","1 K"')!), false)
  assert.equal(parseTasklist(''), null, 'empty output is unreadable, never "nothing running"')
  assert.equal(parseTasklist('ERROR: Access denied'), null)
})

test('the banner names the detected app, from a display-name map that covers the whole list', () => {
  for (const exe of STREAMING_APPS) assert.ok(STREAMING_APP_LABEL[exe], `${exe} has a display name`)
  const label = (...names: string[]) => detectStreamingApp(new Set(names))
  assert.equal(label('obs64.exe'), 'OBS')
  assert.equal(label('xsplit.core.exe'), 'XSplit')
  assert.equal(label('streamlabs desktop.exe'), 'Streamlabs')
  assert.equal(label('twitchstudio.exe'), 'Twitch Studio')
  assert.equal(label('bebo.exe'), 'Bebo')
  assert.equal(label('explorer.exe'), null)
  const { prefs, auto } = rig()
  auto.step('XSplit')
  assert.deepEqual([prefs.streamerMode, prefs.streamerAutoActive, prefs.streamerAutoApp], [true, true, 'XSplit'])
  auto.step(null); auto.step(null)
  assert.deepEqual([prefs.streamerMode, prefs.streamerAutoActive, prefs.streamerAutoApp], [false, false, ''], 'the app name is cleared with the flag')
})

test('start turns Streamer mode on and flags it; the last exit turns it off after two clear samples', () => {
  const { prefs, auto } = rig()
  auto.step(false); assert.equal(prefs.streamerMode, undefined)
  auto.step(true)
  assert.deepEqual([prefs.streamerMode, prefs.streamerAutoActive], [true, true])
  auto.step(true)
  auto.step(false) // one missed sample: OBS restarting must not flap the mode
  assert.equal(prefs.streamerMode, true)
  auto.step(true); auto.step(false)
  assert.equal(prefs.streamerMode, true, 'the miss counter restarted')
  auto.step(false)
  assert.deepEqual([prefs.streamerMode, prefs.streamerAutoActive], [false, false])
})

test('Streamer mode the user turned on stays on when the streaming app exits', () => {
  const { prefs, writes, auto } = rig({ streamerMode: true })
  auto.step(true)
  assert.equal(writes.length, 0, 'nothing to turn on; the mode is the user\'s')
  assert.equal(prefs.streamerAutoActive, undefined)
  auto.step(false); auto.step(false)
  assert.equal(prefs.streamerMode, true)
})

test('a manual off while the app runs stays off until it exits and starts again', () => {
  const { prefs, auto, user } = rig()
  auto.step(true); assert.equal(prefs.streamerMode, true)
  user.off()
  auto.step(true); auto.step(true); auto.step(true)
  assert.equal(prefs.streamerMode, false, 'suppressed while the app keeps running')
  auto.step(false); auto.step(false)
  assert.equal(prefs.streamerMode, false)
  auto.step(true)
  assert.deepEqual([prefs.streamerMode, prefs.streamerAutoActive], [true, true], 'a fresh start turns it on again')
})

test('a manual off of a mode the user had on also suppresses, and a manual on takes the mode from the automation', () => {
  const a = rig({ streamerMode: true })
  a.auto.step(true); a.user.off(); a.auto.step(true); a.auto.step(true)
  assert.equal(a.prefs.streamerMode, false)
  const b = rig()
  b.auto.step(true); b.user.off(); b.auto.step(true)
  b.user.on() // the user owns it now: the flag is cleared by the write
  b.auto.step(true); b.auto.step(false); b.auto.step(false)
  assert.equal(b.prefs.streamerMode, true, 'exit does not turn a mode the user turned on back off')
})

test('with the setting off nothing turns on; a persisted flag from a past session releases at startup when the app is gone', () => {
  const off = rig({ streamerAuto: false })
  off.auto.step(true); assert.equal(off.prefs.streamerMode, undefined)
  const stale = rig({ streamerMode: true, streamerAutoActive: true })
  stale.auto.step(false)
  assert.deepEqual([stale.prefs.streamerMode, stale.prefs.streamerAutoActive], [false, false])
  const running = rig({ streamerMode: true, streamerAutoActive: true })
  running.auto.step(true)
  assert.deepEqual([running.prefs.streamerMode, running.prefs.streamerAutoActive], [true, true], 'still running: stays on and flagged')
  const startup = rig()
  startup.auto.step(true)
  assert.equal(startup.prefs.streamerMode, true, 'the first sample (startup) already turns it on')
})

// Startup (coordinator maf0e03d7007b, @build-sol's source read): native protection is released only
// after a DEFINITIVE first verdict, or after the 10 s cap; a slow, null, hung or failing listing never
// releases it early, and the stored preference is followed (and logged) only at the cap.
function startupRig(list: () => Promise<ReadonlySet<string> | null>, initial: AutoPrefs = {}) {
  const prefs: AutoPrefs = { ...initial }, events: string[] = []
  let t = 0
  // fake clock: a sleep advances it and settles at once, except the 4.5 s list bound when `holdBound`
  const state = { holdBound: false }
  const auto = new StreamerAuto({
    list, prefs: () => ({ ...prefs }), apply: p => { events.push('apply ' + JSON.stringify(p)); Object.assign(prefs, p) },
    now: () => t, sleep: ms => { if (ms === 4500 && state.holdBound) return new Promise<void>(() => {}); t += ms; return Promise.resolve() },
  })
  const logs: string[] = []
  const settle = () => settleStartupVerdict(auto, () => ({ ...prefs }), on => { events.push('native ' + on) }, m => logs.push(m))
  return { prefs, events, logs, settle, state, now: () => t }
}
const pending = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('startup: a slow listing (OBS running) keeps native protection on until its verdict lands', async () => {
  let resolve!: (v: ReadonlySet<string>) => void
  const r = startupRig(() => new Promise(res => { resolve = res }))
  r.state.holdBound = true // the 4.5 s guard does not fire inside this 3 s listing
  let done = false
  const settled = r.settle().then(v => { done = true; return v })
  await pending()
  assert.deepEqual(r.events, [], 'nothing released and nothing applied while the listing is out')
  assert.equal(done, false)
  resolve(new Set(['obs64.exe']))
  assert.equal(await settled, true)
  assert.deepEqual(r.events, ['apply {"streamerMode":true,"streamerAutoActive":true,"streamerAutoApp":"OBS"}', 'native true'], 'the mode is on BEFORE native protection is evaluated')
})

test('startup: null listings are retried and protection stays on until a readable one arrives', async () => {
  let calls = 0
  const r = startupRig(async () => ++calls < 3 ? null : new Set(['explorer.exe']))
  assert.equal(await r.settle(), true)
  assert.equal(calls, 3)
  assert.deepEqual(r.events, ['native false'], 'a readable listing with no streaming app releases protection once')
})

test('startup: a listing that never settles or never reads is capped, logged, and the stored preference stands', async () => {
  const hung = startupRig(() => new Promise(() => {}), { streamerMode: true })
  assert.equal(await hung.settle(), false)
  assert.ok(hung.now() >= STARTUP_CAP_MS, 'ran to the cap')
  assert.deepEqual(hung.events, ['native true'], 'the stored preference (on) stands; nothing was applied')
  assert.equal(hung.logs.length, 1)
  const unreadable = startupRig(async () => null)
  assert.equal(await unreadable.settle(), false)
  assert.deepEqual(unreadable.events, ['native false'])
  assert.match(unreadable.logs[0]!, /no readable process list/)
  const failing = startupRig(async () => { throw new Error('tasklist blocked') })
  assert.equal(await failing.settle(), false, 'a thrown listing is a miss, not a crash')
})

test('an unreadable listing is no verdict and overlapping samples do not stack', async () => {
  const prefs: AutoPrefs = {}
  let calls = 0, release = () => {}
  const auto = new StreamerAuto({
    list: () => { calls++; return calls === 1 ? Promise.resolve(null) : new Promise(r => { release = () => r(new Set(['obs64.exe'])) }) },
    prefs: () => ({ ...prefs }), apply: p => { Object.assign(prefs, p) },
  })
  await auto.sample(); assert.equal(prefs.streamerMode, undefined)
  const first = auto.sample(); void auto.sample(); void auto.sample()
  assert.equal(calls, 2, 'a sample in flight blocks the next ones')
  release(); await first
  assert.equal(prefs.streamerMode, true)
})

test('the banner says why when the automation turned the mode on', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><p>x</p></body></html>', { url: 'http://localhost/' })
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: new Map() }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array {}, configurable: true })
  const boundary = installStreamerBoundary(dom.window.document, () => {})
  try {
    boundary.update(true, [], true, 'turned on because OBS is running'); await flush()
    assert.match(dom.window.document.querySelector('[data-streamer-banner]')!.textContent!, /Streamer mode — turned on because OBS is running/)
    boundary.update(true, [], true, ''); await flush()
    assert.doesNotMatch(dom.window.document.querySelector('[data-streamer-banner]')!.textContent!, /OBS/)
  } finally { boundary.dispose(); dom.window.close() }
})

test('preferences accept the two booleans and nothing else', () => {
  assert.deepEqual(preferencesPatch({ streamerAuto: false, streamerAutoActive: true, streamerAutoApp: 'XSplit' }), { streamerAuto: false, streamerAutoActive: true, streamerAutoApp: 'XSplit' })
  assert.throws(() => preferencesPatch({ streamerAutoApp: 7 }))
  assert.throws(() => preferencesPatch({ streamerAutoApp: 'x'.repeat(41) }))
  assert.throws(() => preferencesPatch({ streamerAuto: 'yes' }))
  assert.throws(() => preferencesPatch({ streamerAutoActive: 1 }))
})

// The one real check: a stand-in process whose image is named obs64.exe is seen
// by the real process listing, and gone after it exits. The stand-in is a copy of
// ping.exe pinging localhost (no window, no audio, no network beyond loopback).
test('real process listing sees a stand-in obs64.exe and loses it after it exits', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-obs-standin-'))
  const exe = path.join(dir, 'obs64.exe')
  fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), exe)
  const child = spawn(exe, ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
  try {
    let seen = false
    // the harness mocks timers: pace by the (real) process listing itself, never a timeout
    for (let i = 0; i < 60 && !seen; i++) seen = streamingAppRunning((await listProcessNames()) ?? new Set())
    assert.equal(seen, true, 'the real tasklist lists the stand-in as obs64.exe')
    const auto = new StreamerAuto({ list: listProcessNames, prefs: () => ({}), apply: () => {} })
    await auto.sample()
    child.kill()
    await new Promise(r => child.once('exit', r))
    let gone = false
    for (let i = 0; i < 60 && !gone; i++) gone = !streamingAppRunning((await listProcessNames()) ?? new Set(['obs64.exe']))
    assert.equal(gone, true, 'after the stand-in exits it is no longer listed')
  } finally {
    try { child.kill() } catch { /* already gone */ }
    try { execFileSync('taskkill', ['/F', '/IM', 'obs64.exe', '/FI', `PID eq ${child.pid}`], { windowsHide: true, stdio: 'ignore' }) } catch { /* not running */ }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// App settings > Display and the banner, through the app's own components with a fake preferences
// bridge (kept here, not in streamerblank.test.tsx, so the two files stop colliding at their ends).
const g = globalThis as unknown as Record<string, unknown>
const native = window as unknown as { orgtreeDesktop?: unknown }
function stubFetch(): void {
  g.fetch = (url: string, init?: RequestInit) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const payload = p === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
      : p === '/api/providers' ? { providers: [] }
        : p === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false }
          : p === '/api/app/records' ? { type: 'app_snapshot', epoch: 'e', seq: 1, registry: { type: 'registry_snapshot', epoch: 'e', cursor: { app_uuid: 't', incarnation: 'e', rev: 1 }, records: [] }, summaries: {}, notices: {}, runtime: { orgs: {}, values: {} } }
            : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${p}`))
    return Promise.resolve(new Response(JSON.stringify(payload)))
  }
}
function installBridge(t: TestContext) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES }
  const writes: Partial<NativePreferences>[] = []
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const broadcast = () => { for (const fn of [...listeners]) fn({ type: 'preferences', data: saved }) }
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => {
      writes.push(patch); saved = { ...saved, ...preferencesPatch(patch) }; broadcast(); return saved
    },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  /** another window (or App menu › Modes) changes the same preference */
  const elsewhere = (patch: Partial<NativePreferences>) => { saved = { ...saved, ...patch }; broadcast() }
  return { writes, elsewhere }
}

test('App settings › Display › Modes has "Turn on automatically while OBS is running", default on, and the banner note follows the automation', async (t) => {
  const { WebSocket } = g
  g.WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
  t.after(() => { g.WebSocket = WebSocket })
  const bridge = installBridge(t)
  stubFetch()
  const stop = startStreamerMode()
  t.after(() => { stop(); delete g.fetch })
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="display" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(10) })
  const host = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
  const row = host.querySelector<HTMLElement>('[data-settings-field="streamerAuto"]')
  assert.equal(row === null, false, 'the row exists beside Streamer mode')
  assert.equal(row!.querySelector('.set-label')!.textContent, 'Turn on automatically while OBS is running')
  assert.equal(row!.classList.contains('set-row'), true)
  const box = row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  assert.equal(box.checked, true, 'default ON (an absent preference reads as on)')
  await inAct(async () => { box.click(); await flush(8) })
  assert.deepEqual(bridge.writes, [{ streamerAuto: false }])
  assert.equal(row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false)
  // the automation turned the mode on: the banner says why; a manual on does not
  await inAct(async () => { bridge.elsewhere({ streamerMode: true, streamerAutoActive: true }); await flush(8) })
  assert.match(document.querySelector('[data-streamer-banner]')!.textContent!, /turned on because OBS is running/)
  await inAct(async () => { bridge.elsewhere({ streamerMode: true, streamerAutoActive: true, streamerAutoApp: 'XSplit' }); await flush(8) })
  assert.match(document.querySelector('[data-streamer-banner]')!.textContent!, /turned on because XSplit is running/, 'names the detected app')
  await inAct(async () => { bridge.elsewhere({ streamerMode: true, streamerAutoActive: false, streamerAutoApp: '' }); await flush(8) })
  assert.doesNotMatch(document.querySelector('[data-streamer-banner]')!.textContent!, /is running/)
})
