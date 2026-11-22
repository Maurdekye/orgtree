// Main-process non-Windows wording & Windows-only tray hides (O-02, O-05, O-13, O-14, O-16, B-03).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { build, transformSync } from 'esbuild'
import { createRequire } from 'node:module'

const indexSrc = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const slice = (from, to) => {
  const start = indexSrc.indexOf(from), end = indexSrc.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `source must contain ${from.trim()}`)
  return indexSrc.slice(start, end)
}
const trayCode = transformSync(slice('  const rebuildTray = () => {', '\n  /**'), { loader: 'ts', target: 'node22' }).code

function buildTray({ platform, isPackaged = true, updatesSupported = false, identityUpdatesSupported = true, updateFeedKind = 'ok' }) {
  let items = []
  const ctx = {
    preferences: { get: () => ({ startAtLogin: true, exitOnClose: false, automaticUpdates: true, notificationsEnabled: true }), set: p => p },
    setPreferences() {},
    trayMenu: undefined, trayMenuOpen: false,
    adminState: { available: platform === 'win32', enabled: false }, adminChanging: false,
    startupKind: () => (platform === 'win32' ? 'boot' : 'signin'), startupChanging: false,
    tray: { setImage() {}, setToolTip() {}, setContextMenu(menu) { items = menu.items } },
    runtimeIcon: () => ({ isEmpty: () => true }), attentionTotal: 0, startupFailure: undefined,
    BrowserWindow: { getAllWindows: () => [] }, applyWindowIcon() {},
    refreshTrayUpdates() {}, refreshTrayEngine() {}, refreshTrayHub() {}, refreshTrayEpic() {},
    epicMuteTrayItem: () => ({ id: 'epic-mute', label: 'Mute' }),
    label: () => 'Ready', updatesSupported, downloaded: false, updateApplying: false, quitting: false,
    canInstallUnattended: () => true,
    identity: { updatesSupported: identityUpdatesSupported },
    updateFeed: { kind: updateFeedKind },
    hubMenuItem: () => ({ id: 'mailhub-status', label: 'Mail hub' }),
    NOTIFICATION_OPTIONS: [], harnessCache: { current: () => [] }, harnessSetupMenu: () => [], trayHarnesses: null,
    Menu: { buildFromTemplate(tpl) { return { items: tpl, on() {}, getMenuItemById(id) { return tpl.find(x => x.id === id) } } } },
    app: { isPackaged, quit() {} },
    process: { platform },
  }
  vm.runInNewContext(trayCode + '\nrebuildTray()', ctx)
  return items
}

test('O-05: tray omits admin checkbox off Windows and keeps it on Windows', () => {
  const lin = buildTray({ platform: 'linux' })
  const mac = buildTray({ platform: 'darwin' })
  const win = buildTray({ platform: 'win32' })
  assert.equal(lin.find(i => i.id === 'run-as-admin'), undefined, 'linux omits run-as-admin')
  assert.equal(mac.find(i => i.id === 'run-as-admin'), undefined, 'darwin omits run-as-admin')
  assert.ok(win.find(i => i.id === 'run-as-admin'), 'win32 keeps run-as-admin')
})

test('O-02: packaged non-Windows build without update feed says updates are not available for this build', () => {
  const macPackaged = buildTray({ platform: 'darwin', isPackaged: true, updatesSupported: false })
  assert.equal(macPackaged[0].label, 'Automatic updates are not available for this build')
  const linuxDeb = buildTray({ platform: 'linux', isPackaged: true, updatesSupported: false })
  assert.equal(linuxDeb[0].label, 'Automatic updates are not available for this build')
  const devWin = buildTray({ platform: 'win32', isPackaged: false, updatesSupported: false })
  assert.equal(devWin[0].label, 'Updates are disabled in this development build')
  const devChannel = buildTray({ platform: 'linux', isPackaged: true, updatesSupported: false, identityUpdatesSupported: false })
  assert.equal(devChannel[0].label, 'Updates are disabled in this development build')
})

test('O-13, O-14, O-16, B-03: main-process wording helpers preserve Windows exact text and genericize non-Windows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-ww-main-'))
  try {
    await build({
      entryPoints: ['apps/desktop/main/datalocation.ts', 'apps/desktop/main/providerlogin.ts'],
      outdir: dir, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error',
    })
    const req = createRequire(import.meta.url)
    const dl = req(path.join(dir, 'datalocation.js'))
    const pl = req(path.join(dir, 'providerlogin.js'))

    assert.equal(typeof dl.linkKindPhrase, 'function')
    assert.equal(dl.linkKindPhrase('win32'), 'symbolic link or junction')
    assert.equal(dl.linkKindPhrase('linux'), 'symbolic link')
    assert.equal(dl.linkKindPhrase('darwin'), 'symbolic link')

    assert.equal(dl.localFolderPathHint('win32'), 'Choose an absolute local drive-letter folder path (network UNC and device paths are not supported).')
    assert.equal(dl.localFolderPathHint('linux'), 'Choose an absolute local folder path.')

    assert.equal(dl.invalidPreviousDataPathError('win32'), 'Previous data folder path is not a valid local drive path.')
    assert.equal(dl.invalidPreviousDataPathError('linux'), 'Previous data folder path is not a valid local folder path.')

    assert.equal(dl.customDataFolderError('/tmp/x', 'win32'), 'custom data folder must be a local drive-letter path: /tmp/x')
    assert.equal(dl.customDataFolderError('/tmp/x', 'linux'), 'custom data folder must be an absolute local folder path: /tmp/x')

    assert.equal(typeof pl.profileNotWritableError, 'function')
    assert.equal(pl.profileNotWritableError('win32'), 'The selected account profile is not writable. Its folder permissions must allow your Windows user before signing in.')
    assert.equal(pl.profileNotWritableError('linux'), 'The selected account profile is not writable. Its folder permissions must allow your user account before signing in.')

    assert.equal(typeof pl.terminalUnsupportedError, 'function')
    assert.equal(pl.terminalUnsupportedError(), 'Opening a sign-in terminal is only supported on Windows. Sign in from your own terminal, then click Refresh.')
    const museManaged = pl.terminalUnsupportedError({
      provider: 'muse',
      profileDir: '/home/user/.orgtree/accounts/muse-1',
      exe: '/usr/local/bin/muse',
      platform: 'linux',
    })
    assert.match(museManaged, /env -u META_API_KEY MUSE_NO_AUTO_UPDATE=1/)
    assert.match(museManaged, /XDG_CONFIG_HOME='\/home\/user\/\.orgtree\/accounts\/muse-1\/config'/)
    assert.match(museManaged, /XDG_DATA_HOME='\/home\/user\/\.orgtree\/accounts\/muse-1\/data'/)
    assert.match(museManaged, /'\/usr\/local\/bin\/muse' login/)
    assert.match(museManaged, /Refresh/)
    const museUnsafe = pl.terminalUnsupportedError({
      provider: 'muse',
      profileDir: '/tmp/bad\npath',
      exe: '/usr/local/bin/muse',
      platform: 'linux',
    })
    assert.match(museUnsafe, /managed Muse profile.*not supported/i)
    assert.doesNotMatch(museUnsafe, /Sign in from your own terminal/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
