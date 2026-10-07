// tools/rig/desktop.mjs: run a desktop page script against a rig run's
// engine in offscreen Electron (tools/rig/desktop/main.cjs). The script is a
// CommonJS module exporting `async (page, ctx) => value`; see the page
// driver in desktop/main.cjs and docs/rust-engine/test-rig.md.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { RIG_DIR, cleanEnv, electronExe, killTree, touch } from './lib.mjs'

/** Run `script` against `rig`; resolves with { ok, value, error, shots, consoleErrors, out }. */
export async function runDesktop(rig, script, { preset = 'short', out, timeout = 180000, org = rig.org, electron, args } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const outDir = path.resolve(out ?? path.join(rig.dir, 'desktop', `${path.basename(script).replace(/\.c?js$/, '')}-${preset}-${stamp}`))
  fs.mkdirSync(outDir, { recursive: true })
  const env = {
    ...cleanEnv(),
    RIG_DESKTOP_URL: rig.url, RIG_DESKTOP_TOKEN: rig.token, RIG_DESKTOP_ORG: org ?? '',
    RIG_DESKTOP_SCRIPT: path.resolve(script), RIG_DESKTOP_OUT: outDir, RIG_DESKTOP_PRESET: String(preset),
    RIG_DESKTOP_PROFILE: path.join(rig.dir, 'electron-profile'), RIG_DESKTOP_TIMEOUT_MS: String(timeout),
    RIG_DESKTOP_ARGS: JSON.stringify(args ?? {}),
  }
  const child = spawn(electronExe(electron), [path.join(RIG_DIR, 'desktop', 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const pidFile = path.join(rig.dir, 'electron.pid')
  fs.writeFileSync(pidFile, String(child.pid))
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
  return { ...result, out: outDir, exit: code }
}
