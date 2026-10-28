import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as lib from '../lib.mjs'

// A rig run's engine and everything it launches must see the run's own fake
// profile, never the profile of whoever started the rig (measured in Session 0
// runs, 2026-10-27: the engine children inherited the real USERPROFILE, so a
// proof that wrote to "home" would have written the user's real files).
// No engine, database or compiler: the real keeper starts a stand-in "engine"
// (a copy of node running serve.js) that records the environment it was given.
const windows = { skip: process.platform !== 'win32' }
const RIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_VARS = ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
// Where provider discovery looks for configuration and skills besides the home
// (engine providers/skills.rs and providers/mcp.rs): these move with the profile
// too (4.5.0 high E16, review alpha8 b7e8e4998677 F1).
const CONFIG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_CONFIG_DIR']
const XDG_VARS = CONFIG_VARS.filter(k => k.startsWith('XDG_'))
// A credential cleanEnv's denylist does not know (4.5.0 high E15, review alpha8
// ba1d8c7a1b50 F1): the stand-in must never write it to disk.
const SENTINEL = 'rig-synthetic-home-sentinel-not-a-real-secret'

const under = (p, root) => {
  const rel = path.relative(root, path.resolve(p))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
const drivePath = p => ({ HOMEDRIVE: p.slice(0, 2), HOMEPATH: p.slice(2) })

function scratch(ctx, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rig-synthetic-home-${label}-`))
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return dir
}

/** Runs the real keeper from a sentinel host profile with run.json fields
 * `run`; returns what its stand-in engine recorded. */
function keeperRecord(ctx, label, run = {}) {
  // The "real" profile is a sentinel outside the run, so the verdict does not depend on this machine.
  const host = scratch(ctx, `${label}-host`)
  const hostProfile = path.join(host, 'real-profile')
  const dir = scratch(ctx, `${label}-run`)
  const data = path.join(dir, 'data')
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  lib.writeRun(dir, { id: 'synthetic-home', dir, data, token: 'synthetic-token', pgBin: path.join(dir, 'no-pg'), status: 'starting', stopKillMs: 100, ...run })
  const standIn = path.join(dir, 'bin', 'orgtree-engine.exe')
  try { fs.linkSync(process.execPath, standIn) } catch { fs.copyFileSync(process.execPath, standIn) }
  // The stand-in records the profile variables (paths of this synthetic run)
  // and the NAMES of any variable that mentions the host profile; it never
  // writes the environment itself, which can hold credentials cleanEnv's
  // denylist does not know (E15). The host path reaches it hex-encoded, so
  // that variable is not itself a mention.
  fs.writeFileSync(path.join(dir, 'serve.js'), [
    "const host = Buffer.from(process.env.RIG_TEST_HOST_PROFILE_HEX || '', 'hex').toString('utf8').toLowerCase()",
    `const keep = ${JSON.stringify([...PROFILE_VARS, 'HOMEDRIVE', 'HOMEPATH', ...CONFIG_VARS])}`,
    "const profile = Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))",
    "const leaks = host ? Object.keys(process.env).filter(k => String(process.env[k]).toLowerCase().includes(host)) : null",
    "require('fs').writeFileSync('child-env.json', JSON.stringify({ profile, leaks, cwd: process.cwd() }))",
  ].join('\n') + '\n')

  const hostEnv = { ...process.env, USERPROFILE: hostProfile, HOME: hostProfile, ...drivePath(hostProfile),
    APPDATA: path.join(hostProfile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(hostProfile, 'AppData', 'Local'),
    TEMP: path.join(hostProfile, 'Temp'), TMP: path.join(hostProfile, 'Temp'),
    XDG_CONFIG_HOME: path.join(hostProfile, '.config'), XDG_DATA_HOME: path.join(hostProfile, '.local', 'share'),
    XDG_CACHE_HOME: path.join(hostProfile, '.cache'), XDG_STATE_HOME: path.join(hostProfile, '.local', 'state'),
    OPENCODE_CONFIG_DIR: path.join(hostProfile, '.config', 'opencode'),
    RIG_SENTINEL_SECRET_ACCESS_KEY: SENTINEL, RIG_TEST_HOST_PROFILE_HEX: Buffer.from(hostProfile, 'utf8').toString('hex'),
    // the leak check's positive control: a variable no rig code moves, naming the host profile
    RIG_TEST_HOST_MENTION: path.join(hostProfile, 'planted') }
  delete hostEnv.RIG_PROTECTED_ROOTS
  const r = childProcess.spawnSync(process.execPath, [path.join(RIG, 'keeper.mjs'), dir],
    { env: hostEnv, cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true })
  assert.equal(r.status, 0, `keeper exited ${r.status}: ${r.stderr}\n${fs.existsSync(path.join(dir, 'keeper.log')) ? '' : r.stdout}`)
  const record = fs.readFileSync(path.join(dir, 'child-env.json'), 'utf8')
  return { record, ...JSON.parse(record), dir, hostProfile, hostEnv }
}

test('the keeper hands its engine the run\'s fake profile, not the host\'s', windows, ctx => {
  const { record, dir, hostProfile } = keeperRecord(ctx, 'fake')
  assert.ok(!record.includes(SENTINEL), 'the stand-in wrote the engine\'s environment to disk, a credential included')
  const { profile: seen, leaks } = JSON.parse(record)
  for (const k of [...PROFILE_VARS, ...CONFIG_VARS]) {
    assert.ok(seen[k], `${k} reaches the engine`)
    assert.ok(under(seen[k], dir), `${k} stays inside the run (${seen[k]})`)
    assert.ok(!under(seen[k], hostProfile) && path.resolve(seen[k]) !== hostProfile, `${k} is not the host's (${seen[k]})`)
  }
  assert.equal(path.resolve((seen.HOMEDRIVE ?? '') + (seen.HOMEPATH ?? '')).toLowerCase(), path.resolve(seen.USERPROFILE).toLowerCase(),
    'HOMEDRIVE + HOMEPATH name the same fake home')
  assert.ok(Array.isArray(leaks), 'the stand-in checked every variable for the host profile')
  assert.deepEqual(leaks.map(k => k.toUpperCase()), ['RIG_TEST_HOST_MENTION'],
    'no variable the engine sees mentions the host profile, except the planted control (so the check sees every variable)')
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'TEMP']) assert.ok(fs.statSync(seen[k]).isDirectory(), `${k} folder exists`)
})

// `up --real-muse` is an explicitly authorized real lane: the installed Muse
// Code finds its signed-in config and its session logs through the host's XDG
// roots, so the keeper keeps those, and only those (review b55d99ef7895 F1).
test('with --real-muse the keeper keeps the host\'s XDG roots and nothing else of its profile', windows, ctx => {
  const { record, profile: seen, leaks, dir, hostEnv } = keeperRecord(ctx, 'muse', { realMuse: 'Z:\\not-run\\muse-bin-9.9.9.exe' })
  assert.ok(!record.includes(SENTINEL), 'the stand-in wrote the engine\'s environment to disk, a credential included')
  for (const k of XDG_VARS) assert.equal(seen[k], hostEnv[k], `${k} is the host's signed-in root`)
  for (const k of [...PROFILE_VARS, 'OPENCODE_CONFIG_DIR']) assert.ok(under(seen[k], dir), `${k} stays inside the run (${seen[k]})`)
  assert.deepEqual(leaks.map(k => k.toUpperCase()).sort(), [...XDG_VARS, 'RIG_TEST_HOST_MENTION'].sort(),
    'only the XDG roots (and the planted control) name the host profile')
})

test('rigProfileEnv keeps the host\'s XDG roots only when given them (the --real-muse lane)', windows, () => {
  const data = 'Z:\\runs\\r1\\data'
  const host = { XDG_CONFIG_HOME: 'Y:\\host\\config', XDG_DATA_HOME: 'Y:\\host\\data', OPENCODE_CONFIG_DIR: 'Y:\\host\\opencode', USERPROFILE: 'Y:\\host' }
  const fake = lib.rigProfileEnv(data, { create: false })
  const muse = lib.rigProfileEnv(data, { create: false, hostXdg: host })
  assert.deepEqual([muse.XDG_CONFIG_HOME, muse.XDG_DATA_HOME], [host.XDG_CONFIG_HOME, host.XDG_DATA_HOME], 'the roots the host sets are kept')
  // a root the host does not set, OpenCode's folder and the profile itself stay the fake profile's
  for (const k of ['XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_CONFIG_DIR', ...PROFILE_VARS]) assert.equal(muse[k], fake[k], k)
})

test('rigProfileEnv moves every profile variable together under the run', windows, ctx => {
  assert.equal(typeof lib.rigProfileEnv, 'function', 'lib.mjs exports rigProfileEnv')
  const data = 'Z:\\runs\\r1\\data'
  const env = lib.rigProfileEnv(data, { tmp: 'Z:\\runs\\r1\\tmp', create: false })
  assert.equal(env.USERPROFILE, path.join(data, 'rig-home'))
  assert.equal(env.HOME, env.USERPROFILE)
  assert.deepEqual({ HOMEDRIVE: env.HOMEDRIVE, HOMEPATH: env.HOMEPATH }, { HOMEDRIVE: 'Z:', HOMEPATH: '\\runs\\r1\\data\\rig-home' })
  assert.equal(env.APPDATA, path.join(env.USERPROFILE, 'AppData', 'Roaming'))
  assert.equal(env.LOCALAPPDATA, path.join(env.USERPROFILE, 'AppData', 'Local'))
  assert.deepEqual([env.TEMP, env.TMP], ['Z:\\runs\\r1\\tmp', 'Z:\\runs\\r1\\tmp'])
  // without a tmp it lands in the fake profile's own Local\Temp
  assert.equal(lib.rigProfileEnv(data, { create: false }).TEMP, path.join(env.LOCALAPPDATA, 'Temp'))
  // provider configuration and skills: the defaults the engine would derive from the fake home
  assert.deepEqual(Object.fromEntries(CONFIG_VARS.map(k => [k, env[k]])), {
    XDG_CONFIG_HOME: path.join(env.USERPROFILE, '.config'), XDG_DATA_HOME: path.join(env.USERPROFILE, '.local', 'share'),
    XDG_CACHE_HOME: path.join(env.USERPROFILE, '.cache'), XDG_STATE_HOME: path.join(env.USERPROFILE, '.local', 'state'),
    OPENCODE_CONFIG_DIR: path.join(env.USERPROFILE, '.config', 'opencode'),
  })
  // and it makes the folders when asked (the default)
  const real = path.join(scratch(ctx, 'make'), 'data')
  const made = lib.rigProfileEnv(real)
  for (const k of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP']) assert.ok(fs.statSync(made[k]).isDirectory(), `${k} created`)
})

test('every rig script that builds an engine environment applies the fake profile', windows, () => {
  // New launch sites must not rebuild an engine environment on cleanEnv() alone.
  const files = []
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'tests') walk(p) } else if (/\.(mjs|cjs)$/.test(e.name)) files.push(p)
  } }
  walk(RIG)
  const builders = files.filter(f => /ORGTREE_ENGINE_RIG\s*:\s*'1'/.test(fs.readFileSync(f, 'utf8')))
  assert.ok(builders.length >= 5, `found the engine launch sites (${builders.map(f => path.basename(f))})`)
  const missing = builders.filter(f => {
    const text = fs.readFileSync(f, 'utf8')
    return (text.match(/\.\.\.cleanEnv\(/g) ?? []).length > (text.match(/\.\.\.rigProfileEnv\(/g) ?? []).length
  }).map(f => path.relative(RIG, f))
  assert.deepEqual(missing, [], 'these build an engine environment from cleanEnv() without rigProfileEnv()')
})
