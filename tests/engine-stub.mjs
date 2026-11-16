// The synthetic engine the desktop supervisor tests spawn, now that no test
// reaches Win32 through Python (4.6.1 phase 2; replaces the generated
// launch.py fixtures and engine/process_lifetime.py + startup_progress.py).
//
// stubEngine() makes a throwaway directory holding a copy of the test-only
// orgtree-test-native image, named orgtree-engine-stub.exe, plus the
// fixture's JavaScript. The desktop spawns that image as its engine `binary`
// exactly as it spawns the real engine. With `guardian`, the stub first
// proves exclusive ownership of the data root and its process tree (root
// lock, Job guardian), as arm_process_lifetime did; then it runs the fixture
// as its child inside that Job. See tools/test-native/src/lifetime.rs.
//
// The fixture JavaScript gets PRELUDE: the stub's pid and guardian pid, the
// data root, the startup-progress/ready lines with the stub's pid, sleep(),
// and alive().
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireTestNative } from '../tools/native-test-bins.mjs'

export const PRELUDE = `'use strict'
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), childProcess = require('node:child_process')
const PID = Number(process.env.ORGTREE_STUB_PID)
const GUARDIAN = Number(process.env.ORGTREE_STUB_GUARDIAN || 0)
const ROOT = process.env.ORGTREE_DATA
let sequence = 0
const say = value => fs.writeSync(1, JSON.stringify(value) + '\\n')
const progress = phase => say({ type: 'startup-progress', protocol: 1, pid: PID, dataRootId: ROOT, sequence: ++sequence, phase })
const ready = (port, extra = {}) => say({ type: 'ready', protocol: 1, pid: PID, dataRootId: ROOT, port, ...extra })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
`

/** Make a stub engine. Returns { binary, directory }. `directory` defaults to
 *  a fresh temp folder; the data root is the caller's business. */
export function stubEngine({ script, guardian = true, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-engine-stub-')) }) {
  const binary = path.join(directory, 'orgtree-engine-stub.exe')
  if (!fs.existsSync(binary)) fs.copyFileSync(requireTestNative(), binary)
  const fixture = path.join(directory, 'fixture.cjs')
  fs.writeFileSync(fixture, PRELUDE + script)
  fs.writeFileSync(path.join(directory, 'engine-stub.json'), JSON.stringify({ node: process.execPath, script: fixture, guardian }))
  return { binary, directory }
}

/** True while `pid` has not exited (OpenProcess + WaitForSingleObject). */
export function alive(pid) {
  return execFileSync(requireTestNative(), ['alive', String(pid)], { encoding: 'utf8', windowsHide: true }).trim() === 'alive'
}

/** [exe, args] for a process that holds `root`'s .desktop-engine.lock as
 *  RootLock did: it prints "held", releases after `seconds`, then prints
 *  "released". Spread it into spawn(). */
export function lockHolder(root, seconds = 120) {
  return [requireTestNative(), ['hold-lock', root, String(seconds)]]
}
