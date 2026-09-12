import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isolatedRoot, acceptanceEnvironment, assertIsolatedEnvironment, preflightHelpers, acceptanceLaunchArgs } from './isolation.mjs'

export { isolatedRoot, acceptanceEnvironment, assertIsolatedEnvironment, preflightHelpers, acceptanceLaunchArgs }

export function runtimeManifest(target, packaged = null) {
  const base = packaged ? path.join(packaged, 'resources') : target
  const files = {}
  function walk(folder, include) {
    if (!fs.existsSync(folder)) return
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['runtime', '__pycache__'].includes(entry.name)) continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(file, include)
      else if (entry.isFile() && include(file)) add(file)
    }
  }
  function add(file) { if (fs.existsSync(file)) files[path.relative(base, file).replaceAll('\\', '/')] = createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  walk(path.join(base, 'engine'), file => file.endsWith('.py'))
  walk(path.join(base, packaged ? 'ui' : 'dist'), () => true)
  for (const name of ['engine/runtime/python.exe', 'engine/runtime/python313._pth', ...(packaged ? ['app.asar','build-info.json'] : [])]) add(path.join(base, name))
  return { files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

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

export function phaseResult(phase, report, result, survivors) {
  return { phase, ...report,
    status: report.status === 'PASS' && result.status === 0 && !result.error && survivors.length === 0 ? 'PASS' : 'FAIL',
    processExitCode: result.status, processError: result.error?.code || null,
    childProcessesExited: survivors.length === 0 }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const target = path.resolve(process.env.ORGTREE_ACCEPTANCE_APP || path.join(here, '../..'))
  const packaged = process.env.ORGTREE_ACCEPTANCE_PACKAGE ? path.resolve(process.env.ORGTREE_ACCEPTANCE_PACKAGE) : null
  const visual = process.env.ORGTREE_ACCEPTANCE_VISUAL_FIXTURE === '1'
  if (packaged && visual) {
    console.log(JSON.stringify({ status: 'INERT', reason: 'Synthetic visual mode currently supports source builds only' }))
    process.exitCode = 2
    return
  }
  const electron = process.env.ORGTREE_ACCEPTANCE_ELECTRON || path.join(target, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const python = process.env.ORGTREE_ACCEPTANCE_PYTHON || path.join(packaged ? path.join(packaged, 'resources') : target, 'engine/runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const missing = packaged ? [['Electron driver', electron], ['packaged executable', path.join(packaged, 'Orgtree.exe')], ['packaged app archive', path.join(packaged, 'resources/app.asar')], ['packaged Python', python], ['packaged launcher', path.join(packaged, 'resources/engine/launch.py')], ['packaged renderer', path.join(packaged, 'resources/ui/index.html')]].filter(([, file]) => !fs.existsSync(file)).map(([name]) => name) : prerequisites(target, electron, python)
  if (missing.length) {
    console.log(JSON.stringify({ status: 'INERT', evidence: 'real-application', missing }))
    process.exitCode = 2
    return
  }
  const root = isolatedRoot()
  // Onboarding populates user charter documents. Give the child process its
  // own home as well as its own store/profile, before importing any engine code.
  let acceptanceHome = path.join(root, 'home')
  if (process.env.ORGTREE_ACCEPTANCE_IMPORT_FIXTURE === '1') {
    const fixture = path.join(root, 'v2-import-fixture-source')
    const seed = spawnSync(python, [path.join(here, 'seed_import_fixture.py'), target, fixture], { cwd: target, encoding: 'utf8', windowsHide: true })
    if (seed.status !== 0) throw new Error('Isolated import seed failed')
    fs.copyFileSync(path.join(fixture, 'manifest.json'), path.join(root, 'import-manifest.json'))
    acceptanceHome = JSON.parse(fs.readFileSync(path.join(root, 'import-manifest.json'), 'utf8')).home
  }
  const env = acceptanceEnvironment(root, { home: acceptanceHome, env: {
    ORGTREE_ACCEPTANCE_APP: target, ORGTREE_V2_PYTHON: python,
    ORGTREE_V2_PORT: '0', ORGTREE_NET_HUB_ADDRESS: 'http://127.0.0.1:9',
    ...(packaged ? { ORGTREE_ACCEPTANCE_PACKAGE: packaged } : {}),
  } })
  assertIsolatedEnvironment(env, root)
  const preflight = preflightHelpers(here, python)
  fs.writeFileSync(path.join(root, 'preflight.json'), JSON.stringify(preflight, null, 2))
  if (preflight.status !== 'PASS') {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ status: 'FAIL', root, preflight }, null, 2))
    console.log(JSON.stringify({ status: 'FAIL', root, preflight }, null, 2))
    process.exitCode = 1
    return
  }
  const manifest = runtimeManifest(target, packaged)
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2))
  const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8', windowsHide: true })
  const buildInfoFile = path.join(packaged ? path.join(packaged, 'resources') : path.join(target, 'dist'), 'build-info.json')
  const buildInfo = fs.existsSync(buildInfoFile) ? JSON.parse(fs.readFileSync(buildInfoFile, 'utf8')) : null
  const phases = []
  for (const phase of ['initial', 'restart']) {
    const result = spawnSync(electron, acceptanceLaunchArgs(path.join(here, 'application.cjs')), {
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
    if (result.error || !report.ready || report.status !== 'PASS' || result.status !== 0) break
  }
  const runtimeUnchanged = runtimeManifest(target, packaged).digest === manifest.digest
  const status = phases.length === 2 && phases.every(p => p.status === 'PASS') && runtimeUnchanged ? 'PASS' : 'FAIL'
  const summary = { status, evidence: packaged ? 'packaged-components-in-instrumented-electron' : visual ? 'real-application-with-synthetic-ledger-and-disabled-provider-processes' : 'instrumented-real-application', target, packaged, python, sourceCommit: packaged ? null : source.status === 0 ? source.stdout.trim() : null, buildInfo, runtimeDigest: manifest.digest, runtimeUnchanged, root, phases,
    limits: ['No real provider turn in this suite', 'Draft values seeded through storage; composer interactions remain separate', 'Not an installer or update execution test', ...(visual ? ['Synthetic ledger seed and disabled discovery/warming/child execution; real launcher, store, routes and renderer'] : []), ...(packaged ? ['Login registration captured without changing Windows; updater network denied; driver executable remains development Electron', 'Source provenance requires package build-info.json; driver checkout SHA is not package provenance'] : [])] }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = status === 'PASS' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
