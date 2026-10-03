// launchagent-install.test.mjs — the real install/uninstall round-trip
// launchagent-mac.ts's install()/uninstall() drive, measured against the
// actual launchd on this machine rather than argued about (D-05's "must
// include a real verification step" requirement).
//
// This registers a real per-user LaunchAgent — a disruptive action launchd
// itself will spawn a process for — under a throwaway label distinct from
// the real production LABEL, so it can never collide with it. The spawned
// program is `/usr/bin/true`, which exits 0 immediately: with
// KeepAlive.SuccessfulExit=false that means launchd will not respawn it, so
// this leaves no running process or restart loop behind, only a momentary
// registration this file removes before it finishes.
//
// Run: THIS PROBE IS OPT-IN AND WILL REGISTER A REAL LAUNCHAGENT.
//   set ORGTREE_DISRUPTIVE_PROBES=1  and then  npm run test:disruptive
//   (or: node --test tests/disruptive/launchagent-install.test.mjs, same variable set)
//   Without that variable every test here SKIPS and measures nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { requireDisruptiveOptIn } from './gate.mjs'

// DISRUPTIVE PROBE — SECOND BARRIER. This file registers a real LaunchAgent
// with the real launchd, so it must never run because somebody typed
// `npm test`. Barrier one is the folder: the default glob
// `tests/*.test.mjs` does not recurse, so it cannot reach this file. Barrier
// two is this gate: without an explicit opt-in every test below is SKIPPED,
// which node:test reports as skipped rather than as a pass.
const DISRUPTIVE_OK = requireDisruptiveOptIn('launchagent install')
const gatedTest = DISRUPTIVE_OK ? test : test.skip

const repo = path.resolve(import.meta.dirname, '../..')
const esbuildOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-launchagent-install-'))
const outfile = path.join(esbuildOutDir, 'launchagent-mac.cjs')
await build({ entryPoints: [path.join(repo, 'apps/desktop/main/launchagent-mac.ts')], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { install, uninstall, buildPlist, plistPath } = createRequire(import.meta.url)(outfile)

const uid = process.getuid()
// Distinct from LABEL ('com.maurdekye.orgtree.boot-engine') by construction
// — this can never collide with the real production LaunchAgent.
const throwawayLabel = `com.maurdekye.orgtree.disruptivetest.${randomUUID()}`
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-launchagent-install-logs-'))

function printExitsZero(label) {
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${label}`])
    return true
  } catch {
    return false
  }
}

gatedTest('install() bootstraps a real LaunchAgent; uninstall() reverses it', () => {
  assert.equal(printExitsZero(throwawayLabel), false, 'the throwaway label must not already be registered')

  install({
    label: throwawayLabel,
    pythonPath: '/usr/bin/true',
    entrypointPath: '/usr/bin/true',
    workingDirectory: os.tmpdir(),
    stdoutLog: path.join(logDir, 'out.log'),
    stderrLog: path.join(logDir, 'err.log'),
    uid,
  })

  assert.equal(printExitsZero(throwawayLabel), true, 'launchctl print must exit 0 immediately after a successful bootstrap')

  uninstall(throwawayLabel, uid)

  assert.equal(printExitsZero(throwawayLabel), false, 'launchctl print must exit nonzero once bootout has removed the job')
})

gatedTest('buildPlist() output passes plutil -lint', () => {
  const plist = buildPlist({
    label: throwawayLabel,
    pythonPath: '/usr/bin/true',
    entrypointPath: '/usr/bin/true',
    workingDirectory: os.tmpdir(),
    stdoutLog: path.join(logDir, 'out.log'),
    stderrLog: path.join(logDir, 'err.log'),
  })
  const lintTarget = path.join(esbuildOutDir, 'lint-target.plist')
  fs.writeFileSync(lintTarget, plist)
  const output = execFileSync('plutil', ['-lint', lintTarget]).toString()
  assert.match(output, /OK/)
})

// Cleanup runs even if an assertion above throws mid-test — node:test still
// runs `test.after` hooks after a failing test, matching the project's
// established cleanup pattern (registry-labels.test.mjs).
test.after(() => {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${throwawayLabel}`])
  } catch {
    // already removed, or install() never reached bootstrap — either way
    // there is nothing left to tear down
  }
  fs.rmSync(plistPath(throwawayLabel), { force: true })
  fs.rmSync(esbuildOutDir, { recursive: true, force: true })
  fs.rmSync(logDir, { recursive: true, force: true })
})
