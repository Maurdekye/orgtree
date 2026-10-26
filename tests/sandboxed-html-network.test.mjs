// Sandboxed agent HTML has no network, WebRTC included (2026-10-27). CSP
// connect-src 'none' does not govern WebRTC, so main seals it: every
// webContents gets the disable_non_proxied_udp IP handling policy, and every
// session that renders agent HTML (app panels and chat HTML replies in the
// shared window session, each HTML presentation viewer in its own) gets a
// proxy that does not exist, with only the engine's loopback host direct.
// These checks pin that configuration and its wiring in main/index.ts; the
// measured behaviour is in docs/agents/desktop-and-renderer.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
const { SANDBOXED_PROXY, SANDBOXED_WEBRTC_POLICY, sealSessionNetwork, sealWebRtc } = createRequire(import.meta.url)(out)

test('every webContents loses UDP that does not go through a proxy', () => {
  const calls = []
  sealWebRtc({ setWebRTCIPHandlingPolicy: policy => calls.push(policy) })
  assert.deepEqual(calls, ['disable_non_proxied_udp'])
  assert.equal(SANDBOXED_WEBRTC_POLICY, 'disable_non_proxied_udp')
})

test('a sealed session sends all but the engine host to a proxy that does not exist', async () => {
  const calls = []
  await sealSessionNetwork({ setProxy: config => { calls.push(config); return Promise.resolve() } })
  assert.deepEqual(calls, [{ mode: 'fixed_servers', proxyRules: '127.0.0.1:1', proxyBypassRules: '<-loopback>;127.0.0.1' }])
  // One proxy and no DIRECT fallback; Chromium's implicit loopback bypass is
  // dropped, so only the engine's host 127.0.0.1 stays direct.
  assert.doesNotMatch(SANDBOXED_PROXY.proxyRules, /direct|[,;]/i)
  assert.deepEqual(SANDBOXED_PROXY.proxyBypassRules.split(';'), ['<-loopback>', '127.0.0.1'])
})

test('a failed seal is not swallowed', async () => {
  await assert.rejects(sealSessionNetwork({ setProxy: () => Promise.reject(new Error('refused')) }), /refused/)
})

test('main seals every webContents, and each agent-HTML session before it loads anything', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  // The app-wide hook is registered before whenReady builds any window.
  const hook = main.indexOf("app.on('web-contents-created'")
  const ready = main.indexOf('app.whenReady().then(async')
  assert.ok(hook > 0 && ready > hook, 'web-contents-created hook precedes window creation')
  assert.match(main.slice(hook, main.indexOf('\n  })', hook)), /sealWebRtc\(contents\)/)
  // The shared window session: app panels and chat HTML replies.
  const created = main.indexOf("session.fromPartition('persist:orgtree-v2')")
  const sealed = main.indexOf('await sealSessionNetwork(browserSession)')
  const configured = main.indexOf('configureEngineSession(browserSession')
  assert.ok(created > 0 && sealed > created && configured > sealed, 'window session sealed before it is configured or used')
  // Each HTML presentation viewer's own session, before its document loads.
  assert.match(main, /sealSessionNetwork\(artifactSession\)\.then\(\(\) => viewer\.loadURL\(url\)\)/)
  assert.doesNotMatch(main, /void viewer\.loadURL\(url\)/)
})
