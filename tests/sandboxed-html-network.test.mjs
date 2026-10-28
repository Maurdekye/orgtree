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
const { SANDBOXED_WEBRTC_POLICY, sealSessionNetwork, sealWebRtc } = createRequire(import.meta.url)(out)

/** The proxy configuration one seal applies for `engineOrigin`. */
const sealed = async engineOrigin => {
  const calls = []
  await sealSessionNetwork({ setProxy: config => { calls.push(config); return Promise.resolve() } }, engineOrigin)
  assert.equal(calls.length, 1)
  return calls[0]
}

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

test('a failed seal is not swallowed', async () => {
  await assert.rejects(sealSessionNetwork({ setProxy: () => Promise.reject(new Error('refused')) }, 'http://127.0.0.1:43210'), /refused/)
})

test("main seals every webContents, and each agent-HTML session for the engine's current port before it loads anything", () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  // The app-wide hook is registered before whenReady builds any window.
  const hook = main.indexOf("app.on('web-contents-created'")
  const ready = main.indexOf('app.whenReady().then(async')
  assert.ok(hook > 0 && ready > hook, 'web-contents-created hook precedes window creation')
  assert.match(main.slice(hook, main.indexOf('\n  })', hook)), /sealWebRtc\(contents\)/)
  // The shared window session: app panels and chat HTML replies.
  const created = main.indexOf("session.fromPartition('persist:orgtree-v2')")
  const sealedAt = main.indexOf('await sealSessionNetwork(browserSession, engine.origin)')
  const configured = main.indexOf('configureEngineSession(browserSession')
  assert.ok(created > 0 && sealedAt > created && configured > sealedAt, 'window session sealed before it is configured or used')
  // An engine recovered in this process on another port: the window session
  // is sealed for that port before any window is rebuilt on it.
  const recovery = main.indexOf('coreLifecycle?.configureRecovery(async allowSpawn =>')
  const body = main.slice(recovery, main.indexOf('}, app.isPackaged)', recovery))
  const moved = body.indexOf('} else {')
  const resealed = body.indexOf('await sealSessionNetwork(browserSession, engine.origin)', moved)
  const rebuilt = body.indexOf('await openWindow(', moved)
  assert.ok(recovery > 0 && moved > 0 && resealed > moved && rebuilt > resealed, 'resealed before windows are rebuilt for a moved engine')
  // Each HTML presentation viewer's own session, before its document loads.
  assert.match(main, /sealSessionNetwork\(artifactSession, engine\.origin\)\.then\(\(\) => viewer\.loadURL\(url\)\)/)
  assert.doesNotMatch(main, /void viewer\.loadURL\(url\)/)
  // Every seal names the engine's port.
  assert.doesNotMatch(main, /sealSessionNetwork\(\w+\)/)
})
