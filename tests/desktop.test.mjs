import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-desktop-test-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const policy = await load('policy'), { Preferences } = await load('preferences'), { detectHarnesses } = await load('harnesses')

test('preferences default close-to-tray/login and retain explicit off across reload', () => {
  const file = path.join(temp, 'prefs.json'), prefs = new Preferences(file)
  assert.deepEqual(prefs.get(), { exitOnClose: false, startAtLogin: true })
  prefs.set({ exitOnClose: true, startAtLogin: false })
  assert.deepEqual(new Preferences(file).get(), { exitOnClose: true, startAtLogin: false })
  for (const bad of [[], null, { startAtLogin: 'false' }, { token: true }, { toString: true }]) assert.throws(() => prefs.set(bad))
  assert.equal(policy.closeAction(false, false), 'hide')
  assert.equal(policy.closeAction(true, false), 'quit')
  assert.equal(policy.closeAction(false, true), 'close')
})
test('resolved v2 root refuses v1 root and overlap before any engine import', () => {
  const old = path.join(temp, 'v1'); fs.mkdirSync(old)
  const next = path.join(temp, 'v2')
  assert.equal(policy.validateDataRoot(next, old), path.join(fs.realpathSync.native(temp), 'v2'))
  for (const bad of [old, path.join(old, 'child'), temp, 'relative']) assert.throws(() => policy.validateDataRoot(bad, old))
})
test('readiness validates protocol, pid, port, exact absolute root; other log lines ignored', () => {
  const ready = { type: 'ready', protocol: 1, port: 1234, pid: 44, dataRootId: temp }
  assert.deepEqual(policy.parseReady(JSON.stringify(ready), temp, 44), ready)
  assert.equal(policy.parseReady('arbitrary log line', temp, 44), null)
  for (const delta of [{ protocol: 2 }, { pid: 45 }, { port: 0 }, { port: 65536 }, { port: '1234' }, { dataRootId: path.join(temp, 'other') }, { dataRootId: '.' }]) assert.throws(() => policy.parseReady(JSON.stringify({ ...ready, ...delta }), temp, 44))
})
test('auth covers HTTP WS assets and strips credentials on all other destinations', () => {
  const origin = 'http://127.0.0.1:4321'
  for (const url of [origin + '/api/orgs', origin + '/assets/index.js', 'ws://127.0.0.1:4321/api/orgs/test/ws']) assert.equal(policy.scopedHeaders({}, url, origin, 'secret')[policy.TOKEN_HEADER], 'secret')
  for (const url of ['http://127.0.0.1:4322/', 'http://localhost:4321/', 'https://example.com/', 'http://evil@127.0.0.1:4321/', 'file:///x', 'https://127.0.0.1:4321/']) assert.deepEqual(policy.scopedHeaders({ 'x-orgtree-desktop-token': 'old', Accept: '*/*' }, url, origin, 'secret'), { Accept: '*/*' })
  assert.equal(policy.trustedUiUrl(origin + '/#org', origin), true)
  assert.equal(policy.trustedUiUrl(origin + '/api/docs/hostile.html', origin), false)
  assert.equal(policy.trustedUiUrl('about:blank', origin), false)
})
test('harness detection has positive fixture and never executes it', () => {
  const name = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  fs.writeFileSync(path.join(temp, name), 'must never execute')
  const rows = detectHarnesses(temp)
  assert.equal(rows.find(r => r.id === 'codex').detected, true)
  assert.equal(rows.find(r => r.id === 'claude').detected, false)
  assert.equal(rows.length, 3)
})
