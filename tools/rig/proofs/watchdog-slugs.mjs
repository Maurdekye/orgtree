// Proof: a watchdog's id is the readable slug of its name (decision 67), as
// agents and the user use it.
//   two dogs with one name get build-watch and build-watch-2, and each one's
//   name is its id; the fire mail and its monitor event carry the slug (the
//   sender, the body, the event's actor and object), and so does the turn
//   that mail wakes
//   list shows the slugs; pause, resume and remove take them; a removed or a
//   spent dog frees its id; a dog without a name is named by kind and target
//   two owners may both keep build-watch: the superior's bare id is its own,
//   owner/id names the report's, the report cannot reach up, the user's bare
//   id is refused as ambiguous and owner/id (the desktop's handle) works
//   two creates racing for one name get race and race-2
//   a dog made before (a random id) still resumes, pauses and removes by it
//   the desktop feed lists owner/id handles, one per dog, while a spent
//   one-shot's id is reused
//   after an engine restart the dogs are armed again and fire
// Run: node tools/rig/rig.mjs run tools/rig/proofs/watchdog-slugs.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

/** The watchdogs group of the org feed, from the records snapshot the desktop
 * loads (a socket only pushes later changes), read until `ready(dogs)`: the
 * feed recomputes the group a moment after a dog changes. */
async function feedDogs(rig, ready, ms = 10000) {
  const end = Date.now() + ms
  let last = { error: 'the records snapshot has no watchdogs group' }
  for (;;) {
    try {
      const snap = await rig.api('GET', `/api/orgs/${rig.org}/records`)
      const group = (snap.records ?? []).find(r => r.entity === 'org' && r.id === 'watchdogs')
      if (group) last = { dogs: group.body?.watchdogs ?? [] }
    } catch (e) { last = { error: e.message } }
    if ((last.dogs && ready(last.dogs)) || Date.now() > end) return last
    await new Promise(r => setTimeout(r, 250))
  }
}

export default async function (rig) {
  const p = new Proof('watchdog-slugs')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'wes', parent: 'boss', tier: 'haiku', title: 'Watchdog owner' })
  await rig.op({ op: 'hire', name: 'kid', parent: 'wes', tier: 'haiku', title: 'Report with dogs of its own' })
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  const wes = rig.agentRow('wes').id
  const kid = rig.agentRow('kid').id
  const folder = name => {
    const d = path.join(rig.data, 'scratch', rig.org, name)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const W = folder('wes')
  const K = folder('kid')
  for (const f of ['a.log', 'b.log', 'owner.txt', 'race.log', 'legacy.log']) fs.writeFileSync(path.join(W, f), 'start\n')
  fs.writeFileSync(path.join(K, 'k.log'), 'start\n')
  const dog = (who, args) => rig.tool(who, 'orgtree_watchdog', args)
  const out = r => r?.json ?? {}
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 240)
  const rows = owner => rig.sql(`SELECT id, uid, name, state FROM ot.watchdogs WHERE owner_agent_id = ${owner} ORDER BY id`)
  const state = (owner, uid) => rows(owner).filter(r => r.uid === uid && r.state !== 'removed').at(-1)?.state ?? null
  const fires = sender => rig.sql(`SELECT id, sender, body, ev FROM ot.mail WHERE recipient_agent_id = ${wes} AND kind = 'watchdog'
    AND sender = '${sender}' ORDER BY id`)
  const asUser = (id, action) => rig.api('POST', `/api/orgs/${rig.org}/watchdogs`, { id, action, reason: 'proof' })
    .then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))

  // ------------------------------------------------------------ one name, two dogs
  const first = await dog('wes', { action: 'create', name: 'Build Watch', kind: 'file', target: 'a.log', pattern: 'ALERT', interval_s: 15 })
  const second = await dog('wes', { action: 'create', name: 'build-watch', kind: 'file', target: 'b.log', pattern: 'ALERT', interval_s: 15 })
  p.check('two dogs with one name get the ids build-watch and build-watch-2', out(first).id === 'build-watch' && out(second).id === 'build-watch-2',
    { first: said(first), second: said(second) })
  const named = rows(wes)
  p.check('each new dog\'s name is its id', named.length === 2 && named.every(r => r.name === r.uid), named)
  p.check('the create result says why the second id has a suffix', /"build-watch-2"/.test(out(second).status ?? '') && /already "build-watch"/.test(out(second).status ?? ''),
    out(second).status)

  // ------------------------------------------------------------ a fire carries the slug
  const turnsBefore = rig.turns('wes').length
  fs.appendFileSync(path.join(W, 'b.log'), 'ALERT: the second dog\n')
  const fired = await rig.waitFor(() => fires('build-watch-2'), { what: 'build-watch-2 to fire', timeout: 60000 }).catch(() => [])
  const m = fired[0] ?? rig.one(`SELECT id, sender, body, ev FROM ot.mail WHERE recipient_agent_id = ${wes} AND kind = 'watchdog' ORDER BY id LIMIT 1`)
  p.check('the fire mail is from build-watch-2 and names it in its body', m?.sender === 'build-watch-2' && /Watchdog "build-watch-2" fired/.test(m?.body ?? '')
    && /ALERT: the second dog/.test(m?.body ?? ''), m && { sender: m.sender, body: String(m.body).slice(0, 200) })
  p.check('its monitor event carries the slug as the actor\'s id and the dog\'s id and name',
    m?.ev?.actor?.kind === 'watchdog' && m.ev.actor.id === 'build-watch-2' && m.ev.object?.id === 'build-watch-2' && m.ev.object?.name === 'build-watch-2',
    m?.ev && { variant: m.ev.variant, actor: m.ev.actor, object: m.ev.object })
  const woken = await rig.waitFor(() => rig.fakeLog('wes').filter(l => l.kind === 'turn').map(l => l.prompt ?? '').find(t => t.includes('[WATCHDOG build-watch-2]')),
    { what: 'wes to read the fire', timeout: 60000 }).catch(() => null)
  p.check('the turn the fire wakes reads [WATCHDOG build-watch-2]', Boolean(woken) && rig.turns('wes').length > turnsBefore,
    woken ? woken.slice(woken.indexOf('[WATCHDOG'), woken.indexOf('[WATCHDOG') + 160) : rig.fakeLog('wes').filter(l => l.kind === 'turn').map(l => (l.prompt ?? '').slice(0, 160)))

  // ------------------------------------------------------------ list, pause, resume, remove by slug
  const listed = (out(await dog('wes', { action: 'list' })).watchdogs ?? []).map(d => d.id)
  p.check('list shows the slugs as ids', listed.includes('build-watch') && listed.includes('build-watch-2'), listed)
  const paused = await dog('wes', { action: 'pause', id: 'build-watch-2' })
  const s1 = state(wes, 'build-watch-2')
  const resumed = await dog('wes', { action: 'resume', id: 'build-watch-2' })
  const s2 = state(wes, 'build-watch-2')
  const removed = await dog('wes', { action: 'remove', id: 'build-watch', reason: 'proof' })
  const s3 = rows(wes).find(r => r.uid === 'build-watch')?.state
  p.check('pause, resume and remove take the slug', paused.ok && s1 === 'paused' && resumed.ok && s2 === 'armed' && removed.ok && s3 === 'removed'
    && out(removed).id === 'build-watch', { pause: [said(paused), s1], resume: [said(resumed), s2], remove: [said(removed), s3] })

  // ------------------------------------------------------------ a removed dog frees its id; no name
  const again = await dog('wes', { action: 'create', name: 'build-watch', kind: 'file', target: 'a.log', pattern: 'ALERT', interval_s: 15 })
  p.check('a removed dog frees its id: the next build-watch is build-watch again', out(again).id === 'build-watch', said(again))
  const anon = await dog('wes', { action: 'create', kind: 'file', target: 'owner.txt', interval_s: 600 })
  p.check('a dog without a name is named by its kind and target', out(anon).id === 'file-owner-txt' && /kind and target/.test(out(anon).status ?? ''), said(anon))

  // ------------------------------------------------------------ two owners, one id
  const kids = await dog('kid', { action: 'create', name: 'build-watch', kind: 'file', target: 'k.log', pattern: 'ALERT', interval_s: 600 })
  p.check('another owner keeps its own build-watch, with no suffix', out(kids).id === 'build-watch', said(kids))
  const own = await dog('wes', { action: 'pause', id: 'build-watch' })
  const ownState = [state(wes, 'build-watch'), state(kid, 'build-watch')]
  p.check('a superior\'s bare id is its own dog', own.ok && ownState[0] === 'paused' && ownState[1] === 'armed', { said: said(own), wes: ownState[0], kid: ownState[1] })
  const theirs = await dog('wes', { action: 'pause', id: 'kid/build-watch' })
  p.check('owner/id names the report\'s dog', theirs.ok && state(kid, 'build-watch') === 'paused', { said: said(theirs), kid: state(kid, 'build-watch') })
  const upward = await dog('kid', { action: 'remove', id: 'wes/build-watch' })
  p.check('a report cannot reach its superior\'s dog', !upward.ok && /owner's superiors/.test(upward.text ?? '') && state(wes, 'build-watch') === 'paused', said(upward))
  const ambiguous = await asUser('build-watch', 'resume')
  p.check('the user\'s bare id shared by two owners is refused, naming both', !ambiguous.ok && /wes\/build-watch/.test(ambiguous.error ?? '')
    && /kid\/build-watch/.test(ambiguous.error ?? ''), ambiguous.error ?? ambiguous.v)
  const exact = await asUser('kid/build-watch', 'resume')
  p.check('the user\'s owner/id (the desktop\'s handle) works', exact.ok && state(kid, 'build-watch') === 'armed' && state(wes, 'build-watch') === 'paused',
    { said: exact.error ?? exact.v, kid: state(kid, 'build-watch'), wes: state(wes, 'build-watch') })

  // ------------------------------------------------------------ a race for one name
  const raced = await Promise.all([1, 2].map(() => dog('wes', { action: 'create', name: 'race', kind: 'file', target: 'race.log', interval_s: 600 })))
  const raceIds = raced.map(r => out(r).id).sort()
  p.check('two creates racing for one name get race and race-2', raceIds[0] === 'race' && raceIds[1] === 'race-2', raced.map(said))

  // ------------------------------------------------------------ a spent one-shot frees its id; the feed keeps one row per handle
  const shot = await dog('wes', { action: 'create', name: 'shot', kind: 'command', target: 'echo READY', pattern: 'READY', interval_s: 15, once: true })
  const spent = await rig.waitFor(() => rows(wes).some(r => r.uid === 'shot' && r.state === 'spent'), { what: 'the one-shot to fire', timeout: 60000 })
    .then(() => true, () => false)
  const shot2 = await dog('wes', { action: 'create', name: 'shot', kind: 'command', target: 'echo LATER', pattern: 'NEVER', interval_s: 600 })
  p.check('a spent one-shot frees its id: the next shot is shot again', shot.ok && spent && out(shot2).id === 'shot', { spent, shot: said(shot), again: said(shot2) })
  const feed = await feedDogs(rig, dogs => dogs.some(d => d.id === 'wes/shot' && d.target === 'echo LATER'))
  // the feed shows a spent one-shot for 15 s: the check counts only inside that window
  const spentAge = rig.one(`SELECT extract(epoch FROM now() - spent_at)::float8 AS s FROM ot.watchdogs
                             WHERE owner_agent_id = ${wes} AND uid = 'shot' AND state = 'spent'`)?.s
  const handles = (feed.dogs ?? []).map(d => d.id)
  p.check('the desktop feed lists owner/id handles, one per dog, while the spent shot is still on show',
    !feed.error && spentAge < 14 && handles.includes('wes/build-watch-2') && handles.includes('kid/build-watch')
      && handles.filter(h => h === 'wes/shot').length === 1 && new Set(handles).size === handles.length,
    { error: feed.error, spent_age_s: spentAge, handles })

  // ------------------------------------------------------------ a dog made before keeps its random id
  const legacy = path.join(W, 'legacy.log').replace(/'/g, "''")
  rig.exec(`INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, pattern, interval_s, state, memo)
            VALUES ('wd0123456789ab', ${org}, ${wes}, 'legacy', 'file', '${legacy}', 'ALERT', 15, 'paused', '{"run":{}}'::jsonb)`)
  const oldListed = (out(await dog('wes', { action: 'list' })).watchdogs ?? []).find(d => d.name === 'legacy')
  const oldResume = await dog('wes', { action: 'resume', id: 'wd0123456789ab' })
  const o1 = state(wes, 'wd0123456789ab')
  const oldPause = await asUser('wes/wd0123456789ab', 'pause')
  const o2 = state(wes, 'wd0123456789ab')
  const oldRemove = await dog('wes', { action: 'remove', id: 'wd0123456789ab', reason: 'proof' })
  const o3 = rows(wes).find(r => r.uid === 'wd0123456789ab')?.state
  p.check('a dog made before keeps its id: list shows it, and resume, pause and remove take it', oldListed?.id === 'wd0123456789ab'
    && oldResume.ok && o1 === 'armed' && oldPause.ok && o2 === 'paused' && oldRemove.ok && o3 === 'removed',
    { listed: oldListed?.id, resume: [said(oldResume), o1], pause: [oldPause.error ?? 'ok', o2], remove: [said(oldRemove), o3] })

  // ------------------------------------------------------------ a restart
  const before = fires('build-watch-2').length
  try { await rig.restart() } catch (e) {
    // a restart that never gets ready: keep why (the run folder may be cleaned up before anyone looks)
    for (const f of [path.join(rig.dir, 'keeper.log'), path.join(rig.dir, 'data', 'pg', 'cluster', 'log', 'postgres.log')]) {
      try { p.file(`restart-${path.basename(f)}`, fs.readFileSync(f, 'utf8').slice(-30000)) } catch { /* gone */ }
    }
    throw e
  }
  fs.appendFileSync(path.join(W, 'b.log'), 'ALERT: after the restart\n')
  const after = await rig.waitFor(() => fires('build-watch-2').length > before ? fires('build-watch-2') : null, { what: 'build-watch-2 after the restart', timeout: 60000 })
    .catch(() => fires('build-watch-2'))
  p.check('after an engine restart build-watch-2 is armed again and fires', after.length > before && /after the restart/.test(after.at(-1)?.body ?? ''),
    { fires: after.length, before })

  p.keep(rig, { agents: ['wes', 'kid'], grep: /watchdog/i })
  return p.summary()
}
