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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-unix-launch-'))
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

test('non-default ORGTREE_V2_DATA or ORGTREE_V2_PROFILE skips boot registration on Linux and macOS', () => {
  const linuxDefault = '/home/alex/.config/Orgtree v2/data'
  const macDefault = '/Users/alex/Library/Application Support/Orgtree v2/data'
  for (const [platform, defaultDataRoot] of [['linux', linuxDefault], ['darwin', macDefault]]) {
    const base = { ...installed, platform, defaultDataRoot }
    // Non-default ORGTREE_V2_DATA skips registration
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: '/tmp/second-orgtree-data' },
      dataRoot: '/tmp/second-orgtree-data',
    }), false, `${platform}: non-default ORGTREE_V2_DATA`)
    // Non-default ORGTREE_V2_PROFILE skips registration even if dataRoot stayed default
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_PROFILE: '/tmp/second-orgtree-profile' },
      dataRoot: defaultDataRoot,
    }), false, `${platform}: non-default ORGTREE_V2_PROFILE`)
    // Relative or whitespace-only ORGTREE_V2_DATA fails closed
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: 'relative/data' },
      dataRoot: 'relative/data',
    }), false, `${platform}: relative ORGTREE_V2_DATA`)
    assert.equal(boot.registersBootEngine({
      ...base,
      env: { ORGTREE_V2_DATA: '   ' },
      dataRoot: '   ',
    }), false, `${platform}: whitespace ORGTREE_V2_DATA`)
    // Missing defaultDataRoot with override fails closed
    assert.equal(boot.registersBootEngine({
      ...installed,
      platform,
      env: { ORGTREE_V2_DATA: '/tmp/second-orgtree-data' },
      dataRoot: '/tmp/second-orgtree-data',
    }), false, `${platform}: missing defaultDataRoot`)
  }
})

test('default root and env vars resolving to the exact default root keep registering on Linux and macOS', () => {
  const linuxProfile = '/home/alex/.config/Orgtree v2'
  const linuxDefault = `${linuxProfile}/data`
  const macProfile = '/Users/alex/Library/Application Support/Orgtree v2'
  const macDefault = `${macProfile}/data`
  for (const [platform, profile, defaultDataRoot] of [['linux', linuxProfile, linuxDefault], ['darwin', macProfile, macDefault]]) {
    const base = { ...installed, platform, defaultDataRoot }
    // No override: registers
    assert.equal(boot.registersBootEngine({ ...base, env: {}, dataRoot: defaultDataRoot }), true, `${platform}: unset env`)
    // Empty override with default dataRoot: registers
    assert.equal(boot.registersBootEngine({ ...base, env: { ORGTREE_V2_DATA: '', ORGTREE_V2_PROFILE: '' }, dataRoot: defaultDataRoot }), true, `${platform}: empty env`)
    // No env override with data-location.json custom folder: registers (single primary profile)
    assert.equal(boot.registersBootEngine({ ...base, env: {}, dataRoot: '/mnt/bigdrive/orgtree-data' }), true, `${platform}: data-location.json without env override`)
    // ORGTREE_V2_DATA equal to default root (exact, trailing slash, normalized segments): registers
    for (const same of [defaultDataRoot, `${defaultDataRoot}/`, `${profile}/./sub/../data/`]) {
      assert.equal(boot.registersBootEngine({
        ...base,
        env: { ORGTREE_V2_DATA: same },
        dataRoot: same,
      }), true, `${platform}: ORGTREE_V2_DATA=${same}`)
    }
    // ORGTREE_V2_PROFILE equal to default profile dir (exact and trailing slash): registers
    for (const sameProfile of [profile, `${profile}/`]) {
      assert.equal(boot.registersBootEngine({
        ...base,
        env: { ORGTREE_V2_PROFILE: sameProfile },
        dataRoot: defaultDataRoot,
      }), true, `${platform}: ORGTREE_V2_PROFILE=${sameProfile}`)
    }
    // Prerelease and dev guards remain false even when env equals default root
    assert.equal(boot.registersBootEngine({ ...base, version: '4.6.9-alpha.1', env: { ORGTREE_V2_DATA: defaultDataRoot }, dataRoot: defaultDataRoot }), false, `${platform}: prerelease`)
    assert.equal(boot.registersBootEngine({ ...base, appId: 'com.maurdekye.orgtree.dev', env: { ORGTREE_V2_DATA: defaultDataRoot }, dataRoot: defaultDataRoot }), false, `${platform}: dev appId`)
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
