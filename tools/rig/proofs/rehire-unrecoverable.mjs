// Proof: an agent 3.x had marked unrecoverable (its session lost) comes back.
// A 3.2 store (tools/rig/legacy32.mjs) where dev is unrecoverable is
// imported; the user rehires dev: it is live again under lead, on a fresh
// session (not the lost one), and its first turn starts with the handoff
// note, as 3.x re-seeded it (decision 43: a fresh session with a handoff).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/rehire-unrecoverable.mjs

import { SLUG32, prepare32 } from '../legacy32.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: 'none', name: 'unrecoverable', prepare: ctx => prepare32({ ...ctx, damage: [
    "UPDATE orgtree.agents SET state = 'unrecoverable' WHERE name = 'dev'"] }) }
}

const ORG = `(SELECT id FROM ot.orgs WHERE slug = '${SLUG32}' AND state = 'active')`

export default async function (rig) {
  const p = new Proof('rehire-unrecoverable')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.one(`SELECT 1 AS ok FROM ot.orgs WHERE slug = '${SLUG32}' AND state = 'active'`), { what: 'the 3.2 org to import', timeout: 60000 })
  const dev = () => rig.one(`SELECT a.state, a.session_id, p.name AS parent FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id
    WHERE a.org_id = ${ORG} AND a.name = 'dev'`)
  const d0 = dev()
  p.check('the imported dev is unrecoverable, with its lost session id', d0?.state === 'unrecoverable' && d0.session_id === 'sess-32-dev', d0)
  const r = await rig.op({ op: 'rehire', node: 'dev' }, { org: SLUG32 }).then(x => ({ ok: true, r: x }), e => ({ ok: false, detail: String(e.body?.detail ?? e.message) }))
  const d1 = dev()
  p.check('the user rehires dev: live again under lead, off the lost session, and the result says it starts fresh', r.ok
    && d1?.state === 'live' && d1.parent === 'lead' && d1.session_id !== 'sess-32-dev' && /fresh session/.test(JSON.stringify(r.r?.warnings ?? '')),
  { r: r.r ?? r.detail, dev: d1 })
  await rig.userMail('dev', 'Welcome back, dev.', { org: SLUG32 })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.org_id = ${ORG} AND a.name = 'dev' AND t.ended_at IS NOT NULL`).length > 0,
    { what: 'dev\'s first turn', timeout: 90000 })
  const start = rig.fakeLog('dev').filter(l => l.kind === 'start').at(-1)
  // the rehire wakes dev at once (mail waits for it from the 3.2 store): its first turn carries the note
  const prompt = rig.fakeLog('dev').filter(l => l.kind === 'turn')[0]?.prompt ?? ''
  p.check('dev\'s first turn runs on a new session (not the lost one) and starts with the handoff note', start && !start.resumed
    && start.session !== 'sess-32-dev' && prompt.includes('fresh session (your earlier session could not be recovered)'),
  { resumed: start?.resumed, session: start?.session, prompt: prompt.slice(prompt.indexOf('fresh session') - 100, prompt.indexOf('fresh session') + 300) })

  p.keep(rig, { agents: ['dev'], grep: /rehire|handoff|unrecoverable/i })
  return p.summary()
}
