import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const root = path.resolve(process.cwd())
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-activity-sounds-smoke-'))
const importModule = async (file, name, load = true) => {
  const output = path.join(temp, name + '.cjs')
  await build({ entryPoints: [path.join(root, file)], outfile: output, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'] })
  return { module: load ? require(output) : null, file: output }
}
const step = () => new Promise(resolve => setImmediate(resolve))
let checks = 0
try {
  const { module: { ActivitySounds, ACTIVITY_TONES } } = await importModule('apps/desktop/main/activity-sounds.ts', 'sounds')
  const { module: { Preferences } } = await importModule('apps/desktop/main/preferences.ts', 'prefs')
  const { module: { nativeAppFeed } } = await importModule('apps/desktop/main/appfeed.ts', 'feed')
  const event = (seq, kind, id = String(seq), extra = {}) =>
    ({ type: 'activity_sound', epoch: 'boot', org_id: 1, seq, kind, id, ...extra })
  let prefs = { responseSound: true, taskSound: true, notificationsEnabled: false, notifyWhileFocused: false }
  const played = [], failures = []
  const sounds = new ActivitySounds(async kind => played.push(kind), () => prefs, error => failures.push(error))
  sounds.receive(event(1, 'response', 'same'))
  sounds.receive(event(2, 'task', 'same'))
  await step(); assert.deepEqual(played, ['response', 'task']); checks++
  sounds.receive(event(2, 'task', 'same'))
  sounds.receive(event(3, 'task', 'same'))
  sounds.receive(event(1, 'response', 'old'))
  await step(); assert.equal(played.length, 2); checks++
  sounds.receive(event(4, 'task', 'same', { org_id: 2 }))
  await step(); assert.equal(played.length, 3); checks++
  prefs = { ...prefs, responseSound: false }
  sounds.receive(event(5, 'response', 'muted'))
  sounds.receive(event(6, 'task', 'allowed'))
  await step(); assert.equal(played.at(-1), 'task'); assert.equal(played.length, 4); checks++
  prefs.responseSound = true
  sounds.receive(event(7, 'response', 'muted'))
  await step(); assert.equal(played.length, 4); checks++
  for (const invalid of [null, {}, event(8, 'other'), event(8, 'task', '', {}), event(-1, 'task'), event(8, 'task', 'bad', { org_id: 0 })]) sounds.receive(invalid)
  await step(); assert.equal(played.length, 4); checks++
  await assert.rejects(sounds.preview('other')); checks++
  prefs.taskSound = false
  assert.equal(await sounds.preview('task'), true); assert.equal(played.at(-1), 'task'); checks++
  sounds.close(); assert.equal(await sounds.preview('response'), false); checks++

  const settings = path.join(temp, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ notificationsEnabled: false }))
  let store = new Preferences(settings)
  assert.equal(store.get().responseSound, true); assert.equal(store.get().taskSound, true)
  store.set({ responseSound: false }); store = new Preferences(settings)
  assert.equal(store.get().responseSound, false); assert.equal(store.get().taskSound, true); checks++
  assert.throws(() => store.set({ taskSound: 'yes' })); checks++
  assert.notDeepEqual(ACTIVITY_TONES.response, ACTIVITY_TONES.task); checks++

  let release
  const bounded = new ActivitySounds(() => new Promise(resolve => { release = resolve }), () => ({ responseSound: true, taskSound: true }), error => failures.push(error))
  const pending = Array.from({ length: 66 }, () => bounded.preview('response'))
  assert.equal(await pending[65], false)
  bounded.close(); release(); assert.equal(await pending[0], true)
  assert.ok((await Promise.all(pending.slice(1))).every(ok => ok === false)); checks++

  const snapshot = { type: 'app_snapshot', epoch: 'boot', seq: 100,
    registry: { type: 'registry_snapshot', epoch: 'boot', cursor: { app_uuid: 'app', incarnation: 'boot', rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  const previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket
  const sockets = [], cues = []
  class Socket {
    constructor(url) { this.url = url; sockets.push(this) }
    close() { this.onclose?.() }
    push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => snapshot })
  globalThis.WebSocket = Socket
  const feed = nativeAppFeed({ origin: 'http://127.0.0.1:7000', token: 'synthetic-token' }, () => {}, cue => cues.push(cue))
  try {
    feed.start(); await step()
    assert.equal(new URL(sockets[0].url).searchParams.get('sounds'), 'true')
    sockets[0].push(event(99, 'response', 'before-initial-copy')); assert.equal(cues.length, 0)
    sockets[0].push(snapshot); assert.equal(feed.status, 'current')
    sockets[0].push(event(101, 'response', 'reply'))
    sockets[0].push(event(102, 'task', 'task'))
    assert.deepEqual(cues.map(cue => cue.kind), ['response', 'task']); checks++
    sockets[0].push(event(103, 'response', 'old-boot', { epoch: 'old' }))
    sockets[0].push(event(104, 'unknown', 'malformed'))
    assert.equal(cues.length, 2); assert.equal(feed.status, 'current'); checks++
    await feed.refresh(); assert.equal(cues.length, 2); checks++
  } finally { feed.stop(); globalThis.fetch = previousFetch; globalThis.WebSocket = previousSocket }

  const { file: playerFile } = await importModule('apps/desktop/main/sound-player.ts', 'player', false)
  const childFile = path.join(temp, 'electron.cjs')
  fs.writeFileSync(childFile, `
    const assert = require('node:assert/strict');
    const { app, BrowserWindow } = require('electron');
    const { SoundPlayer } = require(${JSON.stringify(playerFile)});
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'electron-profile'))});
    app.on('browser-window-created', (_event, window) => window.webContents.setAudioMuted(true));
    app.whenReady().then(async () => {
      const player = new SoundPlayer();
      try {
        await player.play('response'); await player.play('task');
        const windows = BrowserWindow.getAllWindows(); assert.equal(windows.length, 1);
        const w = windows[0]; assert.equal(w.isVisible(), false);
        const result = await w.webContents.executeJavaScript('window.playActivitySound("response")');
        assert.deepEqual(result, {kind:'response',state:'running',notes:1});
        const task = await w.webContents.executeJavaScript('window.playActivitySound("task")');
        assert.deepEqual(task, {kind:'task',state:'running',notes:3});
        const sandbox = w.webContents.getLastWebPreferences();
        assert.equal(sandbox.sandbox, true); assert.equal(sandbox.nodeIntegration, false);
        const idle = await w.webContents.executeJavaScript('context.state'); assert.equal(idle, 'suspended');
        console.log('ACTIVITY_AUDIO_SMOKE ' + JSON.stringify({hidden:!w.isVisible(), response:result, task, idle, muted:w.webContents.isAudioMuted()}));
      } finally { player.close(); app.quit(); }
    }).catch(error => { console.error(error); app.exit(1); });
  `)
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
  const output = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [childFile], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 && !timedOut ? resolve(stdout) : reject(new Error('Audio smoke failed: ' + code + (timedOut ? ' (timeout)' : '') + '\n' + stderr)) })
  })
  assert.match(output, /ACTIVITY_AUDIO_SMOKE/); checks++
  console.log(output.trim())
  console.log(JSON.stringify({ passed: checks, playback: 'real hidden Electron, OS output muted', providerCalls: 0 }))
} finally {
  const resolved = path.resolve(temp)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('orgtree-activity-sounds-smoke-')) throw new Error('Unsafe cleanup path')
  fs.rmSync(resolved, { recursive: true, force: true })
}
