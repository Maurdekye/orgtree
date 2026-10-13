// Proof: removing a registered Muse login (independent review R3 2026-10-13,
// finding 1, under the coordinator's reassign-or-freeze ruling), on the fake
// `muse serve` with per-login catalogs and canned readings.
//   A live seat on the removed login goes to the user's own login when that
//   login's own catalog offers its exact model (pin included) and every
//   continuation gate passes (c1), else to the first registered subscription
//   that does (a1: Full to PF, not the Wonder-only PW listed first nor the key
//   KF; b1: Spark 1.2 to PS); the own login is skipped when its subscription
//   switch is off, the org's list leaves it out, it is signed out, needs a
//   sign-in or is at its limit (d1..d5: to PW). With no login that can take
//   it (h1: Full, PF at its limit, only a key offers it) the seat is unbound
//   and waits frozen saying why, its earlier limit freeze replaced and the
//   request it held kept; it cannot be continued on the own login, and
//   continuing it on PF once PF has room runs it there with that request.
//   A queued account move naming the login names the login chosen for the
//   model it will run (k1), or is dropped when none can (k2); a queued model
//   switch naming it names the chosen login (k3), or no account (k4). The org
//   and app defaults naming it go to the own login, as for every provider. A
//   removal refused for a bound seat mid-turn changes nothing (z1, z2).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-r4-removal.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UPTO_XHIGH = ALL.slice(0, 5)
const W = 'muse-wonder-1.0', F = 'muse-wonder-full-1.0', S13 = 'muse-spark-1.3', S12 = 'muse-spark-1.2'
/** a catalog of [modelId, variants] rows, the first the default */
const catalogOf = (...rows) => JSON.stringify({ source: 'providerCatalog', models: rows.map(([id, variants = ALL], i) => ({
  modelId: id, profileId: 'tbh', isDefault: i === 0, variants, defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })) })
const later = (h) => new Date(Date.now() + h * 3600e3).toISOString()
const reading = (session, weekly = 20) => ({ available: true, observed_at: new Date().toISOString(), limits: [
  { kind: 'session', group: 'window', percent: session, resets_at: later(3), is_active: session >= 100, model: null, observed_model: null, label: '5 h' },
  { kind: 'weekly_all', group: 'weekly', percent: weekly, resets_at: later(72), is_active: weekly >= 100, model: null, observed_model: null, label: 'weekly' }] })
const ROOM = reading(10)
const FULL = reading(100)
const signedOut = () => ({ available: false, error: 'Muse Code is not signed in for this account', reauth_required: true,
  reauth_evidence: 'not_connected', observed_at: new Date().toISOString() })
const AGENTS = ['a1', 'b1', 'b2', 'c1', 'd1', 'd2', 'd3', 'd4', 'd5', 'h1', 'k1', 'k2', 'k3', 'k4', 'z1', 'z2']
const HANGERS = ['k1', 'k2', 'k3', 'k4', 'z2']

export default async function (rig) {
  const p = new Proof('muse-r4-removal')
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
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usageDir, { recursive: true })
  const ownFile = path.join(usageDir, 'muse.json')
  let ownReading = ROOM
  /** the user's own login's reading, as its next read takes it */
  const own = async (r) => { ownReading = r; fs.writeFileSync(ownFile, JSON.stringify(r)); await rig.api('GET', '/api/muse/usage') }
  /** the user's own login's catalog and sign-in, read again (the canned reading steps aside meanwhile) */
  const ownLogin = async ({ rows, account } = {}) => {
    if (rows) fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), catalogOf(...rows))
    const acc = path.join(rig.fakeDir, 'muse-account.json')
    if (account) fs.writeFileSync(acc, JSON.stringify(account)); else fs.rmSync(acc, { force: true })
    fs.rmSync(ownFile, { force: true })
    await rig.api('GET', '/api/muse/usage?force=true')
    await own(ownReading)
  }
  const switches = (sub, keys) => Promise.all([
    rig.api('PUT', '/api/providers/muse/subscription-inference', { enabled: sub }),
    rig.api('PUT', '/api/providers/muse/apikey-fallback', { enabled: keys })])
  /** a managed Muse profile offering `rows` (its own catalog), with its own reading, read once */
  const profile = async (rows, r = ROOM) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), catalogOf(...rows))
    fs.writeFileSync(path.join(usageDir, `muse@${path.basename(dir)}.json`), JSON.stringify(r))
    await rig.api('GET', `/api/accounts/${id}/identity`)
    await rig.api('GET', `/api/accounts/${id}/usage?force=true`)
    return id
  }
  /** a profile's reading, read again now */
  const readingOf = async (id, r) => {
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.writeFileSync(path.join(usageDir, `muse@${path.basename(dir)}.json`), JSON.stringify(r))
    await rig.api('GET', `/api/accounts/${id}/usage?force=true`)
  }
  const settled = (pr) => pr.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const op = (body) => settled(rig.op(body))
  const hire = async (name, tier, account, version) => {
    const h = await op({ op: 'hire', name, parent: 'boss', tier, title: 'Muse R4 agent', ...(account ? { account } : {}) })
    if (h.ok && version) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { model_version: version })
    return h
  }
  const row = (name) => rig.one(`SELECT id, account, frozen, session_id, pending_account, pending_switch, extra->>'handoff_due' AS handoff
                                 FROM ot.agents WHERE name = '${name}' AND state = 'live'`) ?? {}
  const del = (id) => settled(rig.api('DELETE', `/api/accounts/${id}`))
  const gone = (id) => !rig.one(`SELECT 1 AS x FROM ot.accounts WHERE id = '${id}'`)
  const removedEvent = (id, name) => rig.one(`SELECT e.detail FROM ot.events e JOIN ot.agents a ON a.id = e.subject_agent_id
    WHERE e.op = 'account_removed' AND e.detail->>'removed_account' = '${id}' AND a.name = '${name}' ORDER BY e.id DESC LIMIT 1`)?.detail ?? null
  const rebound = (d, name) => (d.r?.rebound ?? []).find((x) => x.node === name)
  const busy = async (name) => {
    await rig.userMail(name, 'MUSE-HANG')
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.name = '${name}' AND a.state = 'live' AND t.ended_at IS NULL`).length > 0, { what: `${name} mid-turn`, timeout: 30000 })
  }
  const interrupt = (name) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/interrupt`, {}).catch(() => null)
  const held = (frozen) => JSON.stringify(frozen?.resume_texts ?? []).includes('PROOF-WALL')
  const mails = (id) => rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id = ${id}`)?.n ?? 0

  // the user's own login offers Wonder and Spark 1.3 only (no Full, no Spark 1.2)
  await own(ROOM)
  await ownLogin({ rows: [[W], [S13]] })
  await switches(true, false)
  // the Wonder-only profile first: any choice that skipped the catalog check would land there
  const PW = await profile([[W]])
  const PF = await profile([[W], [F]])
  const PS = await profile([[S13], [S12, UPTO_XHIGH]])
  const KF = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'apikey', key: 'muse-rig-not-a-real-key' })).id
  const keyConfig = path.join(rig.data, 'profiles', `muse-key-${KF}`, 'config')
  fs.mkdirSync(keyConfig, { recursive: true })
  fs.writeFileSync(path.join(keyConfig, 'muse-catalog.json'), catalogOf([F]))
  await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)

  // ---------------------------------------------------------------- another entitled subscription
  const X1 = await profile([[F]])
  const a1 = await hire('a1', 'wonder-full', X1)
  const d1x = await del(X1)
  const a1r = row('a1')
  p.check('removal: a Full seat goes to the first other subscription that offers Full (PF), not the Wonder-only PW nor the key KF, on a fresh session',
    a1.ok && d1x.ok && gone(X1) && a1r.account === PF && a1r.frozen === null && a1r.session_id === null
      && (a1r.handoff ?? '').includes(PF) && rebound(d1x, 'a1')?.account === PF && rebound(d1x, 'a1')?.frozen === false
      && removedEvent(X1, 'a1')?.account === PF, { d1x, a1: a1r, event: removedEvent(X1, 'a1') })

  // ---------------------------------------------------------------- the pinned version counts
  const X2 = await profile([[S13], [S12, UPTO_XHIGH]])
  const b1 = await hire('b1', 'spark', X2, '1.2')
  const b2 = await hire('b2', 'spark', X2)
  const d2x = await del(X2)
  p.check('removal: the pinned version counts (Spark 1.2 goes to PS, which offers it; unpinned Spark 1.3 to the own login)',
    b1.ok && b2.ok && d2x.ok && row('b1').account === PS && row('b1').frozen === null && row('b2').account === null && row('b2').frozen === null,
    { d2x, b1: row('b1'), b2: row('b2') })

  // ---------------------------------------------------------------- the own login first
  const X3 = await profile([[W]])
  const c1 = await hire('c1', 'wonder', X3)
  const d3x = await del(X3)
  p.check('removal: the own login comes first when it offers the model and passes every gate (Wonder: own login, not PW)',
    c1.ok && d3x.ok && row('c1').account === null && row('c1').frozen === null && rebound(d3x, 'c1')?.account === 'muse/primary',
    { d3x, c1: row('c1') })

  // ---------------------------------------------------------------- the own login's gates
  const gates = []
  for (const [name, what, set, undo] of [
    ['d1', 'its subscription switch off', () => switches(false, false), () => switches(true, false)],
    ['d2', 'the org list leaving it out', () => rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ['muse/primary'] }),
      () => rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })],
    ['d3', 'signed out', () => ownLogin({ account: { state: 'loggedOut' } }), () => ownLogin({})],
    ['d4', 'needing a sign-in', () => own(signedOut()), () => own(ROOM)],
    ['d5', 'at its limit', () => own(FULL), () => own(ROOM)],
  ]) {
    const X = await profile([[W]])
    const h = await hire(name, 'wonder', X)
    await set()
    const d = await del(X)
    gates.push({ name, what, hired: h.ok, ok: d.ok, detail: d.detail, account: row(name).account, frozen: row(name).frozen })
    await undo()
  }
  p.check('removal: with the own login unable to take it (switch off, org list, signed out, needing a sign-in, at its limit) the seat goes to PW',
    gates.every((g) => g.hired && g.ok && g.account === PW && g.frozen === null), gates)

  // ---------------------------------------------------------------- nothing can take it, then recovery
  const X8 = await profile([[F]])
  const h1 = await hire('h1', 'wonder-full', X8)
  await rig.userMail('h1', 'PROOF-WALL: h1, please do the thing.')
  await rig.waitFor(() => row('h1').frozen, { what: "h1's wall", timeout: 45000 })
  const limitFreeze = row('h1').frozen
  await readingOf(PF, FULL)
  const d8x = await del(X8)
  const h1r = row('h1')
  p.check('removal: with no login that can run it (PF at its limit; only a key offers Full) the seat is unbound and waits frozen saying why, its limit freeze replaced and its request kept; never the key',
    h1.ok && limitFreeze?.limit === true && held(limitFreeze) && d8x.ok && gone(X8) && h1r.account === null
      && h1r.frozen?.cause === 'account' && h1r.frozen?.limit === false && (h1r.frozen?.error ?? '').includes(X8)
      && /no Muse login this org may use can run muse-wonder-full-1\.0/.test(h1r.frozen?.error ?? '') && held(h1r.frozen)
      && rebound(d8x, 'h1')?.frozen === true && removedEvent(X8, 'h1')?.frozen === true,
    { limitFreeze, d8x, h1: h1r })
  await readingOf(PF, ROOM)
  const before = { frozen: JSON.stringify(row('h1').frozen), account: row('h1').account, mails: mails(h1r.id) }
  const toOwn = await settled(rig.api('POST', `/api/orgs/${rig.org}/nodes/h1/continue-on`, { account: 'muse/primary' }))
  const toPW = await settled(rig.tool('boss', 'orgtree_continue_on', { node: 'h1', account: PW }).then((r) => {
    if (r && r.ok === false) { const e = new Error(r.text ?? 'refused'); e.status = 409; throw e } return r }))
  const unchanged = JSON.stringify(row('h1').frozen) === before.frozen && row('h1').account === before.account && mails(h1r.id) === before.mails
  const toPF = await settled(rig.api('POST', `/api/orgs/${rig.org}/nodes/h1/continue-on`, { account: PF }))
  await rig.waitTurns('h1', 2, { timeout: 45000 }).catch(() => null)
  const start = rig.fakeLog('h1').filter((l) => l.kind === 'start').at(-1)
  const pfDir = path.basename(rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${PF}'`)?.config_dir ?? 'none')
  const replayed = rig.fakeLog('h1').filter((l) => l.kind === 'turn').slice(1).some((l) => (l.prompt ?? '').includes('PROOF-WALL'))
  p.check('recovery: refused on the own login (no Full) and on PW, nothing changed; continued on PF it runs there, its held request replayed',
    !toOwn.ok && toOwn.status === 409 && /does not offer muse-wonder-full-1\.0/.test(toOwn.detail ?? '') && !toPW.ok && unchanged
      && toPF.ok && row('h1').account === PF && row('h1').frozen === null && (start?.xdg_config ?? '').includes(pfDir) && replayed,
    { toOwn, toPW, unchanged, toPF, start: start?.xdg_config ?? null, replayed })

  // ---------------------------------------------------------------- queued intents naming it
  const PF3 = await profile([[F]])
  const k1 = await hire('k1', 'wonder-full', PF3)
  const k2 = await hire('k2', 'wonder-full', PF3)
  const k3 = await hire('k3', 'wonder', PW)
  const k4 = await hire('k4', 'wonder', PW)
  for (const n of ['k1', 'k2', 'k3', 'k4']) await busy(n)
  const X10 = await profile([[F]])
  const X11 = await profile([[F]])
  const X12 = await profile([[F]])
  const X13 = await profile([[F]])
  const q1 = await op({ op: 'account', node: 'k1', account: X10 })
  const q2 = await op({ op: 'account', node: 'k2', account: X11 })
  const q3 = await op({ op: 'switch_model', node: 'k3', tier: 'wonder-full', account: X12 })
  const q4 = await op({ op: 'switch_model', node: 'k4', tier: 'wonder-full', account: X13 })
  const queued = { q1, q2, q3, q4, k1: row('k1').pending_account, k3: row('k3').pending_switch }
  const d10 = await del(X10)
  const d12 = await del(X12)
  p.check('queued: an account move and a model switch naming the removed login name the first subscription that offers their model (PF), the seats staying where they are',
    [k1, k3, q1, q3, d10, d12].every((x) => x.ok) && row('k1').pending_account?.account === PF && row('k1').account === PF3
      && row('k3').pending_switch?.account === PF && row('k3').pending_switch?.tier === 'wonder-full' && row('k3').account === PW,
    { queued, k1: row('k1'), k3: row('k3') })
  // every subscription offering Full at its limit (X11 and X13 too: each is
  // the other's candidate)
  for (const id of [PF, PF3, X11, X13]) await readingOf(id, FULL)
  const d11 = await del(X11)
  const d13 = await del(X13)
  const k4s = row('k4').pending_switch
  p.check('queued: with no subscription able to run Full, the account move is dropped and the switch names no account (never the key)',
    [k2, k4, q2, q4, d11, d13].every((x) => x.ok) && row('k2').pending_account === null && row('k2').account === PF3
      && k4s?.tier === 'wonder-full' && !('account' in (k4s ?? { account: 1 })) && removedEvent(X11, 'k2')?.pending_account === null,
    { k2: row('k2'), k4: row('k4'), event: removedEvent(X11, 'k2') })
  await readingOf(PF, ROOM)
  await readingOf(PF3, ROOM)
  for (const n of ['k1', 'k2', 'k3', 'k4']) await interrupt(n)

  // ---------------------------------------------------------------- defaults
  const X15 = await profile([[W]])
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: X15 })
  await rig.api('POST', '/api/defaults', { default_account: X15 })
  const d15 = await del(X15)
  const orgDefault = rig.one(`SELECT settings->>'default_account' AS d FROM ot.orgs WHERE slug = '${rig.org}'`)?.d
  const appDefault = rig.one(`SELECT value #>> '{defaults,default_account}' AS d FROM ot.kv WHERE key = 'app_settings'`)?.d
  p.check('defaults: the org and app defaults naming the removed login go to the own login, as for every provider',
    d15.ok && orgDefault === 'muse/primary' && appDefault === 'muse/primary', { d15, orgDefault, appDefault })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: '' })
  await rig.api('POST', '/api/defaults', { default_account: '' })

  // ---------------------------------------------------------------- a refusal changes nothing
  const X16 = await profile([[W]])
  const z1 = await hire('z1', 'wonder', X16)
  const z2 = await hire('z2', 'wonder', X16)
  await busy('z2')
  const refused = await del(X16)
  const kept = !gone(X16) && row('z1').account === X16 && row('z2').account === X16
    && !rig.one(`SELECT 1 AS x FROM ot.events WHERE op = 'account_removed' AND detail->>'removed_account' = '${X16}'`)
  await interrupt('z2')
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
    WHERE a.name = 'z2' AND t.ended_at IS NULL`).length === 0, { what: 'z2 idle', timeout: 30000 })
  const again = await del(X16)
  p.check('atomic: a removal refused for a bound seat mid-turn changes nothing (the login, both bindings, no event); after the turn it moves both',
    z1.ok && z2.ok && !refused.ok && refused.status === 409 && /running a turn/.test(refused.detail ?? '') && kept
      && again.ok && gone(X16) && row('z1').account === null && row('z2').account === null,
    { refused, kept, again, z1: row('z1'), z2: row('z2') })

  for (const n of HANGERS) await interrupt(n)
  p.keep(rig, { agents: ['a1', 'b1', 'h1', 'k1', 'k2', 'k3', 'k4', 'z1', 'z2'], grep: /muse|account|removed|frozen/i })
  return p.summary()
}
