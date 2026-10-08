// Proof: the tree operations that move credits, against 3.x's §4.5/§4.6
// rules. After every operation no live agent holds less than its reports'
// seats and grants (no overdraft).
//   move: the credits travel along the path through the lowest common
//         ancestor, so every agent's free credits stay exactly the same
//         (between teams, to the top level and back).
//   retire: the superior gets the seat and grant back; retiring an agent
//         with live reports archives its whole team (3.x: retire becomes
//         dissolve, and says so); an archived agent retired again is a no-op.
//   dissolve: the whole subtree is archived and its stake returns.
//   rehire: the superior pays seat and grant again; a live agent is a no-op.
//   reallocate: a raise beyond the superior's free credits raises the chain
//         above it; a cut below what the agent's reports hold is refused.
//   swap: two agents exchange seats (superior, reports and grant stay with
//         the seat), and each superior pays only the seat price difference.
//   self-subjugate: a report rises into its superior's seat with its own
//         team, and the former superior reports to it.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/tree-credits.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('tree-credits')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const ORG = `(SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active')`
  const op = body => rig.op(body).then(r => ({ ok: true, r }), e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 240) }))
  const hire = (name, parent, grant, tier = 'haiku') => rig.op({ op: 'hire', name, ...(parent ? { parent } : {}), tier, grant, title: name })
  // every agent's grant, seat, parent and free credits (grant minus what its live reports hold)
  const ledger = () => {
    const rows = rig.sql(`SELECT a.name, a.state, a.grant_credits::float8 AS grant, a.seat::float8 AS seat, p.name AS parent,
      a.grant_credits::float8 - coalesce((SELECT sum(c.seat + c.grant_credits) FROM ot.agents c WHERE c.parent_id = a.id AND c.state = 'live'), 0)::float8 AS free
      FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.org_id = ${ORG} AND a.state <> 'deleted'`)
    return Object.fromEntries(rows.map(r => [r.name, r]))
  }
  const overdrawn = () => Object.values(ledger()).filter(a => a.state === 'live' && a.free < -1e-6).map(a => `${a.name}:${a.free}`)
  const near = (a, b) => Math.abs(a - b) < 1e-6
  const sameFree = (before, after, names) => names.every(n => near(before[n].free, after[n].free))

  // boss (top) > pm (10) > dev1 (2), dev2 (0); boss > qa (3)
  await hire('pm', 'boss', 10)
  await hire('dev1', 'pm', 2)
  await hire('dev2', 'pm', 0)
  await hire('qa', 'boss', 3)
  const L0 = ledger()
  p.note('start', Object.fromEntries(Object.entries(L0).map(([k, v]) => [k, { grant: v.grant, seat: v.seat, free: v.free }])))
  p.check('the seeded ledger has no overdraft', overdrawn().length === 0, overdrawn())

  // ---------------------------------------------------------------- move
  const m1 = await op({ op: 'move', node: 'dev1', new_parent: 'qa' })
  const L1 = ledger()
  const stake = L0.dev1.seat + L0.dev1.grant
  p.check('move between teams: every agent\'s free credits stay the same; pm gives the stake to qa', m1.ok
    && sameFree(L0, L1, ['boss', 'pm', 'qa', 'dev1']) && near(L1.pm.grant, L0.pm.grant - stake) && near(L1.qa.grant, L0.qa.grant + stake)
    && L1.dev1.parent === 'qa', { m1: m1.ok || m1.detail, pm: [L0.pm.grant, L1.pm.grant], qa: [L0.qa.grant, L1.qa.grant] })
  const m2 = await op({ op: 'move', node: 'dev1', new_parent: 'user' })
  const L2 = ledger()
  p.check('move to the top level: the old chain releases the stake and nobody\'s free credits change', m2.ok && !L2.dev1.parent
    && sameFree(L1, L2, ['boss', 'qa', 'dev1']) && near(L2.qa.grant, L1.qa.grant - stake) && near(L2.boss.grant, L1.boss.grant - stake),
  { m2: m2.ok || m2.detail, qa: [L1.qa.grant, L2.qa.grant], boss: [L1.boss.grant, L2.boss.grant] })
  const m3 = await op({ op: 'move', node: 'dev1', new_parent: 'pm' })
  const L3 = ledger()
  p.check('move from the top level back under pm: the new chain is raised by the stake, nobody\'s free credits change', m3.ok
    && L3.dev1.parent === 'pm' && sameFree(L2, L3, ['boss', 'pm', 'dev1']) && near(L3.pm.grant, L2.pm.grant + stake),
  { m3: m3.ok || m3.detail, pm: [L2.pm.grant, L3.pm.grant] })
  p.check('no overdraft after the moves', overdrawn().length === 0, overdrawn())

  // ---------------------------------------------------------------- retire, dissolve, rehire
  const r1 = await op({ op: 'retire', node: 'dev2' })
  const L4 = ledger()
  p.check('retire: pm gets dev2\'s seat and grant back', r1.ok && L4.dev2.state === 'archived'
    && near(L4.pm.free, L3.pm.free + L3.dev2.seat + L3.dev2.grant), { pm: [L3.pm.free, L4.pm.free] })
  const r1b = await op({ op: 'retire', node: 'dev2' })
  p.check('retiring an archived agent again is a no-op that says so', r1b.ok && /already archived/.test(JSON.stringify(r1b.r?.warnings ?? '')), r1b)
  const h1 = await op({ op: 'rehire', node: 'dev2', grant: 1 })
  const L5 = ledger()
  p.check('rehire: dev2 is live again under pm, who pays her seat and grant', h1.ok && L5.dev2.state === 'live' && L5.dev2.parent === 'pm'
    && near(L5.dev2.grant, 1) && near(L5.pm.free, L4.pm.free - L5.dev2.seat - 1), { h1: h1.ok || h1.detail, pm: [L4.pm.free, L5.pm.free] })
  const h2 = await op({ op: 'rehire', node: 'dev2' })
  p.check('rehiring a live agent is a no-op that says so', h2.ok && /already live/.test(JSON.stringify(h2.r ?? '')), h2)

  // ---------------------------------------------------------------- reallocate
  const L6 = ledger()
  const ra = await op({ op: 'reallocate', node: 'dev1', delta: L6.pm.free + 4 })
  const L7 = ledger()
  p.check('reallocate beyond pm\'s free credits raises the chain above (pm, then boss) and leaves no overdraft', ra.ok
    && near(L7.dev1.grant, L6.dev1.grant + L6.pm.free + 4) && L7.pm.grant > L6.pm.grant && overdrawn().length === 0,
  { ra: ra.ok || ra.detail, dev1: [L6.dev1.grant, L7.dev1.grant], pm: [L6.pm.grant, L7.pm.grant] })
  const cut = await op({ op: 'reallocate', node: 'pm', delta: -(L7.pm.free + 1) })
  p.check('a cut below what pm\'s reports hold is refused', !cut.ok && near(ledger().pm.grant, L7.pm.grant), cut)

  // ---------------------------------------------------------------- swap
  await hire('lead', 'boss', 2, 'sonnet')
  const L8 = ledger()
  const sw = await op({ op: 'swap', a: 'pm', b: 'lead' })
  const L9 = ledger()
  p.check('swap: pm and lead exchange seats (reports and grant stay with the seat)', sw.ok && L9.dev1.parent === 'lead' && L9.dev2.parent === 'lead'
    && near(L9.lead.grant, L8.pm.grant) && near(L9.pm.grant, L8.lead.grant), { sw: sw.ok || sw.detail, lead: [L8.lead.grant, L9.lead.grant], pm: [L8.pm.grant, L9.pm.grant] })
  p.check('swap: boss pays only the seat price difference and no one is overdrawn', sw.ok
    && near(L9.boss.free, L8.boss.free) && overdrawn().length === 0, { boss: [L8.boss.free, L9.boss.free], seats: [L8.pm.seat, L8.lead.seat], overdrawn: overdrawn() })

  // a cross-tier swap between two teams whose payer has no room is refused, and nothing changes
  await hire('p1', 'boss', 0.5)
  await hire('ua', 'p1', 0)
  await hire('p2', 'boss', 2)
  await hire('ub', 'p2', 0, 'sonnet')
  const LA = ledger()
  const sw2 = await op({ op: 'swap', a: 'ua', b: 'ub' })
  const LB = ledger()
  p.check('swap across teams that p1 cannot pay for (a dearer seat, no free credits) is refused and changes nothing (3.x: reallocate first)',
    !sw2.ok && /reallocate first/.test(sw2.detail ?? '') && ['p1', 'p2', 'boss', 'ua', 'ub'].every(n => near(LA[n].grant, LB[n].grant) && LA[n].parent === LB[n].parent),
  { sw2: sw2.ok ? sw2.r : sw2.detail, p1: [LA.p1.grant, LB.p1.grant], boss: [LA.boss.grant, LB.boss.grant] })

  // ---------------------------------------------------------------- self-subjugate
  const ss = await rig.tool('lead', 'orgtree_self_subjugate', { target: 'dev1' })
  const L10 = ledger()
  p.check('self-subjugate: dev1 rises into lead\'s seat with his own team, lead reports to him, no overdraft', ss.ok && L10.dev1.parent === 'boss'
    && L10.lead.parent === 'dev1' && L10.dev2.parent === 'lead' && overdrawn().length === 0, { text: ss.text?.slice(0, 200), dev1: L10.dev1.parent, lead: L10.lead.parent, dev2: L10.dev2.parent, overdrawn: overdrawn() })

  // ---------------------------------------------------------------- retire with a team, dissolve
  const before = ledger()
  const r2 = await op({ op: 'retire', node: 'dev1' })
  const L11 = ledger()
  const teamStake = before.dev1.seat + before.dev1.grant
  p.check('retire with live reports archives the whole team and says it became a dissolve (3.x)', r2.ok
    && ['dev1', 'lead', 'dev2'].every(n => L11[n].state === 'archived') && /dissolve/.test(JSON.stringify(r2.r?.warnings ?? '')),
  { r2: r2.r ?? r2.detail, states: ['dev1', 'lead', 'dev2'].map(n => L11[n].state) })
  p.check('and boss gets the whole team\'s stake back', near(L11.boss.free, before.boss.free + teamStake), { boss: [before.boss.free, L11.boss.free], teamStake })
  await hire('ops', 'qa', 1)
  const before2 = ledger()
  const d1 = await op({ op: 'dissolve', node: 'qa' })
  const L12 = ledger()
  p.check('dissolve: qa and her report are archived and boss gets qa\'s stake back', d1.ok && L12.qa.state === 'archived' && L12.ops.state === 'archived'
    && near(L12.boss.free, before2.boss.free + before2.qa.seat + before2.qa.grant) && overdrawn().length === 0, { boss: [before2.boss.free, L12.boss.free] })

  // ---------------------------------------------------------------- an archived agent moves for free
  const before3 = ledger()
  const ma = await op({ op: 'move', node: 'ops', new_parent: 'p2' })
  const L13 = ledger()
  p.check('an archived agent can be moved: free, no credits change, and it says its rehire cost now falls on the new superior (3.x)', ma.ok
    && L13.ops.parent === 'p2' && L13.ops.state === 'archived' && Object.keys(before3).every(n => near(before3[n].grant, L13[n].grant))
    && /archived: moving it is free/.test(JSON.stringify(ma.r?.warnings ?? '')), { ma: ma.r ?? ma.detail })
  const back = await op({ op: 'rehire', node: 'ops' })
  const L14 = ledger()
  p.check('rehired, it comes back under the new superior, whose hold now includes it (raised as needed), with no overdraft', back.ok && L14.ops.state === 'live' && L14.ops.parent === 'p2'
    && overdrawn().length === 0 && near(L14.p2.grant - L14.p2.free, L13.p2.grant - L13.p2.free + L14.ops.seat + L14.ops.grant),
  { back: back.ok || back.detail, p2: [L13.p2.grant, L13.p2.free, L14.p2.grant, L14.p2.free] })

  p.keep(rig, { agents: [], grep: /reallocate|move|retire|dissolve|swap|subjugat|rehire/i })
  return p.summary()
}
