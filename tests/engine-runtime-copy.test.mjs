// The engine's own copy for an AppImage that runs without FUSE
// (apps/desktop/main/engine-runtime.ts; docket 4-6-4-linux-appimage-boot-unit-takeover-fallback).
//
// Measured on 2026-11-19 with the x64 4.6.3 AppImage in a container without FUSE:
// --appimage-extract-and-run unpacks into /tmp/appimage_extracted_<hash>, shared by every
// launch of the file, and each launch deletes the folder when its app exits. A second
// launch removed all 900 files under the first, which was still running. On a Steam Frame
// that left PostgreSQL without plpgsql, and a background engine registered to run the
// AppImage file could not start at all (no libfuse.so.2).
//
// Real folders in the temp directory; no AppImage, no engine, no service manager.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-engine-runtime-'))
const load = async name => {
  const out = path.join(temp, `${name}.cjs`)
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out)
}
const runtime = await load('engine-runtime')
const boot = await load('unixboot')
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))
const posix = process.platform !== 'win32'

/** A stand-in for the extraction's `resources`: an engine, PostgreSQL beside it, the ui. */
function resources(tag, extra = {}) {
  const dir = fs.mkdtempSync(path.join(temp, `resources-${tag}-`))
  const files = {
    'engine/orgtree-engine': 'engine ' + tag,
    'engine/orgtree-mailhub': 'mail hub',
    'engine/postgresql/bin/postgres': 'postgres',
    'engine/postgresql/lib/plpgsql.so': 'plpgsql',
    'engine/postgresql/lib/libpq.so.5.18': 'libpq',
    'ui/index.html': '<!doctype html>',
    'ui/assets/app.js': 'console.log(1)',
    'app.asar': 'not copied',
    'build-info.json': '{}',
    ...extra,
  }
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  if (posix) {
    fs.chmodSync(path.join(dir, 'engine/orgtree-engine'), 0o755)
    fs.symlinkSync('libpq.so.5.18', path.join(dir, 'engine/postgresql/lib/libpq.so.5'))
  }
  return dir
}
const listing = dir => fs.readdirSync(dir, { recursive: true }).map(f => String(f).split(path.sep).join('/')).sort()
const never = async () => false

test('without FUSE the AppImage runs from <tmp>/appimage_extracted_<hash>: that, and only that, is recognised', () => {
  const extracted = '/tmp/appimage_extracted_a790c0f0ac56d3105a15aee42dc97fad'
  assert.equal(runtime.appImageExtracted({ APPIMAGE: '/home/deck/Orgtree.AppImage', APPDIR: extracted }), extracted)
  assert.equal(runtime.appImageExtracted({ APPIMAGE: '/home/deck/Orgtree.AppImage', APPDIR: '/var/tmp/x/appimage_extracted_0123/' }), '/var/tmp/x/appimage_extracted_0123/', 'TMPDIR moves it')
  // with FUSE the app runs from a mount, and nothing changes for it
  assert.equal(runtime.appImageExtracted({ APPIMAGE: '/home/deck/Orgtree.AppImage', APPDIR: '/tmp/.mount_OrgtreXYZ' }), null)
  // the .deb, a development run, a stray variable
  assert.equal(runtime.appImageExtracted({}), null)
  assert.equal(runtime.appImageExtracted({ APPDIR: extracted }), null)
  assert.equal(runtime.appImageExtracted({ APPIMAGE: '/home/deck/Orgtree.AppImage' }), null)
})

test('one folder per build, named by version and commit', () => {
  assert.equal(runtime.runtimeCopyName({ version: '4.6.4', commit: '51ef24f7fb79da51efd53d5eab4b13e45b86e30f' }), '4.6.4-51ef24f7fb79')
  assert.equal(runtime.runtimeCopyName({ version: '4.6.3-frame.1', commit: 'd28c95a155936e86' }), '4.6.3-frame.1-d28c95a15593')
  assert.equal(runtime.runtimeCopyName({ version: '4.6.4' }), '4.6.4')
  assert.equal(runtime.runtimeCopyName({ version: '../../x', commit: 'a/b' }), '.._.._x-a_b', 'never a path')
})

test('the engine and the ui are copied with their layout, links and modes; nothing else is', async () => {
  const from = resources('a')
  const root = path.join(temp, 'root-a', 'engine-runtime')
  const copy = await runtime.ensureRuntimeCopy({ resources: from, root, name: '4.6.4-abc', inUse: never })
  assert.equal(copy.copied, true)
  assert.equal(copy.dir, path.join(root, '4.6.4-abc'))
  assert.equal(copy.engine, path.join(root, '4.6.4-abc', 'engine'))
  assert.equal(copy.ui, path.join(root, '4.6.4-abc', 'ui'))
  assert.equal(fs.readFileSync(path.join(copy.engine, 'orgtree-engine'), 'utf8'), 'engine a')
  assert.equal(fs.readFileSync(path.join(copy.engine, 'postgresql', 'lib', 'plpgsql.so'), 'utf8'), 'plpgsql')
  // the host finds ../ui and postgresql/ beside itself (engine host.rs)
  assert.ok(fs.existsSync(path.join(copy.engine, '..', 'ui', 'index.html')))
  const got = listing(copy.dir)
  assert.ok(!got.includes('app.asar') && !got.includes('build-info.json'), 'only engine/ and ui/')
  assert.deepEqual(got.filter(f => !f.startsWith('.')), listing(from).filter(f => f.startsWith('engine') || f.startsWith('ui')))
  if (posix) {
    assert.equal(fs.statSync(path.join(copy.engine, 'orgtree-engine')).mode & 0o777, 0o755, 'still executable')
    assert.equal(fs.readlinkSync(path.join(copy.engine, 'postgresql', 'lib', 'libpq.so.5')), 'libpq.so.5.18', 'a relative link stays a relative link')
    assert.equal(fs.statSync(root).mode & 0o777, 0o700, 'private, like the data folders')
  }
  assert.deepEqual(fs.readdirSync(root), ['4.6.4-abc'], 'no temporary folder is left')
})

test('a verified copy of this build is used again, not copied again', async () => {
  const from = resources('b')
  const root = path.join(temp, 'root-b')
  const first = await runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never })
  const marker = fs.statSync(path.join(first.dir, '.complete')).mtimeMs
  let copies = 0
  const second = await runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never, copyTree: async () => { copies++ } })
  assert.equal(second.copied, false)
  assert.equal(copies, 0)
  assert.equal(fs.statSync(path.join(second.dir, '.complete')).mtimeMs, marker)
})

test('a half-finished or damaged copy is never used: it is replaced', async () => {
  const from = resources('c')
  const root = path.join(temp, 'root-c')
  // a folder in place without the marker: a copy that died before it was finished
  fs.mkdirSync(path.join(root, 'v', 'engine'), { recursive: true })
  fs.writeFileSync(path.join(root, 'v', 'engine', 'orgtree-engine'), 'half')
  const repaired = await runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never })
  assert.equal(repaired.copied, true)
  assert.equal(fs.readFileSync(path.join(repaired.engine, 'orgtree-engine'), 'utf8'), 'engine c')
  // a finished copy that lost a file since
  fs.rmSync(path.join(repaired.engine, 'postgresql', 'lib', 'plpgsql.so'))
  const again = await runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never })
  assert.equal(again.copied, true)
  assert.ok(fs.existsSync(path.join(again.engine, 'postgresql', 'lib', 'plpgsql.so')))
  // a finished copy whose file changed size
  fs.writeFileSync(path.join(again.engine, 'orgtree-engine'), 'shorter')
  assert.equal((await runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never })).copied, true)
})

test('a copy that does not match its source fails, and leaves nothing that looks finished', async () => {
  const from = resources('d')
  const root = path.join(temp, 'root-d')
  const dropsAFile = async (source, target) => {
    await fs.promises.cp(source, target, { recursive: true })
    await fs.promises.rm(path.join(target, 'postgresql', 'lib', 'plpgsql.so'), { force: true })
  }
  await assert.rejects(runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never, copyTree: dropsAFile }), /the engine copy is incomplete: [0-9]+ files/)
  assert.deepEqual(fs.readdirSync(root), [], 'neither the copy nor its temporary folder')
  const fails = async () => { throw new Error('ENOSPC: no space left on device') }
  await assert.rejects(runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never, copyTree: fails }), /ENOSPC/)
  assert.deepEqual(fs.readdirSync(root), [])
  await assert.rejects(runtime.ensureRuntimeCopy({ resources: path.join(temp, 'nowhere'), root, name: 'v', inUse: never }))
})

test('a damaged copy that a process still runs from is not replaced under it', async () => {
  const from = resources('e')
  const root = path.join(temp, 'root-e')
  const copy = await runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: never })
  fs.rmSync(path.join(copy.ui, 'index.html'))
  await assert.rejects(runtime.ensureRuntimeCopy({ resources: from, root, name: 'v', inUse: async () => true }), /does not match this build and is in use/)
  assert.equal(fs.readFileSync(path.join(copy.engine, 'orgtree-engine'), 'utf8'), 'engine e', 'untouched')
})

test('older copies: the current one and the newest other stay; one in use is never removed; strangers are left alone', async () => {
  const root = path.join(temp, 'root-f')
  const made = []
  for (const [i, name] of ['4.6.1-a', '4.6.2-b', '4.6.3-c'].entries()) {
    const copy = await runtime.ensureRuntimeCopy({ resources: resources('f' + i), root, name, inUse: async () => true })
    // finished one after another
    fs.utimesSync(path.join(copy.dir, '.complete'), new Date(2026, 0, i + 1), new Date(2026, 0, i + 1))
    made.push(copy.dir)
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ['4.6.1-a', '4.6.2-b', '4.6.3-c'], 'nothing in use was removed')
  fs.mkdirSync(path.join(root, 'someone-elses-folder'))
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a copy')
  fs.mkdirSync(path.join(root, '.tmp-4.6.0-z-123'))
  fs.utimesSync(path.join(root, '.tmp-4.6.0-z-123'), new Date(2026, 0, 1), new Date(2026, 0, 1))
  fs.mkdirSync(path.join(root, '.tmp-4.6.4-d-456'))   // another launch, copying right now

  const busy = made[0]   // an old engine still runs from the oldest copy
  const current = await runtime.ensureRuntimeCopy({ resources: resources('f3'), root, name: '4.6.4-d', inUse: async dir => dir === busy })
  assert.deepEqual(fs.readdirSync(root).sort(), ['.tmp-4.6.4-d-456', '4.6.1-a', '4.6.3-c', '4.6.4-d', 'notes.txt', 'someone-elses-folder'])
  assert.deepEqual(current.removed.sort(), [path.join(root, '.tmp-4.6.0-z-123'), made[1]].sort())

  // once nothing runs from it, the oldest goes too
  const later = await runtime.ensureRuntimeCopy({ resources: resources('f3'), root, name: '4.6.4-d', inUse: never })
  assert.equal(later.copied, false)
  assert.deepEqual(later.removed, [busy])
  assert.deepEqual(fs.readdirSync(root).filter(f => /^\d/.test(f)).sort(), ['4.6.3-c', '4.6.4-d'], 'the current and the previous')
})

test('a process counts as running from a copy by its program\'s path', async () => {
  const proc = path.join(temp, 'proc')
  const link = (pid, target) => {
    fs.mkdirSync(path.join(proc, pid), { recursive: true })
    if (posix) fs.symlinkSync(target, path.join(proc, pid, 'exe'))
  }
  link('101', '/home/deck/.config/Orgtree v2/engine-runtime/4.6.3-c/engine/orgtree-engine')
  link('102', '/home/deck/.config/Orgtree v2/engine-runtime/4.6.2-b/engine/postgresql/bin/postgres (deleted)')
  link('103', '/usr/bin/bash')
  fs.mkdirSync(path.join(proc, 'self'), { recursive: true })
  fs.mkdirSync(path.join(proc, '104'), { recursive: true })   // no exe: not ours to read
  const runs = dir => runtime.processRunsFrom(dir, proc)
  if (posix) {
    assert.equal(await runs('/home/deck/.config/Orgtree v2/engine-runtime/4.6.3-c'), true)
    assert.equal(await runs('/home/deck/.config/Orgtree v2/engine-runtime/4.6.2-b'), true, 'PostgreSQL alone keeps it')
    // 4.6.3-c is not 4.6.3-cd
    assert.equal(await runs('/home/deck/.config/Orgtree v2/engine-runtime/4.6.3'), false)
  }
  assert.equal(await runs('/home/deck/.config/Orgtree v2/engine-runtime/4.6.1-a'), false)
  assert.equal(await runtime.processRunsFrom('/anything', path.join(temp, 'no-proc')), false)
})

// The registration: with a copy there is no reason to go through the AppImage at all.
test('the background engine is registered to run the copy itself, and only while the AppImage is still there', () => {
  const copy = '/home/deck/.config/Orgtree v2/engine-runtime/4.6.4-51ef24f7fb79'
  const inputs = { platform: 'linux', home: '/home/deck', appId: 'com.maurdekye.orgtree', engine: `${copy}/engine/orgtree-engine`,
    requires: ['/home/deck/Applications/Orgtree-4.6.4-arm64.AppImage'], dataRoot: '/home/deck/.config/Orgtree v2/data' }
  const command = boot.bootCommand(inputs)
  assert.equal(command.program, `${copy}/engine/orgtree-engine`)
  assert.deepEqual(command.args, ['host'])
  assert.equal(command.env.ELECTRON_RUN_AS_NODE, undefined, 'no Electron in between')
  const unit = boot.systemdUnit(inputs)
  assert.match(unit, /^ExecStart="\/home\/deck\/\.config\/Orgtree v2\/engine-runtime\/4\.6\.4-51ef24f7fb79\/engine\/orgtree-engine" "host"$/m)
  assert.deepEqual(unit.split('\n').filter(line => line.startsWith('ConditionPathExists=')), [
    `ConditionPathExists=${copy}/engine/orgtree-engine`,
    'ConditionPathExists=/home/deck/Applications/Orgtree-4.6.4-arm64.AppImage',
  ], 'a deleted AppImage makes the unit a no-op, as a removed installation does')
  assert.doesNotMatch(unit, /appimage_extracted_|\.mount_|-e /, 'nothing names the extraction, a mount or the AppImage as a program')
  // the autostart fallback runs the same command
  assert.match(boot.autostartEntry(inputs), /^TryExec=\/home\/deck\/\.config\/Orgtree v2\/engine-runtime\/4\.6\.4-51ef24f7fb79\/engine\/orgtree-engine$/m)
  // % in a path is doubled for systemd, as in the first condition
  assert.match(boot.systemdUnit({ ...inputs, requires: ['/home/deck/50% off.AppImage'] }), /^ConditionPathExists=\/home\/deck\/50%% off\.AppImage$/m)
  // without `requires` the unit is what it was
  const { requires: _none, ...plain } = inputs
  assert.equal(boot.systemdUnit(plain).split('\n').filter(line => line.startsWith('ConditionPathExists=')).length, 1)
})

test('which engine the registration names: the copy without FUSE, the AppImage with it, the installed binary otherwise', () => {
  const base = { platform: 'linux', home: '/home/deck', appId: 'com.maurdekye.orgtree', dataRoot: '/d', shellPath: '/usr/bin' }
  const appImage = '/home/deck/Orgtree.AppImage'
  const copyEngine = '/home/deck/.config/Orgtree v2/engine-runtime/v/engine/orgtree-engine'
  assert.deepEqual(boot.bootInputsFor({ ...base, engine: copyEngine, appImage, extracted: true }),
    { ...base, engine: copyEngine, requires: [appImage] })
  assert.deepEqual(boot.bootInputsFor({ ...base, engine: '/tmp/.mount_x/resources/engine/orgtree-engine', appImage, extracted: false }),
    { ...base, engine: '/tmp/.mount_x/resources/engine/orgtree-engine', appImage })
  assert.deepEqual(boot.bootInputsFor({ ...base, engine: '/opt/Orgtree/resources/engine/orgtree-engine', extracted: false }),
    { ...base, engine: '/opt/Orgtree/resources/engine/orgtree-engine', appImage: undefined })
})
