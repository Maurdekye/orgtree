// Proof: the round-2 corrections (independent review 2026-10-13) and the
// removal of a registered Muse login, on the fake `muse serve` with
// per-login catalogs and account answers.
//   retool: an account and an effort named together are checked on the
//     login the seat lands on: A (Wonder through high) to B with max is
//     taken; B to A with max is refused and nothing changes (account,
//     effort, charter); `primary`, `muse/primary` and `default` are the own
//     login; naming the account the seat is on checks it there; an unknown
//     account is refused as such.
//   busy: a seat mid-turn queues the account and the level is checked on
//     the queued login (a retool naming both, and the settings route after a
//     queued move).
//   payload: /api/providers lists Full while the own login lacks it, saying
//     which logins offer it, and each login's levels (`muse.logins`: a
//     profile's Wonder through high, Spark 1.2 through xhigh); with the own
//     login signed out a registered login's offer leaves Muse hirable.
//   staffing: accounts carry their kind (a key is `apikey`) and a Muse login
//     its own levels; a tier's levels are every level some login takes.
//   placement: with the own login switched off for the org, an omitted
//     account is placed on the best allowed login that offers the model,
//     never on one that does not (which sorts first here).
//   removal: a registered Muse login can be removed: its seat moves to the
//     own login where that offers its exact model, pin included, else to the
//     first other subscription login that does (independent review R3: the
//     Full seat to PF, the Spark 1.2 seat to PS; muse-r4-removal.mjs has the
//     rest); the org default naming it moves to the own login.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-r2.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UPTO_XHIGH = ALL.slice(0, 5)
const W = 'muse-wonder-1.0', F = 'muse-wonder-full-1.0', S13 = 'muse-spark-1.3', S12 = 'muse-spark-1.2'
/** a catalog of [modelId, variants] rows, the first the default */
const catalogOf = (...rows) => JSON.stringify({ source: 'providerCatalog', models: rows.map(([id, variants = ALL], i) => ({
  modelId: id, profileId: 'tbh', isDefault: i === 0, variants, defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })) })
const HANGERS = ['bq', 'bs']

export default async function (rig) {
  const p = new Proof('muse-r2')
  rig.scenario({
    agents: Object.fromEntries(HANGERS.map((n) => [n, { turns: [{ name: 'hang', match: 'MUSE-HANG', steps: [{ text: 'On it.' }, { hang: true }] }] }])),
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })

  const refresh = () => rig.api('GET', '/api/muse/usage?force=true')
  const ownCatalog = async (...rows) => { fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), catalogOf(...rows)); await refresh() }
  const ownAccount = async (doc) => {
    const f = path.join(rig.fakeDir, 'muse-account.json')
    if (doc) fs.writeFileSync(f, JSON.stringify(doc)); else fs.rmSync(f, { force: true })
    await refresh()
  }
  /** a managed profile offering `rows` (its own catalog), read once */
  const profile = async (rows) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), catalogOf(...rows))
    await rig.api('GET', `/api/accounts/${id}/identity`).catch(() => null)
    return id
  }
  const settled = (pr) => pr.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const op = (body) => settled(rig.op(body))
  const hire = (name, tier, extra = {}) => op({ op: 'hire', name, parent: 'boss', tier, title: 'Muse R2 agent', ...extra })
  const scope = (name, body) => settled(rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, body))
  const row = (name) => rig.one(`SELECT account, scope->>'effort' AS effort, charter, frozen, pending_account->>'account' AS pending
                                 FROM ot.agents WHERE name = '${name}' AND state = 'live'`) ?? {}
  const settings = (body) => rig.api('POST', `/api/orgs/${rig.org}/settings`, body)
  const muse = async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse')
  const busy = (name) => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
    WHERE a.name = '${name}' AND a.state = 'live' AND t.ended_at IS NULL`).length > 0, { what: `${name} mid-turn`, timeout: 30000 })

  // ---------------------------------------------------------------- the logins
  // the own login lacks Full; the Wonder-only profile is created FIRST so it
  // is the first login every ordering without a catalog check would pick
  await ownCatalog([W], [S13], [S12, UPTO_XHIGH])
  const PW = await profile([[W]])
  const PF = await profile([[W], [F]])
  const PV = await profile([[W, ['low', 'medium', 'high']]])
  const PS = await profile([[S13], [S12, UPTO_XHIGH]])
  const KF = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'apikey', key: 'muse-rig-not-a-real-key' })).id
  const keyConfig = path.join(rig.data, 'profiles', `muse-key-${KF}`, 'config')
  fs.mkdirSync(keyConfig, { recursive: true })
  fs.writeFileSync(path.join(keyConfig, 'muse-catalog.json'), catalogOf([F]))
  // the staffing read refreshes every stale registered login (the key's first read)
  const opts = await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)

  // ---------------------------------------------------------------- the payload
  let m = await muse()
  const fullRow = m?.tiers?.find((t) => t.tier === 'wonder-full')
  p.check('payload: Full is listed though the own login lacks it, saying which logins offer it (the profile and the key, not the Wonder-only one)',
    !!fullRow && fullRow.own === false && fullRow.logins?.includes(PF) && fullRow.logins?.includes(KF) && !fullRow.logins?.includes(PW), { fullRow })
  const doc = (id) => m?.muse?.logins?.find((l) => l.account === id)
  p.check('payload: each login\'s own levels: the own login ready without Full, a profile\'s Wonder through high, Spark 1.2 through xhigh and 1.3 with max',
    doc(null)?.state === 'ready' && !doc(null)?.tiers?.['wonder-full'] && doc(null)?.tiers?.wonder?.latest?.efforts?.includes('max')
      && JSON.stringify(doc(PV)?.tiers?.wonder?.latest?.efforts) === JSON.stringify(['low', 'medium', 'high'])
      && JSON.stringify(doc(PS)?.tiers?.spark?.versions?.['1.2']?.efforts) === JSON.stringify(UPTO_XHIGH)
      && doc(PS)?.tiers?.spark?.latest?.efforts?.includes('max') && doc(KF)?.kind === 'apikey',
    { own: doc(null), PV: doc(PV), PS: doc(PS), KF: doc(KF) })

  // ---------------------------------------------------------------- staffing
  const tierOf = (t) => (opts?.tiers ?? []).find((x) => x.tier === t)
  const acc = (t, id) => tierOf(t)?.accounts?.find((a) => a.id === id)
  p.check('staffing: accounts carry their kind and a Muse login its own levels; the tier\'s levels are every level a login takes',
    acc('wonder-full', KF)?.kind === 'apikey' && acc('wonder-full', PF)?.kind === 'subscription'
      && JSON.stringify(acc('wonder', PV)?.efforts) === JSON.stringify(['low', 'medium', 'high']) && acc('wonder', PF)?.efforts?.includes('max')
      && tierOf('wonder')?.efforts?.includes('max'), { full: tierOf('wonder-full'), wonder: tierOf('wonder') })

  // ---------------------------------------------------------------- retool: account and effort together
  const ra = await hire('ra', 'wonder', { account: PV })
  const ab = await op({ op: 'retool', node: 'ra', account: PF, effort: 'max' })
  p.check('retool A→B with max: the level is checked on B, where the seat lands (taken: account B, effort max)',
    ra.ok && ab.ok && row('ra').account === PF && row('ra').effort === 'max', { ra, ab, after: row('ra') })
  const rb = await hire('rb', 'wonder', { account: PF })
  const before = row('rb')
  const ba = await op({ op: 'retool', node: 'rb', account: PV, effort: 'max', charter: 'MUSE-R2: a charter that must not land' })
  const after = row('rb')
  p.check('retool B→A with max: refused on A (its Wonder takes low..high) and nothing changes: account, effort, charter',
    rb.ok && !ba.ok && ba.status === 400 && /muse-wonder-1\.0 takes the effort levels low, medium, high/.test(ba.detail ?? '')
      && after.account === PF && after.effort === before.effort && after.charter === before.charter, { ba, before, after })
  const aliased = []
  for (const [name, alias] of [['rc', 'primary'], ['rd', 'muse/primary'], ['re', 'default']]) {
    const h = await hire(name, 'wonder', { account: PV })
    const r = await op({ op: 'retool', node: name, account: alias, effort: 'max' })
    aliased.push({ name, alias, hired: h.ok, ok: r.ok, detail: r.detail, ...row(name) })
  }
  p.check('retool aliases: primary, muse/primary and default are the own login, whose Wonder takes max (taken, the seat unbound)',
    aliased.every((x) => x.hired && x.ok && x.account === null && x.effort === 'max'), aliased)
  const rf = await hire('rf', 'wonder', { account: PV })
  const sameMax = await op({ op: 'retool', node: 'rf', account: PV, effort: 'max' })
  const sameHigh = await op({ op: 'retool', node: 'rf', account: PV, effort: 'high' })
  const unknown = await op({ op: 'retool', node: 'rf', account: 'muse-nope', effort: 'high' })
  p.check('retool naming the account the seat is on is checked there (max refused, high taken); an unknown account is refused as such',
    rf.ok && !sameMax.ok && sameMax.status === 400 && sameHigh.ok && row('rf').effort === 'high' && row('rf').account === PV
      && !unknown.ok && unknown.status === 404 && /no account muse-nope/.test(unknown.detail ?? ''), { sameMax, sameHigh, unknown })

  // ---------------------------------------------------------------- busy seats: the queue stands
  const bq = await hire('bq', 'wonder', { account: PV })
  await rig.userMail('bq', 'MUSE-HANG')
  await busy('bq')
  const bqr = await op({ op: 'retool', node: 'bq', account: PF, effort: 'max' })
  p.check('busy: a retool naming B with max queues B behind the turn (the seat stays on A) and checks max on B',
    bq.ok && bqr.ok && row('bq').pending === PF && row('bq').account === PV && row('bq').effort === 'max', { bqr, row: row('bq') })
  const bs = await hire('bs', 'wonder', { account: PV })
  await rig.userMail('bs', 'MUSE-HANG')
  await busy('bs')
  const queued = await op({ op: 'account', node: 'bs', account: PF })
  const scoped = await scope('bs', { effort: 'max' })
  p.check('busy: after an account change queued behind the turn, the settings route checks the level on the queued login (max taken)',
    bs.ok && queued.ok && row('bs').pending === PF && scoped.ok && row('bs').effort === 'max', { queued, scoped, row: row('bs') })
  for (const n of HANGERS) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${n}/interrupt`, {}).catch(() => null)

  // ---------------------------------------------------------------- placement: the best allowed login
  await settings({ disabled_accounts: ['muse/primary'] })
  const pa = await hire('pa', 'wonder-full')
  await settings({ disabled_accounts: [] })
  p.check('placement: with the own login switched off for the org, an omitted Full hire lands on an allowed login that offers Full (not the Wonder-only one listed first)',
    pa.ok && row('pa').account === PF, { pa, row: row('pa') })

  // ---------------------------------------------------------------- the own login signed out
  await ownAccount({ state: 'loggedOut' })
  m = await muse()
  p.check('payload: with the own login signed out, a registered login\'s offer leaves Muse hirable (no reason given) and the own login offers nothing',
    m?.status?.connected === false && m?.hire_enabled === true && !m?.reason && doc(null)?.state === 'signed_out'
      && m?.tiers?.some((t) => t.tier === 'wonder' && t.own === false && t.logins?.includes(PW)), { status: m?.status, hire: m?.hire_enabled, reason: m?.reason, own: doc(null) })
  await ownAccount(null)

  // ---------------------------------------------------------------- removing a registered Muse login
  // the own login offers Wonder and Spark 1.3 only (no Full, no Spark 1.2)
  await ownCatalog([W], [S13])
  const PR = await profile([[W]])
  const PRF = await profile([[F]])
  const PRS = await profile([[S13], [S12, UPTO_XHIGH]])
  const m1 = await hire('m1', 'wonder', { account: PR })
  const m2 = await hire('m2', 'wonder-full', { account: PRF })
  const m3 = await hire('m3', 'spark', { account: PRS })
  const pin3 = await scope('m3', { model_version: '1.2' })
  const m4 = await hire('m4', 'spark', { account: PRS })
  await settings({ default_account: PR })
  const del = (id) => settled(rig.api('DELETE', `/api/accounts/${id}`))
  const orgDefault = () => rig.one(`SELECT settings->>'default_account' AS d FROM ot.orgs WHERE slug = '${rig.org}'`)?.d
  const gone = (id) => !rig.one(`SELECT 1 AS x FROM ot.accounts WHERE id = '${id}'`)
  const d1 = await del(PR)
  p.check('removal: a Muse login can be removed; its seat moves to the own login, which offers Wonder (unbound, not frozen), and the org default naming it moves there too',
    m1.ok && d1.ok && gone(PR) && row('m1').account === null && row('m1').frozen === null && orgDefault() === 'muse/primary', { d1, m1: row('m1'), default: orgDefault() })
  const d2 = await del(PRF)
  p.check('removal: a seat whose model the own login does not offer (Full) moves to the first other subscription that offers it (PF; not the Wonder-only PW, never the key KF)',
    m2.ok && d2.ok && gone(PRF) && row('m2').account === PF && row('m2').frozen === null
      && (d2.r?.rebound ?? []).some((x) => x.node === 'm2' && x.account === PF && x.frozen === false), { d2, m2: row('m2') })
  const d3 = await del(PRS)
  p.check('removal: the pinned version counts (Spark 1.2, which the own login lacks, moves to PS, which offers it; unpinned Spark 1.3 to the own login)',
    m3.ok && pin3.ok && m4.ok && d3.ok && row('m3').account === PS && row('m3').frozen === null
      && row('m4').frozen === null && row('m4').account === null, { d3, m3: row('m3'), m4: row('m4') })
  await settings({ default_account: '' })

  p.keep(rig, { agents: ['ra', 'rb', 'bq', 'bs', 'm2', 'm3'], grep: /muse|effort|account/i })
  return p.summary()
}
