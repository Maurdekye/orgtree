// tools/rig/desktop.mjs: run a desktop page script against a rig run's
// engine in offscreen Electron (tools/rig/desktop/main.cjs). The script is a
// CommonJS module exporting `async (page, ctx) => value`; see the page
// driver in desktop/main.cjs and docs/rust-engine/test-rig.md.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { RIG_DIR, cleanEnv, electronExe, killTree, touch } from './lib.mjs'

/** The Windows session a process runs in (tasklist), or null. */
function sessionOf(pid) {
  if (process.platform !== 'win32') return null
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  const cols = (r.stdout ?? '').trim().split('\n')[0]?.match(/"([^"]*)"/g)?.map(c => c.slice(1, -1))
  const n = cols && Number(cols[3])
  return Number.isInteger(n) ? n : null
}

/** Run `script` against `rig` (`profile`: a folder to keep the Electron profile in, so a later run sees the earlier one's localStorage); resolves with { ok, value, error, shots, consoleErrors, guards, session, out }.
 * Only on a run made with a renderer bundle (`--ui <dir>|auto` or ORGTREE_RIG_UI): a headless run is refused before
 * anything starts. The harness (desktop/main.cjs) is always muted and off the real clipboard (desktop/guards.cjs). */
export async function runDesktop(rig, script, { preset = 'short', out, timeout = 180000, org = rig.org, electron, args, profile } = {}) {
  if (!rig.run?.ui) {
    throw new Error('this run has no renderer bundle, so its desk is not driven: run it with --ui <dir> or --ui auto (or ORGTREE_RIG_UI)')
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const outDir = path.resolve(out ?? path.join(rig.dir, 'desktop', `${path.basename(script).replace(/\.c?js$/, '')}-${preset}-${stamp}`))
  fs.mkdirSync(outDir, { recursive: true })
  const env = {
    ...cleanEnv(),
    RIG_DESKTOP_URL: rig.url, RIG_DESKTOP_TOKEN: rig.token, RIG_DESKTOP_ORG: org ?? '',
    RIG_DESKTOP_SCRIPT: path.resolve(script), RIG_DESKTOP_OUT: outDir, RIG_DESKTOP_PRESET: String(preset),
    // a fresh profile per invocation: no HTTP cache or localStorage carried from one script to the next
    RIG_DESKTOP_PROFILE: profile ?? path.join(rig.dir, 'electron-profiles', `${stamp}-${process.pid}-${Math.random().toString(16).slice(2, 6)}`), RIG_DESKTOP_TIMEOUT_MS: String(timeout),
    RIG_DESKTOP_ARGS: JSON.stringify(args ?? {}),
  }
  const child = spawn(electronExe(electron), [path.join(RIG_DIR, 'desktop', 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const pidFile = path.join(rig.dir, 'electron.pid')
  fs.writeFileSync(pidFile, String(child.pid))
  // where the window lives (team rule: Session 0 or a private desktop only):
  // the receipt names each process and its measured SessionId
  const session = { rig: sessionOf(process.pid), rigPid: process.pid, electron: sessionOf(child.pid), electronPid: child.pid }
  let stderr = ''
  child.stdout.on('data', d => { stderr += d })
  child.stderr.on('data', d => { stderr += d })
  const beat = setInterval(() => touch(rig.dir), 30000)
  const code = await new Promise(resolve => {
    const t = setTimeout(() => { killTree(child.pid); resolve('timeout') }, timeout + 30000)
    child.on('exit', c => { clearTimeout(t); resolve(c) })
  })
  clearInterval(beat)
  killTree(child.pid)
  fs.rmSync(pidFile, { force: true })
  const resultFile = path.join(outDir, 'result.json')
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, error: `electron exited (${code}) without a result` }
  if (!result.ok && stderr.trim()) result.electronOutput = stderr.trim().slice(-2000)
  return { ...result, session, out: outDir, exit: code }
}
