// Proof: the default threshold of "reset a session before a known-cold turn"
//   (auto_cheap_compact.occ) is 25% (user 2026-10-08 22:05Z; 3.x used 50%).
//   The rig org has no setting of its own (none is stored at creation): its
//   settings report {enabled: false, occ: 0.25}, and so do the app defaults.
//   ivy and jon (haiku) switch the reset on with an override that names only
//   `enabled`, and inherit the occupancy, 0.25. Each has a session and a cache
//   receipt two hours old (cold), with 30% (ivy) and 20% (jon) of the context
//   measured. ivy's next turn starts on a fresh session with the compaction
//   handoff; jon's resumes his session.
//   An org occupancy of 40% then reaches ivy's override (3.x merged an
//   override key by key over the org's setting).
//   With --ui, a second org with no setting: its Org settings panel saved
//   untouched stores the reset explicitly ({enabled: false, occ: 0.25}), and
//   switched on it shows 25%.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/cold-reset-default.mjs [--ui <bundle>]

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// key order differs between the payload and jsonb, so compare the two fields
const same = (a, b) => a?.enabled === b.enabled && a?.occ === b.occ && Object.keys(a ?? {}).length === 2

export default async function (rig) {
  const p = new Proof('cold-reset-default')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const stored = slug => rig.one(`SELECT settings ? 'auto_cheap_compact' AS has, settings->'auto_cheap_compact' AS acc
                                    FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`)
  const header = async slug => (await rig.api('GET', `/api/orgs/${slug}`))?.auto_cheap_compact
  const record = async name => {
    const snap = await rig.api('GET', `/api/orgs/${rig.org}/records`)
    return snap?.records?.find(r => r.entity === 'agent' && r.body?.id === name)?.body ?? {}
  }

  // ---- an org with no setting of its own
  const s0 = stored(rig.org)
  p.check('the rig org stores no reset setting of its own (creation writes only its folders)', s0 && s0.has === false, s0)
  const h0 = await header(rig.org)
  p.check('its settings report the default: {enabled: false, occ: 0.25}', same(h0, { enabled: false, occ: 0.25 }), h0)
  const d0 = (await rig.api('GET', '/api/defaults'))?.auto_cheap_compact
  p.check('the app defaults report occ 0.25 too', d0?.occ === 0.25, d0)

  // ---- two agents switch it on, naming only `enabled`
  await rig.op({ op: 'hire', name: 'ivy', parent: 'boss', tier: 'haiku', title: 'Cold subject' })
  await rig.op({ op: 'hire', name: 'jon', parent: 'boss', tier: 'haiku', title: 'Warm subject' })
  for (const name of ['ivy', 'jon']) {
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { auto_cheap_compact: { enabled: true } })
    await rig.userMail(name, `Hello ${name}, start a session.`)
    await rig.waitTurns(name, 1)
  }
  const r1 = await record('ivy')
  p.check('ivy (override {enabled: true}) inherits the occupancy 0.25',
    r1.cheap_compact_on === true && r1.cheap_compact_occ === 0.25, { on: r1.cheap_compact_on, occ: r1.cheap_compact_occ })

  // ---- both cold (receipt two hours old); ivy at 30% of her context, jon at 20%
  const id = name => rig.agentRow(name).id
  const ids = { ivy: id('ivy'), jon: id('jon') }
  const sessions = { ivy: rig.agentRow('ivy').session_id, jon: rig.agentRow('jon').session_id }
  rig.exec(`UPDATE ot.agents SET context_window = 1000000, occupancy_est = false, compacted_unrun = false,
              occupancy = CASE id WHEN ${ids.ivy} THEN 300000 ELSE 200000 END,
              extra = jsonb_set(extra, '{cache_receipt,at}',
                to_jsonb(to_char((now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
            WHERE id IN (${ids.ivy}, ${ids.jon}) AND extra ? 'cache_receipt'`)
  const seeded = rig.sql(`SELECT name, occupancy, extra->'cache_receipt'->>'at' AS at FROM ot.agents WHERE id IN (${ids.ivy}, ${ids.jon}) ORDER BY name`)
  p.note('seeded cold receipts and measured context', seeded)
  // the actors read their receipt when they start
  await rig.restart()
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const before = { ivy: starts('ivy').length, jon: starts('jon').length }
  for (const name of ['ivy', 'jon']) {
    await rig.userMail(name, `Next turn, ${name}.`)
    await rig.waitTurns(name, 2)
  }
  const si = starts('ivy').slice(before.ivy).at(-1)
  const sj = starts('jon').slice(before.jon).at(-1)
  const ended = rig.one(`SELECT end_reason FROM ot.agent_sessions WHERE agent_id = ${ids.ivy} AND session_id = '${sessions.ivy}'`)
  const prompt = [...rig.fakeLog('ivy')].reverse().find(l => l.kind === 'turn')?.prompt ?? ''
  p.check('ivy (30% >= 25%, cold): her turn starts on a fresh session; the old one ends as a cold-cache cheap compact',
    si && si.resumed === false && si.session !== sessions.ivy && ended?.end_reason === 'cheap compact (cold cache)',
    { resumed: si?.resumed, session: si?.session, was: sessions.ivy, ended })
  p.check('ivy: the fresh session starts with the compaction handoff', /prompt cache had expired/.test(prompt), prompt.slice(0, 300))
  p.check('jon (20% < 25%, cold): his turn resumes his session',
    sj && sj.resumed === true && sj.session === sessions.jon, { resumed: sj?.resumed, session: sj?.session, was: sessions.jon })

  // ---- an org occupancy reaches an override that names only `enabled` (3.x)
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { auto_cheap_compact: { occ: 0.4 } })
  const s1 = stored(rig.org)
  const r2 = await record('ivy')
  p.check('with the org at 40%, ivy\'s override (enabled only) uses 0.4',
    r2.cheap_compact_on === true && r2.cheap_compact_occ === 0.4, { org: s1?.acc, on: r2.cheap_compact_on, occ: r2.cheap_compact_occ })

  // ---- the Org settings panel, as the user sees it
  if (rig.run.ui) {
    const fresh = (await rig.api('POST', '/api/orgs', { name: 'Fresh Org', dirs: [], net_autoconnect: false })).slug
    const f0 = stored(fresh)
    const r = await runDesktop(rig, path.join(here, '../desktop/cold-reset-default.cjs'),
      { org: fresh, out: path.join(p.dir, 'desk'), timeout: 120000 })
    p.check('the desk script ran', r.ok, r.ok ? undefined : r)
    const f1 = stored(fresh)
    p.check('a fresh org\'s Org settings panel saved untouched stores the reset explicitly, at the default',
      f0?.has === false && f1?.has === true && same(f1.acc, { enabled: false, occ: 0.25 }), { before: f0, after: f1 })
    p.check('switched on, the panel shows 25%', r.value?.shown === '25', r.value)
  } else {
    p.note('no --ui bundle: the Org settings panel checks were skipped')
  }

  p.keep(rig, { agents: ['ivy', 'jon'], grep: /cheap compact|cold/i })
  return p.summary()
}
