// The background engine on macOS and Linux (docket
// mac-and-linux-background-engine-that-starts-auto): the LaunchAgent, the
// systemd user unit and the XDG autostart entry the installed app writes
// (apps/desktop/main/unixboot.ts), the commands that load them, and the
// POSIX trust check the desktop applies to the host's attach descriptor
// (policy.ts judgePosixTrust).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Anywhere: the generated files, their
// quoting, the exact launchctl/systemctl sequence (a fake runner), the trust
// rules. On a Mac with plutil, the plist lints; on Linux with
// systemd-analyze / desktop-file-validate, the unit and entry verify. That
// launchd or systemd really starts the host and it answers on its port is
// tools/ci/boot-engine-smoke.mjs, run on the CI runners.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-unixboot-'))
const load = async (source, name) => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [source], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out)
}
const boot = await load('apps/desktop/main/unixboot.ts', 'unixboot')
const policy = await load('apps/desktop/main/policy.ts', 'policy')

const mac = { platform: 'darwin', home: '/Users/alex', appId: 'com.maurdekye.orgtree',
  engine: '/Applications/Orgtree.app/Contents/Resources/engine/orgtree-engine', dataRoot: '/Users/alex/Library/Application Support/Orgtree v2/data' }
const deb = { platform: 'linux', home: '/home/alex', appId: 'com.maurdekye.orgtree',
  engine: '/opt/Orgtree/resources/engine/orgtree-engine', dataRoot: '/home/alex/.config/Orgtree v2/data' }
const appImage = { ...deb, engine: '/tmp/.mount_OrgtrXYZ/resources/engine/orgtree-engine', appImage: '/home/alex/Apps/Orgtree 4.1.0.AppImage' }

const has = cmd => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true } catch { return false } }

test('the command: the installed engine binary in host mode, with the data folder and a usual PATH', () => {
  const c = boot.bootCommand(deb)
  assert.equal(c.program, deb.engine)
  assert.deepEqual(c.args, ['host'])
  assert.equal(c.env.ORGTREE_V2_DATA, deb.dataRoot)
  assert.equal(c.env.PATH, '/home/alex/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  assert.match(boot.bootCommand(mac).env.PATH, /^\/Users\/alex\/\.local\/bin:\/opt\/homebrew\/bin:/)
  assert.equal(c.env.ELECTRON_RUN_AS_NODE, undefined)
})

test('an AppImage registers the AppImage file itself (its mount is temporary) and runs the host through it as node', () => {
  const c = boot.bootCommand(appImage)
  assert.equal(c.program, appImage.appImage)
  assert.deepEqual(c.args, ['-e', boot.APPIMAGE_HOST_JS])
  assert.equal(c.env.ELECTRON_RUN_AS_NODE, '1')
  assert.doesNotMatch(boot.APPIMAGE_HOST_JS, /[$%`"]/, 'the wrapper survives every quoting unchanged')
  assert.doesNotMatch(boot.systemdUnit(appImage), /\.mount_/, 'nothing names the temporary mount')
})

test('the AppImage wrapper starts resources/engine/orgtree-engine host beside its own executable and passes its exit code on', { skip: process.platform === 'win32' && 'the engine stand-in is a POSIX script' }, () => {
  const fake = fs.mkdtempSync(path.join(dir, 'appimage-'))
  const engineDir = path.join(fake, 'resources', 'engine')
  fs.mkdirSync(engineDir, { recursive: true })
  // node stands in for the AppImage's electron binary; a script for the engine
  const node = path.join(fake, path.basename(process.execPath))
  fs.copyFileSync(process.execPath, node)
  const engine = path.join(engineDir, 'orgtree-engine')
  fs.writeFileSync(engine, '#!/bin/sh\n[ "$1" = host ] && exit 7\nexit 1\n', { mode: 0o755 })
  let code = 0
  try { execFileSync(node, ['-e', boot.APPIMAGE_HOST_JS], { stdio: 'ignore' }) } catch (e) { code = e.status }
  assert.equal(code, 7)
})

test('macOS: the LaunchAgent runs at load, restarts only after a failure, no sooner than a minute, and skips a removed app', () => {
  const plist = boot.launchAgentPlist(mac)
  assert.equal(boot.bootFile(mac, 'launchd'), '/Users/alex/Library/LaunchAgents/com.maurdekye.orgtree.engine.plist')
  assert.match(plist, /<key>Label<\/key><string>com\.maurdekye\.orgtree\.engine<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/)
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>60<\/integer>/)
  assert.match(plist, /<key>ProcessType<\/key><string>Standard<\/string>/, 'normal priority, as the Windows task')
  const args = [...plist.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map(m => m[1])
  assert.deepEqual(args, ['/bin/sh', '-c', 'test -x &quot;$0&quot; || exit 0; exec &quot;$0&quot; &quot;$@&quot;', mac.engine, 'host'])
  assert.match(plist, /<key>ORGTREE_V2_DATA<\/key><string>\/Users\/alex\/Library\/Application Support\/Orgtree v2\/data<\/string>/)
  assert.match(boot.launchAgentPlist({ ...mac, dataRoot: '/x/a&b<c>' }), /<string>\/x\/a&amp;b&lt;c&gt;<\/string>/)
})

test('macOS: the plist lints (plutil, on a Mac)', { skip: !has('plutil') && 'no plutil here' }, () => {
  const file = path.join(dir, 'agent.plist')
  fs.writeFileSync(file, boot.launchAgentPlist(mac))
  execFileSync('plutil', ['-lint', file])
})

test('the launchd guard: a present engine is exec\'d with its arguments, a missing one exits 0', { skip: process.platform === 'win32' && 'no /bin/sh' }, () => {
  const guard = 'test -x "$0" || exit 0; exec "$0" "$@"'
  assert.equal(execFileSync('/bin/sh', ['-c', guard, '/bin/echo', 'host']).toString(), 'host\n')
  assert.equal(execFileSync('/bin/sh', ['-c', guard, '/nonexistent/orgtree-engine', 'host']).toString(), '')
})

test('Linux: the systemd user unit, quoted, restarting on failure like the task (a minute apart, three times)', () => {
  const unit = boot.systemdUnit(deb)
  assert.equal(boot.bootFile(deb, 'systemd'), '/home/alex/.config/systemd/user/orgtree-engine.service')
  assert.match(unit, /^ConditionPathExists=\/opt\/Orgtree\/resources\/engine\/orgtree-engine$/m)
  assert.match(unit, /^ExecStart="\/opt\/Orgtree\/resources\/engine\/orgtree-engine" "host"$/m)
  assert.match(unit, /^Environment="ORGTREE_V2_DATA=\/home\/alex\/\.config\/Orgtree v2\/data"$/m)
  assert.match(unit, /^Restart=on-failure$/m)
  assert.match(unit, /^RestartSec=60$/m)
  assert.match(unit, /^StartLimitBurst=4$/m)
  assert.match(unit, /^KillMode=mixed$/m)
  assert.match(unit, /^WantedBy=default\.target$/m)
  assert.doesNotMatch(unit, /Nice=|CPUSchedulingPriority=/, 'normal priority')
  assert.equal(boot.systemdQuote('a "b" \\ 100% $HOME'), '"a \\"b\\" \\\\ 100%% $$HOME"')
})

test('Linux: the unit verifies (systemd-analyze, where present)', { skip: !has('systemd-analyze') && 'no systemd-analyze here' }, () => {
  const d = fs.mkdtempSync(path.join(dir, 'unit-'))
  const engine = path.join(d, 'orgtree-engine')
  fs.writeFileSync(engine, '#!/bin/sh\n', { mode: 0o755 })
  const file = path.join(d, 'orgtree-engine.service')
  fs.writeFileSync(file, boot.systemdUnit({ ...deb, engine, home: d }))
  execFileSync('systemd-analyze', ['--user', 'verify', file], { stdio: 'pipe' })
})

test('Linux without systemd --user: an XDG autostart entry with the same command', () => {
  const entry = boot.autostartEntry(appImage)
  assert.equal(boot.bootFile(deb, 'autostart'), '/home/alex/.config/autostart/orgtree-engine.desktop')
  assert.match(entry, /^TryExec=\/home\/alex\/Apps\/Orgtree 4\.1\.0\.AppImage$/m)
  assert.match(entry, /^Exec=env "ORGTREE_V2_DATA=\/home\/alex\/\.config\/Orgtree v2\/data" PATH=\/home\/alex\/\.local\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin ELECTRON_RUN_AS_NODE=1 "\/home\/alex\/Apps\/Orgtree 4\.1\.0\.AppImage" -e "/m)
  assert.match(entry, /^NoDisplay=true$/m)
  assert.equal(boot.desktopExecQuote('a$b`c"d\\e 50%'), '"a\\$b\\`c\\"d\\\\e 50%%"')
})

test('Linux: the autostart entry validates (desktop-file-validate, where present)', { skip: !has('desktop-file-validate') && 'no desktop-file-validate here' }, () => {
  const file = path.join(dir, 'orgtree-engine.desktop')
  fs.writeFileSync(file, boot.autostartEntry(deb))
  execFileSync('desktop-file-validate', [file], { stdio: 'pipe' })
})

/** Fake I/O: records commands, answers from a table keyed by the command line. */
function fakeIo(answers = {}, files = {}) {
  const calls = [], detached = []
  const io = {
    runner: async (file, args) => { const key = [file, ...args].join(' '); calls.push(key); return answers[key] ?? { code: 0, stdout: '', stderr: '' } },
    read: f => files[f] ?? null,
    write: (f, t) => { files[f] = t; calls.push(`write ${f}`) },
    remove: f => { delete files[f]; calls.push(`remove ${f}`) },
    uid: () => 501,
    detach: c => { detached.push(c) },
  }
  return { io, calls, files, detached }
}

test('macOS registering: write, bootstrap and kickstart when new; an unchanged, loaded agent is only kickstarted', async () => {
  const label = 'gui/501/com.maurdekye.orgtree.engine'
  const file = boot.bootFile(mac, 'launchd')
  const fresh = fakeIo({ [`launchctl print ${label}`]: { code: 113, stdout: '', stderr: 'not found' } })
  const r = await boot.ensureBootEngine(mac, fresh.io)
  assert.deepEqual(r, { manager: 'launchd', file, changed: true, started: true })
  assert.deepEqual(fresh.calls, [`launchctl bootout ${label}`, `write ${file}`, `launchctl print ${label}`,
    `launchctl bootstrap gui/501 ${file}`, `launchctl kickstart ${label}`])
  const again = fakeIo({}, { ...fresh.files })
  assert.equal((await boot.ensureBootEngine(mac, again.io)).changed, false)
  assert.deepEqual(again.calls, [`launchctl print ${label}`, `launchctl kickstart ${label}`], 'a running engine is never restarted')
  const moved = fakeIo({}, { ...fresh.files })
  await boot.ensureBootEngine({ ...mac, engine: '/Users/alex/Desktop/Orgtree.app/Contents/Resources/engine/orgtree-engine' }, moved.io)
  assert.equal(moved.calls[0], `launchctl bootout ${label}`, 'a moved app replaces the loaded agent')
  const refused = fakeIo({ [`launchctl print ${label}`]: { code: 113, stdout: '', stderr: '' }, [`launchctl bootstrap gui/501 ${file}`]: { code: 5, stdout: '', stderr: 'Input/output error' } })
  assert.deepEqual(await boot.ensureBootEngine(mac, refused.io), { manager: 'launchd', file, changed: true, started: false, error: 'launchctl bootstrap: Input/output error' })
})

test('Linux registering: systemd enables and starts the unit (restart only when it changed); the autostart entry is removed', async () => {
  const file = boot.bootFile(deb, 'systemd')
  const s = fakeIo({}, { [boot.bootFile(deb, 'autostart')]: 'old' })
  assert.deepEqual(await boot.ensureBootEngine(deb, s.io), { manager: 'systemd', file, changed: true, started: true })
  assert.deepEqual(s.calls, ['systemctl --user show-environment', `write ${file}`, 'systemctl --user daemon-reload',
    'systemctl --user enable orgtree-engine.service', 'systemctl --user restart orgtree-engine.service', `remove ${boot.bootFile(deb, 'autostart')}`])
  const again = fakeIo({}, { ...s.files })
  await boot.ensureBootEngine(deb, again.io)
  assert.ok(again.calls.includes('systemctl --user start orgtree-engine.service') && !again.calls.some(c => c.includes('restart')))
})

test('Linux without systemd --user: the autostart entry is written and this session\'s host is started now', async () => {
  const a = fakeIo({ 'systemctl --user show-environment': { code: 1, stdout: '', stderr: 'Failed to connect to bus' } })
  const r = await boot.ensureBootEngine(appImage, a.io)
  assert.equal(r.manager, 'autostart')
  assert.equal(r.started, true)
  assert.equal(a.files[boot.bootFile(deb, 'autostart')], boot.autostartEntry(appImage))
  assert.deepEqual(a.detached, [boot.bootCommand(appImage)])
})

test('removing undoes every registration', async () => {
  const m = fakeIo({}, { [boot.bootFile(mac, 'launchd')]: 'x' })
  await boot.removeBootEngine(mac, m.io)
  assert.deepEqual(m.calls, ['launchctl bootout gui/501/com.maurdekye.orgtree.engine', `remove ${boot.bootFile(mac, 'launchd')}`])
  const l = fakeIo()
  await boot.removeBootEngine(deb, l.io)
  assert.deepEqual(l.calls, ['systemctl --user disable --now orgtree-engine.service', `remove ${boot.bootFile(deb, 'systemd')}`,
    'systemctl --user daemon-reload', `remove ${boot.bootFile(deb, 'autostart')}`])
})

test('POSIX descriptor trust: this user\'s 0600 file in this user\'s folders; anything another user could write or read is refused', () => {
  const st = (uid, mode, kind = 'dir') => ({ uid, mode, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' })
  const file = st(501, 0o100600, 'file')
  const dirs = [['/home/alex/.config/Orgtree v2/data', st(501, 0o40755)], ['/home/alex', st(501, 0o40750)], ['/home', st(0, 0o40755)], ['/', st(0, 0o40755)]]
  assert.equal(policy.judgePosixTrust(501, file, dirs).ok, true)
  assert.match(policy.judgePosixTrust(501, st(502, 0o100600, 'file'), dirs).detail, /owner 502 is not current user 501/)
  assert.match(policy.judgePosixTrust(501, st(501, 0o100644, 'file'), dirs).detail, /mode 644/)
  assert.match(policy.judgePosixTrust(501, st(501, 0o120777, 'link'), dirs).detail, /not a regular file/)
  assert.match(policy.judgePosixTrust(501, file, [['/d', st(501, 0o40775)], ...dirs.slice(1)]).detail, /directory writable by others/)
  assert.match(policy.judgePosixTrust(501, file, [dirs[0], ['/home/alex', st(502, 0o40755)], ...dirs.slice(2)]).detail, /ancestor \/home\/alex \(owner 502\)/)
  assert.match(policy.judgePosixTrust(501, file, [dirs[0], ['/shared', st(0, 0o40777)], dirs[3]]).detail, /ancestor \/shared/)
  assert.equal(policy.judgePosixTrust(501, file, [dirs[0], ['/tmp', st(0, 0o41777)], dirs[3]]).ok, true, 'a sticky ancestor (/tmp) cannot have our folder replaced')
})
