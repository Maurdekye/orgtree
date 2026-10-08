// Proof: watchdogs, as an agent keeps them (orgtree_watchdog), in a run with
// the engine's restart path on (dogs re-armed at start, their mail wakes).
//   file:     new lines in a file in the owner's folder; only matching ones fire
//   command:  a ONE-SHOT command dog fires once and removes itself
//   process:  pid:N fires when that process goes down
//   stream:   a persistent command's matching lines fire; removing the dog
//             ends its process (no stray process left)
//   activity: a report's turn_done fires
//   the owner is woken by the mail; an agent keeps at most 8 dogs; a file dog
//   survives an engine restart and fires again.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/watchdogs.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { processes } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

const PING = '127.0.0.42'
const pings = () => processes(`$_.CommandLine -like '*${PING}*' -and $_.Name -eq 'PING.EXE'`)

export default async function (rig) {
  const p = new Proof('watchdogs')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'wes', parent: 'boss', tier: 'haiku', title: 'Watchdog owner' })
  await rig.op({ op: 'hire', name: 'kid', parent: 'wes', tier: 'haiku', title: 'Watched report' })
  const wes = rig.agentRow('wes').id
  const scratch = path.join(rig.data, 'scratch', rig.org, 'wes')
  fs.mkdirSync(scratch, { recursive: true })
  const logFile = path.join(scratch, 'watch.log')
  fs.writeFileSync(logFile, 'start\n')
  const dog = args => rig.tool('wes', 'orgtree_watchdog', args)
  const fires = name => rig.sql(`SELECT body, notice, created_at FROM ot.mail WHERE recipient_agent_id = ${wes} AND kind = 'watchdog'
    AND sender = '${name}' ORDER BY id`)
  const dogRow = name => rig.one(`SELECT uid, state, kind FROM ot.watchdogs WHERE owner_agent_id = ${wes} AND name = '${name}' ORDER BY id DESC LIMIT 1`)
  const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
  try {
    // ------------------------------------------------------------ create
    const made = {
      file: await dog({ action: 'create', name: 'log-dog', kind: 'file', target: 'watch.log', pattern: 'ALERT', interval_s: 15 }),
      command: await dog({ action: 'create', name: 'cmd-once', kind: 'command', target: 'echo READY', pattern: 'READY', interval_s: 15, once: true }),
      process: await dog({ action: 'create', name: 'pid-dog', kind: 'process', target: `pid:${dummy.pid}`, interval_s: 15 }),
      stream: await dog({ action: 'create', name: 'ping-dog', kind: 'stream', target: `ping -t ${PING}`, pattern: 'TTL=', interval_s: 5 }),
      activity: await dog({ action: 'create', name: 'kid-dog', kind: 'activity', target: 'kid', pattern: 'turn_done' }),
    }
    p.check('five dogs created by the agent (file, command, process, stream, activity)', Object.values(made).every(r => r.ok),
      Object.fromEntries(Object.entries(made).map(([k, r]) => [k, r.ok ? 'ok' : String(r.text).slice(0, 160)])))
    const turnsBefore = rig.turns('wes').length

    // ------------------------------------------------------------ triggers
    fs.appendFileSync(logFile, 'hello, nothing to see\nALERT: disk full\n')
    dummy.kill()
    await rig.userMail('kid', 'Please say OK.')

    const fired = await rig.waitFor(() => {
      const f = Object.fromEntries(['log-dog', 'cmd-once', 'pid-dog', 'ping-dog', 'kid-dog'].map(n => [n, fires(n)]))
      return Object.values(f).every(x => x.length) ? f : null
    }, { what: 'every dog to fire', timeout: 90000, every: 1000 }).catch(() =>
      Object.fromEntries(['log-dog', 'cmd-once', 'pid-dog', 'ping-dog', 'kid-dog'].map(n => [n, fires(n)])))
    const body = n => (fired[n] ?? []).map(m => m.body).join('\n')
    p.check('file: the matching line fires, the other does not', /ALERT: disk full/.test(body('log-dog')) && !/nothing to see/.test(body('log-dog')),
      body('log-dog').slice(0, 300))
    p.check('command (ONE-SHOT): fired once and removed itself', (fired['cmd-once'] ?? []).length === 1 && /READY/.test(body('cmd-once'))
      && !['armed', 'paused'].includes(dogRow('cmd-once')?.state), { fires: (fired['cmd-once'] ?? []).length, state: dogRow('cmd-once')?.state })
    p.check('process: pid:N fires when the process goes down', (fired['pid-dog'] ?? []).length >= 1, body('pid-dog').slice(0, 200))
    p.check('stream: a matching line of the running command fires', /TTL=/.test(body('ping-dog')), body('ping-dog').slice(0, 200))
    p.check('activity: the report\'s turn_done fires', /turn_done/.test(body('kid-dog')), body('kid-dog').slice(0, 200))
    p.check('the dog mail wakes its owner (not a notice; a turn runs)', Object.values(fired).flat().some(m => !m.notice)
      && await rig.waitFor(() => rig.turns('wes').length > turnsBefore, { what: 'wes to run', timeout: 30000 }).then(() => true, () => false))

    // ------------------------------------------------------------ remove ends the stream's process
    p.check('stream: its command runs while the dog is armed', pings().length >= 1, pings().length)
    const rm = await dog({ action: 'remove', id: dogRow('ping-dog')?.uid, reason: 'proof' })
    const gone = await rig.waitFor(() => pings().length === 0, { what: 'the ping to end', timeout: 15000 }).then(() => true, () => false)
    p.check('stream: removing the dog ends its process', rm.ok && gone, { removed: rm.ok ? 'ok' : rm.text, left: pings().map(x => x.ProcessId) })

    // ------------------------------------------------------------ the cap
    const kept = rig.one(`SELECT count(*)::int AS n FROM ot.watchdogs WHERE owner_agent_id = ${wes} AND state IN ('armed', 'paused', 'exited')`).n
    const extra = []
    for (let i = 0; i < 8 - kept; i++) extra.push(await dog({ action: 'create', name: `cap-${i}`, kind: 'file', target: `cap-${i}.log`, interval_s: 600 }))
    const ninth = await dog({ action: 'create', name: 'cap-over', kind: 'file', target: 'cap-over.log', interval_s: 600 })
    p.check('an agent keeps at most 8 dogs: the ninth is refused', extra.every(r => r.ok) && !ninth.ok && /8 watchdogs/.test(ninth.text ?? ''),
      { kept, made: extra.length, ninth: String(ninth.text).slice(0, 160) })

    // ------------------------------------------------------------ a restart
    const before = fires('log-dog').length
    await rig.restart()
    fs.appendFileSync(logFile, 'ALERT: after the restart\n')
    const again = await rig.waitFor(() => fires('log-dog').length > before ? fires('log-dog') : null, { what: 'log-dog after the restart', timeout: 60000 })
      .catch(() => fires('log-dog'))
    p.check('file: the dog survived an engine restart and fires again', again.length > before && /after the restart/.test(again.at(-1)?.body ?? ''),
      { fires: again.length, before })
  } finally {
    try { dummy.kill() } catch {}
  }
  p.check('no stray dog process is left', pings().length === 0, pings().map(x => x.ProcessId))
  p.keep(rig, { agents: ['wes', 'kid'], grep: /watchdog/i })
  return p.summary()
}
