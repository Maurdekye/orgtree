// Proof: the rendered hire and settings surfaces offer a Muse seat what the
// login it runs on offers (independent review 2026-10-13, round 2), on the
// fake `muse serve` with per-login catalogs, through the real renderer.
//   hire: with the own login lacking Wonder Full and a profile offering it,
//     "Hire a subordinate" lists Full and the draft's hire lands on that
//     profile (the hire names it); with the own login signed out, a Wonder
//     hire from the menu lands on a registered login that offers Wonder.
//   inverse: with the own login offering Full and a seat on a profile that
//     does not, the seat's settings, switched to Full, do not offer that
//     profile and say why.
//   levels: a Spark seat pinned to 1.2 is offered 1.2's levels (no max) in
//     its settings and on its desk; a seat on a profile whose Wonder row ends
//     at high is offered low..high; the unpinned Spark seat on the same
//     login is offered max (control).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-ui-logins.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UPTO_XHIGH = ALL.slice(0, 5)
const W = 'muse-wonder-1.0', F = 'muse-wonder-full-1.0', S13 = 'muse-spark-1.3', S12 = 'muse-spark-1.2'
const catalogOf = (...rows) => JSON.stringify({ source: 'providerCatalog', models: rows.map(([id, variants = ALL], i) => ({
  modelId: id, profileId: 'tbh', isDefault: i === 0, variants, defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })) })

export default async function (rig) {
  const p = new Proof('muse-ui-logins')
  if (!process.env.ORGTREE_RIG_UI) {
    p.check('the renderer bundle is given (--ui <bundle>)', false, 'ORGTREE_RIG_UI is not set')
    return p.summary()
  }
  rig.scenario({ agents: {}, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
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
  const profile = async (rows) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), catalogOf(...rows))
    await rig.api('GET', `/api/accounts/${id}/identity`).catch(() => null)
    return id
  }
  const op = (body) => rig.op(body).then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const hire = (name, tier, extra = {}) => op({ op: 'hire', name, parent: 'boss', tier, title: 'Muse UI agent', ...extra })
  const accountOf = (name) => rig.one(`SELECT account FROM ot.agents WHERE name = '${name}' AND state = 'live'`)?.account ?? null
  const evidence = path.join(rigHome(), 'evidence', 'muse-ui-logins-' + Date.now())
  fs.mkdirSync(evidence, { recursive: true })
  const stage = (tag, args) => runDesktop(rig, path.join(here, '../desktop/muse-logins.cjs'),
    { args: { org: rig.org, theme: 'charcoal', ...args }, out: path.join(evidence, tag), timeout: 150000 })
  const items = (v) => (v?.items ?? []).map((i) => i.text)

  // ---------------------------------------------------------------- the logins
  await ownCatalog([W], [S13], [S12, UPTO_XHIGH])
  const PF = await profile([[W], [F]])
  const PW = await profile([[W]])
  const PV = await profile([[W, ['low', 'medium', 'high']]])
  const PS = await profile([[S13], [S12, UPTO_XHIGH]])
  await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)

  // ---------------------------------------------------------------- hire: Full only on a profile
  const h1 = await stage('hire-full', { stage: 'hire', tier: 'wonder-full', name: 'uf' })
  p.check(`hire: the menu lists Wonder Full though the own login lacks it (shots in ${evidence})`,
    h1.ok !== false && items(h1.value).includes('wonder-full'), { items: h1.value?.items, error: h1.error })
  p.check('hire: the draft\'s hire lands on the profile that offers Full (the hire names it), not on the own login',
    h1.value?.hired === true && accountOf('uf') === PF, { value: h1.value, account: accountOf('uf') })

  // ---------------------------------------------------------------- hire: the own login signed out
  await ownAccount({ state: 'loggedOut' })
  await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)
  const h2 = await stage('hire-signed-out', { stage: 'hire', tier: 'wonder', name: 'uw' })
  const uw = accountOf('uw')
  p.check('hire (own login signed out): the menu still offers Wonder and its hire lands on a registered login that offers it',
    items(h2.value).includes('wonder') && h2.value?.hired === true && [PF, PW, PV].includes(uw), { value: h2.value, account: uw })
  await ownAccount(null)

  // ---------------------------------------------------------------- inverse: Full on the own login, not on the seat's profile
  await ownCatalog([W], [F], [S13], [S12, UPTO_XHIGH])
  const iw = await hire('iw', 'wonder', { account: PW })
  const s1 = await stage('inverse', { stage: 'settings', agent: 'iw', model: 'wonder-full' })
  const choices = (s1.value?.account?.options ?? []).filter((o) => !o.disabled).map((o) => o.value)
  p.check('inverse: switched to Full, the seat\'s settings do not offer its profile (Full is not in its catalog) and say why',
    iw.ok && s1.value?.model === 'wonder-full' && !choices.includes(PW) && choices.includes(PF)
      && new RegExp(`${PW} does not offer wonder-full`).test(s1.value?.note ?? ''), { value: s1.value })

  // ---------------------------------------------------------------- levels by login and pin
  const sp = await hire('sp', 'spark', { account: PS })
  const pin = await rig.api('POST', `/api/orgs/${rig.org}/nodes/sp/scope`, { model_version: '1.2' }).then(() => true, () => false)
  const su = await hire('su', 'spark', { account: PS })
  const vv = await hire('vv', 'wonder', { account: PV })
  const s2 = await stage('pinned', { stage: 'settings', agent: 'sp' })
  const s3 = await stage('unpinned', { stage: 'settings', agent: 'su' })
  const s4 = await stage('profile-levels', { stage: 'settings', agent: 'vv' })
  p.check('levels: a Spark seat pinned to 1.2 is offered 1.2\'s levels (no max) in its settings and on its desk',
    sp.ok && pin && JSON.stringify(s2.value?.levels) === JSON.stringify(UPTO_XHIGH) && JSON.stringify(s2.value?.desk) === JSON.stringify(UPTO_XHIGH),
    { settings: s2.value?.levels, desk: s2.value?.desk })
  p.check('levels (control): the unpinned Spark seat on the same login is offered max',
    su.ok && (s3.value?.levels ?? []).includes('max') && (s3.value?.desk ?? []).includes('max'), { settings: s3.value?.levels, desk: s3.value?.desk })
  p.check('levels: a seat on a profile whose Wonder row ends at high is offered low..high, in its settings and on its desk',
    vv.ok && JSON.stringify(s4.value?.levels) === JSON.stringify(['low', 'medium', 'high'])
      && JSON.stringify(s4.value?.desk) === JSON.stringify(['low', 'medium', 'high']), { settings: s4.value?.levels, desk: s4.value?.desk })
  return p.summary()
}
