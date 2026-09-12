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
const { NativeNotifications, anyOrgtreeWindowFocused, notification } = createRequire(import.meta.url)(file)
test.after(() => rmSync(temp, { recursive: true, force: true }))

const defaults = { notificationsEnabled: true, notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true, notifyAllMail: false, notifyDocuments: false, notifyFrozen: false, notifyWhileFocused: false }
const question = { id: 'opaque', org: 'org', kind: 'question', agent: 'writer',
  source_id: 'q42', title: 'Question from writer', body: 'Choose one' }
class Alert extends EventEmitter {
  closed = false
  show() {}
  close() { this.closed = true }
}
function fixture(focused = () => false) {
  const native = [], opened = []
  const manager = new NativeNotifications(() => {
    const alert = new Alert(); native.push(alert); return alert
  }, data => opened.push(data), focused)
  return { manager, native, opened }
}

test('native delivery waits for show, keeps the exact target, and clears resolved alerts', async () => {
  const { manager, native, opened } = fixture()
  manager.sync([{ org: question.org, id: question.id }])
  let settled = false
  const delivered = manager.notify(question, defaults).then(r => { settled = true; return r })
  await Promise.resolve()
  assert.equal(settled, false, 'calling show is not evidence of native delivery')
  assert.equal(await manager.notify(question, defaults), false, 'pending delivery cannot duplicate')
  native[0].emit('show')
  assert.equal(await delivered, true)
  native[0].emit('click')
  assert.deepEqual(opened, [question], 'source ID survives the native round trip')
  assert.equal(await manager.notify(question, defaults), false)
  manager.sync([])
  assert.equal(native[0].closed, true)
  native[0].emit('click')
  assert.equal(opened.length, 1, 'a withdrawn native handle cannot navigate')
  assert.equal(await manager.notify(question, defaults), false, 'a stale queued call cannot resurrect it')
})

test('native failures retry; resolving during delivery cancels it without recording success', async () => {
  const { manager, native } = fixture()
  const failed = manager.notify(question, defaults)
  native[0].emit('failed')
  assert.equal(await failed, false)
  const retried = manager.notify(question, defaults)
  assert.equal(native.length, 2)
  native[1].emit('show')
  assert.equal(await retried, true)
  const waiting = manager.notify({ ...question, id: 'pending' }, defaults)
  manager.sync([])
  assert.equal(await waiting, false)
  assert.equal(native[2].closed, true)
})

test('an unresolved inventory larger than the old history cap never re-alerts', async () => {
  const { manager, native } = fixture()
  const rows = Array.from({ length: 1002 }, (_, i) => ({ ...question, id: String(i) }))
  manager.sync(rows.map(({ org, id }) => ({ org, id })))
  for (const row of rows) {
    const delivered = manager.notify(row, defaults)
    native.at(-1).emit('show'); assert.equal(await delivered, true)
  }
  for (const row of rows) assert.equal(await manager.notify(row, defaults), false)
  assert.equal(native.length, rows.length)
  assert.throws(() => manager.sync([{ org: 'org', id: 'x', script: true }]), /Invalid/)
  assert.equal(native[0].closed, false, 'invalid sync must not clear valid alerts')
  manager.sync([])
  assert.ok(native.every(n => n.closed))
})

test('routine mail defaults off while urgent mail defaults on', async () => {
  const { manager, native } = fixture()
  assert.equal(await manager.notify({ ...question, kind: 'routine' }, defaults), false)
  assert.equal(native.length, 0)
  const delivered = manager.notify({ ...question, kind: 'urgent-mail' }, defaults)
  native[0].emit('show')
  assert.equal(await delivered, true)
  manager.sync([])
})

test('every category is independent and All mail cannot duplicate urgent mail', async () => {
  const rows = [ ['question', 'notifyQuestions'], ['urgent-mail', 'notifyUrgentMail'],
    ['work-attention', 'notifyDocketAttention'], ['routine', 'notifyAllMail'],
    ['document', 'notifyDocuments'], ['agent-frozen', 'notifyFrozen'] ]
  const off = { ...defaults, notifyQuestions: false, notifyUrgentMail: false, notifyDocketAttention: false, notifyAllMail: false, notifyDocuments: false, notifyFrozen: false, notifyWhileFocused: false }
  for (const [kind, option] of rows) {
    const { manager, native, opened } = fixture()
    const row = { ...question, kind, generation: 2 }
    assert.equal(await manager.notify(row, off), false)
    const prefs = { ...off, [option]: true }
    const pending = manager.notify(row, prefs)
    native[0].emit('show'); assert.equal(await pending, true)
    assert.equal(await manager.notify(row, { ...prefs, notifyAllMail: true }), false)
    manager.configure(off)
    assert.equal(native[0].closed, true, 'turning a category off closes the existing alert')
    native[0].emit('click'); assert.deepEqual(opened, [])
  }
  const { manager, native } = fixture()
  const delivery = manager.notify({ ...question, kind: 'urgent-mail' }, { ...off, notifyAllMail: true })
  native[0].emit('show'); assert.equal(await delivery, true)
  assert.equal(await manager.notify({ ...question, kind: 'urgent-mail' }, { ...defaults, notifyAllMail: true }), false)
  manager.sync([])
})

test('master notifications switch gates dispatch authoritatively across all categories and closes active alerts', async () => {
  const allOn = { notificationsEnabled: true, notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true, notifyAllMail: true, notifyDocuments: true, notifyFrozen: true, notifyWhileFocused: false }
  const masterOff = { ...allOn, notificationsEnabled: false }
  const categories = [
    { ...question, kind: 'question' },
    { ...question, kind: 'urgent-mail' },
    { ...question, kind: 'work-attention' },
    { ...question, kind: 'routine' },
    { ...question, kind: 'document', source_id: 'doc-id' },
    { ...question, kind: 'agent-frozen', generation: 1 },
  ]
  for (const row of categories) {
    const { manager, native } = fixture()
    assert.equal(await manager.notify(row, masterOff), false, `master switch off suppresses ${row.kind}`)
    assert.equal(native.length, 0)
  }
  const { manager, native, opened } = fixture()
  const pending = manager.notify(question, allOn)
  native[0].emit('show')
  assert.equal(await pending, true)
  assert.equal(native[0].closed, false)
  manager.configure(masterOff)
  assert.equal(native[0].closed, true, 'turning master switch off closes active alert')
  native[0].emit('click')
  assert.deepEqual(opened, [], 'closed alert cannot navigate after master off')
  const restored = manager.notify({ ...question, id: 'next-q' }, allOn)
  native[1].emit('show')
  assert.equal(await restored, true)
  manager.sync([])
})

test('main or popout focus suppresses, while hidden/minimized/other-app focus notify; override bypasses focus', async () => {
  const windowState = (focused, visible = true, minimized = false, destroyed = false) => ({
    isFocused: () => focused, isVisible: () => visible, isMinimized: () => minimized, isDestroyed: () => destroyed,
  })
  for (const [name, windows, suppress] of [
    ['main focus', [windowState(true)], true],
    ['popout focus', [windowState(false), windowState(true)], true],
    ['hidden', [windowState(true, false)], false],
    ['minimized', [windowState(true, true, true)], false],
    ['other app', [windowState(false), windowState(false)], false],
    ['destroyed', [windowState(true, true, false, true)], false],
  ]) {
    assert.equal(anyOrgtreeWindowFocused(windows), suppress, name)
    let focus = anyOrgtreeWindowFocused(windows)
    const { manager, native } = fixture(() => focus)
    const pending = manager.notify(question, defaults)
    if (!suppress) native[0].emit('show')
    assert.equal(await pending, !suppress, name)
    if (suppress) {
      assert.equal(native.length, 0)
      focus = false
      const retried = manager.notify(question, defaults)
      native[0].emit('show'); assert.equal(await retried, true, 'focus suppression never consumes delivery')
    }
    manager.sync([])
  }
  const { manager, native } = fixture(() => true)
  const pending = manager.notify(question, { ...defaults, notifyWhileFocused: true })
  native[0].emit('show'); assert.equal(await pending, true)
  manager.sync([])
})

test('new destinations require exact source and agent generation identity', () => {
  assert.throws(() => notification({ ...question, kind: 'agent-frozen' }), /identity/)
  assert.throws(() => notification({ ...question, kind: 'agent-frozen', generation: -1 }), /generation/)
  assert.throws(() => notification({ ...question, kind: 'document', source_id: undefined }), /identity/)
})

test('turning a pending category off and on retries without reviving the cancelled native handle', async () => {
  const { manager, native, opened } = fixture()
  const first = manager.notify(question, defaults)
  manager.configure({ ...defaults, notifyQuestions: false })
  assert.equal(await first, false)
  native[0].emit('show'); native[0].emit('click')
  assert.deepEqual(opened, [])
  const second = manager.notify(question, defaults)
  assert.equal(native.length, 2)
  native[1].emit('show'); assert.equal(await second, true)
  manager.configure({ ...defaults, notifyQuestions: false })
  assert.equal(await manager.notify(question, defaults), false, 'completed delivery stays deduplicated')
})
