// Proof: Orgtree ends Codex gracefully (docket
// urgent-orgtree-s-hard-killing-of-codex-processes). Forcing codex.exe down
// with an RPC call in flight to lsass crashes lsass (RPCRT4 10.0.26100.9444)
// and reboots Windows, so every end closes the app-server's stdin and lets
// it exit by itself before any termination. The REAL installed Codex
// (`--real-cli`) on the Language Server lane against tools/rig/fakellm.mjs:
//   1. halting a seat (kill path) ends its Codex by a natural exit;
//   2. retooling an idle seat (close path: its process is replaced) does too;
//   3. retiring a seat (stop path) does too;
//   5. halting a seat mid-turn, while its model request is outstanding,
//      and while a shell command it started runs: still a natural exit;
//   4. the durable record diagnostics\logs\codex-kills.log has one
//      codex-graceful-exit line per end and no codex-force-kill line, and the
//      engine log mirrors them.
//   node tools/rig/rig.mjs run tools/rig/proofs/codex-graceful.mjs

import fs from 'node:fs'
import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { ps } from './credential-broker.mjs'

const MODEL = 'fake-model:latest'
const done = summary => ({ tool: 'orgtree_status', input: { status: 'done', summary } })

export async function setup() {
  return { name: 'codex-graceful', 'real-cli': true, fixture: 'none' }
}

const alive = pid => pid > 0 && ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`) !== ''

export default async function (rig) {
  const p = new Proof('codex-graceful')
  const llm = await startFakeLlm({
    log: path.join(p.dir, 'fakellm.jsonl'),
    models: [{ name: MODEL, context: 131072, running: 65536 }],
    rules: [
      { match: ['PROOF-G-SLEEP'], tool: 'exec_command', input: { cmd: 'Start-Sleep -Seconds 60' } },
      { match: ['PROOF-G-WAIT'], ...done('PROOF-G-WAIT-DONE'), delay_ms: 60000 },
      ...['G-HALT', 'G-CLOSE', 'G-RETIRE', 'G-BUSY'].map(t => ({ match: [`PROOF-${t}`], ...done(`PROOF-${t}-DONE`) })),
    ],
  })
  const status = n => rig.one(`SELECT last_status->>'summary' AS summary FROM ot.agents WHERE name = '${n}'`)
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l))
  const of = (name, re) => lines(re).filter(l => l.includes(`/${name} `))
  const pidIn = l => Number((l?.match(/ pid=(\d+)/) ?? [])[1] ?? 0)
  const lastPid = name => pidIn(of(name, /CLI started/).at(-1))
  const killLog = () => { try { return fs.readFileSync(path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log'), 'utf8').split(/\r?\n/).filter(Boolean) } catch { return [] } }
  const record = pid => killLog().filter(l => l.includes(` pid=${pid} `))
  async function turn(name, token) {
    await rig.userMail(name, `${token}: report done.`)
    await rig.waitFor(() => (status(name)?.summary === `${token}-DONE` ? true : null), { what: `${name}'s done report`, timeout: 240000 }).catch(() => null)
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}' AND t.ended_at IS NULL`).length === 0,
      { what: `${name}'s turn to end`, timeout: 120000 }).catch(() => null)
    return lastPid(name)
  }
  async function ended(label, name, pid, act) {
    p.check(`${label}: its Codex runs before`, alive(pid), { pid })
    const t0 = Date.now()
    await act()
    const gone = await rig.waitFor(() => !alive(pid), { timeout: 20000, what: `${name}'s Codex to end` }).then(() => true, () => false)
    await rig.waitFor(() => record(pid).length > 0, { timeout: 10000, what: 'its kill record line' }).catch(() => null)
    const rec = record(pid)
    p.check(`${label}: its Codex ended, by a natural exit (codex-graceful-exit, no codex-force-kill)`, gone
      && rec.some(l => l.includes('codex-graceful-exit')) && !rec.some(l => l.includes('codex-force-kill')),
      { pid, gone, ms: Date.now() - t0, record: rec, exit: of(name, /CLI exit observation/).slice(-2) })
  }

  rig.refresh()
  try {
    const home = path.join(rig.data, 'profiles', 'langserver-codex')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
    const s = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'codex-cli',
      label: 'Fake (Codex)', models: [{ id: MODEL, context: 65536 }] })
    const tier = Object.values(s.server?.models ?? {})[0]?.tier
    await seed(rig, { org: { name: 'Codex Graceful Org' }, agents: ['ghalt', 'gclose', 'gretire', 'gbusy'].map(name =>
      ({ name, tier, grant: 1, charter: 'You prove Codex ends gracefully.', tools: { edit: true, bash: true } })) })

    const h = await turn('ghalt', 'PROOF-G-HALT')
    await ended('1 halt', 'ghalt', h, () => rig.op({ op: 'halt', nodes: ['ghalt'] }))

    const c = await turn('gclose', 'PROOF-G-CLOSE')
    await ended('2 retool (idle process replaced)', 'gclose', c, () => rig.op({ op: 'retool', node: 'gclose', tools: { bash: false } }))

    const r = await turn('gretire', 'PROOF-G-RETIRE')
    await ended('3 retire', 'gretire', r, () => rig.op({ op: 'retire', node: 'gretire' }))

    // ---- 5. mid-turn: the model has not answered; then a shell command runs
    const inTurn = name => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}' AND t.ended_at IS NULL`).length > 0
    const b = await turn('gbusy', 'PROOF-G-BUSY')
    await rig.userMail('gbusy', 'PROOF-G-WAIT: wait for the model.')
    await rig.waitFor(() => llm.requests.some(r => (r.last_user ?? '').includes('PROOF-G-WAIT')) || null, { what: 'the outstanding model request', timeout: 60000 }).catch(() => null)
    p.check('5 gbusy is mid-turn, its model request outstanding', inTurn('gbusy'))
    await ended('5 halt mid-turn (model request outstanding)', 'gbusy', b, () => rig.op({ op: 'halt', nodes: ['gbusy'] }))
    await rig.op({ op: 'unhalt', nodes: ['gbusy'] })
    await rig.userMail('gbusy', 'PROOF-G-SLEEP: run the command.')
    await rig.waitFor(() => (lastPid('gbusy') !== b && of('gbusy', /CLI started/).length >= 2) || null, { what: 'gbusy relaunched', timeout: 120000 }).catch(() => null)
    // the shell Codex started for the command (this probe's own line excluded)
    const sleeper = () => Number(ps("(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*Start-Sl' + 'eep -Seconds 60*') } | Select-Object -First 1).ProcessId") || 0)
    const shell = await rig.waitFor(() => sleeper() || null, { what: 'the shell command running', timeout: 120000 }).catch(() => 0)
    const b2 = lastPid('gbusy')
    p.check('5 gbusy runs a shell command mid-turn', inTurn('gbusy') && shell > 0, { shell })
    await ended('5 halt mid-turn (shell command running)', 'gbusy', b2, () => rig.op({ op: 'halt', nodes: ['gbusy'] }))
    const left = await rig.waitFor(() => !alive(shell) || null, { timeout: 10000, what: 'the shell command to end' }).then(() => false, () => true)
    p.check('5 the command it was running ended with it (no orphan)', !left, { shell })

    const all = killLog()
    p.check('4 the durable record has no codex-force-kill line at all', all.length >= 5 && !all.some(l => l.includes('codex-force-kill')), all)
    p.check('4 its lines carry UTC ms, pid, who, reason, waited_ms', all.every(l => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z engine_pid=\d+ codex-(graceful-exit|force-kill) pid=\d+ .*who=".+" reason=".+" .*waited_ms=\d+/.test(l)), all)
    p.check('4 the engine log mirrors them', lines(/codex-graceful-exit/).filter(l => !l.includes('engine_pid=')).length >= 3, lines(/codex-graceful-exit|codex-force-kill/).slice(-6))
  } finally {
    p.keep(rig, { grep: /CLI started|CLI exit|codex-graceful-exit|codex-force-kill|codex stderr/ })
    await llm.close()
  }
  return p.summary()
}
