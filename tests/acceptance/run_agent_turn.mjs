import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  isolatedRoot, acceptanceEnvironment, assertIsolatedEnvironment, preflightHelpers,
  acceptanceLaunchArgs, runtimeManifest, prerequisites, phaseResult,
} from './run.mjs'

function macosPreflight(target) {
  const result = spawnSync(process.execPath, [path.join(target, 'tools/verify-macos-preflight.mjs')], {
    cwd: target, encoding: 'utf8', windowsHide: true,
  })
  try { return JSON.parse(result.stdout) }
  catch { return { status: 'FAIL', reason: 'verify-macos-preflight.mjs produced no parsable output', stderr: result.stderr } }
}

const here = path.dirname(fileURLToPath(import.meta.url))

function main() {
  // Gate the real-provider phase behind explicit authorization (mirrors
  // run_claude.py's --authorize-one-claude-turn gate) so this script is safe
  // to leave wired into `npm run` without ever triggering a live network
  // call by accident.
  if (process.env.ORGTREE_ACCEPTANCE_AUTHORIZE_AGENT_TURN !== '1') {
    console.log(JSON.stringify({ status: 'INERT', reason: 'Explicit agent-turn authorization required' }))
    process.exitCode = 2
    return
  }

  const target = path.resolve(process.env.ORGTREE_ACCEPTANCE_APP || path.join(here, '../..'))
  // Resolve Electron/Python with run.mjs's own platform branch, never
  // run_lifecycle.mjs's hardcoded electron.exe/python.exe paths (Windows-only).
  const electron = process.env.ORGTREE_ACCEPTANCE_ELECTRON
    || path.join(target, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  const python = process.env.ORGTREE_ACCEPTANCE_PYTHON
    || path.join(target, 'engine/runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3')

  // Required first step: fail loud on the known process-lifecycle blockers
  // rather than attempting the real turn and surfacing a confusing mid-run
  // failure (Task 2's gate, tools/verify-macos-preflight.mjs).
  const preflight = macosPreflight(target)
  if (preflight.status !== 'PASS') {
    console.log(JSON.stringify({ status: 'BLOCKED', preflight }))
    process.exitCode = 2
    return
  }

  const missing = prerequisites(target, electron, python)
  if (missing.length) {
    console.log(JSON.stringify({ status: 'INERT', evidence: 'real-agent-turn', missing }))
    process.exitCode = 2
    return
  }

  const harnessPreflight = preflightHelpers(here, python)
  if (harnessPreflight.status !== 'PASS') {
    console.log(JSON.stringify({ status: 'FAIL', reason: 'Acceptance harness preflight failed', preflight: harnessPreflight }))
    process.exitCode = 1
    return
  }

  const root = isolatedRoot()
  const env = acceptanceEnvironment(root, { env: {
    ORGTREE_ACCEPTANCE_APP: target, ORGTREE_V2_PYTHON: python, ORGTREE_V2_PORT: '0',
  } })
  assertIsolatedEnvironment(env, root)
  const manifest = runtimeManifest(target)
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2))

  const result = spawnSync(electron, acceptanceLaunchArgs(path.join(here, 'agent_turn.cjs')), {
    cwd: target, env: { ...env, ORGTREE_ACCEPTANCE_PHASE: 'agent-turn' }, windowsHide: true,
    // Real provider turns can run long; budget generously but boundedly.
    encoding: 'utf8', timeout: 280000, maxBuffer: 1024 * 1024,
  })
  // Neither stdout nor stderr is copied to the console: provider transcripts
  // and engine logs can carry API keys or user content (matches run.mjs).
  const reportFile = path.join(root, 'report.json')
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) :
    { status: 'FAIL', reason: 'Agent turn produced no acceptance report', processStatus: result.status }
  const runtimeUnchanged = runtimeManifest(target).digest === manifest.digest
  const summary = phaseResult('agent-turn', { ...report, runtimeUnchanged }, result, [])
  summary.root = root
  summary.evidence = summary.evidence || 'real-application-real-provider-through-dom'
  fs.writeFileSync(reportFile, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = summary.status === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
