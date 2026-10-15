// Proof: the retired mail kinds (user ruling 2026-10-15). Agent tools offer
// only `message` and `question`; a send naming a retired kind
// (request/decision/status) is accepted and stored as `message`, an unknown
// kind is still refused, engine-generated mail (orgtree_status notices,
// hire kickoffs) is stored as `message` too, and `question` is unchanged.
// At the base (9735bd4) the retired-kind rows below read back with their
// retired kind, so the `stored as message` checks fail there.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/kinds-retired.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('kinds-retired')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'worker', parent: 'boss', tier: 'haiku', title: 'Kinds proof worker' })

  const stored = body => rig.one(`SELECT kind, notice FROM ot.mail WHERE recipient_name = 'worker' AND body = '${body}' ORDER BY id DESC LIMIT 1`)
  const send = (kind, body) => rig.tool('boss', 'orgtree_message', { to: 'worker', kind, body })

  for (const retired of ['request', 'decision', 'status']) {
    const body = `KINDS retired ${retired}`
    const r = await send(retired, body)
    const row = stored(body)
    p.check(`a send with retired kind ${retired} is accepted and stored as message`, r.ok && row?.kind === 'message', { ok: r.ok, text: r.text, row })
  }

  const unknown = await send('memo', 'KINDS unknown memo')
  p.check('an unknown kind is still refused, and nothing is stored', !unknown.ok && !stored('KINDS unknown memo'), unknown.text)

  const q = await send('question', 'KINDS question case')
  p.check('kind question is stored unchanged', q.ok && stored('KINDS question case')?.kind === 'question', { ok: q.ok, row: stored('KINDS question case') })

  const plain = await rig.tool('boss', 'orgtree_message', { to: 'worker', body: 'KINDS plain case' })
  p.check('a send with no kind is stored as message', plain.ok && stored('KINDS plain case')?.kind === 'message', { ok: plain.ok, row: stored('KINDS plain case') })

  // engine-generated: the status tool's superior notice is a message now
  const st = await rig.tool('worker', 'orgtree_status', { status: 'done', summary: 'kinds proof status' })
  const notice = rig.one(`SELECT kind, notice FROM ot.mail WHERE recipient_name = 'boss' AND body LIKE 'Status: done%' ORDER BY id DESC LIMIT 1`)
  p.check('orgtree_status still sends a passive notice, stored as message', st.ok && notice?.notice === true && notice?.kind === 'message', { ok: st.ok, notice })

  // engine-generated: a hire kickoff naming a retired kind lands as message
  const hire = await rig.tool('boss', 'orgtree_hire', { name: 'kindhire', tier: 'haiku', grant: 1, charter: 'Isolated proof agent.', index: 0, add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: false, mcp: [] }, org_visibility: 'self', kickoff: 'KINDS kickoff case', kickoff_kind: 'decision' })
  p.check('a hire with retired kickoff_kind succeeds', hire.ok, hire)
  if (hire.ok) {
    const kick = rig.one(`SELECT kind FROM ot.mail WHERE recipient_name = 'kindhire' AND body = 'KINDS kickoff case'`)
    p.check('the kickoff mail is stored as message', kick?.kind === 'message', kick)
  }
  return p.summary()
}
