// Synthetic native-shell boundary: no Electron process, profile or Windows shell writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const req = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const { buildSync, transformSync } = req('esbuild')
function load(file) {
  const output = buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require: req })
  return module.exports
}
const { taskbarTarget, taskbarOrgs, taskbarTasks } = load('apps/desktop/main/jumplist.ts')
const { AppFeedState } = load('packages/contracts/app-feed.ts')
const plain = value => JSON.parse(JSON.stringify(value))

test('taskbar arguments select only an explicit, unambiguous valid view', () => {
  for (const [arg, expected] of [
    ['home', { kind: 'homepage' }], ['new', { kind: 'create' }],
    ['org:alpha-2', { kind: 'org', slug: 'alpha-2' }],
    ['org:team@dev', { kind: 'org', slug: 'team@dev' }],
  ]) assert.deepEqual(plain(taskbarTarget(['C:\\Orgtree.exe', `--orgtree-taskbar=${arg}`])), expected)
  for (const args of [[], ['--background'], ['--orgtree-taskbar='],
    ['--orgtree-taskbar=org:'], ['--orgtree-taskbar=org:../x'],
    ['--orgtree-taskbar=org:a b'], ['--orgtree-taskbar=org:UPPER'],
    ['--orgtree-taskbar=org:a" --other'], ['--orgtree-taskbar=org:a/b'],
    ['--orgtree-taskbar=home', '--orgtree-taskbar=new']])
    assert.equal(taskbarTarget(args), null, JSON.stringify(args))
})

function state() {
  const state = new AppFeedState()
  state.epoch = 'e'
  state.registry = { type: 'registry_snapshot', epoch: 'e', cursor: { app_uuid: 'a', incarnation: 'i', rev: 1 }, records: [
    { id: '1', body: { org_id: 1, org_uuid: 'u1', slug: 'zeta', state: 'active' } },
    { id: '2', body: { org_id: 2, org_uuid: 'u2', slug: 'alpha', state: 'active' } },
    { id: '3', body: { org_id: 3, org_uuid: 'u3', slug: 'trash', state: 'trashed' } },
  ] }
  state.apply({ type: 'org_summary', epoch: 'e', seq: 1, org_id: 1, org_uuid: 'u1', body: { name: 'Zeta' } })
  return state
}

test('the current org list follows feed membership, names and order without inactive rows', () => {
  const feed = state()
  assert.deepEqual(plain(taskbarOrgs(feed)), [{ slug: 'alpha', name: 'alpha' }, { slug: 'zeta', name: 'Zeta' }])
  feed.apply({ type: 'org_summary', epoch: 'e', seq: 2, org_id: 1, org_uuid: 'u1', body: { name: 'Renamed & Unicode Ω' } })
  assert.equal(taskbarOrgs(feed)[1].name, 'Renamed & Unicode Ω')
  feed.registry.records = feed.registry.records.filter(row => row.id !== '1')
  feed.registry.records.push({ id: '4', body: { org_id: 4, org_uuid: 'u4', slug: 'new-org', state: 'active' } })
  assert.deepEqual(plain(taskbarOrgs(feed)), [{ slug: 'alpha', name: 'alpha' }, { slug: 'new-org', name: 'new-org' }])
})

test('Windows user tasks include Home, New org and every org, with literal names and safe arguments', () => {
  const tasks = taskbarTasks([{ slug: 'a', name: 'One & Two "quoted" Ω' }], 'C:\\Program Files\\Orgtree\\Orgtree.exe')
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].type, 'tasks', 'user tasks work with Windows recent-document tracking disabled')
  const items = tasks[0].items.filter(item => item.type === 'task')
  assert.deepEqual(plain(items.map(item => item.title)), ['Home', 'New org', 'One & Two "quoted" Ω'])
  for (const item of items) {
    assert.equal(item.program, 'C:\\Program Files\\Orgtree\\Orgtree.exe')
    assert.ok(item.description)
    assert.ok(taskbarTarget([item.args]), item.args)
    assert.equal(item.iconIndex, 0)
  }
  assert.deepEqual(plain(taskbarTarget([items[2].args])), { kind: 'org', slug: 'a' })
  assert.deepEqual(plain(taskbarTasks([], 'app.exe')[0].items.filter(i => i.type === 'task').map(i => i.title)), ['Home', 'New org'])
})

test('development tasks quote the app path and reject unsafe org identifiers', () => {
  const tasks = taskbarTasks([{ slug: 'a --injected', name: 'Bad' }, { slug: 'ok', name: '' }], 'electron.exe', 'D:\\Source With Spaces\\orgtree')
  const items = tasks[0].items.filter(item => item.type === 'task')
  assert.deepEqual(plain(items.map(i => i.title)), ['Home', 'New org', 'ok'])
  assert.equal(items[2].args, '"D:\\Source With Spaces\\orgtree" --orgtree-taskbar=org:ok')
  assert.ok(taskbarTasks([{ slug: 'long', name: 'a'.repeat(500) }], 'app.exe')[0].items.at(-1).description.length <= 260)
})

test('native shell updates only for changed contents and remains Windows-only', () => {
  const start = source.indexOf("  let taskbarContents = ''")
  const end = source.indexOf('  /** ⚠ THE EVENTS', start)
  assert.ok(start >= 0 && end > start)
  const writes = [], warnings = []
  const ctx = vm.createContext({
    taskbarTasks, process: { platform: 'win32', execPath: 'app.exe' },
    app: { isPackaged: true, setJumpList: list => { writes.push(plain(list)); return 'ok' } },
    console: { warn: (...args) => warnings.push(args) },
  })
  vm.runInContext(transformSync(source.slice(start, end) + '\nglobalThis.refresh = refreshTaskbar', { loader: 'ts' }).code, ctx)
  ctx.refresh([]); ctx.refresh([])
  assert.equal(writes.length, 1)
  ctx.refresh([{ slug: 'a', name: 'Alpha' }]); ctx.refresh([{ slug: 'a', name: 'Alpha' }])
  ctx.refresh([{ slug: 'a', name: 'Renamed' }]); ctx.refresh([])
  assert.equal(writes.length, 4, 'add/rename/remove each update once')
  ctx.process.platform = 'linux'; ctx.refresh([{ slug: 'b', name: 'B' }])
  assert.equal(writes.length, 4)
  ctx.process.platform = 'win32'; ctx.app.setJumpList = () => { throw new Error('shell unavailable') }
  assert.doesNotThrow(() => ctx.refresh([{ slug: 'b', name: 'B' }]))
  ctx.refresh([{ slug: 'b', name: 'B' }])
  assert.equal(warnings.length, 1, 'a refused list cannot flood logs on every feed pulse')
})

const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
test('second-instance and cold launch queue the requested view until window routing is ready', async () => {
  const start = source.indexOf('  // Taskbar navigation')
  const end = source.indexOf('  /** ⚠ THE EVENTS', start)
  assert.ok(start >= 0 && end > start, 'shipping taskbar router exists')
  const opens = [], creates = [], reveals = []
  let release
  const ready = new Promise(resolve => { release = resolve })
  const context = vm.createContext({
    process: { argv: ['app.exe', '--orgtree-taskbar=org:alpha'] }, taskbarTarget,
    quitting: false, installerUpgradeShutdown: false, console,
    requestOrgWindow: async (slug, caller) => { opens.push({ slug, caller }); await ready },
    createMainWindow: async target => { creates.push(target); return target },
    revealWindow: record => reveals.push(record.kind),
  })
  vm.runInContext(transformSync(source.slice(start, end) + '\nglobalThis.testRouter = { acceptTaskbar, drainTaskbar };', { loader: 'ts' }).code, context)
  const router = context.testRouter
  assert.equal(router.acceptTaskbar(['app.exe', '--orgtree-taskbar=new']), true)
  assert.equal(router.acceptTaskbar(['app.exe']), false)
  assert.equal(opens.length, 0, 'early handoffs wait for routing readiness')
  const drain = router.drainTaskbar()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(opens, [{ slug: 'alpha', caller: null }])
  release(); await drain
  assert.deepEqual(plain(creates), [{ kind: 'create' }])
  assert.deepEqual(reveals, ['create'])
  router.acceptTaskbar(['app.exe', '--orgtree-taskbar=home'])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reveals, ['create', 'homepage'])
  context.quitting = true
  router.acceptTaskbar(['app.exe', '--orgtree-taskbar=org:ignored'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(opens.length, 1)
})

test('shipping wiring publishes feed changes and preserves installer control priority', () => {
  for (const pattern of [/if \(hasInstallerUpgradeRequest\(commandLine\)\)[^\n]+return/,
    /if \(acceptTaskbar\(commandLine\)\) return/, /await drainTaskbar\(\)/,
    /taskbarOrgs\(appFeed\.state\)/, /app\.setJumpList\(/,
    /args: process\.argv\.slice\(1\)\.filter\(arg => !arg\.startsWith\('--orgtree-taskbar='/])
    assert.equal(pattern.test(source), true, String(pattern))
})
