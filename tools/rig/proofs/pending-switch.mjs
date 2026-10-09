// Proof: a queued switch on an idle agent applies at once, and a refused
// admission never spins (decision 62). Live 2026-10-09: an agent retired in
// the middle of an Antigravity turn, rehired and switched agy-opus -> opus
// kept that cut turn on record, so the switch queued behind it and the
// agent's actor looped every ~2 ms without ever starting a turn.
//   mira (agy-opus): retired in the middle of a long turn. The retire
//   settles that turn (closed as killed, its claimed mail settled), so after
//   a rehire her switch to haiku applies at once and her next turn runs on
//   the Claude lane.
//   nell (haiku): a turn on record that no running turn owns (what a lost
//   actor leaves) holds her switch back; being idle she closes it herself
//   (the mail it claimed goes back to her mailbox), the switch applies at
//   once and her next turn runs on sonnet with that mail.
//   otto (haiku): the same record held open by a database fault the engine
//   cannot repair: admission is refused and retried on a backoff (a handful
//   of tries in 10 s, not thousands); once the fault is gone the switch
//   applies and his turn runs.
//   pia, quin (haiku): a switch queued in a turn survives a retire in the
//   middle of it. A rehire that names a tier cancels it (pia, rehired on
//   opus, stays on opus); one that names none applies it at once (quin).
// A BEFORE engine spins on each of them: the loop is cut short (the agent is
// halted) once it shows, so the log stays small.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/pending-switch.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('pending-switch')
  rig.scenario({
    agents: Object.fromEntries(['mira', 'pia', 'quin', 'rex'].map(n =>
      [n, { turns: [{ name: 'long', match: 'PROOF-LONG', once: true, steps: [{ text: 'Working on it.' }, { sleep_ms: 60000 }, { text: 'NEVER-SAID' }] }] }])),
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  // the live agent ran Claude Opus through Antigravity (App settings > Runtime)
  await rig.api('PUT', '/api/app-settings/runtime', { antigravity_claude_enabled: true })
  for (const [name, tier] of [['mira', 'agy-opus'], ['nell', 'haiku'], ['otto', 'haiku'], ['pia', 'haiku'], ['quin', 'haiku']]) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'switch proof' })
  }
  const ids = Object.fromEntries(['mira', 'nell', 'otto', 'pia', 'quin'].map(n => [n, rig.agentRow(n)?.id]))
  const seat = name => rig.one(`SELECT tier, pending_switch, inflight_at FROM ot.agents WHERE id = ${ids[name]}`)
  const turnRows = name => rig.sql(`SELECT id, model, ended_at, killed, error, sent_at FROM ot.turns WHERE agent_id = ${ids[name]} ORDER BY id`)
  const finished = name => turnRows(name).filter(t => t.ended_at).length
  const idle = name => !turnRows(name).some(t => !t.ended_at)
  const lastStart = name => rig.fakeLog(name).filter(l => l.kind === 'start').at(-1)
  const turn = async (name, text) => {
    const done = finished(name)
    await rig.userMail(name, text)
    await rig.waitTurns(name, done + 1)
  }
  // refused admissions, from the engine's call log: start_turn returning Ok(false)
  const refusals = name => {
    const tag = `agent:${ids[name]}/`
    let n = 0
    for (const line of rig.engineLog().split('\n')) {
      if (line.includes(tag) && line.includes('runtime.actor.Actor.start_turn(...)') && line.includes('-> Ok(false)')) n++
    }
    return n
  }
  // wait up to `ms` for `done()`; a refused-admission loop (a BEFORE engine)
  // is cut short by halting the agent once it shows
  const watch = async (name, done, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (done()) return { ok: true, refusals: refusals(name) }
      await pause(1000)
      const r = refusals(name)
      if (r > 200) {
        await rig.op({ op: 'halt', nodes: [name] }).catch(() => {})
        return { ok: false, refusals: r, halted: 'a refused-admission loop' }
      }
    }
    return { ok: !!done(), refusals: refusals(name) }
  }

  // ---------------------------------------------------------------- mira
  await rig.userMail('mira', 'PROOF-LONG: the long job, please.')
  await rig.waitFor(() => rig.fakeLog('mira').some(l => l.kind === 'step' && l.step?.sleep_ms), { what: 'mira to be mid-turn', timeout: 60000 })
  const cut = turnRows('mira').at(-1)
  const claimed = rig.sql(`SELECT id, state FROM ot.mail WHERE turn_id = ${cut.id} ORDER BY id`)
  await rig.op({ op: 'retire', node: 'mira' })
  const closedCut = turnRows('mira').find(t => t.id === cut.id)
  const mailAfter = claimed.length ? rig.sql(`SELECT id, state FROM ot.mail WHERE id IN (${claimed.map(m => m.id).join(',')}) ORDER BY id`) : []
  p.check('mira: retired mid-turn, her cut turn is closed as killed and none of its mail stays claimed',
    !!closedCut?.ended_at && closedCut.killed === true && claimed.length > 0 && mailAfter.every(m => m.state !== 'delivering'),
    { turn: closedCut, claimed, after: mailAfter, inflight: seat('mira').inflight_at })

  await rig.op({ op: 'rehire', node: 'mira' })
  await rig.waitFor(() => idle('mira'), { what: 'mira to be idle after the rehire', timeout: 30000 }).catch(() => null)
  const miraSwitch = await rig.op({ op: 'switch_model', node: 'mira', tier: 'haiku' })
  const miraNow = await rig.waitFor(() => { const s = seat('mira'); return s.tier === 'haiku' && !s.pending_switch ? s : null },
    { what: 'mira\'s switch to apply', timeout: 5000 }).catch(() => seat('mira'))
  p.check('mira: rehired and idle, her switch to haiku applies at once (not queued behind a turn on record)',
    miraSwitch?.queued !== true && miraNow.tier === 'haiku' && !miraNow.pending_switch, { result: miraSwitch, seat: miraNow })

  const miraDone = finished('mira')
  await rig.userMail('mira', 'Hello mira, after the switch.')
  const miraRun = await watch('mira', () => finished('mira') > miraDone && idle('mira'), 20000)
  const miraTurn = turnRows('mira').at(-1), miraStart = lastStart('mira')
  p.check('mira: her next turn runs on the Claude lane (haiku), with no refused admission',
    miraRun.ok && miraStart?.mode !== 'agy' && /haiku/i.test(miraTurn?.model ?? '') && miraRun.refusals === 0,
    { run: miraRun, model: miraTurn?.model, lane: miraStart?.mode ?? 'claude' })

  // ---------------------------------------------------------------- nell
  await turn('nell', 'Hello nell, first turn.')
  // a turn on record that no running turn owns, holding a mail it claimed:
  // what an actor lost mid-turn leaves behind
  await rig.userMail('nell', 'STRANDED-NOTE: the mail a lost turn claimed.', { notice: true })
  const strandedId = rig.one(`SELECT max(id) AS id FROM ot.mail WHERE recipient_agent_id = ${ids.nell} AND state = 'pending'`)?.id
  rig.exec(`WITH t AS (INSERT INTO ot.turns (agent_id, started_at, sent_at) VALUES (${ids.nell}, now() - interval '5 minutes', now() - interval '5 minutes') RETURNING id)
            UPDATE ot.mail SET state = 'delivering', turn_id = (SELECT id FROM t) WHERE id = ${strandedId};
            UPDATE ot.agents SET inflight_at = now() - interval '5 minutes' WHERE id = ${ids.nell};`)
  const stale = turnRows('nell').at(-1)
  const nellSwitch = await rig.op({ op: 'switch_model', node: 'nell', tier: 'sonnet' })
  p.check('nell: with that record standing, the switch is queued (the seat reads as busy)', nellSwitch?.queued === true, nellSwitch)
  const nellNow = await rig.waitFor(() => { const s = seat('nell'); return s.tier === 'sonnet' && !s.pending_switch ? s : null },
    { what: 'nell\'s switch to apply', timeout: 5000 }).catch(() => seat('nell'))
  const staleAfter = turnRows('nell').find(t => t.id === stale.id)
  const strandedAfter = rig.one(`SELECT state, turn_id FROM ot.mail WHERE id = ${strandedId}`)
  p.check('nell: idle, she closes the record herself (killed, its mail back in her mailbox, not in flight) and the switch applies at once, with no mail to wake her',
    nellNow.tier === 'sonnet' && !nellNow.pending_switch && !nellNow.inflight_at && !!staleAfter?.ended_at && staleAfter.killed === true
      && strandedAfter?.state === 'pending',
    { seat: nellNow, record: staleAfter, mail: strandedAfter })
  const nellDone = finished('nell')
  await rig.userMail('nell', 'Hello nell, after the switch.')
  const nellRun = await watch('nell', () => finished('nell') > nellDone && idle('nell'), 20000)
  const nellTurn = turnRows('nell').at(-1)
  const nellPrompt = rig.fakeLog('nell').filter(l => l.kind === 'turn').at(-1)
  p.check('nell: her next turn runs on sonnet and carries the mail the lost turn had claimed, with no refused admission',
    nellRun.ok && /sonnet/i.test(nellTurn?.model ?? '') && /STRANDED-NOTE/.test(JSON.stringify(nellPrompt ?? {})) && nellRun.refusals === 0,
    { run: nellRun, model: nellTurn?.model, prompt: JSON.stringify(nellPrompt ?? {}).slice(0, 200) })

  // ---------------------------------------------------------------- otto
  await turn('otto', 'Hello otto, first turn.')
  rig.exec(`INSERT INTO ot.turns (agent_id, started_at, sent_at) VALUES (${ids.otto}, now(), now())`)
  const stuck = turnRows('otto').at(-1)
  // the fault: the database keeps that record open whatever the engine writes
  rig.exec(`CREATE OR REPLACE FUNCTION rig_keep_open() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;
            CREATE TRIGGER rig_keep_open BEFORE UPDATE ON ot.turns FOR EACH ROW WHEN (OLD.id = ${stuck.id}) EXECUTE FUNCTION rig_keep_open();`)
  const ottoSwitch = await rig.op({ op: 'switch_model', node: 'otto', tier: 'sonnet' })
  // his real turns come after that record (closing it is not a turn)
  const ottoTurns = () => turnRows('otto').filter(t => t.id > stuck.id)
  await rig.userMail('otto', 'Hello otto, are you there?')
  const held = await watch('otto', () => false, 10000)
  const ottoHeld = seat('otto')
  p.check('otto: while the record cannot be closed, admission is refused and retried on a backoff: a handful of tries in 10 s, not a loop',
    ottoSwitch?.queued === true && !held.halted && held.refusals >= 3 && held.refusals <= 8 && ottoHeld.tier === 'haiku',
    { switch: ottoSwitch, held, seat: ottoHeld })
  rig.exec('DROP TRIGGER rig_keep_open ON ot.turns; DROP FUNCTION rig_keep_open();')
  const freed = Date.now()
  const ottoRun = held.halted ? { ok: false, skipped: 'halted (a BEFORE engine)' }
    : await watch('otto', () => ottoTurns().some(t => t.ended_at) && idle('otto'), 70000)
  const ottoTurn = ottoTurns().at(-1)
  p.check('otto: once the fault is gone, a later retry closes the record, the switch applies and his turn runs on sonnet',
    ottoRun.ok && seat('otto').tier === 'sonnet' && /sonnet/i.test(ottoTurn?.model ?? '') && !!turnRows('otto').find(t => t.id === stuck.id)?.ended_at,
    { run: ottoRun, secondsAfterFix: Math.round((Date.now() - freed) / 1000), model: ottoTurn?.model, seat: seat('otto') })

  // ---------------------------------------------------------------- pia, quin
  // a switch queued during a turn is still queued when the agent is retired
  // in the middle of it; a rehire that names a tier cancels it (that tier is
  // the newer choice), one that does not applies it at once
  const queuedThenRetired = async name => {
    await rig.userMail(name, 'PROOF-LONG: the long job, please.')
    await rig.waitFor(() => rig.fakeLog(name).some(l => l.kind === 'step' && l.step?.sleep_ms), { what: `${name} to be mid-turn`, timeout: 60000 })
    const queued = await rig.op({ op: 'switch_model', node: name, tier: 'sonnet' })
    await rig.op({ op: 'retire', node: name })
    return { queued: queued?.queued === true, archived: seat(name).pending_switch?.tier ?? null }
  }
  const events = name => rig.sql(`SELECT op, detail FROM ot.events WHERE subject_agent_id = ${ids[name]} ORDER BY id`)
  const piaBefore = await queuedThenRetired('pia')
  await rig.op({ op: 'rehire', node: 'pia', tier: 'opus' })
  await pause(3000)
  const piaNow = seat('pia'), piaCancel = events('pia').filter(e => e.op === 'switch_cancelled').at(-1)
  p.check('pia: a switch queued in her turn survives her retire; a rehire that names opus cancels it (recorded), and she stays on opus',
    piaBefore.queued && piaBefore.archived === 'sonnet' && piaNow.tier === 'opus' && !piaNow.pending_switch && piaCancel?.detail?.target === 'sonnet',
    { before: piaBefore, seat: piaNow, cancelled: piaCancel })
  const piaDone = finished('pia')
  await rig.userMail('pia', 'Hello pia, after the rehire.')
  const piaRun = await watch('pia', () => finished('pia') > piaDone && idle('pia'), 20000)
  p.check('pia: her next turn runs on opus', piaRun.ok && /opus/i.test(turnRows('pia').at(-1)?.model ?? ''), { run: piaRun, model: turnRows('pia').at(-1)?.model })

  const quinBefore = await queuedThenRetired('quin')
  await rig.op({ op: 'rehire', node: 'quin' })
  const quinNow = await rig.waitFor(() => { const s = seat('quin'); return s.tier === 'sonnet' && !s.pending_switch ? s : null },
    { what: 'quin\'s queued switch to apply', timeout: 5000 }).catch(() => seat('quin'))
  p.check('quin: a rehire that names no tier keeps the queued switch, and it applies at once (sonnet)',
    quinBefore.queued && quinBefore.archived === 'sonnet' && quinNow.tier === 'sonnet' && !quinNow.pending_switch, { before: quinBefore, seat: quinNow })

  // ---------------------------------------------------------------- rex
  // the same for an account: two signed-in Codex accounts; an account change
  // queued in his turn survives his retire, and a rehire that names an
  // account cancels it (recorded)
  const addAccount = async n => {
    const home = path.join(rig.data, 'rig-home', `codex-${n}`)
    fs.mkdirSync(home, { recursive: true })
    const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url')
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: `${enc({ alg: 'none' })}.${enc({ email: `${n}@example.invalid` })}.rig` } }))
    return (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported', path: home })).id
  }
  const first = await addAccount('first'), second = await addAccount('second')
  await rig.op({ op: 'hire', name: 'rex', parent: 'boss', tier: 'luna', title: 'switch proof' })
  ids.rex = rig.agentRow('rex')?.id
  await rig.op({ op: 'account', node: 'rex', account: first })
  await rig.userMail('rex', 'PROOF-LONG: the long job, please.')
  await rig.waitFor(() => rig.fakeLog('rex').some(l => l.kind === 'step' && l.step?.sleep_ms), { what: 'rex to be mid-turn', timeout: 60000 })
  const rexQueued = await rig.op({ op: 'account', node: 'rex', account: second })
  await rig.op({ op: 'retire', node: 'rex' })
  const rexArchived = rig.one(`SELECT account, pending_account FROM ot.agents WHERE id = ${ids.rex}`)
  await rig.op({ op: 'rehire', node: 'rex', account: first })
  await pause(3000)
  const rexNow = rig.one(`SELECT account, pending_account FROM ot.agents WHERE id = ${ids.rex}`)
  const rexCancel = events('rex').filter(e => e.op === 'account_queue_cancelled').at(-1)
  p.check('rex: an account change queued in his turn survives his retire; a rehire that names his account cancels it (recorded), and he keeps that account',
    rexQueued?.queued === true && rexArchived?.pending_account?.account === second && rexNow?.account === first && !rexNow?.pending_account
      && rexCancel?.detail?.account === second,
    { queued: rexQueued, archived: rexArchived, now: rexNow, cancelled: rexCancel })

  p.note('refused admissions per agent', { mira: refusals('mira'), nell: refusals('nell'), otto: refusals('otto') })
  // the engine's own account of the repairs and retries
  p.keep(rig, { agents: ['mira', 'nell', 'otto', 'pia', 'quin', 'rex'], grep: /no running turn own|admission keeps being refused|cut turn|queued configuration/ })
  return p.summary()
}
