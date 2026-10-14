// Proof: an agent's tool commands end with the engine's graceful stop,
// including a background one whose own parent shell has already exited
// (docket installer-can-t-replace-a-running-orgtree-an-ins, lead 1). The
// installer's boot step follows the engine's descendants by parent id, so an
// orphan like that is invisible to it, and a descendant that outlived the
// engine would hold the boot step until its budget ran out. What ends both is
// the engine's kill-on-close root job (winproc.rs, no breakaway). Two real
// upgrades to 4.3.0-alpha.1 measured the same: 1.3 s after the engine's stop,
// every agent descendant had gone.
//
// The engine is stopped here the way the installer and the desktop stop it
// (POST /api/desktop/shutdown), and the tool commands are checked before the
// rig reaps anything: its reaper ends whole trees, which would hide a failure.
//   node tools/rig/rig.mjs run tools/rig/proofs/agent-tree-stop.mjs
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { TOKEN_HEADER, alive, writeRun } from '../lib.mjs'

// The PING.EXE processes now running whose command line contains `needle`.
function pings (needle) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter 'Name = ''PING.EXE''' | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId} }) | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  if (r.status !== 0) throw new Error(`process reading failed: ${r.stderr}`)
  const out = r.stdout.trim()
  return out ? [].concat(JSON.parse(out)) : []
}

export default async function (rig) {
  const p = new Proof('agent-tree-stop')
  // Ping counts no other process on the machine is using, and long enough
  // (minutes) that only an ended process can be gone.
  const n = 400 + (Date.now() % 400)
  const fg = `-n ${n} 127.0.0.2`, bg = `-n ${n + 1} 127.0.0.3`
  // By full path, and with no quotes: the fake CLI passes the command to
  // `cmd /D /C` as one argument, which escapes quotes the way cmd does not read.
  const ping = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE')
  rig.scenario({ agents: { tess: { turns: [{ name: 'tools', steps: [
    { spawn: `${ping} ${fg}` },
    { spawn: `start /b ${ping} ${bg}` },
    { text: 'Started two long tool commands.' }] }] } } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'tess', parent: 'boss', tier: 'haiku', title: 'Tool children' })
  await rig.userMail('tess', 'Start your tool commands.')
  await rig.waitTurns('tess', 1)
  const spawned = rig.fakeLog('tess').filter(l => l.kind === 'spawned')
  p.check('the agent\'s CLI started both tool commands', spawned.length === 2 && spawned.every(s => s.child_pid > 0), spawned)
  const before = await rig.waitFor(() => { const f = pings(fg), b = pings(bg); return f.length === 1 && b.length === 1 ? { fg: f[0], bg: b[0] } : null },
    { what: 'both tool commands to be running', timeout: 20000 }).catch(error => {
    // what there was instead, for the receipt
    const shells = spawned.map(s => s.child_pid).filter(Boolean)
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PING.EXE' -or @(${shells.join(',') || 0}) -contains $_.ParentProcessId -or @(${shells.join(',') || 0}) -contains $_.ProcessId } | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; name=$_.Name; line=$_.CommandLine} }) | ConvertTo-Json -Compress`],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    p.check('both tool commands were running after the turn', false, { error: error.message, shellsAlive: shells.map(pid => [pid, alive(pid)]), seen: r.stdout.trim() })
    return null
  })
  if (!before) return p.summary()
  p.check('the foreground tool command runs under its shell', alive(before.fg.parent), before.fg)
  p.check('the background one is an orphan: the shell that started it has exited', !alive(before.bg.parent), before.bg)

  const run = rig.refresh()
  const engine = run.enginePid
  p.check('the engine is running', engine > 0 && alive(engine), { engine })
  // down on purpose until the restart below: other agents' cleanup must not take the run
  writeRun(rig.dir, { busy: new Date().toISOString() })
  const asked = Date.now()
  await fetch(rig.url + '/api/desktop/shutdown', { method: 'POST', headers: { [TOKEN_HEADER]: rig.token }, signal: AbortSignal.timeout(5000) })
  await rig.waitFor(() => !alive(engine), { what: 'the engine to stop', timeout: 90000, every: 100 })
  const stoppedMs = Date.now() - asked
  let left = []
  const gone = await rig.waitFor(() => { left = [...pings(fg), ...pings(bg)]; return left.length === 0 ? Date.now() - asked : null },
    { what: 'both tool commands to end', timeout: 10000, every: 100 }).catch(() => null)
  p.check('both tool commands ended with the engine, before anything was reaped', gone !== null,
    { engineStoppedMs: stoppedMs, toolsGoneMs: gone, stillRunning: left })
  // The keeper reaps whatever of the run outlived the engine, as soon as it
  // exits, and with `taskkill /T`. Nothing to reap means nothing outlived it.
  await rig.waitFor(() => !alive(run.keeperPid), { what: 'the keeper to note the stop', timeout: 30000 }).catch(() => {})
  const reaped = fs.readFileSync(path.join(rig.dir, 'keeper.log'), 'utf8').split(/\r?\n/).filter(l => /\breaped\b/.test(l))
  p.check('the rig reaped nothing: the engine\'s own job had ended its CLI and tool commands', reaped.length === 0, { reaped })
  await rig.restart()
  p.note('Fake Claude CLI (tools/rig/fakecli `spawn` steps) and the real engine; the stop is the installer\'s and the desktop\'s own request. A ping runs for minutes, so only an ended process is gone. No installer, task or live data.')
  return p.summary()
}
