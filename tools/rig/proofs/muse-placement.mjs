// Proof: a Muse seat is placed and tuned by the login it runs on (R1 finding
// 3, independent review 2026-10-13), on the fake `muse serve` with per-login
// catalogs and account answers. The user's own login's entitlement is never a
// prerequisite for another login's, and another login's never stands in for it.
//   staffing: with the user's own login lacking Wonder Full, Full is offered
//     on the profile and the key that list it (and not on one that does not),
//     not as a no-account default.
//   hire: Full on that profile, on that key, and through the org's default
//     account is accepted; the inverse (the own login offers Full, the named
//     profile does not) is refused, and so are a switch to Full that stays on
//     that profile and an account move of a Full seat onto it.
//   effort: a seat pinned to Spark 1.2 takes only 1.2's levels (max refused,
//     xhigh taken; unpinned, max is taken), on the scope route and by retool;
//     a profile whose Wonder row lists fewer levels refuses max at hire and
//     later; a pin its login does not offer is refused.
//   unknown: a login whose metadata read fails takes no seat (never inferred).
//   own login signed out: a seat with no account is refused; a profile's is not.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-placement.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const ALL_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const W = 'muse-wonder-1.0', F = 'muse-wonder-full-1.0', S13 = 'muse-spark-1.3', S12 = 'muse-spark-1.2'
/** a catalog of [modelId, variants] rows, the first the default */
const catalogOf = (...rows) => JSON.stringify({ source: 'providerCatalog', models: rows.map(([id, variants = ALL_LEVELS], i) => ({
  modelId: id, profileId: 'tbh', isDefault: i === 0, variants, defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })) })

export default async function (rig) {
  const p = new Proof('muse-placement')
  rig.scenario({ agents: {}, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })

  /** the user's own login's catalog, read again */
  const ownCatalog = async (...rows) => {
    fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), catalogOf(...rows))
    await rig.api('GET', '/api/muse/usage?force=true')
  }
  const ownAccount = async (doc) => {
    const f = path.join(rig.fakeDir, 'muse-account.json')
    if (doc) fs.writeFileSync(f, JSON.stringify(doc)); else fs.rmSync(f, { force: true })
    await rig.api('GET', '/api/muse/usage?force=true')
  }
  /** a managed profile offering `rows` (its own catalog), read once */
  const profile = async (rows, account) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), catalogOf(...rows))
    if (account) fs.writeFileSync(path.join(dir, 'config', 'muse-account.json'), JSON.stringify(account))
    await rig.api('GET', `/api/accounts/${id}/identity`).catch(() => null)
    return id
  }
  const op = (body) => rig.op(body).then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const hire = (name, tier, extra = {}) => op({ op: 'hire', name, parent: 'boss', tier, title: 'Muse placement agent', ...extra })
  const scope = (name, body) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, body)
    .then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const accountOf = (name) => rig.one(`SELECT account FROM ot.agents WHERE name = '${name}' AND state = 'live'`)?.account ?? null
  const settings = (body) => rig.api('POST', `/api/orgs/${rig.org}/settings`, body)

  // ---------------------------------------------------------------- the logins
  await ownCatalog([W], [S13], [S12, ALL_LEVELS.slice(0, 5)])
  const PF = await profile([[W], [F]])
  const PW = await profile([[W]])
  const PV = await profile([[W, ['low', 'medium', 'high']]])
  const PS = await profile([[S13], [S12, ALL_LEVELS.slice(0, 5)]])
  const PS13 = await profile([[S13]])
  // a login whose catalog read fails (its model/list answers an error)
  const PU = await profile([[W]])
  const puDir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${PU}'`)?.config_dir
  fs.writeFileSync(path.join(puDir, 'config', 'muse-catalog.json'), JSON.stringify({ fail: 'rig: this login cannot be read' }))
  await rig.api('GET', `/api/accounts/${PU}/identity`).catch(() => null)
  const KF = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'apikey', key: 'muse-rig-not-a-real-key' })).id
  const keyConfig = path.join(rig.data, 'profiles', `muse-key-${KF}`, 'config')
  fs.mkdirSync(keyConfig, { recursive: true })
  fs.writeFileSync(path.join(keyConfig, 'muse-catalog.json'), catalogOf([F]))

  // ---------------------------------------------------------------- staffing
  const opts = await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)
  const full = (opts?.tiers ?? []).find((t) => t.tier === 'wonder-full')
  const ids = (t) => (t?.accounts ?? []).map((a) => a.id)
  p.check('staffing: with the own login lacking Full, Full is offered on the profile and the key that list it, not on one that does not, and not as a no-account default',
    !!full && ids(full).includes(PF) && ids(full).includes(KF) && !ids(full).includes(PW) && full.default_ok === false,
    { full, tiers: (opts?.tiers ?? []).map((t) => t.tier) })
  const wonder = (opts?.tiers ?? []).find((t) => t.tier === 'wonder')
  p.check('staffing: Wonder lists the logins that offer it and leaves out the unreadable one',
    ids(wonder).includes(PF) && ids(wonder).includes(PW) && !ids(wonder).includes(PU), ids(wonder))

  // ---------------------------------------------------------------- placement
  const fa = await hire('fa', 'wonder-full', { account: PF })
  p.check('hire: Full on the profile that lists it is accepted though the own login lacks it', fa.ok && accountOf('fa') === PF, fa)
  const fk = await hire('fk', 'wonder-full', { account: KF })
  p.check('hire: Full on the key whose own catalog lists it is accepted', fk.ok && accountOf('fk') === KF, fk)
  await settings({ default_account: PF })
  const fd = await hire('fd', 'wonder-full')
  await settings({ default_account: '' })
  p.check('hire: Full with no account named lands on the org\'s default account, which lists it', fd.ok && accountOf('fd') === PF, fd)

  await ownCatalog([W], [F], [S13], [S12, ALL_LEVELS.slice(0, 5)])
  const fw = await hire('fw', 'wonder-full', { account: PW })
  p.check('hire (inverse): the own login offers Full but the named profile does not: refused, naming that login',
    !fw.ok && fw.status === 409 && fw.detail.includes(PW) && /does not offer/.test(fw.detail), fw)
  const ww = await hire('ww', 'wonder', { account: PW })
  const sw = await op({ op: 'switch_model', node: 'ww', tier: 'wonder-full' })
  p.check('switch (inverse): a Wonder seat on that profile cannot switch to Full while staying on it',
    ww.ok && !sw.ok && sw.status === 409 && sw.detail.includes(PW), { ww, sw })
  const mv = await op({ op: 'account', node: 'fa', account: PW })
  p.check('account move (inverse): a Full seat cannot move onto a login that does not offer Full',
    !mv.ok && mv.status === 409 && mv.detail.includes(PW) && accountOf('fa') === PF, mv)

  // ---------------------------------------------------------------- effort and pins
  const sp = await hire('sp', 'spark', { account: PS })
  const pin = await scope('sp', { model_version: '1.2' })
  const maxPinned = await scope('sp', { effort: 'max' })
  const xhigh = await scope('sp', { effort: 'xhigh' })
  const retoolMax = await op({ op: 'retool', node: 'sp', effort: 'max' })
  const unpin = await scope('sp', { model_version: '' })
  const maxFree = await scope('sp', { effort: 'max' })
  p.check('effort: pinned to Spark 1.2 the seat takes only 1.2\'s levels (max refused on the scope route and by retool, xhigh taken); unpinned, max is taken',
    sp.ok && pin.ok && !maxPinned.ok && maxPinned.status === 400 && /muse-spark-1\.2/.test(maxPinned.detail) && xhigh.ok
      && !retoolMax.ok && unpin.ok && maxFree.ok, { sp, pin, maxPinned, xhigh, retoolMax, unpin, maxFree })
  const s13 = await hire('s13', 'spark', { account: PS13 })
  const pin13 = await scope('s13', { model_version: '1.2' })
  p.check('pin: a version the seat\'s own login does not offer is refused', s13.ok && !pin13.ok && pin13.status === 409 && pin13.detail.includes(PS13), pin13)
  const vmax = await hire('vmax', 'wonder', { account: PV, effort: 'max' })
  const vh = await hire('vh', 'wonder', { account: PV, effort: 'high' })
  const vhMax = await scope('vh', { effort: 'max' })
  p.check('effort: a profile whose Wonder row lists low..high refuses max at hire and later, and takes high',
    !vmax.ok && vmax.status === 400 && vh.ok && !vhMax.ok, { vmax, vh, vhMax })

  // ---------------------------------------------------------------- unknown, and the own login signed out
  const uu = await hire('uu', 'wonder', { account: PU })
  p.check('unknown: a login whose metadata read fails takes no seat (entitlement is never inferred)',
    !uu.ok && uu.status === 409 && uu.detail.includes(PU) && /could not be read/.test(uu.detail), uu)
  await ownCatalog([W], [S13], [S12, ALL_LEVELS.slice(0, 5)])
  await ownAccount({ state: 'loggedOut' })
  const po = await hire('po', 'wonder')
  const pf2 = await hire('pf2', 'wonder-full', { account: PF })
  await ownAccount(null)
  p.check('own login signed out: a seat with no account is refused; a profile that lists Full still takes one',
    !po.ok && po.status === 409 && pf2.ok && accountOf('pf2') === PF, { po, pf2 })

  return p.summary()
}
