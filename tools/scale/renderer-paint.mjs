// Windows-only: run under the machine's exclusive measurement slot.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { SCHEMA, inside, validateDescriptor, validateLoad, publicDescriptor, percentiles, feedReport } from './renderer-paint/model.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [mode, ...args] = process.argv.slice(2)
const options = Object.fromEntries(args.map((v, i) => v.startsWith('--') ? [v.slice(2), args[i + 1]] : null).filter(Boolean))
if (!['build', 'selfcheck', 'run', 'report'].includes(mode)) {
  console.log('node tools/scale/renderer-paint.mjs build --output <new-build-dir>\n' +
    '  selfcheck --build <build-dir> --output <new-result-dir>\n' +
    '  run --build <build-dir> --descriptor <root/descriptor.json> --label <active-load-label> --output <new-result-dir> [--seconds 15] [--repeats 3]\n' +
    '  report --output <result-dir>  (after the load has finished; no engine access)')
  process.exit(mode ? 1 : 0)
}
if (process.platform !== 'win32') throw Error('Windows compositor format and process isolation required')
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const write = (p, x) => fs.writeFileSync(p, JSON.stringify(x, null, 2))
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
const canonical = p => fs.existsSync(p) ? fs.realpathSync(p) : path.join(canonical(path.dirname(path.resolve(p))), path.basename(p))
const liveRoots = [process.env.ORGTREE_DATA,
  process.env.APPDATA && path.join(process.env.APPDATA, 'Orgtree v2'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'Orgtree')].filter(Boolean).map(canonical)
function safe(p) {
  const resolved = canonical(path.resolve(p))
  if (liveRoots.some(l => inside(resolved, l) || inside(l, resolved))) throw Error('Live-root overlap refused')
  return resolved
}
if (!options.output) throw Error('--output required')
const output = safe(options.output)
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
function headroom() {
  const free = Number(ps('(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory')) / 1024 ** 2
  if (!Number.isFinite(free) || free < 10) throw Error('Free virtual memory must exceed10GiB')
  const active = ps('Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like "*test-baseline*" } | Select-Object -ExpandProperty ProcessId')
  if (active) throw Error('test-baseline active; obtain the measurement slot first')
}
const provenance = () => ({ commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'apps/desktop', 'tools/scale'),
  rendererTree: git('rev-parse', 'HEAD:apps/desktop/renderer'), preloadTree: git('rev-parse', 'HEAD:apps/desktop/preload') })

if (mode === 'build') {
  headroom();fs.mkdirSync(output, { recursive: false })
  const { build: viteBuild } = await import('vite'), { build } = await import('esbuild')
  await viteBuild({ root: path.join(repo, 'apps/desktop/renderer'), base: '/', logLevel: 'warn',
    build: { outDir: path.join(output, 'ui'), emptyOutDir: false, sourcemap: true } })
  await build({ entryPoints: [path.join(repo, 'apps/desktop/preload/index.ts')], outfile: path.join(output, 'preload.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  await build({ entryPoints: [path.join(repo, 'tools/scale/renderer-paint/electron.mjs')], outfile: path.join(output, 'probe.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  write(path.join(output, 'build.json'), { schema: SCHEMA, repo, at: Date.now(), ...provenance() })
} else if (mode === 'report') {
  const run = read(path.join(output, 'run.json')), result = read(path.join(output, 'renderer.json'))
  if (!result.complete || fs.existsSync(path.join(output, 'aborted.json')) || result.errors.length || result.state.errors.length)
    throw Error('Incomplete or failed renderer measurement')
  const loadDir = safe(run.loadDir), summary = read(path.join(loadDir, 'summary.json')), config = read(path.join(loadDir, 'config.json'))
  const rows = name => fs.readFileSync(path.join(loadDir, name + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const offset = result.clock.offset, error = Math.max(result.clock.error, result.clockEnd.error) + Math.abs(offset - result.clockEnd.offset)
  const from = result.state.feedFrom + offset, until = result.state.feedUntil + offset
  const paintMap = new Map(result.paintTimes), feedPaints = []
  for (const b of result.state.batches) {
    const at = paintMap.get(b.id)
    if (at == null) continue
    if (at + error < b.at + offset) throw Error('Compositor proof predates renderer mutation')
    for (const row of b.rows) if (row.type === 'feed') feedPaints.push({ m: row.m, at })
  }
  const feed = feedReport({ emitted: rows('markers'), submits: rows('stream'),
    receipts: result.state.receipts.map(r => ({ ...r, at: r.at + offset })), paints: feedPaints,
    agent: result.agent, from, until, clockErrorMs: error })
  const groups = ['select-agent', 'open-docket-item', 'switch-tab', 'open-attention', 'open-chat']
  const clicks = Object.fromEntries(groups.map(g => [g, percentiles(result.actions.filter(a => a.measured && a.name.startsWith(g + '-')).map(a => a.ms))]))
  const measured = result.actions.filter(a => a.measured)
  const first = Math.min(from, ...measured.map(a => a.start)), last = Math.max(until, ...measured.map(a => a.painted))
  const windowStart = config.started * 1000, windowEnd = windowStart + config.duration_s * 1000
  const inWindow = r => windowStart + r.end_t * 1000 >= first && windowStart + r.end_t * 1000 <= last
  const calls = rows('calls').filter(inWindow), steer = rows('steer').filter(inWindow)
  const overlap = { first, last, windowStart, windowEnd, completedCalls: calls.length, steerPolls: steer.length,
    contained: first - error >= windowStart && last + error <= windowEnd }
  const valid = overlap.contained && calls.length > 0 && steer.length > 0 &&
    summary.workload_completed_without_errors_or_overload === true && config.label === run.label &&
    config.engine_commit === run.descriptorSummary.engine_commit && !result.state.wsClosed &&
    !fs.existsSync(path.join(path.dirname(loadDir), 'qualification-invalid.json')) &&
    groups.every(g => clicks[g].n === run.repeats) && feed.expected > 0
  const report = { schema: SCHEMA, validMeasurement: valid, clicks, clickTargetMet: valid && groups.every(g => clicks[g].max < 100),
    feed, feedTargetMet: valid && feed.targetMet, overlap, workload: { config, achieved: summary.achieved,
      activity: summary.activity_after, valid: summary.workload_completed_without_errors_or_overload },
    descriptor: run.descriptorSummary, build: run.buildProvenance, controls: result.controls, raf: result.raf,
    limitations: result.limitations.concat('This run covers one real renderer window and the selected visible agent only. Other HTTP harness windows are synthetic.'),
    targetInterpretation: 'Every measured click must be <100ms; feed requires every expected marker <=1000ms including clock uncertainty.' }
  write(path.join(output, 'report.json'), report)
  console.log(JSON.stringify({ valid, clicks, feed: feed.counts, clickTargetMet: report.clickTargetMet, feedTargetMet: report.feedTargetMet }))
  process.exitCode = valid ? 0 : 1 // Slow valid measurements remain useful; target booleans are separate.
} else {
  headroom()
  const buildDir = safe(options.build), buildProvenance = read(path.join(buildDir, 'build.json'))
  if (buildProvenance.schema !== SCHEMA || buildProvenance.dirty) throw Error('Build must identify clean committed renderer/harness source')
  const seconds = Number(options.seconds || 15), repeats = Number(options.repeats || 3)
  if (!(seconds >= 1 && seconds <= 600) || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 50) throw Error('Bad duration/repeats')
  let descriptor, descriptorPath, loadDir
  if (mode === 'run') {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.label || '')) throw Error('Safe load --label required')
    descriptorPath = safe(options.descriptor)
    descriptor = validateDescriptor(read(descriptorPath), path.dirname(descriptorPath), liveRoots)
    if (safe(descriptor.data_root) !== path.join(path.dirname(descriptorPath), 'data')) throw Error('Data-root link escaped fixture')
    validateLoad(descriptor, options.label)
    loadDir = safe(path.join(descriptor.root, 'metrics', options.label))
    const processInfo = JSON.parse(ps(`Get-CimInstance Win32_Process -Filter "ProcessId=${descriptor.serve.pid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`))
    if (!processInfo.CommandLine.includes('serve.py') || !processInfo.CommandLine.includes('--child') || !processInfo.CommandLine.includes(descriptor.root))
      throw Error('Descriptor PID is not its owned scale server')
    const response = await fetch(descriptor.origin + '/scale/activity', { headers: { 'X-Orgtree-Desktop-Token': descriptor.token }, signal: AbortSignal.timeout(15000) })
    const activity = await response.json()
    if (!response.ok || activity.launch_attempts?.unexpected !== 0) throw Error('Scale engine did not attest clean launch guard')
  }
  fs.mkdirSync(output, { recursive: false })
  const run = { schema: SCHEMA, mode, output, build: buildDir, buildProvenance, seconds, repeats,
    descriptor: descriptorPath, descriptorSummary: descriptor && publicDescriptor(descriptor),
    org: descriptor?.org, label: options.label, loadDir, started: Date.now() }
  write(path.join(output, 'run.json'), run)
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORGTREE_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|GEMINI_|GOOGLE_API|PYTHON)/i.test(k)))
  const env = { ...cleanEnv, ORGTREE_PAINT_RUN: path.join(output, 'run.json'),
    ORGTREE_DATA: descriptor?.data_root || path.join(output, 'unused-data') }
  delete env.ELECTRON_RUN_AS_NODE
  const executable = createRequire(pathToFileURL(path.join(repo, 'package.json')))('electron')
  const child = spawn(executable, [path.join(buildDir, 'probe.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit' })
  let stopping = false, exited = false, sampling = false
  const stop = reason => {
    if (stopping || exited) return
    stopping = true;write(path.join(output, 'aborted.json'), { reason, at: Date.now() })
    // Only this owned Electron family. Never terminate the separately owned PG/engine/load.
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => { if (error && !exited) child.kill() })
  }
  const guard = setInterval(() => {
    if (sampling || stopping || exited) return
    sampling = true
    execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory'],
      { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        sampling = false;if (exited) return
        const freeGiB = Number(stdout?.trim()) / 1024 ** 2
        fs.appendFileSync(path.join(output, 'memory.jsonl'), JSON.stringify({ at: Date.now(), freeGiB, failed: !!error }) + '\n')
        if (error || !Number.isFinite(freeGiB) || freeGiB < 10) stop('Memory guard failed/less than10GiB')
      })
  }, 10000)
  const timer = setTimeout(() => stop('Measurement wall deadline exceeded'), (seconds + repeats * 100 + 90) * 1000)
  let resultAt = null
  const completionGuard = setInterval(() => {
    if (!fs.existsSync(path.join(output, 'renderer.json'))) return
    resultAt ??= Date.now()
    if (Date.now() - resultAt > 5000) stop('Electron failed to exit within5s of final measurement record')
  }, 1000)
  process.on('SIGINT', () => stop('Interrupted'));process.on('SIGTERM', () => stop('Terminated'))
  const code = await new Promise(resolve => { child.once('error', () => resolve(1));child.once('exit', c => resolve(c ?? 1)) })
  exited = true;clearInterval(guard);clearInterval(completionGuard);clearTimeout(timer)
  write(path.join(output, 'exit.json'), { code, stopping, at: Date.now(), pid: child.pid })
  process.exitCode = stopping ? 1 : code
  console.log(code || stopping ? 'Measurement failed; no qualification. Inspect exit.json and any renderer.json.' :
    mode === 'run' ? 'Raw measurement saved. After load completion, run report; no qualification is asserted yet.' : 'Compositor control finished; see renderer.json.')
}
