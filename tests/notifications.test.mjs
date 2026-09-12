import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-notifications-'))
const file = path.join(temp, 'notifications.cjs')
await build({ entryPoints: ['apps/desktop/main/notifications.ts'], outfile: file,
  bundle: true, platform: 'node', format: 'cjs' })
const { NativeNotifications } = createRequire(import.meta.url)(file)
test.after(() => rmSync(temp, { recursive: true, force: true }))

const question = { id: 'opaque', org: 'org', kind: 'question', agent: 'writer',
  source_id: 'q42', title: 'Question from writer', body: 'Choose one' }
class Alert extends EventEmitter {
  closed = false
  show() {}
  close() { this.closed = true }
}
function fixture() {
  const native = [], opened = []
  const manager = new NativeNotifications(() => {
    const alert = new Alert(); native.push(alert); return alert
  }, data => opened.push(data))
  return { manager, native, opened }
}

test('native delivery waits for show, keeps the exact target, and clears resolved alerts', async () => {
  const { manager, native, opened } = fixture()
  manager.sync([{ org: question.org, id: question.id }])
  let settled = false
  const delivered = manager.notify(question, false).then(r => { settled = true; return r })
  await Promise.resolve()
  assert.equal(settled, false, 'calling show is not evidence of native delivery')
  assert.equal(await manager.notify(question, false), false, 'pending delivery cannot duplicate')
  native[0].emit('show')
  assert.equal(await delivered, true)
  native[0].emit('click')
  assert.deepEqual(opened, [question], 'source ID survives the native round trip')
  assert.equal(await manager.notify(question, false), false)
  manager.sync([])
  assert.equal(native[0].closed, true)
  native[0].emit('click')
  assert.equal(opened.length, 1, 'a withdrawn native handle cannot navigate')
  assert.equal(await manager.notify(question, false), false, 'a stale queued call cannot resurrect it')
})

test('native failures retry; resolving during delivery cancels it without recording success', async () => {
  const { manager, native } = fixture()
  const failed = manager.notify(question, false)
  native[0].emit('failed')
  assert.equal(await failed, false)
  const retried = manager.notify(question, false)
  assert.equal(native.length, 2)
  native[1].emit('show')
  assert.equal(await retried, true)
  const waiting = manager.notify({ ...question, id: 'pending' }, false)
  manager.sync([])
  assert.equal(await waiting, false)
  assert.equal(native[2].closed, true)
})

test('an unresolved inventory larger than the old history cap never re-alerts', async () => {
  const { manager, native } = fixture()
  const rows = Array.from({ length: 1002 }, (_, i) => ({ ...question, id: String(i) }))
  manager.sync(rows.map(({ org, id }) => ({ org, id })))
  for (const row of rows) {
    const delivered = manager.notify(row, false)
    native.at(-1).emit('show'); assert.equal(await delivered, true)
  }
  for (const row of rows) assert.equal(await manager.notify(row, false), false)
  assert.equal(native.length, rows.length)
  assert.throws(() => manager.sync([{ org: 'org', id: 'x', script: true }]), /Invalid/)
  assert.equal(native[0].closed, false, 'invalid sync must not clear valid alerts')
  manager.sync([])
  assert.ok(native.every(n => n.closed))
})

test('routine preference stays optional while urgent mail always reaches native delivery', async () => {
  const { manager, native } = fixture()
  assert.equal(await manager.notify({ ...question, kind: 'routine' }, false), false)
  assert.equal(native.length, 0)
  const delivered = manager.notify({ ...question, kind: 'urgent-mail' }, false)
  native[0].emit('show')
  assert.equal(await delivered, true)
  manager.sync([])
})
