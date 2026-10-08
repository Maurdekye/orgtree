// Proof: Claude agents across accounts (the claude lane with more than one
// login), on the fake Claude Code. The fake is as strict as the CLI about
// `--resume`: the transcript must be under its own config folder.
//   B, an imported Claude config folder, and K, an API-key account, are added
//   through the accounts route.
//   mia: hired on B: her CLI runs with CLAUDE_CONFIG_DIR = B's folder.
//   pat: hired on K: his gets ANTHROPIC_API_KEY, never a config folder.
//   ned: on the primary with account fallback: a usage limit moves him to
//        another account at once; his transcript is carried into its folder
//        and the session resumed.
//   ola: on the primary without fallback: a usage limit freezes her; her
//        superior's orgtree_continue_on moves her to B the same way.
//   B turned off: mia's mail waits, and runs when B is back on.
//   B removed: mia is back on the primary; her transcript stayed in B's
//        folder, so her next turn starts a new session with the handoff note.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/claude-accounts.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

function claudeHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return dir
}
function transcripts(dir) {
  const root = path.join(dir, 'projects')
  return fs.existsSync(root) ? fs.readdirSync(root).flatMap(p => fs.readdirSync(path.join(root, p)).map(f => path.join(root, p, f))) : []
}
const same = (a, b) => path.resolve(a ?? '').toLowerCase() === path.resolve(b ?? '').toLowerCase()

export default async function (rig) {
  const p = new Proof('claude-accounts')
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  const limited = match => ({ name: 'limited', match, once: true, steps: [
    { text: 'Starting on it.' },
    { rate_limit: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour', overageStatus: 'rejected' } },
    { result: { is_error: true, text: "You've hit your limit · resets 7am" } },
  ] })
  rig.scenario({
    agents: { ned: { turns: [limited('PROOF-LIMIT')] }, ola: { turns: [limited('PROOF-LIMIT')] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- the accounts
  const homeA = path.join(rig.data, 'rig-home', '.claude')
  const homeB = claudeHome(path.join(rig.data, 'rig-home', 'claude-b'), 'rig-b@example.invalid')
  // B reads as having room: the automatic fallback moves an agent only onto proven room
  const soon = h => new Date(Date.now() + h * 3600e3).toISOString()
  fs.mkdirSync(path.join(rig.data, 'rig-home', 'rig-usage'), { recursive: true })
  fs.writeFileSync(path.join(rig.data, 'rig-home', 'rig-usage', 'claude@claude-b.json'), JSON.stringify({ available: true, limits: [
    { kind: 'session', percent: 10, resets_at: soon(3), is_active: false },
    { kind: 'weekly_all', percent: 20, resets_at: soon(72), is_active: false }] }))
  const B = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported', path: homeB })).id
  const K = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'apikey', key: 'sk-ant-api03-rig-not-a-real-key' })).id
  const rowB = rig.one(`SELECT id, kind, auth, identity FROM ot.accounts WHERE id = '${B}'`)
  p.check('B: an imported Claude folder, signed in as its own email', rowB?.kind === 'imported' && rowB.auth === 'authenticated'
    && rowB.identity?.email === 'rig-b@example.invalid', rowB)
  p.check('K: an API-key account', rig.one(`SELECT kind FROM ot.accounts WHERE id = '${K}'`)?.kind === 'apikey', { K })
  const hire = (name, extra) => rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Claude rig agent', ...extra })
  await hire('mia', { account: B })
  await hire('pat', { account: K })
  await hire('ned', { account_fallback: true })
  await hire('ola', {})
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const seat = name => rig.one(`SELECT a.account, a.frozen, a.session_id FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${rig.org}' AND o.state = 'active' AND a.name = '${name}'`)

  // ---------------------------------------------------------------- mia on B, pat on K
  await rig.userMail('mia', 'Hello mia.')
  await rig.userMail('pat', 'Hello pat.')
  const [mt] = await rig.waitTurns('mia', 1)
  const [pt] = await rig.waitTurns('pat', 1)
  const ms = log('mia', 'start')[0]
  p.check('mia: her CLI runs with CLAUDE_CONFIG_DIR = B\'s folder', same(ms?.config_dir, homeB) && !ms.api_key_set, { dir: ms?.config_dir })
  const mSession = seat('mia').session_id
  p.check('mia: her transcript lives under B', transcripts(homeB).some(f => f.endsWith(`${mSession}.jsonl`))
    && !transcripts(homeA).some(f => f.endsWith(`${mSession}.jsonl`)))
  p.check('mia: the turn is booked to B', !mt.error && rig.one(`SELECT account FROM ot.turns WHERE id = ${mt.id}`)?.account === B)
  const ps = log('pat', 'start')[0]
  p.check('pat: his CLI gets the API key and no config folder', ps?.api_key_set && !ps.config_dir_set, { key: ps?.api_key_set, dir: ps?.config_dir })
  const prow = rig.one(`SELECT account, api_key FROM ot.turns WHERE id = ${pt.id}`)
  p.check('pat: the turn is booked to K as a key turn', !pt.error && prow?.account === K && prow.api_key === true, prow)

  // ---------------------------------------------------------------- ned: automatic fallback
  await rig.userMail('ned', 'Hello ned.')
  await rig.waitTurns('ned', 1)
  const nSession = seat('ned').session_id
  p.check('ned: his first transcript lives under the primary folder', transcripts(homeA).some(f => f.endsWith(`${nSession}.jsonl`)))
  await rig.userMail('ned', 'PROOF-LIMIT: please do the big thing.')
  const moved = await rig.waitFor(() => { const a = seat('ned'); return a?.account ? a : null },
    { what: 'ned to move to another account', timeout: 30000 }).catch(() => seat('ned'))
  p.check('ned: the usage limit moved him to another account at once (no freeze)', moved.account === B && !moved.frozen,
    { account: moved.account, frozen: moved.frozen })
  const nTurns = await rig.waitTurns('ned', 3, { timeout: 60000 }).catch(() => rig.turns('ned'))
  const nStart = log('ned', 'start').at(-1)
  p.check('ned: the new CLI runs in B\'s folder and resumed his session', same(nStart?.config_dir, homeB) && nStart.resumed
    && nStart.session === nSession, { dir: nStart?.config_dir, resumed: nStart?.resumed, session: nStart?.session })
  p.check('ned: his transcript was carried into B\'s folder', transcripts(homeB).some(f => f.endsWith(`${nSession}.jsonl`)))
  const nAfter = log('ned', 'turn').at(-1)
  p.check('ned: the next turn says where he runs now and completes', /You now run on the account/.test(nAfter?.prompt ?? '')
    && nTurns.length >= 3 && !nTurns.at(-1).error, { prompt: String(nAfter?.prompt ?? '').slice(-200), errors: nTurns.map(t => t.error) })

  // ---------------------------------------------------------------- ola: frozen, then continue-on
  await rig.userMail('ola', 'Hello ola.')
  await rig.waitTurns('ola', 1)
  const oSession = seat('ola').session_id
  await rig.userMail('ola', 'PROOF-LIMIT: please do the other thing.')
  const of = await rig.waitFor(() => seat('ola')?.frozen, { what: 'ola to be frozen' })
  p.check('ola: without fallback the limit freezes her until the reset', of.limit === true
    && Math.abs(Date.parse(of.until) / 1000 - resetAt) <= 5, { until: of.until })
  const co = await rig.tool('boss', 'orgtree_continue_on', { node: 'ola', account: B })
  p.check('ola: her superior moves her to B (orgtree_continue_on)', co.ok && seat('ola')?.account === B && !seat('ola')?.frozen, co.text?.slice(0, 200))
  const oTurns = await rig.waitTurns('ola', 3, { timeout: 60000 }).catch(() => rig.turns('ola'))
  const oStart = log('ola', 'start').at(-1)
  p.check('ola: her CLI runs in B\'s folder, resumed her session, and the turn completes', same(oStart?.config_dir, homeB) && oStart.resumed
    && oStart.session === oSession && transcripts(homeB).some(f => f.endsWith(`${oSession}.jsonl`)) && oTurns.length >= 3 && !oTurns.at(-1).error,
    { dir: oStart?.config_dir, resumed: oStart?.resumed, errors: oTurns.map(t => t.error) })

  // ---------------------------------------------------------------- B turned off, then removed
  await rig.api('PUT', `/api/accounts/${B}/enabled`, { enabled: false })
  await rig.userMail('mia', 'WAIT-1: while B is off.')
  await new Promise(r => setTimeout(r, 5000))
  const held = rig.one(`SELECT state FROM ot.mail WHERE body = 'WAIT-1: while B is off.'`)
  p.check('B off: mia\'s mail waits (no turn on an inactive account)', rig.turns('mia').length === 1 && held?.state === 'pending',
    { turns: rig.turns('mia').length, mail: held?.state })
  await rig.api('PUT', `/api/accounts/${B}/enabled`, { enabled: true })
  const mt2 = await rig.waitTurns('mia', 2, { timeout: 30000 }).catch(() => rig.turns('mia'))
  p.check('B on again: the waiting mail runs on B', mt2.length === 2 && !mt2[1].error && same(log('mia', 'start').at(-1)?.config_dir, homeB),
    { turns: mt2.length, dir: log('mia', 'start').at(-1)?.config_dir })
  const removed = await rig.api('DELETE', `/api/accounts/${B}`).then(r => r, e => ({ error: e.message }))
  p.note('removing B', JSON.stringify(removed).slice(0, 800))
  p.check('B removed: mia, ned and ola are back on the primary', ['mia', 'ned', 'ola'].every(n => !seat(n)?.account),
    Object.fromEntries(['mia', 'ned', 'ola'].map(n => [n, seat(n)?.account])))
  await rig.userMail('mia', 'After B: are you there?')
  const mt3 = await rig.waitTurns('mia', 3, { timeout: 30000 }).catch(() => rig.turns('mia'))
  const mStart = log('mia', 'start').at(-1)
  const m3 = log('mia', 'turn').at(-1)
  p.note('B removed: how mia\'s next turn starts', { error: mt3[2]?.error, config_dir_set: mStart?.config_dir_set, resumed: mStart?.resumed,
    same_session: mStart?.session === mSession, handoff: /could not be resumed|account was removed/.test(m3?.prompt ?? ''),
    prompt: String(m3?.prompt ?? '').slice(0, 400) })
  p.check('B removed: her next turn runs on the primary folder and completes', mt3.length === 3 && !mt3[2].error && !mStart?.config_dir_set,
    { error: mt3[2]?.error, dir: mStart?.config_dir })

  p.keep(rig, { agents: ['mia', 'pat', 'ned', 'ola'], grep: /account|fallback|carried|transcript|continue|resum/ })
  return p.summary()
}
