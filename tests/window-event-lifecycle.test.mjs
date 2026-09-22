import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-event-lifecycle-'))
const require = createRequire(import.meta.url)
async function compile(name) {
  const outfile = path.join(root, name + '.cjs')
  await build({ entryPoints: ['apps/desktop/main/' + name + '.ts'], outfile, bundle: true, platform: 'node', format: 'cjs' })
  return require(outfile)
}
const { attachWindowEventLifecycle } = await compile('window-event-lifecycle')
const { windowOutbox } = await compile('window-outbox')
const { attachWindowLoadRecovery } = await compile('window-load-recovery')
const { registerHeldEventChannels } = await compile('held-events')
const { orgWindowRegistry } = await compile('org-windows')

function fixture() {
  const contents = new EventEmitter()
  let loading = false
  contents.isLoadingMainFrame = () => loading
  contents.id = 1
  contents.mainFrame = { url: 'http://127.0.0.1:12345/o/studio' }
  const record = { documentToken: 'first-document', outbox: windowOutbox({ hold: t => t === 'notification-click' }) }
  const sent = [], holding = [], timers = []
  const lifecycle = attachWindowEventLifecycle(contents, record, e => sent.push(e))
  const recovery = attachWindowLoadRecovery(contents, {
    target: () => 'http://127.0.0.1:12345', builtFor: () => 'http://127.0.0.1:12345',
    load: async () => {}, showHolding: async html => { holding.push(html) },
    record: () => {}, documentLost: lifecycle.documentLost,
    setTimer: fn => { timers.push(fn); return fn }, clearTimer: () => {},
  }, () => contents.mainFrame.url)
  const registry = orgWindowRegistry()
  registry.register({ id: 'one', senderId: 1, window: { webContents: contents, isDestroyed: () => false }, kind: 'org', org: 'studio' })
  const handlers = new Map()
  registerHeldEventChannels({ on: (c, f) => handlers.set(c, f), handle: (c, f) => handlers.set(c, f) }, {
    origin: () => 'http://127.0.0.1:12345', registry, record: () => record,
    token: r => r.documentToken, setToken: (r, t) => { r.documentToken = t },
    drain: r => r.outbox.drain(), send: (_r, e) => sent.push(e),
  })
  const invoke = (channel, token) => handlers.get('desktop:' + channel)({ sender: contents, senderFrame: contents.mainFrame }, token)
  const reveal = n => { const e = { type: 'notification-click', data: n }; if (record.outbox.offer(e)) sent.push(e) }
  const start = (extra = {}) => { loading = true; contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, ...extra }) }
  const stop = () => { loading = false; contents.emit('did-stop-loading') }
  const fail = (code = -102, main = true) => contents.emit('did-fail-load', {}, code, 'failure', contents.mainFrame.url, main)
  return { contents, record, sent, holding, timers, recovery, lifecycle, invoke, reveal, start, stop, fail }
}

test('reload holds both acknowledgement and take until the new document announces itself', () => {
  const h = fixture()
  h.invoke('events-listening', 'first-document')
  h.start(); h.reveal(1)
  h.invoke('events-listening', 'first-document')
  assert.deepEqual(h.invoke('take-pending-events', 'first-document'), [])
  assert.equal(h.record.outbox.pending(), 1)
  assert.deepEqual(h.sent, [])
  h.contents.emit('did-navigate')
  h.invoke('events-listening', 'first-document')
  assert.deepEqual(h.invoke('take-pending-events', 'first-document'), [])
  h.stop()
  assert.deepEqual(h.sent, [], 'load completion is not proof of a listener')
  h.record.documentToken = 'new-document'
  h.invoke('events-listening', 'new-document')
  assert.deepEqual(h.sent.map(e => e.data), [1])
  assert.deepEqual(h.invoke('take-pending-events', 'new-document'), [], 'delivered once')
})

test('cancel resumes an existing listener without a new acknowledgement, in order', () => {
  const h = fixture()
  h.invoke('events-listening', 'first-document')
  h.start(); h.reveal(1); h.reveal(2); h.fail(-3)
  h.stop(); h.reveal(3); h.stop()
  assert.equal(h.record.documentToken, 'first-document')
  assert.deepEqual(h.sent.map(e => e.data), [1, 2, 3])
  assert.equal(h.recovery.isFailed, false)
})

test('cancel retains an acknowledgement received during navigation, but never invents one', () => {
  const h = fixture()
  h.start(); h.reveal(1); h.stop()
  assert.deepEqual(h.sent, [])
  h.start(); h.invoke('events-listening', 'first-document'); h.stop()
  assert.deepEqual(h.sent.map(e => e.data), [1])
})

test('supersession and an obsolete stop cannot drain a newer provisional load', () => {
  const h = fixture()
  h.invoke('events-listening', 'first-document')
  h.start(); h.reveal(1); h.start(); h.fail(-3)
  h.contents.emit('did-stop-loading') // still loading the successor
  assert.deepEqual(h.sent, [])
  assert.equal(h.record.outbox.pending(), 1)
  h.stop()
  assert.deepEqual(h.sent.map(e => e.data), [1])
})

test('subframe and same-document starts do not hold or change document identity', () => {
  const h = fixture()
  h.invoke('events-listening', 'first-document')
  h.start({ isMainFrame: false }); h.reveal(1); h.fail(-102, false)
  h.start({ isSameDocument: true }); h.reveal(2)
  assert.deepEqual(h.sent.map(e => e.data), [1, 2])
  assert.equal(h.record.documentToken, 'first-document')
  assert.equal(h.recovery.isFailed, false)
})

test('terminal loss invalidates token and readiness together; stale failure after recovery does neither', async () => {
  const h = fixture()
  h.invoke('events-listening', 'first-document')
  h.start(); h.reveal(1); h.fail()
  assert.equal(h.record.documentToken, '')
  h.invoke('events-listening', 'first-document')
  assert.deepEqual(h.invoke('take-pending-events', 'first-document'), [])
  assert.deepEqual(h.sent, [])
  h.stop(); h.start(); h.contents.emit('did-navigate')
  h.record.documentToken = 'recovered'
  h.invoke('events-listening', 'recovered')
  h.contents.emit('did-finish-load'); h.stop()
  const pages = h.holding.length
  h.fail()
  await new Promise(r => setImmediate(r))
  assert.equal(h.record.documentToken, 'recovered')
  assert.equal(h.recovery.isFailed, false, 'stale failure must not restart recovery either')
  assert.equal(h.holding.length, pages, 'no holding page may replace the recovered document')
  h.reveal(2)
  assert.deepEqual(h.sent.map(e => e.data), [1, 2])
})
