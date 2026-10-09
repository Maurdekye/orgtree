// A notification click opens or reveals ONE organization's window and leaves
// every other window exactly as it was (user 2026-10-09: "dont minimize any
// existing window"; decision 60). Driven through the real notification
// manager, window registry, openOrg and reveal path (main/window-reveal.ts),
// wired the way main/index.ts wires them, against windows that record every
// call made on them except read-only queries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-window-reveal-'))
await build({ entryPoints: {
  reveal: 'apps/desktop/main/window-reveal.ts',
  registry: 'apps/desktop/main/org-windows.ts',
  notifications: 'apps/desktop/main/notifications.ts',
}, outdir: temp, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs' })
const req = createRequire(import.meta.url)
const { revealInOrgWindow, revealOnly } = req(path.join(temp, 'reveal.cjs'))
const { orgWindowRegistry, openOrg } = req(path.join(temp, 'registry.cjs'))
const { NativeNotifications } = req(path.join(temp, 'notifications.cjs'))
test.after(() => rmSync(temp, { recursive: true, force: true }))

const prefs = { notificationsEnabled: true, notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true,
  notifyAllMail: true, notifyDocuments: true, notifyFrozen: true, notifyTerminalFailures: true, notifyWhileFocused: true }

// Anything but these is recorded as a call: a future mutator (setSkipTaskbar,
// setOpacity, …) is caught without being listed here.
const QUERIES = new Set(['isDestroyed', 'isMinimized', 'isMaximized', 'isVisible', 'isFocused', 'webContents'])
let senders = 0
function fakeWindow(state = {}) {
  const calls = []
  const s = { destroyed: false, minimized: false, maximized: false, visible: true, ...state }
  const own = {
    webContents: { id: ++senders },
    isDestroyed: () => s.destroyed, isMinimized: () => s.minimized, isMaximized: () => s.maximized,
    isVisible: () => s.visible, isFocused: () => false,
    show: () => { s.visible = true }, restore: () => { s.minimized = false }, maximize: () => { s.maximized = true },
    minimize: () => { s.minimized = true }, hide: () => { s.visible = false },
  }
  return new Proxy(own, {
    get(target, prop) {
      if (prop === 'calls') return calls
      if (prop === 'state') return s
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (QUERIES.has(prop)) return target[prop]
      return (...args) => { calls.push(prop); return typeof target[prop] === 'function' ? target[prop](...args) : undefined }
    },
  })
}

class Alert extends EventEmitter { show() {} close() {} }

/** The native host as main/index.ts builds it, around fake windows. A new
 *  organization window's saved placement is maximized, as the user's are. */
function app() {
  const registry = orgWindowRegistry()
  const records = new Map(), sent = [], created = [], alerts = []
  let seq = 0
  const add = (kind, org, state) => {
    const window = fakeWindow(state), id = `w${++seq}`
    registry.register({ id, senderId: window.webContents.id, window, kind, ...(org ? { org } : {}) })
    records.set(id, { id, window, restoreMaximized: false })
    return { id, window }
  }
  const sendTo = (id, event) => sent.push({ id, event })
  // main/index.ts revealWindow: the reveal itself, then bookkeeping on the same window
  const revealWindow = record => {
    if (record.window.isDestroyed()) return
    revealOnly(record)
    registry.activate(record.id)
    sendTo(record.id, { type: 'main-window-shown' })
  }
  const host = {
    focus: entry => { const record = records.get(entry.id); if (record) revealWindow(record) },
    create: async slug => {
      const window = fakeWindow({ visible: false }), id = `w${++seq}`
      records.set(id, { id, window, restoreMaximized: true })
      created.push({ id, slug, window })
      return { id, senderId: window.webContents.id, window }
    },
    // main/index.ts: loadURL(<org>) and then revealWindow
    load: entry => { const record = records.get(entry.id); if (record) revealWindow(record) },
    discard: () => { throw new Error('nothing is discarded here') },
    deliverReveals: (entry, events) => { for (const event of events) sendTo(entry.id, event) },
  }
  const pending = []
  const reveal = (org, event) => revealInOrgWindow(org, event, {
    queueReveal: (target, held) => registry.queueReveal(target, held),
    record: id => records.get(id),
    reveal: revealWindow,
    send: sendTo,
    open: target => openOrg(registry, target, null, host),
  })
  const notices = new NativeNotifications(() => { const alert = new Alert(); alerts.push(alert); return alert },
    data => { pending.push(reveal(data.org, { type: 'notification-click', data })) })
  /** Show a notification, click it, and wait for its window to be opened. */
  const click = async notice => {
    const shown = notices.notify(notice, prefs)
    const alert = alerts.at(-1)
    alert.emit('show')
    assert.equal(await shown, true, 'the notification was shown')
    alert.emit('click')
    await Promise.all(pending.splice(0))
  }
  return { registry, records, sent, created, add, click }
}

const question = org => ({ id: `q-${org}`, org, kind: 'question', agent: 'neo-sandtable', source_id: 'q1',
  title: 'Question from neo-sandtable', body: 'Pick one' })
const clicks = (sent, id) => sent.filter(s => s.id === id && s.event.type === 'notification-click')

test('a notification for another organization opens its own window; the window you are in and every other window are untouched', async () => {
  const a = app()
  const here = a.add('org', 'orgtree', { maximized: true })
  const minimized = a.add('org', 'unity', { minimized: true, maximized: true })
  const home = a.add('homepage')
  await a.click(question('maurdekye-works'))

  assert.equal(a.created.length, 1, 'one new window')
  const opened = a.created[0]
  assert.equal(a.registry.byOrg('maurdekye-works')?.id, opened.id, 'it holds maurdekye-works')
  assert.deepEqual(opened.window.calls, ['show', 'maximize', 'focus'], 'the new window is shown at its saved maximized size and focused')
  assert.equal(clicks(a.sent, opened.id).length, 1, 'the click is handed to the new window')
  for (const [name, other] of [['the window you were in', here], ['a minimized window', minimized], ['a Homepage', home]]) {
    assert.deepEqual(other.window.calls, [], `${name}: no call at all (not minimized, hidden, restored, moved or refocused)`)
    assert.equal(clicks(a.sent, other.id).length, 0, `${name}: is not handed the click`)
  }
  assert.equal(minimized.window.state.minimized, true, 'the minimized window stays minimized')
  assert.equal(a.registry.identity(here.id).org, 'orgtree', 'the window you were in keeps its organization')
  assert.equal(a.registry.identity(home.id).kind, 'homepage', 'a Homepage is not bound by a notification')
})

test('every notification kind takes the same path: only that organization\'s window is opened or touched', async () => {
  const a = app()
  const here = a.add('org', 'orgtree', { maximized: true })
  const kinds = [
    { kind: 'question', agent: 'neo', source_id: 'q1' },
    { kind: 'urgent-mail', source_id: 'm1' },
    { kind: 'terminal-failure', agent: 'neo' },
    { kind: 'work-attention', item: 'a-ticket' },
    { kind: 'routine', source_id: 'm2' },
    { kind: 'document', source_id: 'd1' },
    { kind: 'agent-frozen', agent: 'neo', generation: 2 },
  ]
  for (const [i, extra] of kinds.entries()) {
    const org = `org-${i}`
    await a.click({ id: `${extra.kind}-1`, org, title: extra.kind, body: 'something', ...extra })
    const opened = a.created.at(-1)
    assert.equal(opened?.slug, org, `${extra.kind}: a window for ${org}`)
    assert.deepEqual(opened.window.calls, ['show', 'maximize', 'focus'], `${extra.kind}: only the new window is revealed`)
    assert.equal(clicks(a.sent, opened.id).length, 1, `${extra.kind}: the click reaches it`)
  }
  assert.equal(a.created.length, kinds.length)
  assert.deepEqual(here.window.calls, [], 'the window you were in was never touched')
  for (const opened of a.created) assert.deepEqual(opened.window.calls, ['show', 'maximize', 'focus'],
    `${opened.slug}: later notifications for other organizations did not touch it`)
})

test('an organization that already has a window: that window alone comes forward, restored if it was minimized', async () => {
  const a = app()
  const here = a.add('org', 'orgtree', { maximized: true })
  const theirs = a.add('org', 'maurdekye-works', { minimized: true, maximized: true })
  await a.click(question('maurdekye-works'))
  assert.equal(a.created.length, 0, 'no new window')
  assert.deepEqual(theirs.window.calls, ['show', 'restore', 'focus'], 'its own window is restored and focused')
  assert.equal(clicks(a.sent, theirs.id).length, 1)
  assert.deepEqual(here.window.calls, [], 'the window you were in is untouched')
  assert.equal(here.window.state.minimized, false)
})

test('a second click for an organization whose window is open focuses that window only', async () => {
  const a = app()
  const here = a.add('org', 'orgtree', { maximized: true })
  await a.click(question('maurdekye-works'))
  await a.click({ ...question('maurdekye-works'), id: 'q-again' })
  assert.equal(a.created.length, 1, 'still one window for it')
  assert.deepEqual(a.created[0].window.calls, ['show', 'maximize', 'focus', 'show', 'focus'])
  assert.deepEqual(here.window.calls, [])
})

test('revealOnly acts on the window it is given and on nothing else', () => {
  const one = fakeWindow({ minimized: true }), two = fakeWindow({ maximized: true })
  assert.equal(revealOnly({ id: 'one', window: one, restoreMaximized: true }), true)
  assert.deepEqual(one.calls, ['show', 'restore', 'maximize', 'focus'])
  assert.deepEqual(two.calls, [])
  const gone = fakeWindow({ destroyed: true })
  assert.equal(revealOnly({ id: 'gone', window: gone }), false)
  assert.deepEqual(gone.calls, [], 'a destroyed window is left alone')
})

test('nothing in the main process minimizes or hides a window except that window\'s own controls', () => {
  const dir = 'apps/desktop/main'
  const sources = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => [f, readFileSync(path.join(dir, f), 'utf8')])
  const sites = (pattern) => sources.flatMap(([f, text]) => text.split(/\r?\n/)
    .filter(line => pattern.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line)).map(line => `${f}: ${line.trim()}`))
  assert.deepEqual(sites(/\.minimize\(\)/), [
    "index.ts: handle('desktop:window-minimize', caller => { caller.window.minimize() })",
    "index.ts: handle('desktop:popout-minimize', (caller, name) => { caller.popouts.window(name)?.minimize() })",
  ], 'only the minimize buttons of a window and of a popout minimize, and each acts on itself')
  assert.deepEqual(sites(/\.hide\(\)/), [
    'index.ts: hide: () => window.hide(),',
    "window-close.ts: if (action === 'hide') { host.preventDefault(); host.hide(); return 'hide' }",
  ], 'only the close of the last visible window hides, and it hides itself')
  const reveal = readFileSync(path.join(dir, 'window-reveal.ts'), 'utf8')
  for (const call of ['minimize', 'hide', 'blur', 'close', 'destroy', 'setBounds', 'setPosition', 'setSize', 'moveTop', 'setAlwaysOnTop'])
    assert.doesNotMatch(reveal, new RegExp(`\\.${call}\\(`), `the reveal path never calls ${call}`)
  const main = readFileSync(path.join(dir, 'index.ts'), 'utf8')
  // the WHOLE bodies, so a line added to either (a blur, a z-order change, a
  // loop over the other windows) fails here and has to be argued for
  assert.match(main, /const revealWindow = \(record: MainWindowRecord\) => \{\s*if \(record\.window\.isDestroyed\(\)\) return\s*restoreWindows = true\s*revealOnly\(record\)\s*windows\.activate\(record\.id\)\s*sendTo\(record\.id, \{ type: 'main-window-shown', data: windowState\(record\) \}\)\s*\}/,
    'main/index.ts reveals through revealOnly and touches nothing else')
  assert.match(main, /const revealOrgItem = \(org: unknown, event: DesktopEvent\) => revealInOrgWindow\(org, event, \{\s*queueReveal: \(target, held: DesktopEvent\) => windows\.queueReveal\(target, held\),\s*record: id => records\.get\(id\),\s*reveal: revealWindow,\s*send: sendTo,\s*open: target => requestOrgWindow\(target, null\)\.catch\(\(error: unknown\) => \{\s*console\.warn\('An organization window could not be opened for a notification', error\)\s*\}\),\s*\}\)/,
    'notification clicks go through revealInOrgWindow with exactly this host')
  assert.match(main, /data => \{ void revealOrgItem\(data\.org, \{ type: 'notification-click', data \}\) \}/,
    'the native notification click reveals the notification\'s own organization')
})
