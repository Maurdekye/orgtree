// Proof: the automatic wakes as 3.x ran them (supervisor.py
//   _auto_wake_keeper_pass: the docket reminder first, then the working
//   checkup; ledger.py _work_next_recipient, work_idle_reminder_items,
//   work_docket_reminder_items, waking_mail), on a run whose reminder sweep
//   runs every 5 s. The org is arranged with the switches off, every agent's
//   activity is back-dated 25 minutes in one transaction, then switches are
//   turned on.
//   Reminders: an idle owner hears about its actionable items only (blocked,
//   backlogged, flagged and questioned items are left out); a reviewer about
//   the item it reviews; an owner whose review has no reviewer, or a retired
//   one, is told to name one; a deploy_ready item is owed by the owner's
//   nearest live superior, and a top-level owner keeps it; a `working` agent
//   with actionable items gets the reminder that names them, not the generic
//   checkup; an unread notice holds no wake back; one wake per agent; nothing
//   for a halted agent, a working agent whose items are all blocked, or one
//   with no items. The item's next_action names the same agent and role.
//   Cooldown: nobody is woken again on the next sweeps. Blocked option: with
//   the whole org blocked, owners hear about their blocked items; with one
//   item actionable anywhere, only its owner hears. Checkup: with reminders
//   off, the working agent with actionable work gets the 20-minute check.
//   Both switches off: nothing.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/reminders.mjs

import { Proof } from '../proof.mjs'

// the reminder sweep runs (a safe start never runs it), every 5 s
export async function setup() {
  return { reminders: true }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// two sweeps and a margin
const SWEEPS_MS = 13000

const TITLES = {
  A1: 'Alice in progress', A2: 'Alice blocked', A3: 'Alice backlogged', A4: 'Alice flagged', A5: 'Alice questioned',
  B1: 'Bob in progress', R1: 'Alice in review by carol', R2: 'Boss in review unassigned', R3: 'Carol in review by dave',
  D1: 'Hank deploy ready', D2: 'Boss deploy ready', E1: 'Erin in progress', F1: 'Frank blocked',
}
const OWNER = {
  S: 'alice', A1: 'alice', A2: 'alice', A3: 'alice', A4: 'alice', A5: 'alice', B1: 'bob', R1: 'alice', R2: 'boss',
  R3: 'carol', D1: 'hank', D2: 'boss', E1: 'erin', F1: 'frank',
}
const BLOCKED = 'waits for the proof to end; nobody can act on it; the proof itself says when'

export default async function (rig) {
  const p = new Proof('reminders')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const switches = (checkups, idle, blocked = false) => rig.api('PUT', '/api/app-settings/runtime', {
    working_checkups_enabled: checkups, idle_docket_reminders_enabled: idle, blocked_docket_reminders_enabled: blocked })
  await switches(false, false)
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  // quiet: no turn running and no waking mail waiting for a live, unhalted agent
  // (a notice waits for the next turn by design)
  const busy = () => rig.sql(`SELECT a.name, 'turn ' || t.id AS what FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.org_id = ${orgId} AND t.ended_at IS NULL AND a.state = 'live'
      UNION ALL SELECT a.name, 'mail ' || m.id || ' ' || m.state || ' from ' || m.sender || ': ' || left(m.body, 80)
      FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.org_id = ${orgId} AND m.state IN ('pending', 'delivering') AND NOT m.notice AND a.halt IS NULL AND a.state = 'live'`)
  const settle = async what => {
    try { await rig.waitFor(() => busy().length === 0, { what, timeout: 120000 }) } catch (e) {
      throw new Error(`${e.message}; still busy: ${JSON.stringify(busy()).slice(0, 800)}`)
    }
  }
  await settle('seed turns to settle')

  // ---------------------------------------------------------------- the org
  for (const [name, parent] of [['dave', 'boss'], ['erin', 'boss'], ['frank', 'boss'], ['gina', 'boss'], ['hank', 'alice']]) {
    await rig.op({ op: 'hire', name, parent, tier: 'haiku', title: 'Reminder agent' })
  }
  const slug = { S: rig.one(`SELECT slug FROM ot.work_items WHERE org_id = ${orgId} AND title = 'Rig smoke item'`).slug }
  for (const [k, title] of Object.entries(TITLES)) {
    const r = await rig.tool('boss', 'orgtree_work', { action: 'create', title, kind: 'code', owner: OWNER[k],
      objective: `${title}: an item for the reminders proof.\n\nNothing depends on it.` })
    slug[k] = rig.one(`SELECT slug FROM ot.work_items WHERE org_id = ${orgId} AND title = '${title}'`)?.slug
    if (!slug[k]) throw new Error(`create ${k} failed: ${JSON.stringify(r).slice(0, 300)}`)
  }
  const key = Object.fromEntries(Object.entries(slug).map(([k, s]) => [s, k]))
  const upd = async (k, args) => {
    const r = await rig.tool(OWNER[k], 'orgtree_work', { action: 'update', slug: slug[k], done_so_far: ['set up'], working_on_next: ['wait'], ...args })
    if (!r.ok) throw new Error(`update ${k} refused: ${String(r.text).slice(0, 300)}`)
  }
  for (const k of ['A1', 'A4', 'A5', 'B1', 'E1']) await upd(k, { status: 'in_progress' })
  for (const k of ['A2', 'F1']) await upd(k, { status: 'blocked', blocked_reason: BLOCKED })
  await upd('A3', { status: 'backlogged' })
  await upd('A4', { attention: true, attention_reason: 'The reminders proof needs this flag to stay up.' })
  await upd('R1', { status: 'review', reviewer: 'carol' })
  await upd('R2', { status: 'review' })
  await upd('R3', { status: 'review', reviewer: 'dave' })
  for (const k of ['D1', 'D2']) await upd(k, { status: 'deploy_ready' })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'alice', reason: 'proof: may ask the user' })
  const asked = await rig.tool('alice', 'orgtree_ask', { question: 'Should this item wait for you?', work_item: slug.A5, options: ['Yes', 'No'] })
  for (const name of ['bob', 'frank', 'gina']) await rig.tool(name, 'orgtree_status', { status: 'working', summary: 'working on it' })
  // dave's review request runs a turn: let it end before he is retired
  await settle('dave\'s turn to end')
  await rig.op({ op: 'retire', node: 'dave' })
  await settle('the arranging turns to settle')
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/erin/halt`)
  await rig.tool('carol', 'orgtree_send_notice', { to: 'boss', body: 'FYI from carol: nothing to do.' })
  const openAsk = rig.one(`SELECT count(*)::int AS n FROM ot.asks WHERE org_id = ${orgId} AND status = 'open' AND '${slug.A5}' = ANY (work_items)`).n
  const bossNotices = rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id = ${rig.agentRow('boss').id}
    AND state = 'pending' AND notice`).n
  const unread = rig.sql(`SELECT a.name, count(*) FILTER (WHERE m.notice)::int AS notices, count(*) FILTER (WHERE NOT m.notice)::int AS waking
      FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
     WHERE a.org_id = ${orgId} AND m.state IN ('pending', 'delivering') GROUP BY a.name ORDER BY a.name`)
  p.note('arranged', { slug, askOk: asked.ok, openAsk, bossNotices, halted: !!rig.agentRow('erin').halt, unread })

  // every live agent's activity 25 minutes old, in one transaction
  const ago = `to_char((now() - interval '25 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
  const backdate = () => rig.exec(`
    UPDATE ot.turns SET started_at = started_at - interval '25 minutes', ended_at = ended_at - interval '25 minutes'
     WHERE agent_id IN (SELECT id FROM ot.agents WHERE org_id = ${orgId});
    UPDATE ot.agents SET last_status = jsonb_set(last_status, '{at}', to_jsonb(${ago}))
     WHERE org_id = ${orgId} AND jsonb_typeof(last_status) = 'object' AND last_status ? 'at';
    UPDATE ot.agents SET extra = extra || jsonb_build_object('working_activity_at', ${ago}, 'docket_reminder_at', ${ago})
     WHERE org_id = ${orgId};`)
  const lastMail = () => rig.one(`SELECT coalesce(max(id), 0)::bigint AS n FROM ot.mail`).n
  const woken = since => rig.sql(`SELECT m.id, a.name, m.ev->>'variant' AS variant, m.ev->'items' AS items, m.body
      FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
     WHERE a.org_id = ${orgId} AND m.id > ${since} AND m.ev->>'variant' LIKE 'reminder.%' ORDER BY m.id`)
  const rows = (all, name) => all.filter(r => r.name === name)
  // "K:status:role" per listed item
  const listed = r => (r?.items ?? []).map(i => `${key[i.slug] ?? i.slug}:${i.status}:${i.role}`).sort()
  const summary = all => Object.fromEntries([...new Set(all.map(r => r.name))].map(n => [n,
    rows(all, n).map(r => (r.variant === 'reminder.idle_docket' ? listed(r).join(' ') : r.variant))]))
  const prompt = (name, since) => rig.fakeLog(name).filter(l => l.kind === 'turn' && l.ts >= since).map(l => String(l.prompt ?? '')).join('\n')
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

  // ---------------------------------------------------------------- reminders
  await backdate()
  let since = lastMail()
  const t0 = new Date().toISOString()
  await switches(true, true)
  await sleep(SWEEPS_MS)
  await settle('the reminded turns to settle')
  const wave = woken(since)
  p.note('first wave', summary(wave))
  const one = name => rows(wave, name)
  p.check('alice (idle) is reminded of her actionable items only: not the blocked, backlogged, flagged or questioned ones',
    one('alice').length === 1 && one('alice')[0].variant === 'reminder.idle_docket'
    && ['S', 'A1'].every(k => listed(one('alice')[0]).some(l => l.startsWith(`${k}:`)))
    && !['A2', 'A3', 'A4', 'A5', 'R1'].some(k => listed(one('alice')[0]).some(l => l.startsWith(`${k}:`))), listed(one('alice')[0]))
  p.check('a deploy_ready item is owed by the owner\'s nearest live superior (alice, as deployer); its owner hank is not woken',
    listed(one('alice')[0]).includes('D1:deploy_ready:deployer') && one('hank').length === 0,
  { alice: listed(one('alice')[0]), hank: summary(one('hank')) })
  p.check('a top-level owner keeps its deploy_ready item; an unassigned review asks the owner to name a reviewer; an unread notice holds no wake back (boss)',
    one('boss').length === 1 && same(listed(one('boss')[0]), ['D2:deploy_ready:owner', 'R2:review:unassigned_review']),
  { boss: summary(one('boss')), bossNotices })
  p.check('the reviewer hears about the item in review; a review whose reviewer retired goes back to its owner (carol)',
    one('carol').length === 1 && same(listed(one('carol')[0]), ['R1:review:reviewer', 'R3:review:stale_reviewer']), summary(one('carol')))
  p.check('a working agent with actionable items gets the reminder that names them, not the generic checkup (bob, 3.x order)',
    one('bob').length === 1 && one('bob')[0].variant === 'reminder.idle_docket' && same(listed(one('bob')[0]), ['B1:in_progress:owner']),
    summary(one('bob')))
  p.check('nobody else is woken: not the halted erin, frank (working, only blocked items), gina (working, no items) or the retired dave',
    ['erin', 'frank', 'gina', 'dave'].every(n => one(n).length === 0) && Object.keys(summary(wave)).every(n => ['alice', 'boss', 'carol', 'bob', 'hank'].includes(n)),
    summary(wave))
  const seen = prompt('alice', t0)
  p.check('alice\'s turn reads the reminder with the deployer line',
    /\[AUTOMATIC IDLE DOCKET REMINDER\]/.test(seen) && seen.includes(`- ${slug.D1} (deploy_ready — awaiting YOUR authorized deployment/publication action): ${TITLES.D1}`),
    seen.split('\n').filter(l => /REMINDER|deploy_ready/.test(l)).slice(0, 6))
  const read = wave.filter(r => r.variant === 'reminder.idle_docket').map(r => {
    const text = prompt(r.name, t0)
    return { name: r.name, storedIsRead: !!r.body && text.includes(r.body), asksWaiting: /waiting_reason/.test(text) }
  })
  p.check('every reminder an agent read is the text stored for the desk, and none asks for the waiting status (removed 2026-09-07)',
    read.length > 0 && read.every(r => r.storedIsRead && !r.asksWaiting), read)
  const next = async k => (await rig.api('GET', `/api/orgs/${rig.org}/work-items/${slug[k]}`)).item?.next_action ?? null
  const na = {}
  for (const k of ['S', 'R1', 'R2', 'R3', 'D1', 'D2']) na[k] = await next(k)
  const naIs = (k, node, role) => na[k]?.node === node && na[k]?.role === role
  p.check('each item\'s next_action names the same agent and role as the reminder',
    naIs('S', 'alice', 'owner') && naIs('R1', 'carol', 'reviewer') && naIs('R2', 'boss', 'unassigned_review')
    && naIs('R3', 'carol', 'stale_reviewer') && naIs('D1', 'alice', 'deployer') && naIs('D2', 'boss', 'owner'), na)

  since = lastMail()
  await sleep(SWEEPS_MS)
  await settle('a quiet spell')
  p.check('cooldown: the next sweeps wake nobody again', woken(since).length === 0, summary(woken(since)))

  // ---------------------------------------------------------------- blocked option
  await switches(false, false)
  await settle('the switches off')
  rig.exec(`UPDATE ot.work_items SET status = 'blocked', blocked_reason = '${BLOCKED}'
     WHERE org_id = ${orgId} AND status NOT IN ('done', 'superseded', 'dropped', 'backlogged') AND archived_at IS NULL`)
  await backdate()
  since = lastMail()
  await switches(false, true, true)
  await sleep(SWEEPS_MS)
  await settle('the blocked reminders to settle')
  const blocked = woken(since)
  p.note('whole org blocked', summary(blocked))
  const b = name => rows(blocked, name)
  p.check('the whole org blocked and the option on: owners hear about their own blocked items (alice, frank)',
    b('alice').length === 1 && ['S', 'A1', 'A2'].every(k => listed(b('alice')[0]).includes(`${k}:blocked:owner`))
    && b('frank').length === 1 && same(listed(b('frank')[0]), ['F1:blocked:owner']), summary(blocked))
  rig.exec(`UPDATE ot.work_items SET status = 'in_progress', blocked_reason = NULL WHERE org_id = ${orgId} AND slug = '${slug.R3}'`)
  await backdate()
  since = lastMail()
  await sleep(SWEEPS_MS)
  await settle('the mixed org reminders to settle')
  const mixed = woken(since)
  p.check('one item actionable anywhere: only its owner hears (carol), nobody hears about blocked items',
    same(Object.keys(summary(mixed)), ['carol']) && same(listed(rows(mixed, 'carol')[0]), ['R3:in_progress:owner']), summary(mixed))

  // ---------------------------------------------------------------- checkup
  await switches(false, false)
  await settle('the switches off')
  rig.exec(`UPDATE ot.work_items SET status = 'in_progress', blocked_reason = NULL WHERE org_id = ${orgId} AND slug IN ('${slug.B1}', '${slug.A1}')`)
  await backdate()
  since = lastMail()
  await switches(true, false)
  await sleep(SWEEPS_MS)
  await settle('the checkups to settle')
  const checked = woken(since)
  p.check('reminders off, checkups on: the working agent with actionable work gets the 20-minute check, nobody else (alice is idle)',
    same(Object.keys(summary(checked)), ['bob']) && rows(checked, 'bob').length === 1 && rows(checked, 'bob')[0].variant === 'reminder.working_checkup',
    summary(checked))

  // ---------------------------------------------------------------- off
  await switches(false, false)
  await backdate()
  since = lastMail()
  await sleep(SWEEPS_MS)
  p.check('both switches off: nobody is woken', woken(since).length === 0, summary(woken(since)))

  p.keep(rig, { agents: ['alice', 'bob', 'boss', 'carol', 'hank'] })
  return p.save()
}
