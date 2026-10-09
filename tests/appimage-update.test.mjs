import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-appimage-'))
const outfile = path.join(root, 'appimage-update.cjs')
await build({ entryPoints: ['apps/desktop/main/appimage-update.ts'], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { appImagePath, replaceAppImage, appImageRelaunch, appImageRelaunchEnv } = createRequire(import.meta.url)(outfile)
const posix = process.platform !== 'win32'

test('only an absolute APPIMAGE counts as an AppImage run', () => {
  assert.equal(appImagePath({}), undefined)
  assert.equal(appImagePath({ APPIMAGE: '' }), undefined)
  assert.equal(appImagePath({ APPIMAGE: 'Orgtree.AppImage' }), undefined)
  assert.equal(appImagePath({ APPIMAGE: '/home/a/Orgtree\0.AppImage' }), undefined)
  assert.equal(appImagePath({ APPIMAGE: '/home/a/Apps/Orgtree-4.1.0.AppImage' }), '/home/a/Apps/Orgtree-4.1.0.AppImage')
})

test('the AppImage is replaced in place, under its old name, and the download is consumed', () => {
  const dir = fs.mkdtempSync(path.join(root, 'swap-'))
  const current = path.join(dir, 'Orgtree-4.1.0.AppImage')
  const downloaded = path.join(fs.mkdtempSync(path.join(root, 'cache-')), 'Orgtree-4.2.0.AppImage')
  fs.writeFileSync(current, 'old')
  fs.writeFileSync(downloaded, 'new')
  const result = replaceAppImage(current, downloaded, 4242)
  assert.deepEqual(result, { accepted: true, directory: dir, appImage: current })
  assert.equal(fs.readFileSync(current, 'utf8'), 'new')
  assert.deepEqual(fs.readdirSync(dir), ['Orgtree-4.1.0.AppImage'])
  assert.equal(fs.existsSync(downloaded), false)
  if (posix) assert.equal(fs.statSync(current).mode & 0o777, 0o755)
})

test('a failed swap leaves the old AppImage and no staged file behind, and throws', () => {
  const dir = fs.mkdtempSync(path.join(root, 'fail-'))
  const current = path.join(dir, 'Orgtree.AppImage')
  fs.writeFileSync(current, 'old')
  const io = {
    copyFileSync: (from, to) => fs.writeFileSync(to, 'partial'),
    chmodSync: () => {},
    renameSync: () => { throw new Error('EXDEV') },
    unlinkSync: file => fs.unlinkSync(file),
  }
  assert.throws(() => replaceAppImage(current, '/cache/new.AppImage', 7, io), /EXDEV/)
  assert.equal(fs.readFileSync(current, 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(dir), ['Orgtree.AppImage'])
  assert.throws(() => replaceAppImage(current, undefined), /did not name/)
})

test('the relaunch environment drops the old run\'s AppImage variables and restores the desktop name', () => {
  const env = appImageRelaunchEnv({ APPIMAGE: '/a', APPDIR: '/tmp/.mount_x', ARGV0: 'x', OWD: '/', ELECTRON_RUN_AS_NODE: '1',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME', XDG_CURRENT_DESKTOP: 'Unity', HOME: '/home/a', ORGTREE_UPDATE_FEED: 'http://127.0.0.1:1/' })
  assert.deepEqual(env, { XDG_CURRENT_DESKTOP: 'GNOME', HOME: '/home/a', ORGTREE_UPDATE_FEED: 'http://127.0.0.1:1/' })
})

test('the relaunch waits for the old process to exit, then runs the AppImage', { skip: !posix && 'needs /bin/sh' }, async () => {
  const dir = fs.mkdtempSync(path.join(root, 'relaunch '))
  const marker = path.join(dir, 'ran')
  const fake = path.join(dir, 'Orgtree $(touch pwned).AppImage')
  fs.writeFileSync(fake, `#!/bin/sh\necho "ran $*" > "${marker}"\n`, { mode: 0o755 })
  const old = spawn('sleep', ['1.5'])
  const started = Date.now()
  const command = appImageRelaunch(fake, old.pid, ['--updated', 'a b'])
  const waiter = spawn(command.file, command.args, { stdio: 'ignore', cwd: dir })
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(fs.existsSync(marker), false, 'ran while the old process was still alive')
  await new Promise(resolve => waiter.on('exit', resolve))
  assert.ok(Date.now() - started >= 1400)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ran --updated a b')
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false)
})
