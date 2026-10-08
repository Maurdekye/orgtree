// Proof: the user's hard rule, never a model on a login whose window it
// spends is at 100% (3.x staffcache / account_fallback), with per-login canned
// readings (rig-usage\claude@<folder>.json).
//   The primary has room; B's standard weekly window reads 100%; C's Fable
//   weekly window reads 100% (so C still has room for every tier but fable).
//   Quick staff: B is not offered (C is, for haiku; not for fable), and the
//     commit refuses B; with the primary at 100% the default is refused too.
//   Continue-on: onto B refused for a haiku agent (the tool and the user's
//     route); onto C allowed for haiku and refused for fable.
//   Automatic fallback: a haiku agent skips B and moves to C (proven room);
//     a fable agent finds no proven room anywhere and freezes.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/account-windows.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const future = hours => new Date(Date.now() + hours * 3600e3).toISOString()
const reading = ({ session = 10, weekly = 20, fable = 30 } = {}) => ({
  available: true, observed_at: new Date().toISOString(),
  limits: [
    { kind: 'session', group: 'session', percent: session, resets_at: future(3), is_active: false, model: null, label: 'Current session' },
    { kind: 'weekly_all', group: 'weekly_all', percent: weekly, resets_at: future(72), is_active: false, model: null, label: 'Current week (all models)' },
    { kind: 'weekly_scoped', group: 'weekly_scoped', percent: fable, resets_at: future(72), is_active: false, model: 'Fable', label: 'Current week (Fable)' },
  ],
})
function claudeHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return dir
}

export default async function (rig) {
  const p = new Proof('account-windows')
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  const limited = { name: 'limited', match: 'PROOF-LIMIT', once: true, steps: [
    { text: 'Starting on it.' },
    { rate_limit: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour', overageStatus: 'rejected' } },
    { result: { is_error: true, text: "You've hit your limit · resets 7am" } },
  ] }
  rig.scenario({
    agents: Object.fromEntries(['ola', 'fay', 'ned', 'fio'].map(n => [n, { turns: [limited] }])),
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- logins and readings
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usageDir, { recursive: true })
  const put = (name, r) => fs.writeFileSync(path.join(usageDir, `${name}.json`), JSON.stringify(r))
  put('claude', reading())
  put('claude@claude-b', reading({ weekly: 100 }))
  put('claude@claude-c', reading({ fable: 100 }))
  const B = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-b'), 'rig-b@example.invalid') })).id
  const C = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-c'), 'rig-c@example.invalid') })).id
  const reread = async () => {
    await rig.api('GET', '/api/accounts/usage/primary')
    for (const id of [B, C]) await rig.api('GET', `/api/accounts/${id}/usage?force=true`)
  }
  await reread()
  p.note('logins', { B, C })

  // ---------------------------------------------------------------- quick staff
  await rig.api('PUT', '/api/app-settings/runtime', { quick_staff_behavior: 'top_level' })
  const item = await rig.tool('boss', 'orgtree_work', { action: 'create', kind: 'code', title: 'Window rule ticket',
    objective: 'A ticket to staff in the account-windows proof.\n\nNothing depends on it.', owner: 'boss' })
  const slug = item.json?.slug
  await rig.tool('boss', 'orgtree_work', { action: 'update', slug, status: 'backlogged', done_so_far: [], working_on_next: ['Staff it.'] })
  const preview = await rig.api('GET', `/api/orgs/${rig.org}/work-items/${slug}/quick-staff`).catch(e => ({ error: e.message }))
  const offered = tier => (preview.models ?? []).find(m => m.tier === tier)
  const ids = tier => (offered(tier)?.accounts ?? []).map(a => a.id)
  p.check('quick staff: B (standard weekly at 100%) is offered for no tier', ['haiku', 'opus'].every(t => !ids(t).includes(B)),
    { haiku: ids('haiku'), opus: ids('opus'), error: preview.error })
  p.check('quick staff: C is offered for haiku and opus, not for fable (its Fable weekly is at 100%)',
    ids('haiku').includes(C) && ids('opus').includes(C) && (!offered('fable') || !ids('fable').includes(C)),
    { haiku: ids('haiku'), opus: ids('opus'), fable: offered('fable') ? ids('fable') : 'not offered' })
  const commit = (tier, account) => rig.api('POST', `/api/orgs/${rig.org}/work-items/${slug}/quick-staff`, {
    request_id: `rq-${tier}-${account ?? 'default'}-${Date.now()}`, mode: preview.mode, configured_mode: preview.configured_mode,
    owner: preview.owner, tier, effort: null, account }).then(r => ({ ok: true, r }), e => ({ ok: false, e: e.message }))
  const cB = await commit('haiku', B)
  p.check('quick staff commit: B is refused', !cB.ok && /at its limit|signed out|cannot run/.test(cB.e), cB)
  put('claude', reading({ session: 100 }))
  await reread()
  const cDefault = await commit('haiku', null)
  p.check('quick staff commit: with the primary\'s session window at 100% the default is refused', !cDefault.ok && /100%/.test(cDefault.e), cDefault)
  put('claude', reading())
  await reread()

  // ---------------------------------------------------------------- continue-on
  await rig.op({ op: 'hire', name: 'ola', parent: 'boss', tier: 'haiku', title: 'Window rule agent' })
  await rig.op({ op: 'hire', name: 'fay', tier: 'fable', title: 'Window rule agent' })
  const seat = name => rig.one(`SELECT a.account, a.frozen FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${rig.org}' AND o.state = 'active' AND a.name = '${name}'`)
  for (const n of ['ola', 'fay']) {
    await rig.userMail(n, 'PROOF-LIMIT: please do the thing.')
    await rig.waitFor(() => seat(n)?.frozen, { what: `${n} to be frozen` })
  }
  await reread()
  const toolB = await rig.tool('boss', 'orgtree_continue_on', { node: 'ola', account: B })
  p.check('continue-on (tool): ola (haiku) onto B is refused, nothing changed', !toolB.ok && /100%/.test(toolB.text ?? '')
    && !seat('ola').account && !!seat('ola').frozen, toolB.text?.slice(0, 240))
  const httpB = await rig.api('POST', `/api/orgs/${rig.org}/nodes/ola/continue-on`, { account: B }).then(r => ({ ok: true, r }), e => ({ ok: false, e: e.message }))
  p.check('continue-on (the user\'s route): ola onto B is refused too', !httpB.ok && /100%/.test(httpB.e) && !seat('ola').account, httpB)
  // fay is top level: the user's route moves her
  const fayC = await rig.api('POST', `/api/orgs/${rig.org}/nodes/fay/continue-on`, { account: C }).then(r => ({ ok: true, r }), e => ({ ok: false, e: e.message }))
  p.check('continue-on: fay (fable) onto C is refused (C\'s Fable weekly at 100%)', !fayC.ok && /100%/.test(fayC.e ?? '')
    && !seat('fay').account, fayC)
  const olaC = await rig.tool('boss', 'orgtree_continue_on', { node: 'ola', account: C })
  p.check('continue-on: ola (haiku) onto C is allowed (haiku ignores the Fable window)', olaC.ok && seat('ola').account === C, olaC.text?.slice(0, 200))

  // ---------------------------------------------------------------- automatic fallback
  await rig.op({ op: 'hire', name: 'ned', parent: 'boss', tier: 'haiku', title: 'Window rule agent', account_fallback: true })
  await rig.op({ op: 'hire', name: 'fio', tier: 'fable', title: 'Window rule agent', account_fallback: true })
  await reread()
  await rig.userMail('ned', 'PROOF-LIMIT: please do the big thing.')
  const nedAt = await rig.waitFor(() => { const s = seat('ned'); return s?.account || s?.frozen ? s : null }, { what: 'ned to move or freeze', timeout: 30000 })
  p.check('fallback: ned (haiku) skips B (no room) and moves to C', nedAt.account === C && !nedAt.frozen, nedAt)
  await rig.userMail('fio', 'PROOF-LIMIT: please do the big thing.')
  const fioAt = await rig.waitFor(() => { const s = seat('fio'); return s?.account || s?.frozen ? s : null }, { what: 'fio to move or freeze', timeout: 30000 })
  p.check('fallback: fio (fable) has no proven room anywhere and freezes', !fioAt.account && fioAt.frozen?.limit === true,
    { account: fioAt.account, frozen: fioAt.frozen && { limit: fioAt.frozen.limit, until: fioAt.frozen.until } })

  p.keep(rig, { agents: ['ola', 'fay', 'ned', 'fio'], grep: /fallback|continue|100%|limit/ })
  return p.summary()
}
