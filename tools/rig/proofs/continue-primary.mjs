// Native continuation through both real entry points, on a disposable rig only.
// --signed-out removes the fake native Codex login before discovery.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const quote = s => `'${String(s).replaceAll("'", "''")}'`
const later = h => new Date(Date.now() + h * 3600e3).toISOString()
const reading = (session = 10, weekly = 20) => ({ available: true, limits: [
  { kind: 'session', group: 'codex', percent: session, resets_at: later(3), is_active: false, model: null },
  { kind: 'weekly_all', group: 'codex', percent: weekly, resets_at: later(72), is_active: false, model: null },
] })
function codexHome(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null,
    tokens: { id_token: `${b64({ alg: 'none' })}.${b64({ email: 'rig-secondary@example.invalid' })}.rig` } }))
  return dir
}
export function setup(flags) {
  return flags['signed-out'] ? { prepare: ({ data }) => {
    fs.rmSync(path.join(data, 'rig-home', '.codex', 'auth.json'))
  } } : {}
}

export default async function (rig, { flags }) {
  const p = new Proof(flags['signed-out'] ? 'continue-primary-signed-out' : 'continue-primary')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'fixture turns settled', timeout: 60000 })
  const usage = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usage, { recursive: true })
  const put = (name, data) => fs.writeFileSync(path.join(usage, `${name}.json`), JSON.stringify(data))
  put('openai@codex-b', reading())
  put('openai@codex-c', reading())
  put('openai', reading())
  const B = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported',
    path: codexHome(path.join(rig.data, 'rig-home', 'codex-b')) })).id
  const C = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported',
    path: codexHome(path.join(rig.data, 'rig-home', 'codex-c')) })).id
  await rig.api('GET', `/api/accounts/${B}/usage?force=true`)
  await rig.api('GET', `/api/accounts/${C}/usage?force=true`)
  const nativeRead = () => rig.api('GET', '/api/codex/usage?force=true')
  if (!flags['signed-out']) await nativeRead()
  await rig.op({ op: 'hire', name: 'mira', parent: 'boss', tier: 'sol', title: 'Continuation proof', account: B })
  const id = rig.one("SELECT id FROM ot.agents WHERE name='mira' AND state='live'").id
  const seat = () => rig.one(`SELECT account,pending_account,frozen,limit_locked,row_version FROM ot.agents WHERE id=${id}`)
  const counts = () => rig.one(`SELECT (SELECT count(*) FROM ot.events WHERE subject_agent_id=${id} AND op='account_switch') AS events,
    (SELECT count(*) FROM ot.mail WHERE recipient_agent_id=${id} AND sender='@system') AS mail`)
  const snapshot = () => JSON.stringify({ seat: seat(), counts: counts() })
  const freeze = async () => {
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id=${id} AND ended_at IS NULL`).length === 0,
      { what: 'continuation turn settled', timeout: 60000 })
    rig.exec(`UPDATE ot.agents SET account=${quote(B)},pending_account=${quote(C)},limit_locked=true,
      frozen='{"limit":true,"cause":"usage_limit","resume_texts":["REPLAY-PRIMARY-PROOF"],"until":"${later(3)}"}'::jsonb WHERE id=${id}`)
  }
  const http = account => rig.api('POST', `/api/orgs/${rig.org}/nodes/mira/continue-on`, { account })
    .then(json => ({ ok: true, json }), e => ({ ok: false, text: e.message }))
  const tool = account => rig.tool('boss', 'orgtree_continue_on', { node: 'mira', account })
  const refuse = async (what, account, re, route = tool) => {
    const before = snapshot()
    const result = await route(account)
    p.check(what, !result.ok && re.test(result.text ?? '') && snapshot() === before,
      { text: result.text?.slice(0, 240), stateUnchanged: snapshot() === before })
  }
  await freeze()
  if (flags['signed-out']) {
    await refuse('signed-out native login refused by tool; freeze/pending/audit/mail unchanged', 'primary', /not signed in/)
    await refuse('signed-out native login refused by user route too', 'openai/primary', /not signed in/, http)
    const detail = await rig.api('GET', `/api/orgs/${rig.org}/nodes/mira/detail`)
    p.check('signed-out primary absent from UI candidates', !detail.continue_accounts?.includes('openai/primary'))
    return p.summary()
  }
  const detail = await rig.api('GET', `/api/orgs/${rig.org}/nodes/mira/detail`)
  p.check('secondary-frozen UI offers openai/primary', detail.continue_accounts?.includes('openai/primary'), detail.continue_accounts)
  for (const invalid of ['claude/primary', 'bogus/primary', 'openai/missing', '', '/primary']) {
    await refuse(`invalid ${JSON.stringify(invalid)} retains all state`, invalid, /runs on openai|no account|choose an account|account.*required/)
  }
  await refuse('user route rejects provider mismatch equally', 'claude/primary', /runs on openai/, http)
  for (const tier of ['or-proof', 'ls-proof-model']) {
    rig.exec(`UPDATE ot.agents SET tier=${quote(tier)} WHERE id=${id}`)
    await refuse(`unsupported native primary on ${tier} refused`, 'primary', /no native primary/)
  }
  rig.exec(`UPDATE ot.agents SET tier='sol' WHERE id=${id}`)
  const unauthorized = await rig.tool('alice', 'orgtree_continue_on', { node: 'mira', account: 'primary' })
  p.check('peer cannot continue another subtree', !unauthorized.ok && seat().account === B && !!seat().frozen, unauthorized.text?.slice(0, 200))
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ['openai/primary'] })
  await refuse('org-disabled primary refused', 'primary', /not used by the org/)
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })
  await rig.api('PUT', '/api/providers/openai/subscription-inference', { enabled: false })
  await refuse('inactive native account refused', 'default', /inactive/)
  await rig.api('PUT', '/api/providers/openai/subscription-inference', { enabled: true })
  await rig.api('PUT', '/api/providers/openai/enabled', { enabled: false })
  await refuse('inactive provider refused', 'openai/primary', /inactive/, http)
  await rig.api('PUT', '/api/providers/openai/enabled', { enabled: true })
  for (const [window, data] of [['session', reading(100, 20)], ['weekly', reading(10, 100)]]) {
    put('openai', data); await nativeRead()
    await refuse(`primary ${window} exhaustion refused by tool`, 'primary', /100%/)
    await refuse(`primary ${window} exhaustion refused by user route`, 'openai/primary', /100%/, http)
  }
  put('openai', reading()); await nativeRead()
  for (const negative of [{ reauth_required: true }, { reauth_evidence: 'not_connected' }]) {
    put('openai', { available: false, ...negative }); await nativeRead()
    await refuse('recent negative native auth evidence refused without state change', 'primary', /requires sign-in/)
  }
  put('openai', reading()); await nativeRead()
  // Keep the exhausted secondary's mark: moving away must never erase it.
  rig.exec(`INSERT INTO ot.account_marks(account,pool,until,provenance) VALUES (${quote(B)},'default','${later(3)}','observed')`)
  await rig.api('PUT', `/api/accounts/${B}/enabled`, { enabled: true }) // snapshot reload
  const markBefore = JSON.stringify(rig.sql(`SELECT * FROM ot.account_marks WHERE account=${quote(B)}`))
  for (const [i, alias] of ['primary', 'openai/primary', 'default', '  primary  '].entries()) {
    await freeze()
    const beforeTurns = rig.turns('mira').length
    const result = await (i % 2 ? http : tool)(alias)
    const row = seat()
    const audit = rig.one(`SELECT detail FROM ot.events WHERE subject_agent_id=${id} AND op='account_switch' ORDER BY id DESC LIMIT 1`)
    const mail = rig.one(`SELECT body FROM ot.mail WHERE recipient_agent_id=${id} AND sender='@system' ORDER BY id DESC LIMIT 1`)
    p.check(`alias ${JSON.stringify(alias)} atomically resumes on native binding`, result.ok && row.account === null
      && row.pending_account === null && row.frozen === null && !row.limit_locked
      && audit?.detail?.account === 'openai/primary' && audit.detail.cache_namespace_changed === true
      && mail?.body.includes('REPLAY-PRIMARY-PROOF') && mail.body.includes('new provider cache namespace'), { result, row, audit })
    await rig.waitTurns('mira', beforeTurns + 1, { timeout: 60000 })
    const turn = rig.fakeLog('mira').filter(l => l.kind === 'turn').at(-1)
    const start = rig.fakeLog('mira').filter(l => l.kind === 'start').at(-1)
    p.check(`alias ${JSON.stringify(alias)} actually launches native home and replays`,
      turn && path.resolve(start?.codex_home ?? '').toLowerCase() === path.resolve(path.join(rig.data, 'rig-home', '.codex')).toLowerCase()
      && turn.prompt?.includes('REPLAY-PRIMARY-PROOF'), { home: start?.codex_home })
  }
  p.check('secondary capacity mark survives every primary switch', markBefore === JSON.stringify(rig.sql(`SELECT * FROM ot.account_marks WHERE account=${quote(B)}`)))
  // The same shared route resolves each native provider, never the old binding.
  // Synthetic frozen rows avoid making any real provider quota request.
  for (const [tier, provider] of [['haiku', 'claude'], ['flash', 'google']]) {
    await freeze()
    rig.exec(`UPDATE ot.agents SET tier=${quote(tier)},provider=${quote(provider)},session_id=NULL WHERE id=${id}`)
    const beforeTurns = rig.turns('mira').length
    const result = await http(`${provider}/primary`)
    p.check(`${provider} qualified native primary resolves independently of secondary`,
      result.ok && result.json?.account === `${provider}/primary` && seat().account === null && !seat().frozen, result)
    if (result.ok) await rig.waitTurns('mira', beforeTurns + 1, { timeout: 60000 })
  }
  rig.exec(`UPDATE ot.agents SET tier='sol',provider='openai',session_id=NULL WHERE id=${id}`)
  await freeze()
  await rig.api('PUT', `/api/accounts/${C}/enabled`, { enabled: false })
  await refuse('disabled registered target retains freeze', C, /inactive/)
  await rig.api('PUT', `/api/accounts/${C}/enabled`, { enabled: true })
  // Failure after the agent UPDATE proves transaction rollback, not just validation.
  for (const table of ['events', 'mail']) {
    rig.exec(`CREATE FUNCTION ot.proof_continuation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'continuation proof write failure'; END $$;
      CREATE TRIGGER proof_continuation_fail BEFORE INSERT ON ot.${table} FOR EACH ROW EXECUTE FUNCTION ot.proof_continuation_fail()`)
    await refuse(`failed ${table} insertion rolls back binding/freeze/pending/audit/mail`, 'primary', /write failure|database|db error|internal/i, http)
    rig.exec(`DROP TRIGGER proof_continuation_fail ON ot.${table}; DROP FUNCTION ot.proof_continuation_fail()`)
  }
  const registered = await tool(C)
  p.check('ordinary registered-account continuation preserved', registered.ok && seat().account === C && !seat().frozen, registered)
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id=${id} AND ended_at IS NULL`).length === 0, { what: 'last turn settled' })
  // Native mark with unknown usage: no reading can mean zero or clear that mark.
  const A = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported',
    path: path.join(rig.data, 'rig-home', '.codex') })).id
  rig.exec(`INSERT INTO ot.account_marks(account,pool,until,provenance) VALUES (${quote(A)},'default','${later(3)}','observed')`)
  await rig.api('PUT', `/api/accounts/${A}/enabled`, { enabled: true })
  put('openai', { available: false, error: 'rig missing reading' }); await nativeRead()
  await freeze()
  await refuse('unknown native usage cannot bypass ambient capacity mark', 'primary', /itself limited/)
  p.check('native capacity mark retained', rig.sql(`SELECT 1 FROM ot.account_marks WHERE account=${quote(A)}`).length === 1)
  p.keep(rig, { agents: ['mira'], grep: /continue|account_switch|namespace/ })
  return p.summary()
}
