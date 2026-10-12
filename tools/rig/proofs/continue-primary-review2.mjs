// Cross-alias authentication recovery and actual automatic fallback, fake CLI only.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const quote = s => `'${String(s).replaceAll("'", "''")}'`
const future = h => new Date(Date.now() + h * 3600e3).toISOString()
const room = () => ({ available: true, limits: [
  { kind: 'session', percent: 10, resets_at: future(3), is_active: false },
  { kind: 'weekly_all', percent: 20, resets_at: future(72), is_active: false },
] })
const negative = () => ({ available: false, error: 'rig sign-in rejected',
  reauth_required: true, reauth_evidence: 'measured_403' })
function home(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'rig-auth@example.invalid' },
  }))
  return dir
}

export default async function (rig) {
  const p = new Proof('continue-primary-review2')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settled', timeout: 60000 })
  const usage = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usage, { recursive: true })
  const put = (name, value) => fs.writeFileSync(path.join(usage, `${name}.json`), JSON.stringify(value))
  for (const name of ['claude', 'claude@.claude', 'claude@auth-b', 'claude@auth-c']) put(name, room())
  const nativeHome = home(path.join(rig.data, 'rig-home', '.claude'))
  const A = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported', path: nativeHome })).id
  const B = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: home(path.join(rig.data, 'rig-home', 'auth-b')) })).id
  const cHome = home(path.join(rig.data, 'rig-home', 'auth-c'))
  const C = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported', path: cHome })).id
  const native = () => rig.api('GET', '/api/usage?force=true')
  const ambient = () => rig.api('GET', `/api/accounts/${A}/usage?force=true`)
  await native(); await ambient()
  await rig.api('GET', `/api/accounts/${B}/usage?force=true`)
  await rig.api('GET', `/api/accounts/${C}/usage?force=true`)
  await rig.op({ op: 'hire', name: 'mira', parent: 'boss', tier: 'haiku', title: 'Alias recovery', account: B })
  const id = rig.one("SELECT id FROM ot.agents WHERE name='mira' AND state='live'").id
  const seat = () => rig.one(`SELECT account,pending_account,frozen,limit_locked,row_version FROM ot.agents WHERE id=${id}`)
  const snapshot = () => JSON.stringify({ seat: seat(), counts: rig.one(`SELECT
    (SELECT count(*) FROM ot.events WHERE subject_agent_id=${id} AND op='account_switch') AS events,
    (SELECT count(*) FROM ot.mail WHERE recipient_agent_id=${id} AND sender='@system') AS mail`) })
  const hold = async () => {
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id=${id} AND ended_at IS NULL`).length === 0,
      { what: 'alias turn settled', timeout: 60000 })
    rig.exec(`UPDATE ot.agents SET account=${quote(B)},pending_account=${quote(JSON.stringify({account:C}))}::jsonb,
      limit_locked=true,frozen='{"limit":true,"cause":"usage_limit","resume_texts":["REPLAY-AUTH"],"until":"${future(3)}"}'::jsonb
      WHERE id=${id}`)
  }
  const tool = account => rig.tool('boss', 'orgtree_continue_on', { node: 'mira', account })
  const http = account => rig.api('POST', `/api/orgs/${rig.org}/nodes/mira/continue-on`, { account })
    .then(json => ({ ok: true, json }), e => ({ ok: false, text: e.message }))
  const deny = async (what, account, route) => {
    await hold()
    const before = snapshot()
    const result = await route(account)
    p.check(what, !result.ok && /requires sign-in/.test(result.text ?? '') && snapshot() === before,
      { ok: result.ok, unchanged: snapshot() === before, text: result.text?.slice(0, 160) })
  }
  for (const [direction, badName, badRead, goodName, goodRead] of [
    ['explicit negative then native success', 'claude@.claude', ambient, 'claude', native],
    ['native negative then explicit success', 'claude', native, 'claude@.claude', ambient],
  ]) {
    put('claude', room()); await native()
    put('claude@.claude', room()); await ambient()
    put(badName, negative()); await badRead()
    put(goodName, room()); await goodRead()
    for (const [account, route] of [['primary', tool], [A, http]]) {
      await hold()
      const before = rig.turns('mira').length
      const result = await route(account)
      p.check(`${direction}: ${account === A ? 'ambient id' : account} resumes`, result.ok
        && !seat().frozen && seat().pending_account === null && !seat().limit_locked
        && seat().account === (account === A ? A : null), { ok: result.ok, seat: seat() })
      if (result.ok) await rig.waitTurns('mira', before + 1, { timeout: 60000 })
    }
    put(badName, negative()); await badRead()
    await deny(`${direction}: newer negative still refuses primary`, 'primary', tool)
    await deny(`${direction}: newer negative still refuses ambient id`, A, http)
    put(goodName, { available: false, error: 'rig transient failure' }); await goodRead()
    await deny(`${direction}: transient on other alias cannot clear negative`, 'primary', tool)
  }

  // A is the first registry candidate. It retains complete good bars after
  // an authentication failure; C is later, separately signed in, with room.
  put('claude', room()); await native()
  put('claude@.claude', room()); await ambient()
  put('claude@.claude', negative()); await ambient()
  const peek = await rig.api('GET', '/api/accounts')
  const ord = rig.sql(`SELECT id,ord,auth FROM ot.accounts WHERE id IN (${quote(A)},${quote(C)}) ORDER BY ord,id`)
  p.check('fallback fixture orders authenticated ambient A before usable C', ord[0]?.id === A
    && ord[0].auth === 'authenticated' && ord[1]?.id === C, ord)
  p.note('registered accounts snapshot available for fixture inspection', Array.isArray(peek) ? peek.length : Object.keys(peek))
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  rig.scenario({ agents: { ned: { turns: [{ name: 'limited', match: 'PROOF-FALLBACK-REJECTED', once: true, steps: [
    { text: 'Starting.' },
    { rate_limit: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour', overageStatus: 'rejected' } },
    { result: { is_error: true, text: "You've hit your limit · resets 7am" } },
  ] }] } }, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.op({ op: 'hire', name: 'ned', parent: 'boss', tier: 'haiku', title: 'Eligibility fallback',
    account: B, account_fallback: true })
  const fallbackSeat = () => rig.one(`SELECT account,frozen FROM ot.agents WHERE name='ned' AND state='live'`)
  await rig.userMail('ned', 'PROOF-FALLBACK-REJECTED: continue the held request.')
  await rig.waitTurns('ned', 1, { timeout: 60000 })
  const moved = await rig.waitFor(() => {
    const s = fallbackSeat()
    return s.account === C || /account fallback failed/.test(rig.engineLog()) ? s : null
  }, { what: 'real fallback selects later eligible account', timeout: 30000 }).catch(() => fallbackSeat())
  p.check('actual fallback skips rejected first candidate and continues on later C', moved.account === C && !moved.frozen,
    { A, B, C, seat: moved })
  if (moved.account === C) await rig.waitTurns('ned', 2, { timeout: 60000 })
  const launched = rig.fakeLog('ned').filter(l => l.kind === 'start').at(-1)
  p.check('fallback actually launches later C and completes its resumed turn', moved.account === C
    && path.resolve(launched?.config_dir ?? '').toLowerCase() === path.resolve(cHome).toLowerCase()
    && rig.turns('ned').length >= 2 && !rig.turns('ned').at(-1)?.error)
  p.check('fallback retains the exhausted original account mark', rig.sql(`SELECT 1 FROM ot.account_marks WHERE account=${quote(B)}`).length > 0)
  p.keep(rig, { agents: ['mira', 'ned'], grep: /fallback|usage read|continue|requires sign-in/ })
  return p.summary()
}
