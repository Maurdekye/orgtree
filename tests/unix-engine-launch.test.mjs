// How the desktop starts or registers the engine on macOS and Linux (docket
// 4-6-4-linux-appimage-boot-unit-takeover-fallback), found with an arm64 AppImage test
// build on a Steam Frame (SteamOS, no FUSE, started with --appimage-extract-and-run):
//
//  - a test build, version 4.6.3-frame.1, rewrote the installed 4.6.3's
//    orgtree-engine.service: only a build without a prerelease label may register,
//    enable, disable or remove the background engine;
//  - the engine the desktop starts itself got the desktop's PATH (/usr/local/bin:/usr/bin
//    under Steam), not the PATH the background engine's unit gets, so it found no CLI in
//    ~/.local/bin.
//
// Pure decisions only: nothing here touches a unit, a service manager or a real engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-unix-launch-')))
const load = async name => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out)
}
const boot = await load('unixboot')
const engine = await load('engine')
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

const RELEASE = 'com.maurdekye.orgtree'
const installed = { packaged: true, platform: 'linux', appId: RELEASE, releaseAppId: RELEASE, version: '4.6.4', hasEngine: true }

test('the installed release registers the background engine on macOS and Linux', () => {
  assert.equal(boot.registersBootEngine(installed), true)
  assert.equal(boot.registersBootEngine({ ...installed, platform: 'darwin' }), true)
})

test('a build with a prerelease label never registers: it leaves the installed version\'s unit alone', () => {
  for (const version of ['4.6.3-frame.1', '4.6.4-alpha.1', '4.6.4-beta.2', '4.6.4-rc.1', '4.6.4-RC3'])
    assert.equal(boot.registersBootEngine({ ...installed, version }), false, version)
  // a build suffix after "+" is not a prerelease label
  assert.equal(boot.registersBootEngine({ ...installed, version: '4.6.4+build.7' }), true)
})

test('as before: no registration on Windows, in development, under another identity, or without an engine', () => {
  assert.equal(boot.registersBootEngine({ ...installed, platform: 'win32' }), false)
  assert.equal(boot.registersBootEngine({ ...installed, packaged: false }), false)
  assert.equal(boot.registersBootEngine({ ...installed, appId: 'com.maurdekye.orgtree.dev' }), false)
  assert.equal(boot.registersBootEngine({ ...installed, hasEngine: false }), false)
})

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

function makeProfileDirs(label) {
  const root = fs.mkdtempSync(path.join(dir, `${label}-`))
  const profile = path.join(root, 'Orgtree v2')
  const factory = path.join(profile, 'data')
  const moved = path.join(root, 'moved-primary')
  const other = path.join(root, 'other-org')
  fs.mkdirSync(factory, { recursive: true })
  fs.mkdirSync(moved, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  return { root, profile, factory, moved, other }
}

test('non-default ORGTREE_V2_DATA or ORGTREE_V2_PROFILE skips boot registration on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const d = makeProfileDirs(`nondef-${platform}`)
    const base = { ...installed, platform, defaultUserData: d.profile, defaultDataRoot: d.factory }
    // Non-default ORGTREE_V2_DATA skips registration
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: d.other },
      dataRoot: d.other,
    }), false, `${platform}: non-default ORGTREE_V2_DATA`)
    // Non-default ORGTREE_V2_PROFILE skips registration even if dataRoot stayed default
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_PROFILE: d.other },
      dataRoot: d.factory,
    }), false, `${platform}: non-default ORGTREE_V2_PROFILE`)
    // Relative ORGTREE_V2_DATA fails closed
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: 'relative/data' },
      dataRoot: 'relative/data',
    }), false, `${platform}: relative ORGTREE_V2_DATA`)
    // Missing defaultUserData & defaultDataRoot with override fails closed
    assert.equal(boot.registersBootEngine({
      ...installed,
      platform,
      env: { ORGTREE_V2_DATA: d.other },
      dataRoot: d.other,
    }), false, `${platform}: missing default roots`)
  }
})

test('default root and env vars resolving to the exact default root keep registering on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const d = makeProfileDirs(`def-${platform}`)
    const sub = path.join(d.profile, 'sub')
    fs.mkdirSync(sub, { recursive: true })
    const base = { ...installed, platform, defaultUserData: d.profile }
    // No override: registers
    assert.equal(boot.registersBootEngine({ ...base, env: {}, dataRoot: d.factory }), true, `${platform}: unset env`)
    // Empty and whitespace overrides are treated as unset consistently (even with empty/whitespace dataRoot)
    for (const blank of ['', '   ', '\t ']) {
      const ownedBlank = boot.resolveUnixStartupOwnership({
        defaultUserData: d.profile,
        env: { ORGTREE_V2_DATA: blank },
      })
      assert.equal(ownedBlank.nonDefault, false, `${platform}: ownership blank data ${JSON.stringify(blank)}`)
      assert.equal('dataRootOverride' in ownedBlank, true, `${platform}: ownership exposes normalised dataRootOverride`)
      assert.equal(ownedBlank.dataRootOverride, undefined, `${platform}: blank dataRootOverride is undefined`)
      assert.equal(boot.registersBootEngine({
        ...base,
        env: { ORGTREE_V2_DATA: blank, ORGTREE_V2_PROFILE: blank },
        dataRoot: blank,
      }), true, `${platform}: blank override ${JSON.stringify(blank)} treated as unset`)
      assert.equal(boot.isNonDefaultDataRoot({
        defaultUserData: d.profile,
        env: { ORGTREE_V2_DATA: blank },
      }), false, `${platform}: early check blank data ${JSON.stringify(blank)}`)
      assert.equal(boot.isNonDefaultDataRoot({
        defaultUserData: d.profile,
        env: { ORGTREE_V2_PROFILE: blank },
      }), false, `${platform}: early check blank profile ${JSON.stringify(blank)}`)
    }
    // ORGTREE_V2_DATA equal to default root (exact, trailing slash, existing sub/..): registers
    const viaSub = `${d.profile}${path.sep}.${path.sep}sub${path.sep}..${path.sep}data${path.sep}`
    assert.ok(viaSub.includes('..'))
    for (const same of [d.factory, d.factory + path.sep, viaSub]) {
      assert.equal(boot.registersBootEngine({
        ...base,
        env: { ORGTREE_V2_DATA: same },
        dataRoot: same,
      }), true, `${platform}: ORGTREE_V2_DATA=${same}`)
    }
    // ORGTREE_V2_PROFILE equal to default profile dir (exact and trailing slash): registers
    for (const sameProfile of [d.profile, d.profile + path.sep]) {
      assert.equal(boot.registersBootEngine({
        ...base,
        env: { ORGTREE_V2_PROFILE: sameProfile },
        dataRoot: d.factory,
      }), true, `${platform}: ORGTREE_V2_PROFILE=${sameProfile}`)
    }
    // Prerelease and dev guards remain false even when env equals default root
    assert.equal(boot.registersBootEngine({ ...base, version: '4.6.9-alpha.1', env: { ORGTREE_V2_DATA: d.factory }, dataRoot: d.factory }), false, `${platform}: prerelease`)
    assert.equal(boot.registersBootEngine({ ...base, appId: 'com.maurdekye.orgtree.dev', env: { ORGTREE_V2_DATA: d.factory }, dataRoot: d.factory }), false, `${platform}: dev appId`)
  }
})

test('saved Data location move: effective default root owns startup; old pre-move folder is non-default on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const d = makeProfileDirs(`moved-${platform}`)
    fs.writeFileSync(
      path.join(d.profile, 'data-location.json'),
      JSON.stringify({ version: 1, dataRoot: d.moved, previousRoot: d.factory }, null, 2),
      'utf8',
    )
    const base = { ...installed, platform, defaultUserData: d.profile }
    // Plain launch (no env override): registers moved folder
    assert.equal(boot.registersBootEngine({ ...base, env: {}, dataRoot: d.moved }), true, `${platform}: plain launch after move`)
    // Explicitly opening the moved-to current folder: registers as normal
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: d.moved },
      dataRoot: d.moved,
    }), true, `${platform}: explicit current moved folder registers`)
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: d.moved + path.sep },
      dataRoot: d.moved + path.sep,
    }), true, `${platform}: explicit current moved folder with trailing separator registers`)
    // Explicitly opening the old pre-move factory folder: NON-DEFAULT, skips
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: d.factory },
      dataRoot: d.factory,
    }), false, `${platform}: explicit old pre-move folder must skip`)
    // Explicitly opening the ordinary default profile after move: registers as normal
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_PROFILE: d.profile },
      dataRoot: d.moved,
    }), true, `${platform}: explicit default profile after move registers`)
    // Alternate profile with moved data root: skips
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_PROFILE: d.other, ORGTREE_V2_DATA: d.moved },
      dataRoot: d.moved,
    }), false, `${platform}: alternate profile with moved root skips`)
    // When data folder itself is a symlink to another folder, default profile resolves independently
    const linked = makeProfileDirs(`linked-data-${platform}`)
    fs.rmSync(linked.factory, { recursive: true, force: true })
    fs.symlinkSync(linked.moved, linked.factory, linkType)
    assert.equal(boot.registersBootEngine({
      ...installed,
      platform,
      defaultUserData: linked.profile,
      env: { ORGTREE_V2_PROFILE: linked.profile },
      dataRoot: linked.factory,
    }), true, `${platform}: symlinked data dir does not reject its real profile`)
  }
})

test('path canonicalisation: symlinked intermediate, missing intermediate, missing dir and canonicalisation errors fail closed; verified alias returns canonical hostDataRoot', () => {
  for (const platform of ['linux', 'darwin']) {
    const d = makeProfileDirs(`canon-${platform}`)
    const base = { ...installed, platform, defaultUserData: d.profile }

    // 1. Symlinked intermediate + `..` pointing to ANOTHER directory must NOT collapse lexically to default
    const otherSub = path.join(d.other, 'sub')
    const otherData = path.join(d.other, 'data')
    fs.mkdirSync(otherSub, { recursive: true })
    fs.mkdirSync(otherData, { recursive: true })
    const sneakyLink = path.join(d.profile, 'sneaky')
    fs.symlinkSync(otherSub, sneakyLink, linkType)
    const sneakyPath = `${sneakyLink}${path.sep}..${path.sep}data`
    assert.ok(sneakyPath.includes('..'), 'test fixture must pass literal .. segments')
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: sneakyPath },
      dataRoot: sneakyPath,
    }), false, `${platform}: symlinked intermediate + .. pointing elsewhere must fail closed`)

    // 2. Missing intermediate + `..` must fail closed (never lexically discard missing/..)
    const missingIntermediate = `${d.profile}${path.sep}does-not-exist${path.sep}..${path.sep}data`
    assert.ok(missingIntermediate.includes('..'), 'test fixture must pass literal .. segments')
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: missingIntermediate },
      dataRoot: missingIntermediate,
    }), false, `${platform}: missing intermediate + .. must fail closed`)

    // 3. Missing directory must fail closed
    const missingDir = path.join(d.root, 'never-created')
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: missingDir },
      dataRoot: missingDir,
    }), false, `${platform}: missing directory must fail closed`)

    // 4. Canonicalisation error (realpath throws) must fail closed even if spelling equals default
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: d.factory },
      dataRoot: d.factory,
      fs: {
        realpathSync: { native: () => { throw new Error('EACCES') } },
        readFileSync: fs.readFileSync,
        lstatSync: fs.lstatSync,
      },
    }), false, `${platform}: realpath error must fail closed`)

    // 5. Symlinked alias pointing TO the effective default root resolves and returns canonical physical hostDataRoot
    const aliasProfile = path.join(d.root, 'alias-profile')
    fs.symlinkSync(d.profile, aliasProfile, linkType)
    const aliasData = path.join(aliasProfile, 'data')
    assert.equal(typeof boot.resolveUnixStartupOwnership, 'function', 'shared ownership resolver must be exported')
    const owned = boot.resolveUnixStartupOwnership({
      defaultUserData: d.profile,
      env: { ORGTREE_V2_DATA: aliasData },
    })
    assert.equal(owned.nonDefault, false, `${platform}: alias to effective default root is accepted`)
    assert.equal(owned.hostDataRoot, fs.realpathSync.native(d.factory), `${platform}: hostDataRoot uses verified canonical spelling, not symlink alias`)
  }
})

test('the engine the desktop starts itself searches the same folders as the background engine', () => {
  const shellPath = '/home/alex/.nvm/versions/node/v22/bin:/usr/bin'
  const own = boot.managedEnginePath({ packaged: true, platform: 'linux', home: '/home/alex', shellPath })
  assert.equal(own, '/home/alex/.nvm/versions/node/v22/bin:/usr/bin:/home/alex/.local/bin:/usr/local/bin:/bin:/usr/sbin:/sbin')
  const unit = boot.bootCommand({ platform: 'linux', home: '/home/alex', appId: RELEASE, engine: '/opt/Orgtree/resources/engine/orgtree-engine',
    dataRoot: '/home/alex/.config/Orgtree v2/data', shellPath })
  assert.equal(own, unit.env.PATH, 'one PATH for both ways the engine starts')
  // Steam's PATH has no ~/.local/bin; the result does, whatever the login shell says
  assert.match(boot.managedEnginePath({ packaged: true, platform: 'linux', home: '/home/deck', shellPath: '' }), /^\/home\/deck\/\.local\/bin:/)
  assert.match(boot.managedEnginePath({ packaged: true, platform: 'darwin', home: '/Users/alex', shellPath: '' }), /\/opt\/homebrew\/bin/)
})

test('Windows and a development run keep the PATH they were started with', () => {
  assert.equal(boot.managedEnginePath({ packaged: true, platform: 'win32', home: 'C:\\Users\\alex', shellPath: '' }), undefined)
  assert.equal(boot.managedEnginePath({ packaged: false, platform: 'linux', home: '/home/alex', shellPath: '/usr/bin' }), undefined)
})

test('the managed engine\'s environment: the given search path replaces PATH, everything else is kept', () => {
  const base = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/deck', LANG: 'C.UTF-8' }
  const env = engine.withSearchPath(base, '/home/deck/.local/bin:/usr/local/bin:/usr/bin')
  assert.deepEqual(env, { PATH: '/home/deck/.local/bin:/usr/local/bin:/usr/bin', HOME: '/home/deck', LANG: 'C.UTF-8' })
  assert.deepEqual(base, { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/deck', LANG: 'C.UTF-8' }, 'the desktop\'s own environment is not changed')
  // none given (Windows, development): the same variables, PATH as it was, whatever its spelling
  assert.deepEqual(engine.withSearchPath({ Path: 'C:\\Windows', TEMP: 'C:\\t' }, undefined), { Path: 'C:\\Windows', TEMP: 'C:\\t' })
  assert.deepEqual(engine.withSearchPath(base, ''), base)
})

test('the managed engine\'s Unix environment drops blank/whitespace ORGTREE_V2_DATA and normalises active overrides; Windows is untouched', () => {
  assert.equal(typeof engine.withUnixDataRootEnv, 'function', 'engine exports withUnixDataRootEnv')
  for (const platform of ['linux', 'darwin']) {
    for (const blank of ['', '   ', '\t ']) {
      const env = engine.withUnixDataRootEnv({ HOME: '/home/deck', ORGTREE_V2_DATA: blank }, platform, '/vol/primary')
      assert.equal('ORGTREE_V2_DATA' in env, false, `${platform} ${JSON.stringify(blank)}: blank ORGTREE_V2_DATA stripped`)
      assert.equal(env.HOME, '/home/deck')
    }
    const unset = engine.withUnixDataRootEnv({ HOME: '/home/deck' }, platform, '/vol/primary')
    assert.equal('ORGTREE_V2_DATA' in unset, false, `${platform}: unset stays unset`)
    const active = engine.withUnixDataRootEnv({ HOME: '/home/deck', ORGTREE_V2_DATA: '/alias' }, platform, '/vol/primary')
    assert.equal(active.ORGTREE_V2_DATA, '/vol/primary', `${platform}: active override receives canonical root`)
  }
  const win = engine.withUnixDataRootEnv({ ORGTREE_V2_DATA: '   ', Path: 'C:\\Windows' }, 'win32', 'C:\\Orgtree\\data')
  assert.equal(win.ORGTREE_V2_DATA, '   ', 'win32: environment left completely untouched')
})
