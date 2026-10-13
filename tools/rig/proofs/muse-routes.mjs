// Proof: Muse's account routes (lead 2026-10-13 06:50Z: close C4a and C4b
// under max feasible parity), on the fake `muse serve` with canned readings.
//   C4a, the limit fallback and the user's own Muse login (`muse/primary`):
//   an opted-in agent frozen on a registered Muse profile moves back to the
//   user's own login when that login's catalog offers its exact model, every
//   continuation gate passes and its own reading proves room, its held
//   request replayed there (ana). It stays frozen on its profile, the request
//   held, when the own-login subscription switch is off (bo), the org's list
//   disallows that login (cy), its reading is unknown (di) or full (ed), it
//   needs a sign-in (fay), its catalog lacks the tier (gus, Wonder Full) or
//   the pinned version (hal, Spark 1.2), or the agent did not opt in (ivo).
//   An agent already on the user's own login is never moved to it again
//   (jo). Registered subscriptions come first (kit), API keys after it (lev).
//   C4b, the org account-list move: a Muse seat whose login the org unticks
//   goes to a login that offers its exact model (mo) or to the user's own
//   login when that offers it and passes every gate (quin); a login without
//   the model (nia), an own login without the pinned version (oz) or one that
//   needs a sign-in (pip) is never a target: the seat freezes saying so, its
//   mail waiting, and re-ticking its login lets it run (nia).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-routes.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const row = (modelId, isDefault) => ({ modelId, profileId: 'tbh', isDefault, variants: LEVELS,
  defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })
const catalogOf = (...ids) => JSON.stringify({ source: 'providerCatalog', models: ids.map((id, i) => row(id, i === 0)) })
const W = 'muse-wonder-1.0', FULL_MODEL = 'muse-wonder-full-1.0', S13 = 'muse-spark-1.3', S12 = 'muse-spark-1.2'
const ALL = [W, FULL_MODEL, S13, S12]
const later = (h) => new Date(Date.now() + h * 3600e3).toISOString()
const reading = (session, weekly = 20) => ({ available: true, observed_at: new Date().toISOString(), limits: [
  { kind: 'session', group: 'window', percent: session, resets_at: later(3), is_active: session >= 100, model: null, observed_model: null, label: '5 h' },
  { kind: 'weekly_all', group: 'weekly', percent: weekly, resets_at: later(72), is_active: weekly >= 100, model: null, observed_model: null, label: 'weekly' }] })
const ROOM = reading(10)
const FULL = reading(100)
const UNKNOWN = { available: false, error: 'Muse has not reported usage for this account yet' }
const signedOut = () => ({ available: false, error: 'Muse Code is not signed in for this account', reauth_required: true,
  reauth_evidence: 'not_connected', observed_at: new Date().toISOString() })
const AGENTS = ['jo', 'ana', 'bo', 'cy', 'di', 'ed', 'fay', 'gus', 'hal', 'ivo', 'kit', 'lev', 'mo', 'nia', 'oz', 'pip', 'quin']

export default async function (rig) {
  const p = new Proof('muse-routes')
  const resetMs = Date.now() + 2 * 3600 * 1000
  rig.scenario({ agents: Object.fromEntries(AGENTS.map((n) => [n, { turns: [
    { name: 'moved', match: 'You now run on the account', steps: [{ text: 'Continuing on the other login.' }] },
    { name: 'wall', match: 'PROOF-WALL', once: true, steps: [{ text: 'Trying.' }, { quota: { resetsAtMs: resetMs } }] },
    { name: 'next', match: 'PROOF-NEXT', steps: [{ text: 'Next turn done.' }] },
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
  /** the user's own login's catalog, read again (a canned reading stands in for the read, so it steps aside) */
  const ownCatalog = async (...ids) => {
    fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), catalogOf(...ids))
    fs.rmSync(ownFile, { force: true })
    await rig.api('GET', '/api/muse/usage?force=true')
    await own(ownReading)
  }
  const switches = (sub, keys) => Promise.all([
    rig.api('PUT', '/api/providers/muse/subscription-inference', { enabled: sub }),
    rig.api('PUT', '/api/providers/muse/apikey-fallback', { enabled: keys })])
  const accounts = []
  /** a managed Muse profile offering `models`, with its own reading */
  const profile = async (models, r = FULL) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), catalogOf(...models))
    fs.writeFileSync(path.join(usageDir, `muse@${path.basename(dir)}.json`), JSON.stringify(r))
    await rig.api('GET', `/api/accounts/${id}/identity`)
    accounts.push(id)
    return { id, dir, reading: (x) => fs.writeFileSync(path.join(usageDir, `muse@${path.basename(dir)}.json`), JSON.stringify(x)) }
  }
  const settings = (off) => rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: off })
  const accountOf = (id) => rig.one(`SELECT account FROM ot.agents WHERE id = ${id}`)?.account ?? null
  const prompts = (name) => rig.fakeLog(name).filter((l) => l.kind === 'turn').map((l) => l.prompt ?? '')
  const lastStart = (name) => rig.fakeLog(name).filter((l) => l.kind === 'start').at(-1)
  const stays = (id) => new RegExp(`it stays frozen[^\\n]*agent=${id}\\b|agent=${id}\\b[^\\n]*it stays frozen`)
  const held = (r) => JSON.stringify(r?.frozen?.resume_texts ?? []).includes('PROOF-WALL')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const hire = async (name, { tier = 'wonder', account, version, fallback } = {}) => {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'Muse route agent', ...(account ? { account } : {}),
      ...(fallback === undefined ? {} : { account_fallback: fallback }) })
    const id = await rig.waitFor(() => rig.agentRow(name)?.id, { what: `${name} hired`, timeout: 20000 })
    if (version) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { model_version: version })
    return id
  }
  /** C4a: give `name` (on `account`) the wall; resolve once the fallback moved it or left it frozen */
  const wall = async (name, { tier = 'wonder', account, version, fallback = true, before } = {}) => {
    const id = await hire(name, { tier, account, version, fallback })
    if (before) await before()
    await rig.userMail(name, `PROOF-WALL: ${name}, please do the thing.`)
    await rig.waitFor(() => rig.agentRow(name)?.frozen || accountOf(id) !== (account ?? null), { what: `${name}'s wall`, timeout: 45000 })
    if (fallback) {
      await rig.waitFor(() => accountOf(id) !== (account ?? null) || stays(id).test(rig.engineLog()),
        { what: `${name}'s fallback decision`, timeout: 45000 }).catch(() => null)
    } else {
      await sleep(4000)
    }
    const a = rig.agentRow(name)
    return { id, account: accountOf(id), frozen: a?.frozen ?? null, last_error: a?.last_error ?? null }
  }
  /** a moved agent's next turn: where it ran and whether its held request was replayed there */
  const after = async (name, id, n = 2) => {
    await rig.waitTurns(name, n, { timeout: 45000 }).catch(() => null)
    const start = lastStart(name)
    return { account: accountOf(id), frozen: rig.agentRow(name)?.frozen ?? null, roots: start?.xdg_config ?? null,
      key: start?.meta_api_key_set ?? null, replayed: prompts(name).slice(1).some((t) => t.includes('PROOF-WALL')) }
  }
  const own_ = (r) => !r.account && !r.frozen && !(r.roots ?? '').includes(`${path.sep}profiles${path.sep}`) && r.key === false

  await ownCatalog(...ALL)
  await switches(true, false)

  // ---------------------------------------------------------------- C4a
  // jo: already on the user's own login; it is never offered to her again
  const jo = await wall('jo')
  p.check('C4a jo: an agent already on the user\'s own login stays frozen there (no move onto the same login)',
    !!jo.frozen && jo.account === null && held(jo) && stays(jo.id).test(rig.engineLog()), jo)

  const P1 = await profile([W])
  const ana = await wall('ana', { account: P1.id })
  const anaAfter = await after('ana', ana.id)
  p.check('C4a ana: on a profile at its limit she moves back to the user\'s own login (offers Wonder, allowed, signed in, room)',
    ana.account === null && own_(anaAfter), { wall: ana, after: anaAfter })
  p.check('C4a ana: her held request is replayed in her next turn there', anaAfter.replayed, prompts('ana'))

  await switches(false, false)
  const P2 = await profile([W])
  const bo = await wall('bo', { account: P2.id })
  await switches(true, false)
  p.check('C4a bo: with the own-login subscription switch off she stays frozen on her profile, the request held',
    !!bo.frozen && bo.account === P2.id && held(bo), bo)

  await settings(['muse/primary'])
  const P3 = await profile([W])
  const cy = await wall('cy', { account: P3.id })
  await settings([])
  p.check('C4a cy: with the org\'s list disallowing the user\'s own login she stays frozen on her profile',
    !!cy.frozen && cy.account === P3.id && held(cy), cy)

  const P4 = await profile([W])
  const di = await wall('di', { account: P4.id, before: () => own(UNKNOWN) })
  await own(ROOM)
  p.check('C4a di: with the own login\'s reading unknown (never room) she stays frozen on her profile',
    !!di.frozen && di.account === P4.id && held(di), di)

  const P5 = await profile([W])
  const ed = await wall('ed', { account: P5.id, before: () => own(FULL) })
  await own(ROOM)
  p.check('C4a ed: with the own login at its limit she stays frozen on her profile', !!ed.frozen && ed.account === P5.id && held(ed), ed)

  const P6 = await profile([W])
  const fay = await wall('fay', { account: P6.id, before: () => own(signedOut()) })
  await own(ROOM)
  p.check('C4a fay: with the own login needing a sign-in she stays frozen on her profile', !!fay.frozen && fay.account === P6.id && held(fay), fay)

  const P7 = await profile([FULL_MODEL])
  const gus = await wall('gus', { tier: 'wonder-full', account: P7.id, before: () => ownCatalog(W, S13, S12) })
  await ownCatalog(...ALL)
  p.check('C4a gus: with the own login\'s catalog lacking Wonder Full he stays frozen on his profile',
    !!gus.frozen && gus.account === P7.id && held(gus), gus)

  const P8 = await profile([S13, S12])
  const hal = await wall('hal', { tier: 'spark', account: P8.id, version: '1.2', before: () => ownCatalog(W, FULL_MODEL, S13) })
  await ownCatalog(...ALL)
  p.check('C4a hal: pinned to Spark 1.2, with the own login offering only 1.3, he stays frozen on his profile',
    !!hal.frozen && hal.account === P8.id && held(hal), hal)

  const P9 = await profile([W])
  const ivo = await wall('ivo', { account: P9.id, fallback: false })
  p.check('C4a ivo: an agent that did not opt into fallback stays frozen on his profile',
    !!ivo.frozen && ivo.account === P9.id && held(ivo), ivo)

  const P11 = await profile([W])
  const R11 = await profile([W], ROOM)
  const kit = await wall('kit', { account: P11.id })
  p.check('C4a kit: a registered subscription with room comes before the user\'s own login', kit.account === R11.id && !kit.frozen, kit)
  R11.reading(FULL)

  const P12 = await profile([W])
  const K = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'apikey', key: 'muse-rig-not-a-real-key' })).id
  accounts.push(K)
  const keyConfig = path.join(rig.data, 'profiles', `muse-key-${K}`, 'config')
  fs.mkdirSync(keyConfig, { recursive: true })
  fs.writeFileSync(path.join(keyConfig, 'muse-catalog.json'), catalogOf(W))
  await switches(true, true)
  const lev = await wall('lev', { account: P12.id })
  await switches(true, false)
  p.check('C4a lev: with the API-key switch on and a key that offers Wonder, the user\'s own login still comes first',
    lev.account === null && !lev.frozen, { lev, key: K })

  // ---------------------------------------------------------------- C4b
  // every other Muse login is unticked in each case, so only the named targets are in play
  const only = (...keep) => accounts.filter((a) => !keep.includes(a))
  /** hire `name` on `q`, untick `off`, mail it: the org-list move runs at that turn's boundary */
  const leave = async (name, q, off, { tier = 'wonder', version, before } = {}) => {
    const id = await hire(name, { tier, account: q, version })
    if (before) await before()
    await settings(off)
    await rig.userMail(name, `PROOF-NEXT: ${name}, the next turn.`)
    await rig.waitFor(() => rig.agentRow(name)?.frozen || accountOf(id) !== q || rig.turns(name).length > 0 || rig.agentRow(name)?.last_error,
      { what: `${name}'s org-list move`, timeout: 45000 }).catch(() => null)
    await sleep(1500)
    const a = rig.agentRow(name)
    return { id, account: accountOf(id), frozen: a?.frozen ?? null, last_error: a?.last_error ?? null, turns: rig.turns(name).length }
  }
  const ran = async (name, n = 1) => {
    await rig.waitTurns(name, n, { timeout: 45000 }).catch(() => null)
    const start = lastStart(name)
    return { turns: rig.turns(name).length, roots: start?.xdg_config ?? null, key: start?.meta_api_key_set ?? null,
      delivered: prompts(name).some((t) => t.includes('PROOF-NEXT')) }
  }
  const noOther = (r) => !!r.frozen && r.frozen.cause === 'org_accounts' && /allows no other Muse account/.test(r.frozen.error ?? '')

  const Q1 = await profile([W])
  const R1 = await profile([W], UNKNOWN)
  const mo = await leave('mo', Q1.id, only(R1.id))
  const moRan = await ran('mo')
  p.check('C4b mo: unticked, she goes to the allowed login that offers Wonder (no proven room needed for this move) and runs there',
    mo.account === R1.id && !mo.frozen && moRan.delivered && (moRan.roots ?? '').toLowerCase().startsWith(R1.dir.toLowerCase()), { mo, ran: moRan })

  const Q2 = await profile([W])
  const R2 = await profile([S13], UNKNOWN)
  const nia = await leave('nia', Q2.id, [...only(R2.id), 'muse/primary'])
  p.check('C4b nia: the only allowed login lacks Wonder and the own login is unticked: she freezes saying so, still on her login, no turn run',
    noOther(nia) && nia.account === Q2.id && nia.turns === 0, nia)
  await settings([...only(R2.id, Q2.id), 'muse/primary'])
  const niaRan = await ran('nia')
  p.check('C4b nia: re-ticking her login lets her run, the waiting mail delivered', niaRan.delivered && accountOf(nia.id) === Q2.id, niaRan)

  const Q3 = await profile([S13, S12])
  const oz = await leave('oz', Q3.id, only(), { tier: 'spark', version: '1.2', before: () => ownCatalog(W, FULL_MODEL, S13) })
  await ownCatalog(...ALL)
  p.check('C4b oz: pinned to Spark 1.2, unticked, the own login offers only 1.3: he freezes saying so, still on his login',
    noOther(oz) && oz.account === Q3.id && oz.turns === 0, oz)

  const Q4 = await profile([W])
  const pip = await leave('pip', Q4.id, only(), { before: () => own(signedOut()) })
  await own(ROOM)
  p.check('C4b pip: unticked, the own login offers Wonder but needs a sign-in: never a target, she freezes saying so',
    noOther(pip) && pip.account === Q4.id && pip.turns === 0, pip)

  const Q5 = await profile([W])
  const quin = await leave('quin', Q5.id, only())
  const quinRan = await ran('quin')
  p.check('C4b quin: unticked, nothing registered left: the user\'s own login (offers Wonder, signed in) takes her and she runs',
    quin.account === null && !quin.frozen && quinRan.delivered && !(quinRan.roots ?? '').includes(`${path.sep}profiles${path.sep}`), { quin, ran: quinRan })

  await settings([])
  p.keep(rig, { agents: AGENTS, grep: /account fallback|stays frozen|own login|Muse login|org_accounts|leave/i })
  return p.summary()
}
