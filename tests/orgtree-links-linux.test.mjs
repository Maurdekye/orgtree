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
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const req = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const { buildSync } = req('esbuild')
function load(file) {
  const output = buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, process })
  return module.exports
}
const {
  registerLinuxOrgtreeScheme,
  registerLinuxOrgtreeApp,
  linkEntryText,
  appEntryText,
  desktopExecArg,
  LINK_ENTRY,
  LINK_MIME,
  APP_ENTRY,
} = load('apps/desktop/main/orgtree-link-linux.ts')

function home(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orgtree-linux-link-${name}-`))
  return { dir, entry: path.join(dir, '.local', 'share', 'applications', 'dev.orgtree.link.desktop'),
    apps: path.join(dir, '.local', 'share', 'applications'), mime: path.join(dir, '.config', 'mimeapps.list'),
    sysData: path.join(dir, 'sys-data') }
}
const inputs = (h, over = {}) => ({ platform: 'linux', isPackaged: true, home: h.dir, version: '4.6.6', execPath: '/tmp/.mount_OrgtreAbCdEf/orgtree',
  env: { HOME: h.dir, APPIMAGE: '/home/u/Applications/Orgtree.AppImage', APPDIR: '/tmp/.mount_OrgtreAbCdEf', XDG_DATA_DIRS: h.sysData }, ...over })

test('the entry is hidden, takes the scheme, starts this AppImage and carries the version', () => {
  assert.equal(LINK_ENTRY, 'dev.orgtree.link.desktop')
  assert.equal(LINK_MIME, 'x-scheme-handler/orgtree')
  const text = linkEntryText({ program: '/home/u/Applications/Orgtree.AppImage', extracted: false, version: '4.6.6' })
  assert.deepEqual(text.split('\n'), ['[Desktop Entry]', 'Type=Application', 'Name=Orgtree link', 'NoDisplay=true',
    'Exec=/home/u/Applications/Orgtree.AppImage %u', 'MimeType=x-scheme-handler/orgtree;', 'X-Orgtree-Version=4.6.6', ''])
  // a run without FUSE asks for the same mode in the handler (the runtime consumes the argument form)
  assert.match(linkEntryText({ program: '/a/Orgtree.AppImage', extracted: true, version: '4.6.6' }),
    /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 \/a\/Orgtree\.AppImage %u$/m)
})

test('a plain program path is written bare: SteamOS keeps the quotes of a quoted one', () => {
  // gamescope's xdg-open (generic mode) hands `env` the quotes as part of the name: ENOENT, the tap does nothing
  const frame = '/home/steamos/Applications/Orgtree.AppImage'
  assert.equal(desktopExecArg(frame), frame)
  assert.equal(desktopExecArg('/opt/Orgtree-4.6.7_arm64+x/orgtree'), '/opt/Orgtree-4.6.7_arm64+x/orgtree')
  assert.match(linkEntryText({ program: frame, extracted: true, version: '4.6.7' }),
    /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 \/home\/steamos\/Applications\/Orgtree\.AppImage %u$/m)
  assert.match(linkEntryText({ program: frame, extracted: false, version: '4.6.7' }),
    /^Exec=\/home\/steamos\/Applications\/Orgtree\.AppImage %u$/m)
  // anything else keeps the quoted form
  assert.equal(desktopExecArg('/home/u/$HOME/Orgtree.AppImage'), '"/home/u/\\\\$HOME/Orgtree.AppImage"')
  assert.match(linkEntryText({ program: '/home/u/My Apps/Orgtree.AppImage', extracted: false, version: '4.6.7' }),
    /^Exec="\/home\/u\/My Apps\/Orgtree\.AppImage" %u$/m)
})

test('an entry 4.6.6 wrote with quotes is rewritten bare at the next start', () => {
  for (const [name, execPath, env, before, after] of [
    ['bare-extracted', '/tmp/appimage_extracted_0123abcd/orgtree', { APPIMAGE: '/home/steamos/Applications/Orgtree.AppImage', APPDIR: '/tmp/appimage_extracted_0123abcd' },
      'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 "/home/steamos/Applications/Orgtree.AppImage" %u',
      'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 /home/steamos/Applications/Orgtree.AppImage %u'],
    ['bare-mounted', '/tmp/.mount_OrgtreAbCdEf/orgtree', { APPIMAGE: '/home/steamos/Applications/Orgtree.AppImage', APPDIR: '/tmp/.mount_OrgtreAbCdEf' },
      'Exec="/home/steamos/Applications/Orgtree.AppImage" %u', 'Exec=/home/steamos/Applications/Orgtree.AppImage %u'],
  ]) {
    const h = home(name)
    const lines = exec => ['[Desktop Entry]', 'Type=Application', 'Name=Orgtree link', 'NoDisplay=true', exec,
      'MimeType=x-scheme-handler/orgtree;', 'X-Orgtree-Version=4.6.6', ''].join('\n')
    fs.mkdirSync(h.apps, { recursive: true })
    fs.writeFileSync(h.entry, lines(before))
    fs.mkdirSync(path.dirname(h.mime), { recursive: true })
    fs.writeFileSync(h.mime, '[Default Applications]\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n')
    const start = () => ({ ...registerLinuxOrgtreeScheme(inputs(h, { execPath, env: { HOME: h.dir, ...env } })) })
    assert.deepEqual(start(), { entry: 'written', default: 'ours' }, name)
    assert.equal(fs.readFileSync(h.entry, 'utf8'), lines(after), name)
    assert.deepEqual(start(), { entry: 'current', default: 'ours' }, name)
  }
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
  assert.match(fs.readFileSync(h.entry, 'utf8'), /^Exec=\/home\/u\/Applications\/Orgtree\.AppImage %u$/m)
  assert.equal(fs.readFileSync(h.mime, 'utf8'), '[Default Applications]\nx-scheme-handler/orgtree=dev.orgtree.link.desktop;\n')
  const stamp = [fs.statSync(h.entry).mtimeMs, fs.statSync(h.mime).mtimeMs]
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h)) }, { entry: 'current', default: 'ours' })
  assert.deepEqual([fs.statSync(h.entry).mtimeMs, fs.statSync(h.mime).mtimeMs], stamp)
  assert.deepEqual(fs.readdirSync(h.apps), ['dev.orgtree.link.desktop'], 'no temporary file is left')
})

test('a moved AppImage, a new version or a run without FUSE rewrites only its own entry', () => {
  const h = home('rewrite')
  registerLinuxOrgtreeScheme(inputs(h))
  const next = registerLinuxOrgtreeScheme(inputs(h, { version: '4.6.7', execPath: '/tmp/appimage_extracted_0123abcd/orgtree',
    env: { HOME: h.dir, APPIMAGE: '/opt/o/Orgtree.AppImage', APPDIR: '/tmp/appimage_extracted_0123abcd' } }))
  assert.deepEqual({ ...next }, { entry: 'written', default: 'ours' })
  const text = fs.readFileSync(h.entry, 'utf8')
  assert.match(text, /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 \/opt\/o\/Orgtree\.AppImage %u$/m)
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
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h, { execPath: '/tmp/appimage_extracted_0123abcd/orgtree', env })) }, { entry: 'written', default: 'ours' })
  assert.match(fs.readFileSync(h.entry, 'utf8'), /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 \/opt\/o\/Orgtree\.AppImage %u$/m)
  assert.deepEqual({ ...registerLinuxOrgtreeScheme(inputs(h, { execPath: '/tmp/appimage_extracted_0123abcd/orgtree', env })) }, { entry: 'current', default: 'ours' })
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
    ['a program path that cannot be written', h => ({ env: { HOME: h.dir, APPIMAGE: '/a/line\nbreak', APPDIR: '/tmp/.mount_OrgtreAbCdEf' } })],
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
  assert.match(fs.readFileSync(h.entry, 'utf8'), /^Exec=\/opt\/Orgtree\/orgtree %u$/m)
})

test('shipping wiring: registered at start beside the Windows registration', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(main, /registerLinuxOrgtreeScheme\(\{ platform: process\.platform, isPackaged: app\.isPackaged, home: os\.userInfo\(\)\.homedir, version: app\.getVersion\(\), execPath: process\.execPath, env: process\.env \}\)/)
  assert.match(main, /registerLinuxOrgtreeApp\(\{[\s\S]*platform: process\.platform[\s\S]*isPackaged: app\.isPackaged[\s\S]*home: os\.userInfo\(\)\.homedir[\s\S]*version: app\.getVersion\(\)[\s\S]*execPath: process\.execPath[\s\S]*env: process\.env[\s\S]*iconSource:/)
})

// Request 1: visible orgtree.desktop in Linux extract-and-run mode (SteamOS / Steam Frame)

const extractedInputs = (h, over = {}) => ({
  ...inputs(h, {
    version: '4.6.9',
    execPath: '/tmp/appimage_extracted_0123abcd/orgtree',
    env: {
      HOME: h.dir,
      APPIMAGE: '/home/steamos/Applications/Orgtree.AppImage',
      APPDIR: '/tmp/appimage_extracted_0123abcd',
      XDG_DATA_DIRS: h.sysData,
    },
  }),
  ...over,
})

test('visible app entry carries extract-and-run flags, original AppImage path, bare when plain, and no NoDisplay/MimeType', () => {
  assert.equal(APP_ENTRY, 'orgtree.desktop')
  const text = appEntryText({ program: '/home/steamos/Applications/Orgtree.AppImage', version: '4.6.9' })
  assert.deepEqual(text.split('\n'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Orgtree',
    'Comment=Put a team of AI agents to work',
    'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 /home/steamos/Applications/Orgtree.AppImage %U',
    'Icon=orgtree',
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=Orgtree',
    'X-Orgtree-Version=4.6.9',
    '',
  ])
  assert.doesNotMatch(text, /^NoDisplay=/m)
  assert.doesNotMatch(text, /^MimeType=/m)
  assert.match(
    appEntryText({ program: '/home/u/My Apps/Orgtree.AppImage', version: '4.6.9-alpha.1' }),
    /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 "\/home\/u\/My Apps\/Orgtree\.AppImage" %U$/m,
  )
})

test('extract-and-run first launch writes orgtree.desktop and icon; repeat launch is a no-op', () => {
  const h = home('app-first')
  const srcIcon = path.join(h.dir, 'source-eye.png')
  const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  fs.writeFileSync(srcIcon, iconBytes)
  const appFile = path.join(h.apps, 'orgtree.desktop')
  const destIcon = path.join(h.dir, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'orgtree.png')

  const first = registerLinuxOrgtreeApp(extractedInputs(h, { iconSource: srcIcon }))
  assert.deepEqual({ ...first }, { entry: 'written', icon: 'written' })
  const text = fs.readFileSync(appFile, 'utf8')
  assert.match(text, /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 \/home\/steamos\/Applications\/Orgtree\.AppImage %U$/m)
  assert.doesNotMatch(text, /appimage_extracted_/)
  assert.deepEqual(fs.readFileSync(destIcon), iconBytes)

  const stamp = [fs.statSync(appFile).mtimeMs, fs.statSync(destIcon).mtimeMs]
  const second = registerLinuxOrgtreeApp(extractedInputs(h, { iconSource: srcIcon }))
  assert.deepEqual({ ...second }, { entry: 'current', icon: 'exists' })
  assert.deepEqual([fs.statSync(appFile).mtimeMs, fs.statSync(destIcon).mtimeMs], stamp)
  assert.deepEqual(fs.readdirSync(h.apps), ['orgtree.desktop'])
})

test('managed orgtree.desktop is repaired on update, moved AppImage, missing NO_CLEANUP, or quoted path', () => {
  const h = home('app-repair')
  const appFile = path.join(h.apps, 'orgtree.desktop')
  fs.mkdirSync(h.apps, { recursive: true })
  fs.writeFileSync(appFile, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Orgtree',
    'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 "/home/steamos/Old/Orgtree.AppImage" %U',
    'Icon=orgtree',
    'X-Orgtree-Version=4.6.8',
    '',
  ].join('\n'))

  const res = registerLinuxOrgtreeApp(extractedInputs(h))
  assert.deepEqual({ ...res }, { entry: 'written', icon: 'skipped' })
  const text = fs.readFileSync(appFile, 'utf8')
  assert.match(text, /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 \/home\/steamos\/Applications\/Orgtree\.AppImage %U$/m)
  assert.match(text, /^X-Orgtree-Version=4\.6\.9$/m)
  assert.deepEqual({ ...registerLinuxOrgtreeApp(extractedInputs(h)) }, { entry: 'current', icon: 'skipped' })
})

test('hand-written orgtree.desktop, other-named entries, and existing custom icons are preserved byte-for-byte', () => {
  const h = home('app-handwritten')
  fs.mkdirSync(h.apps, { recursive: true })
  const handwritten = [
    '[Desktop Entry]',
    'Name=Orgtree',
    'Comment=Custom Frame wrapper',
    'Exec=/home/steamos/bin/my-orgtree %U',
    'Icon=custom-orgtree',
    'Type=Application',
    '',
  ].join('\n')
  const appFile = path.join(h.apps, 'orgtree.desktop')
  const otherFile = path.join(h.apps, 'frame-orgtree.desktop')
  const otherText = '[Desktop Entry]\nType=Application\nName=My Orgtree\nExec=/opt/other\n'
  fs.writeFileSync(appFile, handwritten)
  fs.writeFileSync(otherFile, otherText)

  // Hand-written orgtree.desktop (no X-Orgtree-Version=) is left untouched.
  const srcIcon = path.join(h.dir, 'source-eye.png')
  fs.writeFileSync(srcIcon, Buffer.from('new-png'))
  const res = registerLinuxOrgtreeApp(extractedInputs(h, { iconSource: srcIcon }))
  assert.deepEqual({ ...res }, { entry: 'other', icon: 'skipped' })
  assert.equal(fs.readFileSync(appFile, 'utf8'), handwritten)
  assert.equal(fs.readFileSync(otherFile, 'utf8'), otherText)
  assert.ok(!fs.existsSync(path.join(h.dir, '.local', 'share', 'icons')))

  // When orgtree.desktop is absent, an existing custom icon and other-named entry stay untouched.
  fs.unlinkSync(appFile)
  const destIcon = path.join(h.dir, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'orgtree.png')
  fs.mkdirSync(path.dirname(destIcon), { recursive: true })
  const customIcon = Buffer.from('user-custom-icon')
  fs.writeFileSync(destIcon, customIcon)
  const created = registerLinuxOrgtreeApp(extractedInputs(h, { iconSource: srcIcon }))
  assert.deepEqual({ ...created }, { entry: 'written', icon: 'exists' })
  assert.deepEqual(fs.readFileSync(destIcon), customIcon)
  assert.equal(fs.readFileSync(otherFile, 'utf8'), otherText)
})

test('a failed optional icon write leaves orgtree.desktop and link registration usable', () => {
  const h = home('app-icon-fail')
  const srcIcon = path.join(h.dir, 'source-eye.png')
  fs.writeFileSync(srcIcon, Buffer.from('png-bytes'))
  // Block icons directory creation by placing a regular file at .local/share/icons
  const iconsBlocker = path.join(h.dir, '.local', 'share', 'icons')
  fs.mkdirSync(path.dirname(iconsBlocker), { recursive: true })
  fs.writeFileSync(iconsBlocker, 'not a directory')

  const appRes = registerLinuxOrgtreeApp(extractedInputs(h, { iconSource: srcIcon }))
  assert.deepEqual({ ...appRes }, { entry: 'written', icon: 'skipped' })
  assert.ok(fs.existsSync(path.join(h.apps, 'orgtree.desktop')))
  const linkRes = registerLinuxOrgtreeScheme(extractedInputs(h))
  assert.deepEqual({ ...linkRes }, { entry: 'written', default: 'set' })
})

test('XDG_DATA_HOME relocates orgtree.desktop and its icon', () => {
  const h = home('app-xdg')
  const srcIcon = path.join(h.dir, 'source-eye.png')
  fs.writeFileSync(srcIcon, Buffer.from('png'))
  const data = path.join(h.dir, 'xdg-data')
  const env = { ...extractedInputs(h).env, XDG_DATA_HOME: data }
  const res = registerLinuxOrgtreeApp(extractedInputs(h, { env, iconSource: srcIcon }))
  assert.deepEqual({ ...res }, { entry: 'written', icon: 'written' })
  assert.ok(fs.existsSync(path.join(data, 'applications', 'orgtree.desktop')))
  assert.ok(fs.existsSync(path.join(data, 'icons', 'hicolor', '256x256', 'apps', 'orgtree.png')))
  assert.ok(!fs.existsSync(path.join(h.apps, 'orgtree.desktop')))
})

test('guards skip non-extracted runs, non-Linux, dev builds, custom profiles, foreign HOME, and invalid APPIMAGE', () => {
  for (const [why, over] of [
    ['FUSE-mounted AppImage', h => ({ env: { HOME: h.dir, APPIMAGE: '/home/u/Orgtree.AppImage', APPDIR: '/tmp/.mount_OrgtreAbCdEf' } })],
    ['installed package (no AppImage)', h => ({ env: { HOME: h.dir }, execPath: '/opt/Orgtree/orgtree' })],
    ['Windows', { platform: 'win32' }],
    ['macOS', { platform: 'darwin' }],
    ['development', { isPackaged: false }],
    ['custom data root', h => ({ env: { ...extractedInputs(h).env, ORGTREE_V2_DATA: '/scratch/data' } })],
    ['custom profile', h => ({ env: { ...extractedInputs(h).env, ORGTREE_V2_PROFILE: '/scratch/profile' } })],
    ['foreign HOME', h => ({ env: { ...extractedInputs(h).env, HOME: '/tmp/smoke-home' } })],
    ['relative APPIMAGE', h => ({ env: { ...extractedInputs(h).env, APPIMAGE: 'relative/Orgtree.AppImage' } })],
    ['control-char APPIMAGE', h => ({ env: { ...extractedInputs(h).env, APPIMAGE: '/a/bad\npath' } })],
  ]) {
    const h = home('app-guard')
    const result = registerLinuxOrgtreeApp(extractedInputs(h, typeof over === 'function' ? over(h) : over))
    assert.deepEqual({ ...result }, { entry: 'skipped', icon: 'skipped' }, why)
    assert.deepEqual(fs.readdirSync(h.dir), [], why)
  }
})

test('non-regular orgtree.desktop, commented or wrong-section markers, and symlinks are never overwritten', () => {
  // Commented or other-section X-Orgtree-Version= does not claim ownership.
  for (const [label, body] of [
    ['commented', '[Desktop Entry]\nType=Application\nName=Orgtree\n# X-Orgtree-Version=4.6.8\nExec=/opt/custom\n'],
    ['other section', '[Desktop Entry]\nType=Application\nName=Orgtree\nExec=/opt/custom\n\n[Other]\nX-Orgtree-Version=4.6.8\n'],
    ['empty value', '[Desktop Entry]\nType=Application\nName=Orgtree\nExec=/opt/custom\nX-Orgtree-Version=\n'],
  ]) {
    const h = home('app-marker')
    fs.mkdirSync(h.apps, { recursive: true })
    const appFile = path.join(h.apps, 'orgtree.desktop')
    fs.writeFileSync(appFile, body)
    assert.deepEqual({ ...registerLinuxOrgtreeApp(extractedInputs(h)) }, { entry: 'other', icon: 'skipped' }, label)
    assert.equal(fs.readFileSync(appFile, 'utf8'), body, label)
  }

  // Non-regular directory at orgtree.desktop is refused cleanly.
  const hd = home('app-dir')
  fs.mkdirSync(path.join(hd.apps, 'orgtree.desktop'), { recursive: true })
  assert.deepEqual({ ...registerLinuxOrgtreeApp(extractedInputs(hd)) }, { entry: 'other', icon: 'skipped' })
  assert.ok(fs.lstatSync(path.join(hd.apps, 'orgtree.desktop')).isDirectory())

  // On Linux, symlinks at orgtree.desktop or icon target are left untouched.
  if (process.platform === 'linux') {
    const hs = home('app-symlink')
    fs.mkdirSync(hs.apps, { recursive: true })
    const target = path.join(hs.dir, 'target.desktop')
    const targetBody = '[Desktop Entry]\nType=Application\nName=Orgtree\nExec=/opt/custom\nX-Orgtree-Version=4.6.8\n'
    fs.writeFileSync(target, targetBody)
    const linkPath = path.join(hs.apps, 'orgtree.desktop')
    fs.symlinkSync(target, linkPath)
    assert.deepEqual({ ...registerLinuxOrgtreeApp(extractedInputs(hs)) }, { entry: 'other', icon: 'skipped' })
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink())
    assert.equal(fs.readFileSync(target, 'utf8'), targetBody)
  }
})

test('generated entries pass desktop-file-validate on Linux when installed', () => {
  if (process.platform !== 'linux') return
  const h = home('validate')
  assert.equal(registerLinuxOrgtreeApp(extractedInputs(h)).entry, 'written')
  assert.equal(registerLinuxOrgtreeScheme(extractedInputs(h)).entry, 'written')
  execFileSync('desktop-file-validate', [path.join(h.apps, 'orgtree.desktop')], { stdio: 'pipe' })
  execFileSync('desktop-file-validate', [path.join(h.apps, 'dev.orgtree.link.desktop')], { stdio: 'pipe' })
})

// Round 1 review fixes: M10 (AppImage executable ownership) and M12 (concurrent write safety,
// system-entry shadowing, and exclusive temp-file collision handling).

test('M10: native install inheriting another apps AppImage/APPDIR never registers that foreign AppImage', () => {
  const h = home('m10-foreign-appimage')
  const inheritedEnv = {
    HOME: h.dir,
    APPIMAGE: '/home/u/Applications/OtherApp.AppImage',
    APPDIR: '/tmp/appimage_extracted_deadbeef',
    XDG_DATA_DIRS: h.sysData,
  }
  // Native .deb binary started as child of another extracted AppImage.
  const appRes = registerLinuxOrgtreeApp(extractedInputs(h, {
    execPath: '/opt/Orgtree/orgtree',
    env: inheritedEnv,
  }))
  assert.deepEqual({ ...appRes }, { entry: 'skipped', icon: 'skipped' })
  assert.ok(!fs.existsSync(path.join(h.apps, 'orgtree.desktop')))

  // Scheme handler must also ignore the parent AppImage and register our own native executable.
  const linkRes = registerLinuxOrgtreeScheme(extractedInputs(h, {
    execPath: '/opt/Orgtree/orgtree',
    env: inheritedEnv,
  }))
  assert.deepEqual({ ...linkRes }, { entry: 'written', default: 'set' })
  const linkText = fs.readFileSync(h.entry, 'utf8')
  assert.match(linkText, /^Exec=\/opt\/Orgtree\/orgtree %u$/m)
  assert.doesNotMatch(linkText, /OtherApp|APPIMAGE_EXTRACT_AND_RUN/)

  // Spoofed broad APPDIR (e.g. /opt or /) must not claim ownership of a native binary.
  for (const spoofedDir of ['/', '/opt']) {
    const hs = home('m10-spoof')
    const r = registerLinuxOrgtreeScheme(inputs(hs, {
      execPath: '/opt/Orgtree/orgtree',
      env: { HOME: hs.dir, APPIMAGE: '/home/u/Other.AppImage', APPDIR: spoofedDir, XDG_DATA_DIRS: hs.sysData },
    }))
    assert.deepEqual({ ...r }, { entry: 'written', default: 'set' }, spoofedDir)
    assert.match(fs.readFileSync(hs.entry, 'utf8'), /^Exec=\/opt\/Orgtree\/orgtree %u$/m, spoofedDir)
  }
})

test('M12: first install of orgtree.desktop and icon uses no-replace semantics against concurrent writers', () => {
  const h = home('m12-noreplace')
  const appFile = path.join(h.apps, 'orgtree.desktop')
  const destIcon = path.join(h.dir, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'orgtree.png')
  const srcIcon = path.join(h.dir, 'source-eye.png')
  fs.writeFileSync(srcIcon, Buffer.from('bundled-png'))
  const concurrentDesktop = '[Desktop Entry]\nType=Application\nName=Custom\nExec=/opt/user-custom\n'
  const concurrentIcon = Buffer.from('user-concurrent-icon')

  // Concurrent custom orgtree.desktop lands after absence check, right before publish.
  const res1 = registerLinuxOrgtreeApp(extractedInputs(h, {
    iconSource: srcIcon,
    beforePublish: (dest) => {
      if (dest === appFile) fs.writeFileSync(appFile, concurrentDesktop)
    },
  }))
  assert.deepEqual({ ...res1 }, { entry: 'other', icon: 'skipped' })
  assert.equal(fs.readFileSync(appFile, 'utf8'), concurrentDesktop)
  assert.deepEqual(fs.readdirSync(h.apps), ['orgtree.desktop'], 'temp file cleaned up on EEXIST')

  // Concurrent custom icon lands after absence check, right before icon publish.
  fs.unlinkSync(appFile)
  const res2 = registerLinuxOrgtreeApp(extractedInputs(h, {
    iconSource: srcIcon,
    beforePublish: (dest) => {
      if (dest === destIcon) fs.writeFileSync(destIcon, concurrentIcon)
    },
  }))
  assert.deepEqual({ ...res2 }, { entry: 'written', icon: 'exists' })
  assert.deepEqual(fs.readFileSync(destIcon), concurrentIcon)
  assert.deepEqual(fs.readdirSync(path.dirname(destIcon)), ['orgtree.png'], 'icon temp file cleaned up on EEXIST')
})

test('M12: repair of managed orgtree.desktop refuses to clobber a concurrent user edit or replacement', () => {
  const h = home('m12-repair-race')
  const appFile = path.join(h.apps, 'orgtree.desktop')
  fs.mkdirSync(h.apps, { recursive: true })
  const oldManaged = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Orgtree',
    'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 /home/steamos/Old/Orgtree.AppImage %U',
    'Icon=orgtree',
    'X-Orgtree-Version=4.6.8',
    '',
  ].join('\n')
  const concurrentCustom = '[Desktop Entry]\nType=Application\nName=Orgtree\nExec=/home/steamos/my-wrapper %U\n'
  fs.writeFileSync(appFile, oldManaged)

  const res = registerLinuxOrgtreeApp(extractedInputs(h, {
    beforePublish: (dest) => {
      if (dest === appFile) fs.writeFileSync(appFile, concurrentCustom)
    },
  }))
  assert.deepEqual({ ...res }, { entry: 'other', icon: 'skipped' })
  assert.equal(fs.readFileSync(appFile, 'utf8'), concurrentCustom)
  assert.deepEqual(fs.readdirSync(h.apps), ['orgtree.desktop'], 'temp file cleaned up when repair aborts')
})

test('M12: administrator-installed system orgtree.desktop under XDG_DATA_DIRS is not shadowed', () => {
  const h = home('m12-sys-entry')
  const sysApps = path.join(h.sysData, 'applications')
  fs.mkdirSync(sysApps, { recursive: true })
  fs.writeFileSync(path.join(sysApps, 'orgtree.desktop'), '[Desktop Entry]\nType=Application\nName=Orgtree\nExec=/opt/Orgtree/orgtree %U\n')
  const srcIcon = path.join(h.dir, 'source-eye.png')
  fs.writeFileSync(srcIcon, Buffer.from('png'))

  const res = registerLinuxOrgtreeApp(extractedInputs(h, { iconSource: srcIcon }))
  assert.deepEqual({ ...res }, { entry: 'other', icon: 'skipped' })
  assert.ok(!fs.existsSync(path.join(h.apps, 'orgtree.desktop')))
  assert.ok(!fs.existsSync(path.join(h.dir, '.local', 'share', 'icons')))

  // XDG_DATA_DIRS pointing only at dataHome itself must not block creating our own user entry.
  const h2 = home('m12-sys-self')
  const dataHome = path.join(h2.dir, '.local', 'share')
  const envSelf = { ...extractedInputs(h2).env, XDG_DATA_DIRS: dataHome }
  assert.equal(registerLinuxOrgtreeApp(extractedInputs(h2, { env: envSelf })).entry, 'written')
})

test('M12: exclusive temp-open collision never deletes the pre-existing file at the tentative temp path', () => {
  const h = home('m12-tmp-collision')
  fs.mkdirSync(h.apps, { recursive: true })
  const collidingTmp = path.join(h.apps, 'preexisting-collision.tmp')
  fs.writeFileSync(collidingTmp, 'do-not-delete-me')

  assert.throws(() => {
    registerLinuxOrgtreeApp(extractedInputs(h, {
      makeTempPath: () => collidingTmp,
    }))
  })
  assert.equal(fs.readFileSync(collidingTmp, 'utf8'), 'do-not-delete-me')
})
