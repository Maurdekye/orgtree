import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export function prerequisites(target, electron, python) {
  return [
    ['Electron executable', electron], ['Python interpreter', python],
    ['engine launcher', path.join(target, 'engine/launch.py')],
    ['copied backend', path.join(target, 'engine/backend/orgtree/api.py')],
    ['built main', path.join(target, 'dist/main/index.cjs')],
    ['built preload', path.join(target, 'dist/preload/index.cjs')],
    ['built renderer', path.join(target, 'dist/renderer/index.html')],
  ].filter(([, file]) => !file || !fs.existsSync(file) || !fs.statSync(file).isFile()).map(([name]) => name)
}

export function isolatedRoot(base = os.tmpdir()) {
  const canonicalBase = fs.realpathSync.native(base)
  const forbiddenPath = path.resolve(os.homedir(), 'orgtree')
  const forbidden = fs.existsSync(forbiddenPath) ? fs.realpathSync.native(forbiddenPath) : forbiddenPath
  const relative = path.relative(forbidden, canonicalBase)
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Acceptance data must be outside the live v1 tree')
  }
  const root = fs.mkdtempSync(path.join(canonicalBase, 'orgtree-v2-acceptance-'))
  for (const name of ['data', 'profile', 'project', 'inherited-v1']) fs.mkdirSync(path.join(root, name))
  return root
}

export function phaseResult(phase, report, result, survivors) {
  return { phase, ...report,
    status: report.status === 'PASS' && result.status === 0 && !result.error && survivors.length === 0 ? 'PASS' : 'FAIL',
    processExitCode: result.status, processError: result.error?.code || null,
    childProcessesExited: survivors.length === 0 }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const target = path.resolve(process.env.ORGTREE_ACCEPTANCE_APP || path.join(here, '../..'))
  const electron = process.env.ORGTREE_ACCEPTANCE_ELECTRON || path.join(target, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const python = process.env.ORGTREE_ACCEPTANCE_PYTHON || path.join(target, 'engine/runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const missing = prerequisites(target, electron, python)
  if (missing.length) {
    console.log(JSON.stringify({ status: 'INERT', evidence: 'real-application', missing }))
    process.exitCode = 2
    return
  }
  const root = isolatedRoot()
  const env = { ...process.env, ORGTREE_ACCEPTANCE_ROOT: root, ORGTREE_ACCEPTANCE_APP: target,
    ORGTREE_DATA: path.join(root, 'inherited-v1'), ORGTREE_V2_DATA: path.join(root, 'data'),
    ORGTREE_V2_PROFILE: path.join(root, 'profile'), ORGTREE_V2_PYTHON: python,
    ORGTREE_V2_PORT: '0', ORGTREE_NET_HUB_ADDRESS: 'http://127.0.0.1:9' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ORGTREE_PORT
  delete env.ORGTREE_V1_ROOT
  delete env.ORGTREE_V2_TOKEN
  const phases = []
  for (const phase of ['initial', 'restart']) {
    const result = spawnSync(electron, [path.join(here, 'application.cjs')], {
      cwd: target, env: { ...env, ORGTREE_ACCEPTANCE_PHASE: phase }, windowsHide: true,
      encoding: 'utf8', timeout: 150000, maxBuffer: 1024 * 1024,
    })
    // Arbitrary engine/Chromium logs can contain private data. Only our structured
    // report is published; neither stdout nor stderr is copied to the console.
    const reportFile = path.join(root, phase + '.json')
    const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) :
      { status: 'FAIL', reason: 'Application produced no acceptance report', processStatus: result.status }
    const survivors = (report.childPids || []).filter(pid => {
      try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
    })
    phases.push(phaseResult(phase, report, result, survivors))
    if (survivors.length) break
    if (result.error || !report.ready || result.status !== 0) break
  }
  const status = phases.length === 2 && phases.every(p => p.status === 'PASS') ? 'PASS' : 'FAIL'
  const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8', windowsHide: true })
  const summary = { status, evidence: 'instrumented-real-application', target, python, sourceCommit: source.status === 0 ? source.stdout.trim() : null, root, phases,
    limits: ['No real provider turn in this suite', 'Draft values seeded through storage; composer interactions remain separate', 'Not an installer or update execution test'] }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = status === 'PASS' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
