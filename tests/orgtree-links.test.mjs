// orgtree:// links (docs/rust-engine/orgtree-links.md): an Orgtree mention chip
// in Hubchat opens its target in this PC's Orgtree through one strict URL shape
// per kind, the mirror of the hubchat:// links Orgtree opens (USER 2026-11-08
// mb3e5b66f1e00). Synthetic: no Electron process, registry or Windows shell writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const req = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const { buildSync, transformSync } = req('esbuild')
function load(file) {
  const output = buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require: req, Buffer, process })
  return module.exports
}
const { orgtreeLink, isOrgtreeLinkArg, registerOrgtreeScheme, ORGTREE_SCHEME } = load('apps/desktop/main/orgtree-link.ts')
const { taskbarTarget } = load('apps/desktop/main/jumplist.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const fixture = JSON.parse(fs.readFileSync('apps/desktop/renderer/tests/ref-tokens.json', 'utf8'))
const reference = (org, token) => ({ kind: 'reference', org, token })

test('each kind has exactly one link shape, and it names the canonical token', () => {
  for (const [url, expected] of [
    ['orgtree://item/alpha/git-review-workspace', reference('alpha', '@item:alpha/git-review-workspace')],
    ['orgtree://doc/alpha/d1a2b3c4', reference('alpha', '@doc:alpha/d1a2b3c4')],
    ['orgtree://app/alpha/caption-app', reference('alpha', '@app:alpha/caption-app')],
    ['orgtree://panel/alpha/p1234', reference('alpha', '@panel:alpha/p1234')],
    ['orgtree://agent/alpha/luna-reserve', reference('alpha', '@agent:alpha/luna-reserve')],
    ['orgtree://agent/alpha/codex-checklist@4', reference('alpha', '@agent:alpha/codex-checklist@4')],
    ['orgtree://project/alpha/web-team', reference('alpha', '@project:alpha/web-team')],
    ['orgtree://mail/alpha/user/ab12cd34', reference('alpha', '@mail:alpha/user/ab12cd34')],
    ['orgtree://mail/alpha/org/ab12cd34', reference('alpha', '@mail:alpha/org/ab12cd34')],
    ['orgtree://mail/alpha/node/luna-reserve/ab12cd34', reference('alpha', '@mail:alpha/node/luna-reserve/ab12cd34')],
    ['orgtree://org/alpha', { kind: 'org', org: 'alpha' }],
  ]) assert.deepEqual(plain(orgtreeLink(url)), expected, url)
})

test('anything else is refused: no query, fragment, port, credentials, escapes, capitals or extra parts', () => {
  for (const url of ['', 'orgtree:', 'orgtree://', 'orgtree://item', 'orgtree://item/alpha', 'orgtree://item/alpha/',
    'orgtree://item/alpha/one/extra', 'orgtree://item//one', 'orgtree:item/alpha/one', 'orgtree:/item/alpha/one',
    'ORGTREE://item/alpha/one', 'orgtree://Item/alpha/one', 'orgtree://item/Alpha/one',
    'orgtree://item/alpha/one?x=1', 'orgtree://item/alpha/one?', 'orgtree://item/alpha/one#top',
    'orgtree://item:80/alpha/one', 'orgtree://user:pass@item/alpha/one', 'orgtree://user@item/alpha/one',
    'orgtree://item/alpha/one%20', 'orgtree://item/alpha/%6fne', 'orgtree://item/alpha/one two',
    'orgtree://item/alpha/one\\x', 'orgtree://item/alpha/one@4', 'orgtree://agent/alpha/one@bad',
    'orgtree://agent/alpha/one@12x', 'orgtree://mail/alpha/mailbox/abc', 'orgtree://mail/alpha/node/abc',
    'orgtree://mail/alpha/user/ab12cd34/extra', 'orgtree://org/', 'orgtree://org/alpha/beta', 'orgtree://org/a@b',
    'orgtree://node/alpha/one', 'orgtree://user/alpha/one', 'orgtree://item/alpha/' + 'a'.repeat(400),
    'hubchat://chat?to=@net:alpha', 'https://example.com/item/alpha/one', ' orgtree://item/alpha/one',
    'orgtree://item/alpha/one\n', 'orgtree://item/alpha/one" --inspect', null, undefined, 42,
  ]) assert.equal(orgtreeLink(url), null, JSON.stringify(url))
})

test('a link means exactly what its token means to the renderer parser (shared fixture)', () => {
  let checked = 0
  for (const [token, parsed] of Object.entries(fixture.parse)) {
    const m = /^@(item|doc|agent|mail|app|panel|project):(.*)$/s.exec(token)
    if (!m) continue
    const link = orgtreeLink(`orgtree://${m[1]}/${m[2]}`)
    if (parsed === null) assert.equal(link, null, token)
    else assert.deepEqual(plain(link), reference(parsed.org, token), token)
    checked++
  }
  assert.ok(checked >= 20, `fixture rows checked: ${checked}`)
})

test('the command line carries one destination: a link or a taskbar entry, never both', () => {
  const exe = 'C:\\Program Files\\Orgtree\\Orgtree.exe'
  assert.deepEqual(plain(taskbarTarget([exe, 'orgtree://item/alpha/one'])), reference('alpha', '@item:alpha/one'))
  assert.deepEqual(plain(taskbarTarget([exe, 'orgtree://org/alpha'])), { kind: 'org', slug: 'alpha', link: true })
  for (const args of [[exe, 'orgtree://item/alpha/one', 'orgtree://org/alpha'],
    [exe, 'orgtree://org/alpha', '--orgtree-taskbar=home'], [exe, 'orgtree://item/alpha/one?x'],
    [exe, 'ORGTREE://org/alpha']])
    assert.equal(taskbarTarget(args), null, JSON.stringify(args))
  // the taskbar's own entries are unchanged
  assert.deepEqual(plain(taskbarTarget([exe, '--orgtree-taskbar=org:alpha'])), { kind: 'org', slug: 'alpha' })
  assert.equal(isOrgtreeLinkArg('orgtree://org/alpha'), true)
  assert.equal(isOrgtreeLinkArg('ORGTREE://anything'), true, 'counted, so it can be refused rather than ignored')
  for (const arg of [exe, '--orgtree-taskbar=home', 'D:\\orgtree\\apps\\desktop', 'hubchat://chat'])
    assert.equal(isOrgtreeLinkArg(arg), false, arg)
})

test('a link opens only in an org this Orgtree has; anything else opens nothing', async () => {
  const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  const start = source.indexOf('  // Taskbar navigation')
  const end = source.indexOf('  /** ⚠ THE EVENTS', start)
  assert.ok(start >= 0 && end > start, 'shipping taskbar router exists')
  const opens = [], reveals = [], asked = []
  let rows = [{ slug: 'alpha', name: 'Alpha', live: 0 }]
  const context = vm.createContext({
    process: { argv: ['Orgtree.exe', 'orgtree://item/alpha/one'] }, taskbarTarget, isOrgtreeLinkArg,
    quitting: false, installerUpgradeShutdown: false, console: { warn() {} }, path,
    app: { getPath: () => 'C:/synthetic/taskbar' }, JumpListIcons: class {}, preferences: { get: () => ({}) },
    engine: { orgActivity: async () => { asked.push(1); return rows } },
    requestOrgWindow: async (slug, caller) => { opens.push({ slug, caller }) },
    revealOrgItem: async (org, event) => { reveals.push({ org, event }) },
    createMainWindow: async target => target, revealWindow: () => {},
  })
  vm.runInContext(transformSync(source.slice(start, end) + '\nglobalThis.testRouter = { acceptTaskbar, drainTaskbar };', { loader: 'ts' }).code, context)
  const router = context.testRouter
  await router.drainTaskbar()
  assert.deepEqual(plain(reveals), [{ org: 'alpha', event: { type: 'open-reference', data: { org: 'alpha', token: '@item:alpha/one' } } }],
    'a cold-start link reveals its reference in that org\'s own window')
  assert.equal(router.acceptTaskbar(['Orgtree.exe', 'orgtree://org/alpha']), true)
  await router.drainTaskbar()
  assert.deepEqual(plain(opens), [{ slug: 'alpha', caller: null }], 'the org-only link opens the org')
  for (const url of ['orgtree://item/beta/one', 'orgtree://org/beta'])
    assert.equal(router.acceptTaskbar(['Orgtree.exe', url]), true, url)
  await router.drainTaskbar()
  assert.equal(reveals.length, 1, 'an org this Orgtree does not have opens nothing')
  assert.equal(opens.length, 1)
  rows = null
  router.acceptTaskbar(['Orgtree.exe', 'orgtree://item/alpha/two'])
  await router.drainTaskbar()
  assert.equal(reveals.length, 1, 'nor does a link the engine cannot vouch for')
  rows = [{ slug: 'alpha', name: 'Alpha', live: 0 }]
  assert.equal(router.acceptTaskbar(['Orgtree.exe', 'orgtree://item/alpha/one?x=1']), true,
    'a malformed link is consumed, so a running Orgtree does not come forward for it')
  await router.drainTaskbar()
  assert.equal(reveals.length, 1)
  assert.equal(opens.length, 1)
  const before = asked.length
  router.acceptTaskbar(['Orgtree.exe', '--orgtree-taskbar=org:gamma'])
  await router.drainTaskbar()
  assert.deepEqual(plain(opens.at(-1)), { slug: 'gamma', caller: null }, 'the taskbar org entry is unchanged')
  assert.equal(asked.length, before, 'and does not ask the engine')
  assert.equal(router.acceptTaskbar(['Orgtree.exe']), false, 'an ordinary second launch still shows the last window')
})

test('the scheme is registered the way Hubchat registers hubchat://: packaged, Windows, real profile, only when it points elsewhere', () => {
  const calls = []
  const appData = 'C:\\Users\\someone\\AppData\\Roaming'
  const host = (over = {}) => ({ isPackaged: true, appData,
    isDefaultProtocolClient: protocol => { calls.push(['is', protocol]); return false },
    setAsDefaultProtocolClient: protocol => { calls.push(['set', protocol]); return true }, ...over })
  const env = { APPDATA: appData }
  assert.equal(ORGTREE_SCHEME, 'orgtree')
  assert.equal(registerOrgtreeScheme(host(), 'win32', env), true)
  assert.deepEqual(calls, [['is', 'orgtree'], ['set', 'orgtree']])
  assert.equal(registerOrgtreeScheme(host(), 'win32', { APPDATA: appData.toLowerCase() + '\\' }), true, 'same folder, other spelling')
  for (const [h, platform, e, why] of [
    [host({ isDefaultProtocolClient: () => true }), 'win32', env, 'already this Orgtree'],
    [host({ isPackaged: false }), 'win32', env, 'development'],
    [host(), 'linux', env, 'Linux'], [host(), 'darwin', env, 'macOS'],
    [host(), 'win32', { ...env, ORGTREE_V2_DATA: 'D:\\scratch\\data' }, 'custom data root'],
    [host(), 'win32', { ...env, ORGTREE_V2_PROFILE: 'D:\\scratch\\profile' }, 'custom profile'],
    [host(), 'win32', { APPDATA: 'C:\\smoke\\AppData\\Roaming' }, 'packaged smoke with a fake APPDATA'],
  ]) {
    calls.length = 0
    assert.equal(registerOrgtreeScheme(h, platform, e), false, why)
    assert.deepEqual(calls.filter(call => call[0] === 'set'), [], why)
  }
})

test('shipping wiring: registered at start, held for its window, never replayed by a relaunch', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(main, /registerOrgtreeScheme\(\{ isPackaged: app\.isPackaged, appData: app\.getPath\('appData'\)/)
  assert.match(main, /filter\(arg => !arg\.startsWith\('--orgtree-taskbar='\) && !isOrgtreeLinkArg\(arg\)\)/)
  assert.match(main, /const HELD_EVENT_TYPES = new Set<DesktopEvent\['type'\]>\(\[[^\]]*'open-reference'[^\]]*\]\)/)
  assert.match(fs.readFileSync('packages/contracts/index.ts', 'utf8'), /\| 'open-reference'/)
  assert.match(fs.readFileSync('apps/desktop/renderer/src/events/heldbus.ts', 'utf8'), /'open-reference'/)
})
