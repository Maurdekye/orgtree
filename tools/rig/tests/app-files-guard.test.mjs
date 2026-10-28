// The app-files proof writes nothing before the rig's own home guard passes
// (4.5.0 high E17, review alpha2 09281842a7e9 F1).
//
// Its setup() makes files-fixture under the rig home and has ffmpeg write a
// fixed video there. It used to take ORGTREE_RIG_HOME as given, before up()
// checks the home, so a home inside live Orgtree data, or a fixture folder
// linked elsewhere, was written (and an existing file overwritten) first.
// setup() runs in a child with the protected roots set to scratch folders,
// and nothing may appear in them. No engine, database or rig run is started.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as lib from '../lib.mjs'

const windows = { skip: process.platform !== 'win32' }
const PROOF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'proofs', 'app-files.mjs')

function scratch(ctx, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `app-files-guard-${label}-`))
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return dir
}

/** setup() in a child whose rig home and protected roots are given. */
function setup(home, protectedRoots) {
  const env = { ...process.env, ORGTREE_RIG_HOME: home, RIG_PROTECTED_ROOTS: JSON.stringify(protectedRoots) }
  delete env.NODE_OPTIONS
  const code = `import(${JSON.stringify(pathToFileURL(PROOF).href)}).then(m => m.setup())` +
    `.then(() => console.log('SETUP ok'), e => console.log('SETUP refused: ' + e.message))`
  const r = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { env, encoding: 'utf8', timeout: 120000, windowsHide: true })
  return `${r.stdout}${r.stderr}`
}

const listing = dir => fs.readdirSync(dir, { recursive: true }).map(String).sort()

test('a rig home inside live Orgtree data is refused before anything is written', windows, ctx => {
  const live = scratch(ctx, 'live')
  const home = path.join(live, 'rig-home')
  const out = setup(home, [live, ...lib.liveRoots()])
  assert.deepEqual(listing(live), [], `setup wrote inside the live folder: ${out}`)
  assert.match(out, /SETUP refused: refusing .* overlaps the live Orgtree data folder/, out)
})

test('a fixture folder linked elsewhere is refused before anything is written through it', windows, ctx => {
  const root = scratch(ctx, 'linked')
  const home = path.join(root, 'rig-home'), elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(home)
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, path.join(home, 'files-fixture'), 'junction')
  ctx.after(() => { try { fs.rmdirSync(path.join(home, 'files-fixture')) } catch {} })
  const out = setup(home, lib.liveRoots())
  assert.deepEqual(listing(elsewhere), [], `setup wrote through the link: ${out}`)
  assert.match(out, /SETUP refused: .*files-fixture.* link/, out)
})
