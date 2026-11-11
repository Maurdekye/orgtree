// Remote organizations (docs/rust-engine/remote-org.md): a window bound to an
// organization of a remote engine carries X-Orgtree-Remote on its permitted
// engine requests, and only there. Main sets it per owner window; page script
// can never set it, and no other window or destination ever gets it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// a worktree without node_modules names the dependency checkout (ORGTREE_TEST_DEPS)
const { build } = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)('esbuild')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-remote-header-'))
const stubElectron = {
  name: 'stub-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    // editmenu.ts wraps Menu in a Proxy at load: the stub gives it an object
    builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({ contents: 'module.exports = { Menu: {}, BrowserWindow: {}, shell: {} }', loader: 'js' }))
  },
}
const load = async name => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs', plugins: [stubElectron], logLevel: 'silent' })
  return createRequire(import.meta.url)(out)
}
const policy = await load('policy')
const { configureEngineSession } = await load('windows')
const { remoteAliases, readRemotes } = await load('remotes')

const origin = 'http://127.0.0.1:4321'
const REMOTE = 'X-Orgtree-Remote'
const TOKEN = 'X-Orgtree-Desktop-Token'

test('the header is stripped everywhere and added only to this engine, for a window that has a remote', () => {
  assert.equal(policy.REMOTE_HEADER, REMOTE)
  for (const url of [origin + '/api/accounts', origin + '/api/orgs/acme/nodes/1/chat', 'ws://127.0.0.1:4321/api/orgs/acme/ws']) {
    assert.deepEqual(policy.remoteHeaders({ Accept: '*/*', 'x-orgtree-remote': 'page-supplied' }, url, origin, 'r1'), { Accept: '*/*', [REMOTE]: 'r1' })
    assert.deepEqual(policy.remoteHeaders({ Accept: '*/*', 'X-ORGTREE-REMOTE': 'page-supplied' }, url, origin, undefined), { Accept: '*/*' })
  }
  // another destination, or a request that was not permitted (empty origin): never
  const never = [['https://example.com/', origin], ['http://127.0.0.1:4322/api/accounts', origin], ['http://localhost:4321/api/accounts', origin], [origin + '/api/accounts', '']]
  for (const [url, permittedOrigin] of never) {
    assert.deepEqual(policy.remoteHeaders({ Accept: '*/*', [REMOTE]: 'page-supplied' }, url, permittedOrigin, 'r1'), { Accept: '*/*' }, url)
  }
})

/** A session double that keeps the header listener, and windows as main registers them. */
function harness(remoteOf) {
  let listener
  const session = {
    webRequest: { onBeforeRequest() {}, onBeforeSendHeaders(fn) { listener = fn } },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
  }
  const register = configureEngineSession(session, () => origin, () => 'desktop-token', remoteOf)
  const window = (id, url) => {
    const frame = { url }
    return { webContents: { id, mainFrame: frame }, isDestroyed: () => false, once() {} }
  }
  const ask = details => {
    let out
    listener(details, result => { out = result.requestHeaders })
    return out
  }
  const send = (win, url, extra = {}) => ask({ webContentsId: win.webContents.id, frame: win.webContents.mainFrame, resourceType: 'xhr', url,
    requestHeaders: { Accept: '*/*', ...extra } })
  return { register, window, send, ask }
}

test('a remote organization window carries its connection id; a local one, a portal and a foreign frame carry none', () => {
  const remotes = new Map([[11, 'remote-1']])
  const { register, window, send, ask } = harness(win => remotes.get(win.webContents.id))
  const remoteWindow = window(11, origin + '/o/acme-galaxy'), localWindow = window(12, origin + '/o/acme')
  register(remoteWindow)
  register(localWindow)
  // the remote window: token and connection id on engine requests, whatever the page supplied
  const sent = send(remoteWindow, origin + '/api/accounts', { 'x-orgtree-remote': 'page-supplied', 'x-orgtree-desktop-token': 'page-supplied' })
  assert.deepEqual(sent, { Accept: '*/*', [TOKEN]: 'desktop-token', [REMOTE]: 'remote-1' })
  assert.equal(send(remoteWindow, 'ws://127.0.0.1:4321/api/orgs/acme-galaxy/ws')[REMOTE], 'remote-1', 'the org socket upgrade carries it too')
  // ... and nothing on a request that leaves this engine
  assert.deepEqual(send(remoteWindow, 'https://example.com/x', { [REMOTE]: 'page-supplied' }), { Accept: '*/*' })
  // a local organization's window: the token, never the header
  assert.deepEqual(send(localWindow, origin + '/api/accounts', { [REMOTE]: 'page-supplied' }), { Accept: '*/*', [TOKEN]: 'desktop-token' })
  // a frame that is not the window's top frame is not permitted at all
  assert.deepEqual(ask({ webContentsId: 11, frame: { url: 'about:srcdoc' }, resourceType: 'xhr', url: origin + '/api/accounts', requestHeaders: { [REMOTE]: 'page-supplied' } }), {})
  // a portal's copied assets are authenticated; it has a remote only when main says so for that window
  const portal = window(13, 'about:blank')
  register(portal, true)
  assert.deepEqual(ask({ webContentsId: 13, frame: portal.webContents.mainFrame, resourceType: 'image', url: origin + '/api/orgs/acme/profile-picture', requestHeaders: {} }),
    { [TOKEN]: 'desktop-token' })
  // an unknown sender gets neither
  assert.deepEqual(send(window(99, origin + '/o/acme-galaxy'), origin + '/api/accounts', { [REMOTE]: 'x' }), { Accept: '*/*' })
})

test('without a lookup the session behaves as before', () => {
  const { register, window, send } = harness(undefined)
  const win = window(21, origin + '/o/acme')
  register(win)
  assert.deepEqual(send(win, origin + '/api/accounts', { [REMOTE]: 'page-supplied' }), { Accept: '*/*', [TOKEN]: 'desktop-token' })
})

test('the alias map comes from the connection list and nothing else', async () => {
  const list = [
    { id: 'r1', name: 'Galaxy', orgs: [{ alias: 'acme-galaxy', remote_slug: 'acme' }, { alias: 'beta', remote_slug: 'beta', gone: true }] },
    { id: 'r2', name: 'Moon', orgs: [] },
    { id: '', orgs: [{ alias: 'x' }] }, { orgs: [{ alias: 'y' }] }, null, 'junk', { id: 'r3', orgs: [{ alias: 7 }, null, { alias: '' }] },
  ]
  assert.deepEqual([...remoteAliases(list)], [['acme-galaxy', 'r1'], ['beta', 'r1']])
  for (const junk of [undefined, null, {}, 'remotes', 7]) assert.equal(remoteAliases(junk).size, 0)
  // an engine that cannot be reached answers an empty list, within its bound
  const started = Date.now()
  assert.deepEqual(await readRemotes({ origin: 'http://127.0.0.1:9', token: 't' }, 300), [])
  assert.ok(Date.now() - started < 5000)
})
