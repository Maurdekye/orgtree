// Proof: the round-3 corrections to retool and continue-on (independent
// review R3 2026-10-13, findings 2 and 3), on the fake `muse serve` with
// per-login catalogs.
//   retool: with no account named, a level is checked on the login the seat's
//     next turn runs on: an account change queued behind a running turn. A
//     move from PV (Wonder low..high) to PF queued, max is taken (q1, and as
//     an agent's tool, q6); the inverse is refused with nothing changed (q2:
//     level, charter, the queued move); an account named overrides the queued
//     one (q3); a queued `default` is the own login (q4); with nothing queued
//     the bound login decides (q5).
//   continue-on: the user's route and the agent tool continue a frozen Muse
//     seat only on a login whose own catalog offers its exact model, pinned
//     version included: the own login without Full (f1), the Wonder-only PW
//     (f1), a login whose catalog cannot be read (f1) and a Spark-1.3-only
//     login or own login for a Spark 1.2 pin (f2) are refused with nothing
//     changed (binding, freeze, queued account, mail). The frozen seats'
//     choices leave out every login whose catalog lacks the model (one never
//     read or unreadable stays: continue-on reads it, then decides) and keep
//     the own login for a model it offers (f3). A login that offers the model
//     takes the seat, its held request replayed there (f1 on PF; f3 on the
//     own login, by the tool).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-r4-routes.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UPTO_XHIGH = ALL.slice(0, 5)
const W = 'muse-wonder-1.0', F = 'muse-wonder-full-1.0', S13 = 'muse-spark-1.3', S12 = 'muse-spark-1.2'
/** a catalog of [modelId, variants] rows, the first the default */
const catalogOf = (...rows) => JSON.stringify({ source: 'providerCatalog', models: rows.map(([id, variants = ALL], i) => ({
  modelId: id, profileId: 'tbh', isDefault: i === 0, variants, defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })) })
const AGENTS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'f1', 'f2', 'f3']
const HANGERS = ['q1', 'q2', 'q3', 'q4', 'q6']

export default async function (rig) {
  const p = new Proof('muse-r4-routes')
  const resetMs = Date.now() + 2 * 3600 * 1000
  rig.scenario({ agents: Object.fromEntries(AGENTS.map((n) => [n, { turns: [
    { name: 'moved', match: 'You now run on the account', steps: [{ text: 'Continuing on the other login.' }] },
    { name: 'wall', match: 'PROOF-WALL', once: true, steps: [{ text: 'Trying.' }, { quota: { resetsAtMs: resetMs } }] },
    { name: 'hang', match: 'MUSE-HANG', steps: [{ text: 'On it.' }, { hang: true }] },
  ] }])), default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })

  // ---------------------------------------------------------------- fixtures
  fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), catalogOf([W], [S13]))
  await rig.api('GET', '/api/muse/usage?force=true')
  /** a managed Muse profile whose own catalog is `rows` (or `fail`: unreadable), read once */
  const profile = async (rows, fail) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), fail ? JSON.stringify({ fail }) : catalogOf(...rows))
    await rig.api('GET', `/api/accounts/${id}/identity`).catch(() => null)
    return id
  }
  const settled = (pr) => pr.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  /** an orgtree_* tool as boss; a refusal settles as { ok: false, detail } */
  const tool = (name, args) => rig.tool('boss', name, args).then((r) => (r?.ok === false ? { ok: false, detail: r.text ?? '' } : { ok: true, r }),
    (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const op = (body) => settled(rig.op(body))
  const hire = async (name, tier, account, version) => {
    const h = await op({ op: 'hire', name, parent: 'boss', tier, title: 'Muse R4 agent', ...(account ? { account } : {}) })
    if (h.ok && version) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { model_version: version })
    return h
  }
  const row = (name) => rig.one(`SELECT id, account, frozen, charter, scope->>'effort' AS effort, pending_account
                                 FROM ot.agents WHERE name = '${name}' AND state = 'live'`) ?? {}
  const busy = async (name) => {
    await rig.userMail(name, 'MUSE-HANG')
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.name = '${name}' AND a.state = 'live' AND t.ended_at IS NULL`).length > 0, { what: `${name} mid-turn`, timeout: 30000 })
  }
  const wall = async (name) => {
    await rig.userMail(name, `PROOF-WALL: ${name}, please do the thing.`)
    await rig.waitFor(() => row(name).frozen, { what: `${name}'s wall`, timeout: 45000 })
    return row(name).frozen
  }
  const mails = (id) => rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id = ${id}`)?.n ?? 0
  const choices = async (name) => (await rig.api('GET', `/api/orgs/${rig.org}/nodes/${name}/detail`))?.continue_accounts ?? null
  const continueOn = (name, account) => settled(rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/continue-on`, { account }))

  const PW = await profile([[W]])
  const PV = await profile([[W, ['low', 'medium', 'high']]])
  const PF = await profile([[W], [F]])
  const PF2 = await profile([[F]])
  const PS = await profile([[S13], [S12, UPTO_XHIGH]])
  const PS13 = await profile([[S13]])
  const PU = await profile(null, 'rig: this login cannot be read')

  // ---------------------------------------------------------------- retool after a queued account move
  const hires = {}
  for (const [name, account] of [['q1', PV], ['q2', PF], ['q3', PV], ['q4', PV], ['q5', PV], ['q6', PV]]) hires[name] = await hire(name, 'wonder', account)
  for (const n of HANGERS) await busy(n)
  const queued = {
    q1: await op({ op: 'account', node: 'q1', account: PF }),
    q2: await op({ op: 'account', node: 'q2', account: PV }),
    q3: await op({ op: 'account', node: 'q3', account: PF }),
    q4: await op({ op: 'account', node: 'q4', account: 'default' }),
    q6: await op({ op: 'account', node: 'q6', account: PF }),
  }
  const r1 = await op({ op: 'retool', node: 'q1', effort: 'max' })
  p.check('retool: an account move PV→PF queued behind the turn, an effort-only max is checked on PF (taken; the seat still on PV, PF still queued)',
    hires.q1.ok && queued.q1.ok && r1.ok && row('q1').effort === 'max' && row('q1').account === PV && row('q1').pending_account?.account === PF,
    { queued: queued.q1, r1, q1: row('q1') })
  const q2before = row('q2')
  const r2 = await op({ op: 'retool', node: 'q2', effort: 'max', charter: 'MUSE-R4: a charter that must not land' })
  const q2after = row('q2')
  p.check('retool: the inverse (PF→PV queued) is refused on PV and nothing changes: level, charter, the queued move',
    hires.q2.ok && queued.q2.ok && !r2.ok && r2.status === 400 && /muse-wonder-1\.0 takes the effort levels low, medium, high/.test(r2.detail ?? '')
      && q2after.effort === q2before.effort && q2after.charter === q2before.charter && q2after.pending_account?.account === PV,
    { r2, q2before, q2after })
  const r3 = await op({ op: 'retool', node: 'q3', account: PV, effort: 'max' })
  const q3mid = row('q3')
  const r3b = await op({ op: 'retool', node: 'q3', account: PF, effort: 'max' })
  p.check('retool: an account named overrides the queued one (PV named: max refused, PF still queued; PF named: taken)',
    hires.q3.ok && queued.q3.ok && !r3.ok && r3.status === 400 && q3mid.pending_account?.account === PF && q3mid.effort === null
      && r3b.ok && row('q3').effort === 'max', { r3, q3mid, r3b, q3: row('q3') })
  const r4 = await op({ op: 'retool', node: 'q4', effort: 'max' })
  p.check('retool: a queued `default` is the own login (Wonder with max): an effort-only max is taken',
    hires.q4.ok && queued.q4.ok && r4.ok && row('q4').effort === 'max' && ['primary', 'muse/primary'].includes(row('q4').pending_account?.account),
    { queued: queued.q4, r4, q4: row('q4') })
  const r5 = await op({ op: 'retool', node: 'q5', effort: 'max' })
  const r5b = await op({ op: 'retool', node: 'q5', effort: 'high' })
  p.check('retool: with nothing queued the bound login decides (PV: max refused, high taken)',
    hires.q5.ok && !r5.ok && r5.status === 400 && r5b.ok && row('q5').effort === 'high' && row('q5').pending_account === null, { r5, r5b, q5: row('q5') })
  const r6 = await tool('orgtree_retool', { node: 'q6', effort: 'max' })
  p.check('retool (agent tool): after a queued PV→PF move, an effort-only max is checked on PF and taken',
    hires.q6.ok && queued.q6.ok && r6.ok && row('q6').effort === 'max' && row('q6').pending_account?.account === PF, { r6, q6: row('q6') })
  for (const n of HANGERS) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${n}/interrupt`, {}).catch(() => null)

  // ---------------------------------------------------------------- continue-on
  const f1h = await hire('f1', 'wonder-full', PF2)
  const f2h = await hire('f2', 'spark', PS, '1.2')
  const f3h = await hire('f3', 'wonder', PW)
  const walls = { f1: await wall('f1'), f2: await wall('f2'), f3: await wall('f3') }
  const f1 = row('f1')
  // a queued account on the frozen seat (fixture): a refusal must leave it
  rig.exec(`UPDATE ot.agents SET pending_account = '{"account": "${PF}", "from": "${PF2}", "seq": 1, "by": "@user"}'::jsonb WHERE id = ${f1.id}`)
  const snap = (name) => { const r = row(name); return JSON.stringify({ a: r.account, f: r.frozen, q: r.pending_account, m: mails(r.id) }) }
  const s1 = snap('f1')
  const n1 = await continueOn('f1', 'muse/primary')
  const n2 = await tool('orgtree_continue_on', { node: 'f1', account: PW })
  const n3 = await continueOn('f1', PU)
  const s1after = snap('f1')
  p.check('continue-on: a frozen Full seat is refused on the own login (route), on Wonder-only PW (tool) and on an unreadable login, with nothing changed',
    f1h.ok && walls.f1?.limit === true && !n1.ok && n1.status === 409 && /does not offer muse-wonder-full-1\.0/.test(n1.detail ?? '')
      && !n2.ok && /does not offer muse-wonder-full-1\.0/.test(n2.detail ?? '') && !n3.ok && n3.status === 409 && /catalog is unknown/.test(n3.detail ?? '')
      && s1after === s1, { n1, n2, n3, before: s1, after: s1after })
  const s2 = snap('f2')
  const n4 = await tool('orgtree_continue_on', { node: 'f2', account: PS13 })
  const n5 = await continueOn('f2', 'muse/primary')
  p.check('continue-on: a seat pinned to Spark 1.2 is refused on a Spark-1.3-only login (tool) and on the own login (route), with nothing changed',
    f2h.ok && !!walls.f2 && !n4.ok && /does not offer muse-spark-1\.2/.test(n4.detail ?? '') && !n5.ok && n5.status === 409
      && /does not offer muse-spark-1\.2/.test(n5.detail ?? '') && snap('f2') === s2, { n4, n5 })
  const c1 = await choices('f1'), c2 = await choices('f2'), c3 = await choices('f3')
  p.check("choices: a frozen seat is offered only logins whose own catalog may offer its exact model (unreadable PU stays); the own login only for a model it offers",
    Array.isArray(c1) && c1.includes(PF) && !c1.includes('muse/primary') && ![PW, PV, PS, PS13].some((a) => c1.includes(a)) && c1.includes(PU)
      && Array.isArray(c2) && !c2.includes('muse/primary') && ![PS13, PW, PV, PF, PF2].some((a) => c2.includes(a))
      && Array.isArray(c3) && c3.includes('muse/primary') && c3.includes(PF) && c3.includes(PV) && ![PF2, PS, PS13].some((a) => c3.includes(a)),
    { f1: c1, f2: c2, f3: c3 })
  const p1 = await continueOn('f1', PF)
  await rig.waitTurns('f1', 2, { timeout: 45000 }).catch(() => null)
  const start = rig.fakeLog('f1').filter((l) => l.kind === 'start').at(-1)
  const pfDir = path.basename(rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${PF}'`)?.config_dir ?? 'none')
  const replayed = rig.fakeLog('f1').filter((l) => l.kind === 'turn').slice(1).some((l) => (l.prompt ?? '').includes('PROOF-WALL'))
  const p2 = await tool('orgtree_continue_on', { node: 'f3', account: 'muse/primary' })
  p.check('continue-on: a login that offers the model takes the seat (Full on PF by the route, run there with its request replayed; Wonder on the own login by the tool)',
    p1.ok && row('f1').account === PF && row('f1').frozen === null && row('f1').pending_account === null && (start?.xdg_config ?? '').includes(pfDir) && replayed
      && f3h.ok && p2.ok && row('f3').account === null && row('f3').frozen === null, { p1, start: start?.xdg_config ?? null, replayed, p2, f3: row('f3') })

  p.keep(rig, { agents: ['q1', 'q2', 'q3', 'q6', 'f1', 'f2', 'f3'], grep: /muse|effort|account|continu/i })
  return p.summary()
}
