// Proof: an automatic wake is idle-only, as 3.x sent it (supervisor.py
//   send_message(idle_only=True) and _auto_wake_cancel), on a run whose
//   reminder sweep runs every 5 s and pauses 6 s between a wake's
//   reservation and its mail (`reminderPauseMs`).
//   rex: his reminder is reserved (the stamp is written), then he starts real
//   work in the pause (a 12 s turn). The reminder loses the idle race: its
//   mail is withdrawn, it never reaches him, he runs no second turn behind
//   the real one, and the stamp keeps him from being reminded again at once.
//   sam: at the turn cap (max_concurrent_turns 1, hog's turn holding the
//   slot) an idle agent's reminder is accepted, not withdrawn: it waits for a
//   slot and is read once hog's turn ends.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/reminder-race.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { reminders: true, reminderPauseMs: 6000 }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const MARK = '[AUTOMATIC IDLE DOCKET REMINDER]'

export default async function (rig) {
  const p = new Proof('reminder-race')
  rig.scenario({
    agents: {
      rex: { turns: [{ name: 'busy', match: 'PROOF-BUSY', once: true, steps: [{ sleep_ms: 12000 }, { text: 'Real work done.' }] }] },
      hog: { turns: [{ name: 'hog', match: 'PROOF-HOG', once: true, steps: [{ hang: true }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const runtime = body => rig.api('PUT', '/api/app-settings/runtime', body)
  await runtime({ working_checkups_enabled: false, idle_docket_reminders_enabled: false, blocked_docket_reminders_enabled: false })
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  const busy = () => rig.sql(`SELECT a.name, 'turn ' || t.id AS what FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.org_id = ${orgId} AND t.ended_at IS NULL
      UNION ALL SELECT a.name, 'mail ' || m.id FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.org_id = ${orgId} AND m.state IN ('pending', 'delivering') AND NOT m.notice AND a.halt IS NULL AND a.state = 'live'`)
  const settle = async (what, timeout = 120000) => {
    try { await rig.waitFor(() => busy().length === 0, { what, timeout }) } catch (e) {
      throw new Error(`${e.message}; still busy: ${JSON.stringify(busy()).slice(0, 600)}`)
    }
  }
  await settle('seed turns to settle')
  for (const name of ['rex', 'sam', 'hog']) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Race agent' })
  const slug = {}
  for (const name of ['rex', 'sam']) {
    const title = `${name} has work`
    await rig.tool('boss', 'orgtree_work', { action: 'create', title, kind: 'code', owner: name,
      objective: `${title}: an item for the reminder race proof.\n\nNothing depends on it.` })
    slug[name] = rig.one(`SELECT slug FROM ot.work_items WHERE org_id = ${orgId} AND title = '${title}'`).slug
    await rig.tool(name, 'orgtree_work', { action: 'update', slug: slug[name], status: 'in_progress', done_so_far: ['set up'], working_on_next: ['wait'] })
  }
  await settle('the arranging turns to settle')
  const id = name => rig.agentRow(name).id
  const ago = `to_char((now() - interval '25 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
  // these agents' activity 25 minutes old; every other agent's stamps fresh, so only they are due
  const backdate = names => rig.exec(`
    UPDATE ot.agents SET extra = extra || jsonb_build_object('working_activity_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                             'docket_reminder_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     WHERE org_id = ${orgId};
    UPDATE ot.turns SET started_at = started_at - interval '25 minutes', ended_at = ended_at - interval '25 minutes'
     WHERE agent_id IN (${names.map(id).join(', ')});
    UPDATE ot.agents SET last_status = jsonb_set(last_status, '{at}', to_jsonb(${ago}))
     WHERE id IN (${names.map(id).join(', ')}) AND jsonb_typeof(last_status) = 'object' AND last_status ? 'at';
    UPDATE ot.agents SET extra = extra || jsonb_build_object('working_activity_at', ${ago}, 'docket_reminder_at', ${ago})
     WHERE id IN (${names.map(id).join(', ')});`)
  const stamped = name => rig.one(`SELECT (extra->>'docket_reminder_at')::timestamptz > now() - interval '1 minute' AS fresh,
      extra->>'docket_reminder_at' AS at FROM ot.agents WHERE id = ${id(name)}`)
  const reminderMail = (name, since) => rig.sql(`SELECT id, state FROM ot.mail WHERE recipient_agent_id = ${id(name)}
      AND id > ${since} AND ev->>'variant' = 'reminder.idle_docket' ORDER BY id`)
  const lastMail = () => rig.one(`SELECT coalesce(max(id), 0)::bigint AS n FROM ot.mail`).n
  const turnsSince = (name, at) => rig.sql(`SELECT id, started_at, ended_at FROM ot.turns WHERE agent_id = ${id(name)}
      AND started_at >= '${at}'::timestamptz ORDER BY id`)
  const prompts = (name, since) => rig.fakeLog(name).filter(l => l.kind === 'turn' && l.ts >= since).map(l => String(l.prompt ?? ''))

  // ---------------------------------------------------------------- rex: the lost race
  backdate(['rex'])
  const since = lastMail()
  const t0 = new Date().toISOString()
  const dbNow = rig.one(`SELECT now()::text AS now_at`).now_at
  await runtime({ idle_docket_reminders_enabled: true })
  await rig.waitFor(() => stamped('rex')?.fresh, { what: 'rex\'s reminder to be reserved', timeout: 30000, every: 150 })
  const reservedAt = stamped('rex').at
  await rig.userMail('rex', 'PROOF-BUSY: real work, please.')
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id = ${id('rex')} AND ended_at IS NULL`).length > 0,
    { what: 'rex\'s real turn to start', timeout: 20000, every: 150 })
  await sleep(8000)
  await settle('rex\'s turns to settle')
  const rexMail = reminderMail('rex', since)
  const rexTurns = turnsSince('rex', dbNow)
  const rexRead = prompts('rex', t0)
  p.note('rex', { reservedAt, mail: rexMail, turns: rexTurns.length, prompts: rexRead.map(t => t.slice(0, 120)) })
  p.check('a reminder that loses the idle race is withdrawn: no reminder mail is left for rex and none reached him',
    rexMail.length === 0 && !rexRead.some(t => t.includes(MARK)), { mail: rexMail, read: rexRead.filter(t => t.includes(MARK)).length })
  p.check('rex ran only his real turn, no second turn behind it', rexTurns.length === 1, rexTurns)
  const after = lastMail()
  await sleep(11000)
  p.check('the reservation\'s stamp stays and the next sweeps do not remind rex again',
    reminderMail('rex', after).length === 0 && stamped('rex')?.at === reservedAt, { at: stamped('rex')?.at, reservedAt })

  // ---------------------------------------------------------------- sam: accepted at the turn cap
  await runtime({ idle_docket_reminders_enabled: false })
  await runtime({ max_concurrent_turns: 1 })
  await rig.userMail('hog', 'PROOF-HOG: hold the only turn slot.')
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id = ${id('hog')} AND ended_at IS NULL`).length > 0,
    { what: 'hog\'s turn to hold the slot', timeout: 20000 })
  backdate(['sam'])
  const since2 = lastMail()
  const t1 = new Date().toISOString()
  await runtime({ idle_docket_reminders_enabled: true })
  await rig.waitFor(() => reminderMail('sam', since2).length > 0, { what: 'sam\'s reminder mail', timeout: 30000 })
  await sleep(4000)
  const waiting = reminderMail('sam', since2)
  const samTurnWhileHog = rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id = ${id('sam')} AND started_at >= '${t1}'::timestamptz`).length
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/hog/interrupt`)
  await rig.waitFor(() => prompts('sam', t1).some(t => t.includes(MARK)), { what: 'sam to read his reminder', timeout: 60000 })
  p.check('at the turn cap an idle agent\'s reminder is accepted, not withdrawn: it waits for the slot and is read once it frees',
    waiting.length === 1 && waiting[0].state === 'pending' && samTurnWhileHog === 0 && prompts('sam', t1).some(t => t.includes(MARK)),
    { waiting, samTurnWhileHog })
  await runtime({ max_concurrent_turns: 8 })

  p.keep(rig, { agents: ['rex', 'sam', 'hog'] })
  return p.save()
}
