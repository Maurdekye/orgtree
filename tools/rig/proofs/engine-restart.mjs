// Proof: the engine is killed mid-turn (as an install or a crash does: no
// graceful stop, its job takes PostgreSQL and every CLI with it) and started
// again on the same data, with the engine's restart path on (`recover`).
//   ria (Claude) and rex (Codex) are mid-turn: their turns are closed as
//     stopped by the engine, their mail stays delivered (not re-sent), and a
//     waking restart message resumes them on their own session and thread.
//   carl's CLI had died just before: his connection-freeze retry is re-armed
//     after the restart and still runs.
//   The others get the passive restart notice, which starts no turn.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/engine-restart.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('engine-restart')
  const long = { name: 'long', match: 'PROOF-LONG', once: true, steps: [{ text: 'Working on the long job.' }, { sleep_ms: 120000 }] }
  const resumed = { name: 'resumed', match: 'engine restarted', steps: [{ text: 'Back after the restart.' }] }
  rig.scenario({
    agents: {
      ria: { turns: [resumed, long] },
      rex: { turns: [resumed, long] },
      carl: { turns: [
        { name: 'retry', match: 'being retried', steps: [{ text: 'Recovered, continuing.' }] },
        { name: 'die', match: 'PROOF-EXIT', once: true, steps: [{ text: 'Starting.' }, { exit: 1 }] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'ria', parent: 'boss', tier: 'haiku', title: 'Restart agent' })
  await rig.op({ op: 'hire', name: 'rex', parent: 'boss', tier: 'luna', title: 'Restart agent' })
  await rig.op({ op: 'hire', name: 'carl', parent: 'boss', tier: 'haiku', title: 'Restart agent' })
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const seat = name => rig.one(`SELECT a.id, a.frozen, a.session_id, a.inflight_at FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${rig.org}' AND o.state = 'active' AND a.name = '${name}'`)

  // carl: a connection freeze that will still be running at the crash
  await rig.userMail('carl', 'PROOF-EXIT: please start the work.')
  const cf = await rig.waitFor(() => seat('carl')?.frozen, { what: 'carl to be frozen', timeout: 30000 })
  // ria and rex: mid-turn at the crash
  await rig.userMail('ria', 'PROOF-LONG: the long job, please.')
  await rig.userMail('rex', 'PROOF-LONG: the long job, please.')
  await rig.waitFor(() => ['ria', 'rex'].every(a => log(a, 'step').some(l => l.step?.sleep_ms)), { what: 'ria and rex to be mid-turn' })
  const riaSession = seat('ria').session_id
  const rexThread = log('rex', 'thread')[0]?.thread
  const aliceTurns = rig.turns('alice').length

  await rig.crash()
  p.note('crashed', { at: new Date().toISOString(), carl_until: cf.until })
  await rig.restart()

  // ---------------------------------------------------------------- the turns the crash cut
  for (const a of ['ria', 'rex']) {
    const first = rig.turns(a)[0]
    p.check(`${a}: the cut turn is closed as stopped by the engine`, first?.killed && /engine stopped during this turn/.test(first.error ?? ''), first)
  }
  const turns = await rig.waitFor(() => {
    const t = ['ria', 'rex'].map(a => rig.turns(a))
    return t.every(x => x.length >= 2 && x.every(r => r.ended_at)) ? t : null
  }, { what: 'ria and rex to run their restart turns', timeout: 60000 })
  for (const [i, a] of ['ria', 'rex'].entries()) {
    const prompt = log(a, 'turn').at(-1)?.prompt ?? ''
    p.check(`${a}: woken by the restart message, and the turn completes`, /The engine restarted while you were working/.test(prompt)
      && !turns[i][1].error, { error: turns[i][1].error, prompt: prompt.slice(-300) })
    const mail = rig.one(`SELECT state FROM ot.mail WHERE recipient_agent_id = ${seat(a).id} AND body LIKE 'PROOF-LONG%'`)
    p.check(`${a}: the mail the cut turn held stays delivered and is not sent again`, mail?.state === 'delivered' && !/PROOF-LONG/.test(prompt), mail)
  }
  const riaStart = log('ria', 'start').at(-1)
  p.check('ria: her new CLI resumed her session', riaStart?.resumed && riaStart.session === riaSession, { resumed: riaStart?.resumed, session: riaStart?.session, was: riaSession })
  const rexThreads = log('rex', 'thread')
  p.check('rex: his new app-server resumed his thread', rexThreads.at(-1)?.action === 'resume' && rexThreads.at(-1).thread === rexThread,
    rexThreads.map(l => [l.action, l.thread]))

  // ---------------------------------------------------------------- carl's freeze survives
  const ct = await rig.waitFor(() => { const t = rig.turns('carl'); return t.length >= 2 && t.every(r => r.ended_at) ? t : null },
    { what: 'carl\'s retry after the restart', timeout: 90000, every: 1000 })
  const late = (Date.parse(ct[1].started_at) - Date.parse(cf.until)) / 1000
  p.check('carl: his connection-freeze retry was re-armed after the restart and ran on time', !ct[1].error && late >= -1 && late < 15
    && /being retried/.test(log('carl', 'turn').find(l => l.script === 'retry')?.prompt ?? ''), { late_s: late, error: ct[1].error })

  // ---------------------------------------------------------------- everybody else
  await new Promise(r => setTimeout(r, 3000))
  const notice = rig.one(`SELECT count(*)::int AS n FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.name = 'alice' AND m.body LIKE '[ORGTREE RESTART NOTICE]%' AND m.notice`)
  p.check('alice: gets the passive restart notice, which starts no turn', notice?.n >= 1 && rig.turns('alice').length === aliceTurns,
    { notices: notice?.n, turns: rig.turns('alice').length, before: aliceTurns })
  p.keep(rig, { agents: ['ria', 'rex', 'carl'], grep: /recover|restart|freeze|resum/ })
  return p.summary()
}
