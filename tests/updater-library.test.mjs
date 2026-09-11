// What electron-updater ACTUALLY does, driven against the installed package
// rather than described from its source. Everything in apps/desktop/main/
// updater.ts about judging an offer before accepting it rests on these two
// behaviours, so they are exercised here: if a future electron-updater changes
// either one, this fails loudly instead of the product quietly losing a
// prepared update.
//
// No network, no feed, no Electron. The library only touches `electron` lazily
// (ElectronAppAdapter's default argument, and getNetSession), neither of which
// is reached when an app adapter is supplied and no request is made.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { NsisUpdater } = require_('electron-updater/out/NsisUpdater')
const { DownloadedUpdateHelper } = require_('electron-updater/out/DownloadedUpdateHelper')
const version = require_('electron-updater/package.json').version

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const sha512 = text => crypto.createHash('sha512').update(Buffer.from(text)).digest('base64')

function updaterRunning(appVersion) {
  const updater = new NsisUpdater(null, {
    version: appVersion, name: 'Orgtree', isPackaged: true,
    appUpdateConfigPath: 'unused.yml', userDataPath: os.tmpdir(), baseCachePath: os.tmpdir(),
    whenReady: () => Promise.resolve(), quit: () => {}, onQuit: () => {},
  })
  updater.logger = quiet
  return updater
}

/** A pending cache as it exists on disk, with one prepared installer in it. */
function preparedCache(fileName, contents) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-updater-cache-'))
  const pending = path.join(cacheDir, 'pending')
  fs.mkdirSync(pending, { recursive: true })
  fs.writeFileSync(path.join(pending, fileName), contents)
  fs.writeFileSync(path.join(pending, 'update-info.json'),
    JSON.stringify({ fileName, sha512: sha512(contents), isAdminRightsRequired: false }))
  return { cacheDir, pending, file: path.join(pending, fileName), survives: () => fs.existsSync(path.join(pending, fileName)) }
}

test('electron-updater answers "is there an update" against the RUNNING version, not against what is already prepared', async () => {
  // This is the whole reason UpdateController has to judge the offer itself.
  // Running 2.0.3 with 2.0.4 already downloaded and waiting: the library still
  // calls 2.0.4 "available", and it calls a rolled-back 2.0.4 available too
  // even when 2.0.5 is the package sitting on disk.
  const updater = updaterRunning('2.0.3')
  assert.equal(await updater.isUpdateAvailable({ version: '2.0.4' }), true,
    'the release already prepared is reported as an available update all over again')
  assert.equal(await updater.isUpdateAvailable({ version: '2.0.5' }), true)
  // the control: it does refuse what is not newer than the RUNNING version
  assert.equal(await updater.isUpdateAvailable({ version: '2.0.3' }), false)
  assert.equal(await updater.isUpdateAvailable({ version: '2.0.2' }), false)
  assert.match(version, /^6\./, 'these behaviours are read off electron-updater 6.x')
})

test('accepting an offer is what destroys the prepared package: the library empties its own pending directory', async () => {
  const contents = 'PREPARED INSTALLER BYTES'
  // A fresh helper is the state after a restart - the common case, since a
  // prepared update usually outlives the session that downloaded it.
  const kept = preparedCache('Orgtree-Setup-2.0.4.exe', contents)
  const keptHelper = new DownloadedUpdateHelper(kept.cacheDir)
  const same = await keptHelper.validateDownloadedPath(kept.file, { version: '2.0.4' },
    { info: { sha512: sha512(contents), url: 'Orgtree-Setup-2.0.4.exe' } }, quiet)
  assert.equal(same, kept.file, 'POSITIVE CONTROL: an unchanged artifact is reused')
  assert.equal(kept.survives(), true, 'and the file this instrument watches is still there, so "deleted" below means something')

  const republished = preparedCache('Orgtree-Setup-2.0.4.exe', contents)
  const republishedHelper = new DownloadedUpdateHelper(republished.cacheDir)
  const changed = await republishedHelper.validateDownloadedPath(republished.file, { version: '2.0.4' },
    { info: { sha512: sha512('A DIFFERENT BUILD'), url: 'Orgtree-Setup-2.0.4.exe' } }, quiet)
  assert.equal(changed, null)
  assert.equal(republished.survives(), false,
    'the SAME version republished with different bytes deletes the prepared installer, so version equality never proved survival')

  const replaced = preparedCache('Orgtree-Setup-2.0.4.exe', contents)
  const replacedHelper = new DownloadedUpdateHelper(replaced.cacheDir)
  const newer = await replacedHelper.validateDownloadedPath(path.join(replaced.pending, 'Orgtree-Setup-2.0.5.exe'),
    { version: '2.0.5' }, { info: { sha512: sha512('2.0.5 BYTES'), url: 'Orgtree-Setup-2.0.5.exe' } }, quiet)
  assert.equal(newer, null)
  assert.equal(replaced.survives(), false, 'and so does a different version')
  assert.equal(replacedHelper.file, null,
    'after a restart the library also forgets the path, so install() refuses outright rather than spawning it')

  for (const cache of [kept, republished, replaced]) fs.rmSync(cache.cacheDir, { recursive: true, force: true })
})

test('within the session that downloaded it, the library deletes the prepared file and KEEPS POINTING AT IT', async () => {
  // The exact window main/index.ts closes by clearing `downloaded` the moment a
  // replacement is accepted: here install() would be handed a path that is gone.
  const contents = 'PREPARED INSTALLER BYTES'
  const cache = preparedCache('Orgtree-Setup-2.0.4.exe', contents)
  const helper = new DownloadedUpdateHelper(cache.cacheDir)
  const info = { info: { sha512: sha512(contents), url: 'Orgtree-Setup-2.0.4.exe' } }
  await helper.setDownloadedFile(cache.file, null, { version: '2.0.4' }, info, 'Orgtree-Setup-2.0.4.exe', true)

  assert.equal(await helper.validateDownloadedPath(cache.file, { version: '2.0.4' }, info, quiet), cache.file,
    'POSITIVE CONTROL: the same offer is still served from the cache')
  assert.equal(cache.survives(), true)

  const newer = await helper.validateDownloadedPath(path.join(cache.pending, 'Orgtree-Setup-2.0.5.exe'),
    { version: '2.0.5' }, { info: { sha512: sha512('2.0.5 BYTES'), url: 'Orgtree-Setup-2.0.5.exe' } }, quiet)
  assert.equal(newer, null)
  assert.equal(cache.survives(), false, 'the 2.0.4 installer is gone the moment a 2.0.5 download is begun')
  assert.equal(helper.file, cache.file,
    'but the library still reports the deleted path as its installerPath - BaseUpdater.install would spawn it')
  fs.rmSync(cache.cacheDir, { recursive: true, force: true })
})
