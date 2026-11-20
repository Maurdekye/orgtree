// orgtree:// on Linux (docs/rust-engine/orgtree-links.md, USER 2026-11-20
// m5b5128333307): the packaged app writes its OWN handler entry and makes it the
// default only when nothing else is. Synthetic: temp folders, no xdg tools, no
// Electron process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const req = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const { buildSync } = req('esbuild')
function load(file) {
  const output = buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, process })
  return module.exports
}
const { registerLinuxOrgtreeScheme, linkEntryText, desktopExecArg, LINK_ENTRY, LINK_MIME } = load('apps/desktop/main/orgtree-link-linux.ts')

function home(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orgtree-linux-link-${name}-`))
  return { dir, entry: path.join(dir, '.local', 'share', 'applications', 'dev.orgtree.link.desktop'),
    apps: path.join(dir, '.local', 'share', 'applications'), mime: path.join(dir, '.config', 'mimeapps.list') }
}
const inputs = (h, over = {}) => ({ platform: 'linux', isPackaged: true, home: h.dir, version: '4.6.6', execPath: '/tmp/.mount_x/orgtree',
  env: { HOME: h.dir, APPIMAGE: '/home/u/Applications/Orgtree.AppImage', APPDIR: '/tmp/.mount_OrgtreAbCdEf' }, ...over })

test('the entry is hidden, takes the scheme, starts this AppImage and carries the version', () => {
  assert.equal(LINK_ENTRY, 'dev.orgtree.link.desktop')
  assert.equal(LINK_MIME, 'x-scheme-handler/orgtree')
  const text = linkEntryText({ program: '/home/u/Applications/Orgtree.AppImage', extracted: false, version: '4.6.6' })
  assert.deepEqual(text.split('\n'), ['[Desktop Entry]', 'Type=Application', 'Name=Orgtree link', 'NoDisplay=true',
    'Exec="/home/u/Applications/Orgtree.AppImage" %u', 'MimeType=x-scheme-handler/orgtree;', 'X-Orgtree-Version=4.6.6', ''])
  // a run without FUSE asks for the same mode in the handler (the runtime consumes the argument form)
  assert.match(linkEntryText({ program: '/a/Orgtree.AppImage', extracted: true, version: '4.6.6' }),
    /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 "\/a\/Orgtree\.AppImage" %u$/m)
})

test('a program path is quoted by the Desktop Entry rules, or refused', () => {
  assert.equal(desktopExecArg('/home/u/My Apps/Orgtree.AppImage'), '"/home/u/My Apps/Orgtree.AppImage"')
  // inside the quotes " ` $ \ take a backslash; the entry's string value doubles each backslash; % doubles
  assert.equal(desktopExecArg('/a/$x`y"z\\w/50%.AppImage'), '"/a/\\\\$x\\\\`y\\\\"z\\\\\\\\w/50%%.AppImage"')
  for (const bad of ['', 'relative/Orgtree.AppImage', '/a/line\nbreak', '/a/tab\there', '/a/\u0001']) assert.equal(desktopExecArg(bad), null, JSON.stringify(bad))
})

test('a first start writes its own entry and becomes the default; a second start changes nothing', () => {
  const h = home('first')
  const first = registerLinuxOrgtreeScheme(inputs(h))
  assert.deepEqual({ ...first }, { entry: 'written', default: 'set' })
  assert.match(fs.readFileSync(h.entry, 'utf8'), /^Exec="\/home\/u\/Applications\/Orgtree\.AppImage" %u$/m)
  assert.equal(fs.readFileSync(h.mime, 'utf8'), '[Default Applications]\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n')
  const stamp = [fs.statSync(h.entry).mtimeMs, fs.statSync(h.mime).mtimeMs]
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h)) }, { entry: 'current', default: 'ours' })
  assert.deepEqual([fs.statSync(h.entry).mtimeMs, fs.statSync(h.mime).mtimeMs], stamp)
  assert.deepEqual(fs.readdirSync(h.apps), ['dev.orgtree.link.desktop'], 'no temporary file is left')
})

test('a moved AppImage, a new version or a run without FUSE rewrites only its own entry', () => {
  const h = home('rewrite')
  registerLinuxOrgtreeScheme(inputs(h))
  const next = registerLinuxOrgtreeScheme(inputs(h, { version: '4.6.7',
    env: { HOME: h.dir, APPIMAGE: '/opt/o/Orgtree.AppImage', APPDIR: '/tmp/appimage_extracted_0123abcd' } }))
  assert.deepEqual({ ...next }, { entry: 'written', default: 'ours' })
  const text = fs.readFileSync(h.entry, 'utf8')
  assert.match(text, /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 "\/opt\/o\/Orgtree\.AppImage" %u$/m)
  assert.match(text, /^X-Orgtree-Version=4\.6\.7$/m)
})

test('an entry from before NO_CLEANUP is rewritten at the next start', () => {
  // The runtime removes its extraction folder when the app it started exits; a
  // link's launch would remove the running app's (runtime.c, AppImageKit effcebc).
  const h = home('cleanup')
  const env = { HOME: h.dir, APPIMAGE: '/opt/o/Orgtree.AppImage', APPDIR: '/tmp/appimage_extracted_0123abcd' }
  fs.mkdirSync(h.apps, { recursive: true })
  fs.writeFileSync(h.entry, ['[Desktop Entry]', 'Type=Application', 'Name=Orgtree link', 'NoDisplay=true',
    'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 "/opt/o/Orgtree.AppImage" %u', 'MimeType=x-scheme-handler/orgtree;', 'X-Orgtree-Version=4.6.6', ''].join('\n'))
  fs.mkdirSync(path.dirname(h.mime), { recursive: true })
  fs.writeFileSync(h.mime, '[Default Applications]\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n')
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h, { env })) }, { entry: 'written', default: 'ours' })
  assert.match(fs.readFileSync(h.entry, 'utf8'), /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 "\/opt\/o\/Orgtree\.AppImage" %u$/m)
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h, { env })) }, { entry: 'current', default: 'ours' })
})

test("another program's default is left alone, and no other entry is ever touched", () => {
  const h = home('other')
  fs.mkdirSync(h.apps, { recursive: true }); fs.mkdirSync(path.dirname(h.mime), { recursive: true })
  const theirs = '[Desktop Entry]\nType=Application\nName=Orgtree\nExec=env APPIMAGE_EXTRACT_AND_RUN=1 /home/steamos/Applications/Orgtree.AppImage %U\n'
  fs.writeFileSync(path.join(h.apps, 'orgtree.desktop'), theirs)
  const list = '[Added Associations]\ntext/html=firefox.desktop;\n\n[Default Applications]\ntext/html=firefox.desktop\nx-scheme-handler/orgtree=orgtree.desktop;\n'
  fs.writeFileSync(h.mime, list)
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h)) }, { entry: 'written', default: 'other', other: 'orgtree.desktop' })
  assert.equal(fs.readFileSync(h.mime, 'utf8'), list)
  assert.equal(fs.readFileSync(path.join(h.apps, 'orgtree.desktop'), 'utf8'), theirs)
})

test('an existing list keeps every line; the default joins its section or a new one', () => {
  const a = home('section')
  fs.mkdirSync(path.dirname(a.mime), { recursive: true })
  fs.writeFileSync(a.mime, '[Default Applications]\ntext/html=firefox.desktop\n\n[Added Associations]\nimage/png=gimp.desktop;\n')
  assert.equal(registerLinuxOrgtreeScheme(inputs(a)).default, 'set')
  assert.equal(fs.readFileSync(a.mime, 'utf8'),
    '[Default Applications]\ntext/html=firefox.desktop\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n\n[Added Associations]\nimage/png=gimp.desktop;\n')
  const b = home('nosection')
  fs.mkdirSync(path.dirname(b.mime), { recursive: true })
  fs.writeFileSync(b.mime, '[Added Associations]\nimage/png=gimp.desktop;')
  assert.equal(registerLinuxOrgtreeScheme(inputs(b)).default, 'set')
  assert.equal(fs.readFileSync(b.mime, 'utf8'),
    '[Added Associations]\nimage/png=gimp.desktop;\n\n[Default Applications]\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n')
  // an empty value is no default
  const c = home('empty')
  fs.mkdirSync(path.dirname(c.mime), { recursive: true })
  fs.writeFileSync(c.mime, '[Default Applications]\nx-scheme-handler/orgtree=\n')
  assert.equal(registerLinuxOrgtreeScheme(inputs(c)).default, 'set')
  assert.equal(fs.readFileSync(c.mime, 'utf8'), '[Default Applications]\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n')
})

test('XDG_CONFIG_HOME and XDG_DATA_HOME move the two files', () => {
  const h = home('xdg')
  const env = { ...inputs(h).env, XDG_CONFIG_HOME: path.join(h.dir, 'cfg'), XDG_DATA_HOME: path.join(h.dir, 'data') }
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h, { env })) }, { entry: 'written', default: 'set' })
  assert.ok(fs.existsSync(path.join(h.dir, 'data', 'applications', 'dev.orgtree.link.desktop')))
  assert.ok(fs.existsSync(path.join(h.dir, 'cfg', 'mimeapps.list')))
  assert.ok(!fs.existsSync(h.entry))
})

test('only the real install registers: the same guards as Windows', () => {
  for (const [why, over] of [
    ['Windows', { platform: 'win32' }], ['macOS', { platform: 'darwin' }],
    ['development', { isPackaged: false }],
    ['custom data root', h => ({ env: { ...inputs(h).env, ORGTREE_V2_DATA: '/scratch/data' } })],
    ['custom profile', h => ({ env: { ...inputs(h).env, ORGTREE_V2_PROFILE: '/scratch/profile' } })],
    ['a smoke run with a fake HOME', h => ({ env: { ...inputs(h).env, HOME: '/tmp/smoke-home' } })],
    ['a program path that cannot be written', h => ({ env: { HOME: h.dir, APPIMAGE: '/a/line\nbreak' } })],
  ]) {
    const h = home('guard')
    const result = registerLinuxOrgtreeScheme(inputs(h, typeof over === 'function' ? over(h) : over))
    assert.deepEqual({ ...result }, { entry: 'skipped', default: 'skipped' }, why)
    assert.deepEqual(fs.readdirSync(h.dir), [], why)
  }
})

test('an installed package (no AppImage) registers its own program', () => {
  const h = home('deb')
  assert.equal(registerLinuxOrgtreeScheme(inputs(h, { env: { HOME: h.dir }, execPath: '/opt/Orgtree/orgtree' })).entry, 'written')
  assert.match(fs.readFileSync(h.entry, 'utf8'), /^Exec="\/opt\/Orgtree\/orgtree" %u$/m)
})

test('shipping wiring: registered at start beside the Windows registration', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(main, /registerLinuxOrgtreeScheme\(\{ platform: process\.platform, isPackaged: app\.isPackaged, home: os\.userInfo\(\)\.homedir, version: app\.getVersion\(\), execPath: process\.execPath, env: process\.env \}\)/)
})
