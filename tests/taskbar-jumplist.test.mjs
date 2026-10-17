// Synthetic native-shell boundary: no Electron process, profile or Windows shell writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const req = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const { buildSync, transformSync } = req('esbuild')
function load(file) {
  const output = buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require: req, Buffer })
  return module.exports
}
const { taskbarTarget, taskbarOrgs, taskbarTasks } = load('apps/desktop/main/jumplist.ts')
const { AppFeedState } = load('packages/contracts/app-feed.ts')
const { JumpListIcons, actionPng, picturePng } = load('apps/desktop/main/jumplist-icons.ts')
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

test('Recent orgs precede fixed Tasks, with literal names and safe arguments', () => {
  const tasks = taskbarTasks([{ slug: 'a', name: 'One & Two "quoted" Ω' }], 'C:\\Program Files\\Orgtree\\Orgtree.exe')
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].type, 'custom')
  assert.equal(tasks[0].name, 'Recent')
  assert.equal(tasks[1].type, 'tasks')
  const items = tasks.flatMap(category => category.items)
  assert.ok(items.every(item => item.type === 'task'), 'no separators between fixed sections')
  assert.deepEqual(plain(items.map(item => item.title)), ['One & Two "quoted" Ω', 'Home', 'New org'])
  for (const item of items) {
    assert.equal(item.program, 'C:\\Program Files\\Orgtree\\Orgtree.exe')
    assert.ok(item.description)
    assert.ok(taskbarTarget([item.args]), item.args)
    assert.equal(item.iconIndex, 0)
  }
  assert.deepEqual(plain(taskbarTarget([items[0].args])), { kind: 'org', slug: 'a' })
  assert.deepEqual(plain(taskbarTasks([], 'app.exe')[0].items.filter(i => i.type === 'task').map(i => i.title)), ['Home', 'New org'])
})

test('development tasks quote the app path and reject unsafe org identifiers', () => {
  const tasks = taskbarTasks([{ slug: 'a --injected', name: 'Bad' }, { slug: 'ok', name: '' }], 'electron.exe', 'D:\\Source With Spaces\\orgtree')
  const items = tasks.flatMap(category => category.items).filter(item => item.type === 'task')
  assert.deepEqual(plain(items.map(i => i.title)), ['ok', 'Home', 'New org'])
  assert.equal(items[0].args, '"D:\\Source With Spaces\\orgtree" --orgtree-taskbar=org:ok')
  assert.ok(taskbarTasks([{ slug: 'long', name: 'a'.repeat(500) }], 'app.exe')[0].items.at(-1).description.length <= 260)
})

test('org and fixed action entries use their distinct supplied icons with app fallback', () => {
  const categories = taskbarTasks([{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }], 'app.exe', undefined,
    { home: 'home.ico', create: 'add.ico', orgs: { a: 'logo.ico' } })
  const items = categories.flatMap(category => category.items).filter(item => item.type === 'task')
  const paths = Object.fromEntries(items.map(item => [item.title, item.iconPath]))
  assert.deepEqual(plain(paths), { A: 'logo.ico', B: 'app.exe', Home: 'home.ico', 'New org': 'add.ico' })
})

test('feed logo revisions enter the taskbar projection without carrying picture bytes', () => {
  const feed = state(), hash = 'a'.repeat(64)
  feed.apply({ type: 'org_summary', epoch: 'e', seq: 2, org_id: 1, org_uuid: 'u1', body: { name: 'Zeta', logo_sha256: hash } })
  assert.equal(taskbarOrgs(feed)[1].logo, hash)
  feed.apply({ type: 'org_summary', epoch: 'e', seq: 3, org_id: 1, org_uuid: 'u1', body: { name: 'Zeta', logo_sha256: null } })
  assert.equal(taskbarOrgs(feed)[1].logo, undefined)
})

function picture(kind) {
  const png = actionPng(kind)
  return { sha256: createHash('sha256').update(png).digest('hex'), data: png.toString('base64'),
    bytes: png.length, width: 64, height: 64 }
}
const normalize = png => ({ png, width: 64, height: 64 })
const iconDir = () => fs.mkdtempSync(path.join(process.env.ORGTREE_TEST_OUTPUT || 'C:/orgtree-build/taskbar-orgs-sol', 'jump-icons-'))

test('logo icons are owned ICO files, version paths on edits, and disappear from removed logos', async () => {
  const dir = iconDir(), one = picture('home'), two = picture('create')
  let current = one, reads = 0
  const cache = new JumpListIcons(dir, async () => { reads++; return current }, normalize)
  const org = { slug: 'alpha', name: 'Alpha', logo: one.sha256 }
  assert.equal(await cache.prepare([org]), true)
  const first = cache.paths([org]), bytes = fs.readFileSync(first.orgs.alpha)
  assert.equal(path.dirname(first.orgs.alpha), dir)
  assert.equal(bytes.readUInt16LE(2), 1)
  assert.equal(bytes.readUInt32LE(18), 22)
  assert.deepEqual(bytes.subarray(22), Buffer.from(one.data,'base64'))
  assert.notEqual(first.home, first.create)
  assert.notEqual(first.home, first.orgs.alpha)
  await cache.prepare([org]); assert.equal(reads, 1)
  current = two; org.logo = two.sha256
  await cache.prepare([org])
  assert.notEqual(cache.paths([org]).orgs.alpha, first.orgs.alpha)
  delete org.logo; await cache.prepare([org])
  assert.deepEqual(plain(cache.paths([org]).orgs), {})
  const fallback = taskbarTasks([{ slug: 'constructor', name: 'Fallback' }], 'app.exe', undefined, cache.paths([]))
  assert.equal(fallback[0].items[0].iconPath, 'app.exe')
})

test('picture admission rejects stale, corrupt, oversized and non-square inputs before native decode', async () => {
  const one = picture('home'), other = picture('create')
  assert.ok(picturePng(one,one.sha256))
  for (const record of [null, other, {...one,data:'bad'}, {...one,bytes:1}, {...one,width:65}, {...one,data:'A'.repeat(400000)}])
    assert.equal(picturePng(record,one.sha256), undefined)
  assert.equal(picturePng(one,'../../escape'),undefined)
  let decodes = 0
  const cache = new JumpListIcons(iconDir(), async () => other, () => { decodes++; return normalize(Buffer.alloc(0)) })
  const org = { slug: 'a', name: 'A', logo: one.sha256 }
  await cache.prepare([org]); assert.equal(decodes,0)
  assert.equal(cache.paths([org]).orgs.a,undefined)
})

test('a late logo fetch cannot replace the latest requested organization picture', async () => {
  const one = picture('home'), two = picture('create')
  let release, entered, reads = []
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const cache = new JumpListIcons(iconDir(), async org => {
    reads.push(org.logo)
    if (org.logo === one.sha256) { entered(); await gate; return one }
    return two
  },normalize)
  const first = { slug: 'a', name: 'A', logo: one.sha256 }, last = {...first,logo:two.sha256}
  const pending = cache.prepare([first])
  await started
  cache.prepare([last]); release(); await pending
  assert.ok(cache.paths([last]).orgs.a.endsWith(two.sha256+'.ico'))
  assert.ok(reads.every(hash => hash === one.sha256 || hash === two.sha256))
})

test('the native app feed advertises only a logo hash and logo commits invalidate it', () => {
  const engine = fs.readFileSync('engine/rs/orgtree-engine/src/appfeed.rs','utf8')
  const pictures = fs.readFileSync('engine/rs/orgtree-engine/src/profile_pictures/mod.rs','utf8')
  assert.match(engine,/value->>'sha256'/)
  assert.match(engine,/"logo_sha256": org.get/)
  assert.match(pictures,/engine\.app\.org_changed\(org\)/)
})

test('native shell updates only for changed contents and remains Windows-only', () => {
  const start = source.indexOf("  let taskbarContents = ''")
  const end = source.indexOf('  /** ⚠ THE EVENTS', start)
  assert.ok(start >= 0 && end > start)
  const writes = [], warnings = []
  const ctx = vm.createContext({
    taskbarTasks, taskbarIcons: { prepare: async () => false, paths: () => ({}) },
    process: { platform: 'win32', execPath: 'app.exe' },
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
  ctx.app.setJumpList = list => { writes.push(plain(list)); return list.some(category => category.type === 'custom') ? 'customCategoryAccessDeniedError' : 'ok' }
  ctx.refresh([{ slug: 'private', name: 'Private' }])
  assert.deepEqual(writes.at(-1).map(category => category.type), ['tasks'], 'fixed actions survive Windows custom-category privacy refusal')
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
    quitting: false, installerUpgradeShutdown: false, console, path,
    app: { getPath: () => 'C:/synthetic/taskbar' }, JumpListIcons: class {},
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
