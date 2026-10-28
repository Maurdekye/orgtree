// Sandboxed agent HTML has no network, WebRTC included (2026-10-27). CSP
// connect-src 'none' does not govern WebRTC, so main seals it: every
// webContents gets the disable_non_proxied_udp IP handling policy, and every
// session that renders agent HTML (app panels and chat HTML replies in the
// shared window session, each HTML presentation viewer in its own) sends all
// its traffic to a dead proxy this process holds, with only the engine's own
// port direct. These checks pin that configuration and its wiring in
// main/index.ts; the measured behaviour is in docs/agents/desktop-and-renderer.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-sandbox-net-')), 'windows.cjs')
// 'electron' is stubbed, as in popout-windows.test.mjs: outside an Electron
// process the real package refuses to load, and these helpers read nothing
// off it.
const stubElectron = {
  name: 'stub-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
  },
}
await build({ entryPoints: ['apps/desktop/main/windows.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', plugins: [stubElectron], logLevel: 'silent' })
const { SANDBOXED_WEBRTC_POLICY, forgetSealedSession, resealSandboxedSessions, sandboxSealed, sealSessionNetwork, sealWebRtc } = createRequire(import.meta.url)(out)
const engineOut = path.join(path.dirname(out), 'engine.cjs')
await build({ entryPoints: ['apps/desktop/main/engine.ts'], outfile: engineOut, bundle: true, platform: 'node', format: 'cjs', plugins: [stubElectron], logLevel: 'silent' })
const { Engine } = createRequire(import.meta.url)(engineOut)

/** The proxy configuration one seal applies for `engineOrigin`. */
const sealed = async engineOrigin => {
  const calls = [], session = { setProxy: config => { calls.push(config); return Promise.resolve() } }
  await sealSessionNetwork(session, engineOrigin, () => {})
  forgetSealedSession(session)
  assert.equal(calls.length, 1)
  return calls[0]
}
/** A session whose proxy updates follow `script`, one entry per update: 'ok'
 *  applies at once, 'fail' rejects, 'hold' waits in `held` until the test
 *  settles it (true applies, false fails). It records what it was asked for,
 *  what applied, and the most updates it ever had in flight. */
const scripted = (name, log) => {
  const s = { name, asked: [], applied: [], held: [], script: [], inFlight: 0, maxInFlight: 0 }
  s.setProxy = config => {
    const rules = config.proxyBypassRules, step = s.script.shift() ?? 'ok'
    s.asked.push(rules); log.push(`${name} asked ${rules}`)
    s.maxInFlight = Math.max(s.maxInFlight, ++s.inFlight)
    return new Promise((resolve, reject) => {
      const settle = applied => {
        s.inFlight--
        if (applied) { s.applied.push(rules); log.push(`${name} applied ${rules}`); resolve() }
        else { log.push(`${name} failed ${rules}`); reject(new Error(`${name} refused`)) }
      }
      if (step === 'hold') s.held.push(settle)
      else settle(step === 'ok')
    })
  }
  return s
}
/** Waits a few milliseconds at a time until `ready()` holds. */
const until = async (ready, what) => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(ready(), `timed out waiting for ${what}`)
}
const A = 'http://127.0.0.1:43210', B = 'http://127.0.0.1:43220', C = 'http://127.0.0.1:43230'
const rulesFor = origin => origin ? `<-loopback>;127.0.0.1:${origin.split(':')[2]}` : '<-loopback>'

test('every webContents loses UDP that does not go through a proxy', () => {
  const calls = []
  sealWebRtc({ setWebRTCIPHandlingPolicy: policy => calls.push(policy) })
  assert.deepEqual(calls, ['disable_non_proxied_udp'])
  assert.equal(SANDBOXED_WEBRTC_POLICY, 'disable_non_proxied_udp')
})

test('a sealed session sends everything to one proxy, with no direct fallback', async () => {
  const config = await sealed('http://127.0.0.1:43210')
  assert.equal(config.mode, 'fixed_servers')
  assert.match(config.proxyRules, /^127\.0\.0\.1:\d+$/)
  assert.doesNotMatch(config.proxyRules, /direct|[,;]/i)
})

// Review B6 (4.5.0, c3068e98c63c F1): the dead proxy was 127.0.0.1:1, a port
// that was only vacant. A local program listening there that relays HTTP
// CONNECT would carry a sealed frame's TURN over TCP off the machine.
test('the dead proxy is a port this process holds, so no other program can listen there', async () => {
  const port = Number((await sealed('http://127.0.0.1:43210')).proxyRules.split(':')[1])
  const squatter = net.createServer()
  const bound = await new Promise(resolve => {
    squatter.once('error', error => resolve(error.code))
    squatter.listen(port, '127.0.0.1', () => resolve('listening'))
  })
  if (bound === 'listening') squatter.close()
  assert.equal(bound, 'EADDRINUSE', `another program could listen on the dead proxy 127.0.0.1:${port}`)
  // It relays nothing: a CONNECT is closed unanswered.
  const answered = await new Promise((resolve, reject) => {
    let bytes = 0
    const socket = net.connect(port, '127.0.0.1', () => socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'))
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the dead proxy kept a connection open')) }, 5000)
    socket.on('data', chunk => { bytes += chunk.length })
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(timer); resolve(bytes) })
  })
  assert.equal(answered, 0)
  // One dead proxy for every seal, for the life of the process.
  assert.equal((await sealed('http://127.0.0.1:43211')).proxyRules, `127.0.0.1:${port}`)
})

// Review B7 (4.5.0, c3068e98c63c F2): the bypass was all of 127.0.0.1, so a
// sealed frame's WebRTC reached every local port directly, a local TURN server
// or relay included. Only the engine's own current port stays direct.
test("only the engine's own port bypasses the dead proxy", async () => {
  const bypass = async origin => (await sealed(origin)).proxyBypassRules
  assert.equal(await bypass('http://127.0.0.1:43210'), '<-loopback>;127.0.0.1:43210')
  // An engine recovered on another port moves the bypass with it.
  assert.equal(await bypass('http://127.0.0.1:43211'), '<-loopback>;127.0.0.1:43211')
  // Anything but the engine's loopback origin bypasses nothing.
  for (const origin of ['', 'http://localhost:43210', 'https://127.0.0.1:43210', 'http://127.0.0.2:43210', 'not a url'])
    assert.equal(await bypass(origin), '<-loopback>', origin)
})

// Review of f6e8a6c (F1): a failed seal was logged and swallowed, and
// sandboxSealed settled all the same, so a session could keep a lost engine's
// port direct while main reloaded into it. A session whose seal fails is shut
// at once (main closes its windows), and sandboxSealed reports false until a
// seal of it applies.
test('a session whose seal fails is shut, and reported until a seal of it applies', async () => {
  const log = [], window = scripted('window', log), viewer = scripted('viewer', log)
  // A first seal that fails.
  window.script.push('fail')
  await assert.rejects(sealSessionNetwork(window, A, () => log.push('window shut')), /window refused/)
  assert.deepEqual(log, [`window asked ${rulesFor(A)}`, `window failed ${rulesFor(A)}`, 'window shut'])
  assert.equal(await sandboxSealed(), false)
  // The next seal that applies clears it.
  await resealSandboxedSessions(A)
  assert.equal(await sandboxSealed(), true)
  // A viewer whose reseal fails is shut too; main forgets its session as it
  // closes it, so it holds nothing back.
  await sealSessionNetwork(viewer, A, () => { log.push('viewer shut'); forgetSealedSession(viewer) })
  viewer.script.push('fail')
  await assert.rejects(resealSandboxedSessions(B), /viewer refused/)
  assert.ok(log.includes('viewer shut'))
  assert.equal(await sandboxSealed(), true)
  // A reseal that fails shuts its session before the next seal begins.
  window.script.push('hold')
  const failing = resealSandboxedSessions('')
  await until(() => window.held.length === 1, "the window session's update")
  const next = resealSandboxedSessions(C)
  window.held.shift()(false)
  await assert.rejects(failing, /window refused/)
  await next
  assert.deepEqual(log.slice(-5), ['window asked <-loopback>', 'window failed <-loopback>', 'window shut', `window asked ${rulesFor(C)}`, `window applied ${rulesFor(C)}`])
  assert.deepEqual(viewer.asked, [rulesFor(A), rulesFor(B)], 'a forgotten session is not sealed again')
  assert.equal(await sandboxSealed(), true)
  forgetSealedSession(window)
})

// Review of 7924322 (F1): an open presentation viewer kept its first engine's
// port as its direct port after that engine was lost, through recovery on
// another port, and so did the window session until recovery. A local relay
// that took the freed port was reachable from sealed WebRTC.
test('every sealed session follows the engine: nothing direct while it is lost, then its new port', async () => {
  const session = name => ({ name, rules: [], setProxy(config) { this.rules.push(config.proxyBypassRules); return Promise.resolve() } })
  const window = session('window'), viewer = session('viewer')
  await sealSessionNetwork(window, 'http://127.0.0.1:43210', () => {})
  await sealSessionNetwork(viewer, 'http://127.0.0.1:43210', () => {})
  await resealSandboxedSessions('')
  await resealSandboxedSessions('http://127.0.0.1:43220')
  for (const s of [window, viewer]) assert.deepEqual(s.rules, ['<-loopback>;127.0.0.1:43210', '<-loopback>', '<-loopback>;127.0.0.1:43220'], s.name)
  // A closed viewer's session is forgotten; the window session keeps following.
  forgetSealedSession(viewer)
  await resealSandboxedSessions('http://127.0.0.1:43230')
  assert.equal(viewer.rules.length, 3)
  assert.equal(window.rules.at(-1), '<-loopback>;127.0.0.1:43230')
  forgetSealedSession(window)
})

// Review of f6e8a6c (F2), and of d2f822b (F1): Promise.all ended a step at the
// first failed update while a slow one was still pending, so the next seal
// began and the slow, older update could land last, leaving a lost engine's
// port direct. A step now ends only when every update it started has settled.
test('a seal step waits for every update it started, so a slow one cannot land after a later seal', async () => {
  const log = [], window = scripted('window', log), viewer = scripted('viewer', log)
  await sealSessionNetwork(window, A, () => log.push('window shut'))
  await sealSessionNetwork(viewer, A, () => { log.push('viewer shut'); forgetSealedSession(viewer) })
  // The engine is back on B: the window session's update fails at once and
  // the viewer's is slow. Then the engine is lost again.
  window.script.push('fail'); viewer.script.push('hold')
  const back = resealSandboxedSessions(B)
  await until(() => viewer.held.length === 1, "the viewer's update")
  const lost = resealSandboxedSessions('')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(viewer.asked, [rulesFor(A), rulesFor(B)], 'no seal begins while an update is pending')
  viewer.held.shift()(true)
  await assert.rejects(back, /window refused/)
  await lost
  for (const s of [window, viewer]) {
    assert.equal(s.maxInFlight, 1, `${s.name}: one update at a time`)
    assert.equal(s.applied.at(-1), '<-loopback>', `${s.name}: the lost engine's seal is the one in force`)
  }
  assert.deepEqual(log.filter(line => line.endsWith(' shut')), ['window shut'])
  assert.equal(await sandboxSealed(), true)
  forgetSealedSession(window); forgetSealedSession(viewer)
})

// Review of 7cf4a3e (F1): a failed session was shut only once every other
// session's update had settled, so a slow or hung update elsewhere left it
// running with its old direct port. Each session is shut from its own
// failure; the next seal still waits for every update.
test('a session whose update fails is shut at once, while another update is still held', async () => {
  const log = [], window = scripted('window', log), viewer = scripted('viewer', log)
  try {
    await sealSessionNetwork(window, A, () => log.push('window shut'))
    await sealSessionNetwork(viewer, A, () => { log.push('viewer shut'); forgetSealedSession(viewer) })
    // The engine is lost: the window session's update fails at once and the
    // viewer's is held.
    window.script.push('fail'); viewer.script.push('hold')
    const lost = resealSandboxedSessions('')
    lost.catch(() => {})
    await until(() => log.includes('window shut'), 'the window session to be shut')
    assert.equal(viewer.held.length, 1, "shut while the viewer's update is still held")
    // The next seal still waits for the held update.
    const back = resealSandboxedSessions(B)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(viewer.asked, [rulesFor(A), '<-loopback>'])
    viewer.held.shift()(true)
    await assert.rejects(lost, /window refused/)
    await back
    assert.equal(viewer.applied.at(-1), rulesFor(B))
    assert.equal(await sandboxSealed(), true)
  } finally {
    while (viewer.held.length) viewer.held.shift()(true)
    forgetSealedSession(window); forgetSealedSession(viewer)
  }
})

// An update that never settles counts as failed once its deadline passes: its
// session is shut, though the queue still waits for that update, and the
// session is sealed for it if it lands at last.
test('an update that does not settle in time counts as failed, and its session is shut', async t => {
  const log = [], window = scripted('window', log)
  await sealSessionNetwork(window, A, () => log.push('window shut'))
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    window.script.push('hold')
    const lost = resealSandboxedSessions('')
    lost.catch(() => {})
    await flush()
    assert.equal(window.held.length, 1)
    t.mock.timers.tick(1000)
    await flush()
    assert.ok(!log.includes('window shut'), 'not shut before the deadline')
    t.mock.timers.tick(10 * 60 * 1000)
    await flush()
    assert.ok(log.includes('window shut'), 'shut once the deadline has passed')
    window.held.shift()(true)
    await assert.rejects(lost, /not applied within/)
    assert.equal(await sandboxSealed(), true)
  } finally {
    t.mock.timers.reset()
    while (window.held.length) window.held.shift()(true)
    forgetSealedSession(window)
  }
})

test('the engine announces every change of its origin, a lost engine included', () => {
  const engine = new Engine(), seen = []
  engine.on('origin', origin => seen.push(origin))
  engine.endpoint = 'http://127.0.0.1:43210'
  engine.endpoint = 'http://127.0.0.1:43210'
  engine.endpoint = ''
  engine.endpoint = 'http://127.0.0.1:43220'
  assert.deepEqual(seen, ['http://127.0.0.1:43210', '', 'http://127.0.0.1:43220'])
  assert.equal(engine.origin, 'http://127.0.0.1:43220')
})

test("main seals every webContents, and each agent-HTML session for the engine's current port before it loads anything", () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  // The app-wide hook is registered before whenReady builds any window.
  const hook = main.indexOf("app.on('web-contents-created'")
  const ready = main.indexOf('app.whenReady().then(async')
  assert.ok(hook > 0 && ready > hook, 'web-contents-created hook precedes window creation')
  assert.match(main.slice(hook, main.indexOf('\n  })', hook)), /sealWebRtc\(contents\)/)
  // The shared window session: app panels and chat HTML replies. Every sealed
  // session follows the engine's origin from before the first seal on.
  const created = main.indexOf("session.fromPartition('persist:orgtree-v2')")
  const follows = main.indexOf("engine.on('origin', origin => ")
  const sealedAt = main.indexOf('await sealSessionNetwork(browserSession, engine.origin, shutWindowSession)')
  const configured = main.indexOf('configureEngineSession(browserSession')
  assert.ok(created > 0 && follows > created && sealedAt > follows && configured > sealedAt, 'window session follows the engine and is sealed before it is configured or used')
  assert.match(main.slice(follows, main.indexOf('\n', follows)), /resealSandboxedSessions\(origin\)/)
  // Review of f6e8a6c (F1): a window session whose seal fails runs no agent
  // HTML. Every window on it is destroyed, and nothing reloads, is rebuilt or
  // opens into it unless the seals applied.
  const shut = main.indexOf('const shutWindowSession = () => {')
  assert.ok(shut > created && follows > shut, 'shutWindowSession is ready before the first seal')
  const shutBody = main.slice(shut, follows)
  assert.match(shutBody, /BrowserWindow\.getAllWindows\(\)/)
  assert.match(shutBody, /webContents\.session === browserSession/)
  assert.match(shutBody, /\.destroy\(\)/)
  const reloads = [...main.matchAll(/for \(const record of records\.values\(\)\) if \(!record\.window\.isDestroyed\(\)\) record\.window\.webContents\.reload\(\)/g)].map(m => m.index)
  assert.equal(reloads.length, 3)
  const recovery = main.indexOf('coreLifecycle?.configureRecovery(async allowSpawn =>')
  const end = main.indexOf('}, app.isPackaged)', recovery)
  const body = main.slice(recovery, end)
  const gate = body.indexOf('if (!await sandboxSealed()) return'), moved = body.indexOf('} else {'), rebuilt = body.indexOf('await openWindow(', moved)
  assert.ok(recovery > 0 && gate > 0 && moved > gate && rebuilt > moved, 'nothing is rebuilt for a recovered engine unless the seals applied')
  for (const at of reloads) {
    const gated = at > recovery && at < end ? at > recovery + gate : main.slice(at - 27, at) === 'if (await sandboxSealed()) '
    assert.ok(gated, `the reload at ${at} happens only when the seals applied`)
  }
  for (const build of ['const record = buildMainWindow(kind, org)', "const record = buildMainWindow('org', slug, { register: false })"]) {
    const at = main.indexOf(build)
    assert.ok(at > 0 && /if \(!await sandboxSealed\(\)\) throw /.test(main.slice(at - 200, at)), `${build}: nothing opens into a shut window session`)
  }
  // Each HTML presentation viewer's own session, before its document loads. A
  // viewer whose seal fails, then or later, is closed and its session
  // forgotten, as it is when the viewer closes.
  assert.match(main, /const shutViewer = \(\) => \{ forgetSealedSession\(artifactSession\); if \(!viewer\.isDestroyed\(\)\) viewer\.destroy\(\) \}/)
  assert.match(main, /void sealSessionNetwork\(artifactSession, engine\.origin, shutViewer\)\.then\(\(\) => viewer\.loadURL\(url\)\)\.catch\(shutViewer\)/)
  assert.doesNotMatch(main, /void viewer\.loadURL\(url\)/)
  assert.match(main, /viewer\.on\('closed', \(\) => forgetSealedSession\(artifactSession\)\)/)
  // Every seal names the engine's port and what shuts its session.
  assert.doesNotMatch(main, /sealSessionNetwork\(\s*[\w.]+\s*(,\s*[\w.]+\s*)?\)/)
})
