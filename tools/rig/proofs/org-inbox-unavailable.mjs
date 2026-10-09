// Proof: outside mail when the org-inbox holder cannot run (user 2026-10-09
//   07:03Z: if the holder is halted or frozen, outside mail goes to another
//   active agent who can take it, usually the first live top-level agent,
//   and nothing is lost; decision 59).
//   A is the rig org: boss (top level) and alice under him, plus fay (a
//   Codex report a usage limit freezes), dan (a report) and cleo (a second
//   top-level agent). B is a second org; zoe writes to A from there.
//   1. alice holds A's inbox and is halted: zoe's @org mail goes to boss,
//      the first top-level agent who can run, and his turn takes it. alice
//      keeps the audience and gets no copy; zoe is told it reached boss.
//   2. the same over the mail hub (@net): boss gets it.
//   3. fay holds it and is frozen by a usage limit: boss gets it.
//   4. fay frozen and boss halted: cleo, the next top-level agent, gets it.
//   5. multi-holder, fay (frozen) and dan (can run) hold it: dan gets it.
//   6. the holders retired and boss halted: the inbox goes to cleo, the
//      first top-level agent who can run, not to boss.
//   7. nobody can run (every top-level agent halted): the mail waits with
//      the holder, the user is told, and it is read once cleo is unhalted.
//   Every message is in A's org inbox.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-inbox-unavailable.mjs

import { Proof } from '../proof.mjs'

const LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later."

export default async function (rig) {
  const p = new Proof('org-inbox-unavailable')
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  rig.scenario({
    agents: {
      fay: { turns: [{ name: 'limited', match: 'PROOF-FREEZE', once: true, steps: [
        { rate_limit: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAt },
                        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: resetAt + 86400 } } },
        { error: { message: LIMIT, codexErrorInfo: 'usageLimitExceeded' } },
      ] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const A = rig.org
  await rig.op({ op: 'hire', name: 'fay', parent: 'boss', tier: 'luna', title: 'Codex holder' })
  await rig.op({ op: 'hire', name: 'dan', parent: 'boss', tier: 'haiku', title: 'Second holder' })
  await rig.op({ op: 'hire', name: 'cleo', tier: 'haiku', title: 'Second lead', grant: 5 })
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig Writer Org', dirs: [], net_autoconnect: false })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', title: 'B lead', grant: 5 }, { org: B })

  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`).id
  // the holders as the org inbox shows them (a retired agent keeps its grant row for a rehire)
  const holders = () => rig.sql(`SELECT DISTINCT au.grantee FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
    WHERE au.org_id = ${orgId(A)} AND au.grantor = '@extern' AND au.revoked_at IS NULL AND a.state = 'live' ORDER BY au.grantee`).map(r => r.grantee)
  // which of A's agents got a copy of a message, and in what state
  const copies = text => Object.fromEntries(rig.sql(`SELECT a.name, m.state FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.org_id = ${orgId(A)} AND m.recipient_kind = 'agent' AND m.body LIKE '%${text}%' ORDER BY m.id`).map(r => [r.name, r.state]))
  const inInbox = text => rig.sql(`SELECT 1 FROM ot.org_inbox WHERE org_id = ${orgId(A)} AND dir = 'in' AND body LIKE '%${text}%'`).length === 1
  const fromZoe = text => rig.tool('zoe', 'orgtree_message', { to: `@org:${A}`, body: `${text} from zoe` }, { org: B })
  const fromHub = (id, text) => rig.api('POST', '/api/rig/hub-mail', { org: A, op: 'inbound', id, body: `${text} over the hub` })
  // a turn took the copy (it left 'pending'); false when nothing reads it within the wait
  const taken = (name, text, timeout = 30000) => rig.waitFor(() => {
    const s = copies(text)[name]
    return s && s !== 'pending' ? s : null
  }, { what: `${name} to take ${text}`, timeout }).then(s => s, () => false)
  const halt = async (...nodes) => {
    await rig.op({ op: 'halt', nodes })
    await rig.waitFor(() => nodes.every(n => rig.agentRow(n)?.halt?.phase === 'halted'), { what: `${nodes} halted`, timeout: 30000 })
  }
  const grant = (node, reason) => rig.api('POST', `/api/orgs/${A}/audiences`, { action: 'grant', node, target: 'extern', reason })

  // ---------------------------------------------------------------- 1. halted holder (@org)
  await grant('alice', 'proof: alice holds the org inbox')
  await halt('alice')
  const s1 = await fromZoe('ORGIN-HALTED')
  const t1 = await taken('boss', 'ORGIN-HALTED')
  const c1 = copies('ORGIN-HALTED')
  p.check('1. alice (holder) halted: zoe\'s @org mail goes to boss, the first top-level agent who can run, and his turn takes it',
    s1.ok && !!t1 && inInbox('ORGIN-HALTED'), { copies: c1, taken: t1, sent: s1.text })
  p.check('1. alice keeps the audience and gets no copy; zoe is told it reached boss',
    holders().join(',') === 'alice' && !('alice' in c1) && /and to boss\b/.test(s1.text ?? ''), { holders: holders(), copies: c1, sent: s1.text })

  // ---------------------------------------------------------------- 2. halted holder (@net)
  await fromHub('net-halted', 'ORGIN-NET')
  const t2 = await taken('boss', 'ORGIN-NET')
  const c2 = copies('ORGIN-NET')
  p.check('2. the same over the mail hub: boss gets it and his turn takes it; alice gets no copy',
    !!t2 && !('alice' in c2) && inInbox('ORGIN-NET'), { copies: c2, taken: t2 })

  // ---------------------------------------------------------------- 3. frozen holder
  await grant('fay', 'proof: fay holds the org inbox')
  await rig.userMail('fay', 'PROOF-FREEZE: please do the limited thing.')
  const fz = await rig.waitFor(() => rig.agentRow('fay')?.frozen, { what: 'fay to be frozen', timeout: 60000 })
  const s3 = await fromZoe('ORGIN-FROZEN')
  const t3 = await taken('boss', 'ORGIN-FROZEN')
  const c3 = copies('ORGIN-FROZEN')
  p.check('3. fay (holder) frozen by a usage limit: boss gets it and his turn takes it; fay gets no copy and keeps the audience',
    fz?.limit === true && !!t3 && !('fay' in c3) && holders().join(',') === 'fay' && inInbox('ORGIN-FROZEN'),
    { frozen: { limit: fz?.limit, until: fz?.until }, copies: c3, taken: t3, holders: holders(), sent: s3.text })

  // ---------------------------------------------------------------- 4. frozen holder, first top-level halted
  await halt('boss')
  const s4 = await fromZoe('ORGIN-BOTH')
  const t4 = await taken('cleo', 'ORGIN-BOTH')
  const c4 = copies('ORGIN-BOTH')
  p.check('4. fay frozen and boss halted: cleo, the next top-level agent, gets it and her turn takes it',
    !!t4 && !('fay' in c4) && !('boss' in c4) && inInbox('ORGIN-BOTH'), { copies: c4, taken: t4, sent: s4.text })

  // ---------------------------------------------------------------- 5. multi-holder
  await rig.api('POST', `/api/orgs/${A}/settings`, { org_inbox_multi_holder: true })
  await grant('dan', 'proof: dan holds it too')
  const s5 = await fromZoe('ORGIN-MULTI')
  const t5 = await taken('dan', 'ORGIN-MULTI')
  const c5 = copies('ORGIN-MULTI')
  p.check('5. multi-holder, fay (frozen) and dan hold it: dan, the holder who can run, gets it; fay gets no copy and no top-level agent is drawn in',
    holders().join(',') === 'dan,fay' && !!t5 && !('fay' in c5) && !('cleo' in c5) && !('boss' in c5),
    { holders: holders(), copies: c5, taken: t5, sent: s5.text })

  // ---------------------------------------------------------------- 6. holders retired, boss halted
  await rig.op({ op: 'retire', node: 'dan' })
  await rig.op({ op: 'retire', node: 'fay' })
  const s6 = await fromZoe('ORGIN-RETIRED')
  const t6 = await taken('cleo', 'ORGIN-RETIRED')
  const c6 = copies('ORGIN-RETIRED')
  p.check('6. holders retired and boss halted: the inbox goes to cleo, the first top-level agent who can run, not to boss',
    holders().join(',') === 'cleo' && !!t6 && !('boss' in c6), { holders: holders(), copies: c6, taken: t6, sent: s6.text })

  // ---------------------------------------------------------------- 7. nobody can run
  await halt('cleo')
  const userNotes = () => rig.sql(`SELECT body FROM ot.mail WHERE org_id = ${orgId(A)} AND recipient_kind = 'user' AND sender = '@system'
    AND ev->>'variant' = 'runtime.external_unroutable' AND ev->>'excerpt' LIKE '%ORGIN-NOBODY%'`)
  const s7 = await fromZoe('ORGIN-NOBODY')
  const c7 = copies('ORGIN-NOBODY')
  const told = await rig.waitFor(() => userNotes()[0], { what: 'the user to be told', timeout: 15000 }).catch(() => null)
  p.check('7. every top-level agent halted: the mail waits with the holder and the user is told nobody can read it now',
    inInbox('ORGIN-NOBODY') && Object.values(c7).includes('pending') && !!told, { copies: c7, told: told?.body, sent: s7.text })
  await rig.op({ op: 'unhalt', nodes: ['cleo'] })
  const t7 = await taken('cleo', 'ORGIN-NOBODY')
  p.check('7. nothing is lost: once cleo is unhalted her turn takes it', !!t7, { copies: copies('ORGIN-NOBODY'), taken: t7 })

  p.keep(rig, { agents: ['boss', 'alice', 'fay', 'dan', 'cleo'] })
  return p.summary()
}
