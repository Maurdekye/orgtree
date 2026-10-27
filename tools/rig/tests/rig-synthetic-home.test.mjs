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

test('the keeper hands its engine the run\'s fake profile, not the host\'s', windows, ctx => {
  // The "real" profile is a sentinel outside the run, so the verdict does not depend on this machine.
  const host = scratch(ctx, 'host')
  const hostProfile = path.join(host, 'real-profile')
  const dir = scratch(ctx, 'run')
  const data = path.join(dir, 'data')
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  lib.writeRun(dir, { id: 'synthetic-home', dir, data, token: 'synthetic-token', pgBin: path.join(dir, 'no-pg'), status: 'starting', stopKillMs: 100 })
  const standIn = path.join(dir, 'bin', 'orgtree-engine.exe')
  try { fs.linkSync(process.execPath, standIn) } catch { fs.copyFileSync(process.execPath, standIn) }
  fs.writeFileSync(path.join(dir, 'serve.js'),
    "require('fs').writeFileSync('child-env.json', JSON.stringify({ env: process.env, cwd: process.cwd() }))\n")

  const hostEnv = { ...process.env, USERPROFILE: hostProfile, HOME: hostProfile, ...drivePath(hostProfile),
    APPDATA: path.join(hostProfile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(hostProfile, 'AppData', 'Local'),
    TEMP: path.join(hostProfile, 'Temp'), TMP: path.join(hostProfile, 'Temp') }
  delete hostEnv.RIG_PROTECTED_ROOTS
  const r = childProcess.spawnSync(process.execPath, [path.join(RIG, 'keeper.mjs'), dir],
    { env: hostEnv, cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true })
  assert.equal(r.status, 0, `keeper exited ${r.status}: ${r.stderr}\n${fs.existsSync(path.join(dir, 'keeper.log')) ? '' : r.stdout}`)

  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'child-env.json'), 'utf8')).env
  for (const k of PROFILE_VARS) {
    assert.ok(seen[k], `${k} reaches the engine`)
    assert.ok(under(seen[k], dir), `${k} stays inside the run (${seen[k]})`)
    assert.ok(!under(seen[k], hostProfile) && path.resolve(seen[k]) !== hostProfile, `${k} is not the host's (${seen[k]})`)
  }
  assert.equal(path.resolve((seen.HOMEDRIVE ?? '') + (seen.HOMEPATH ?? '')).toLowerCase(), path.resolve(seen.USERPROFILE).toLowerCase(),
    'HOMEDRIVE + HOMEPATH name the same fake home')
  const leaks = Object.entries(seen).filter(([, v]) => String(v).toLowerCase().includes(hostProfile.toLowerCase())).map(([k]) => k)
  assert.deepEqual(leaks, [], 'no variable the engine sees mentions the host profile')
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'TEMP']) assert.ok(fs.statSync(seen[k]).isDirectory(), `${k} folder exists`)
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
