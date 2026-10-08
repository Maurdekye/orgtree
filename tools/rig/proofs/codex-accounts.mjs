// Proof: Codex agents across accounts (the openai lane with more than one
// login), on the fake app-server.
//   B, an imported Codex home, and K, an API-key account, are added through
//   the accounts route.
//   mia: hired on B: her app-server runs with CODEX_HOME = B's folder.
//   pat: hired on K: his runs in the key's own home with OPENAI_API_KEY set.
//   ned: on the primary with account fallback: a usage limit moves him to
//        another account at once; his thread is carried into its home and
//        resumed, and the request the limit stopped is given again.
//   ola: on the primary without fallback: a usage limit freezes her; her
//        superior's orgtree_continue_on moves her to B the same way.
//   B turned off: mia's mail waits, and runs when B is back on.
//   B removed: mia is back on the primary; a Codex account change ends the
//        thread, so her next turn starts a fresh one with the handoff note.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/codex-accounts.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
function codexHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email })}.rig`
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken } }))
  return dir
}
function rollouts(home) {
  const out = []
  const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p)
  } }
  walk(path.join(home, 'sessions'))
  return out
}
const same = (a, b) => path.resolve(a ?? '').toLowerCase() === path.resolve(b ?? '').toLowerCase()
const LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later."

export default async function (rig) {
  const p = new Proof('codex-accounts')
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  const limited = match => ({ name: 'limited', match, once: true, steps: [
    { text: 'Starting on it.' },
    { rate_limit: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAt },
                    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: resetAt + 86400 } } },
    { error: { message: LIMIT, codexErrorInfo: 'usageLimitExceeded' } },
  ] })
  rig.scenario({
    agents: { ned: { turns: [limited('PROOF-LIMIT')] }, ola: { turns: [limited('PROOF-LIMIT')] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- the accounts
  const homeA = path.join(rig.data, 'rig-home', '.codex')
  const homeB = codexHome(path.join(rig.data, 'rig-home', 'codex-b'), 'rig-b@example.invalid')
  const B = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported', path: homeB })).id
  const K = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'apikey', key: 'sk-rig-not-a-real-key' })).id
  const accounts = await rig.api('GET', '/api/accounts')
  p.note('the accounts route after adding B and K', JSON.stringify(accounts).slice(0, 1500))
  const rowB = rig.one(`SELECT id, kind, auth, identity, config_dir FROM ot.accounts WHERE id = '${B}'`)
  p.check('B: an imported Codex home, signed in as its own email', rowB?.kind === 'imported' && rowB.auth === 'authenticated'
    && rowB.identity?.email === 'rig-b@example.invalid', rowB)
  p.check('K: an API-key account', rig.one(`SELECT kind FROM ot.accounts WHERE id = '${K}'`)?.kind === 'apikey', { K })
  const hire = (name, extra) => rig.op({ op: 'hire', name, parent: 'boss', tier: 'luna', title: 'Codex rig agent', ...extra })
  await hire('mia', { account: B })
  await hire('pat', { account: K })
  await hire('ned', { account_fallback: true })
  await hire('ola', {})
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const seat = name => rig.one(`SELECT a.account, a.frozen FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${rig.org}' AND o.state = 'active' AND a.name = '${name}'`)

  // ---------------------------------------------------------------- mia on B, pat on K
  await rig.userMail('mia', 'Hello mia.')
  await rig.userMail('pat', 'Hello pat.')
  const [mt] = await rig.waitTurns('mia', 1)
  const [pt] = await rig.waitTurns('pat', 1)
  const ms = log('mia', 'start')[0]
  p.check('mia: her app-server runs with CODEX_HOME = B\'s folder', ms?.codex_home_set && same(ms.codex_home, homeB) && !ms.api_key_set,
    { home: ms?.codex_home, set: ms?.codex_home_set })
  const mThread = log('mia', 'thread')[0]?.thread
  p.check('mia: her thread lives under B', rollouts(homeB).some(f => f.endsWith(`${mThread}.jsonl`)) && !rollouts(homeA).some(f => f.endsWith(`${mThread}.jsonl`)))
  p.check('mia: the turn is booked to B', !mt.error && rig.one(`SELECT account FROM ot.turns WHERE id = ${mt.id}`)?.account === B)
  const ps = log('pat', 'start')[0]
  p.check('pat: his app-server gets the key and the key\'s own home, never the primary login', ps?.api_key_set && ps.codex_home_set
    && /openai-key-/.test(ps.codex_home ?? '') && !same(ps.codex_home, homeA), { home: ps?.codex_home, key: ps?.api_key_set })
  const prow = rig.one(`SELECT account, api_key FROM ot.turns WHERE id = ${pt.id}`)
  p.check('pat: the turn is booked to K as a key turn', !pt.error && prow?.account === K && prow.api_key === true, prow)

  // ---------------------------------------------------------------- ned: automatic fallback
  await rig.userMail('ned', 'Hello ned.')
  await rig.waitTurns('ned', 1)
  const nThread = log('ned', 'thread')[0]?.thread
  p.check('ned: his first thread lives under the primary home', rollouts(homeA).some(f => f.endsWith(`${nThread}.jsonl`)))
  await rig.userMail('ned', 'PROOF-LIMIT: please do the big thing.')
  const moved = await rig.waitFor(() => { const a = seat('ned'); return a?.account ? a : null },
    { what: 'ned to move to another account', timeout: 30000 }).catch(() => seat('ned'))
  p.check('ned: the usage limit moved him to another account at once (no freeze)', !!moved.account && !moved.frozen,
    { account: moved.account, frozen: moved.frozen })
  const nTurns = await rig.waitTurns('ned', 3, { timeout: 60000 }).catch(() => rig.turns('ned'))
  const nAfter = log('ned', 'turn').at(-1)
  p.check('ned: the next turn says where he runs now and gives the stopped request again', /You now run on the account/.test(nAfter?.prompt ?? '')
    && /PROOF-LIMIT: please do the big thing/.test((nAfter?.prompt ?? '').split('You now run on the account')[1] ?? ''), String(nAfter?.prompt ?? '').slice(-400))
  const nStart = log('ned', 'start').at(-1)
  const nThreads = log('ned', 'thread')
  const toHome = moved.account === B ? homeB : nStart?.codex_home
  p.check('ned: the new app-server runs in that account\'s home and resumed his thread', nStart?.codex_home_set && same(nStart.codex_home, toHome)
    && nThreads.at(-1)?.action === 'resume' && nThreads.at(-1).thread === nThread, { home: nStart?.codex_home, threads: nThreads.map(l => [l.action, l.thread]) })
  p.check('ned: his rollout was carried into that home', rollouts(toHome).some(f => f.endsWith(`${nThread}.jsonl`)))
  p.check('ned: the turn on the new account completed', nTurns.length >= 3 && !nTurns.at(-1).error, nTurns.map(t => t.error))

  // ---------------------------------------------------------------- ola: frozen, then continue-on
  await rig.userMail('ola', 'Hello ola.')
  await rig.waitTurns('ola', 1)
  const oThread = log('ola', 'thread')[0]?.thread
  await rig.userMail('ola', 'PROOF-LIMIT: please do the other thing.')
  const of = await rig.waitFor(() => rig.agentRow('ola')?.frozen, { what: 'ola to be frozen' })
  p.check('ola: without fallback the limit freezes her, keeping the request', of.limit === true
    && /PROOF-LIMIT: please do the other thing/.test((of.resume_texts ?? []).join('\n')), { until: of.until })
  const co = await rig.tool('boss', 'orgtree_continue_on', { node: 'ola', account: B })
  p.check('ola: her superior moves her to B (orgtree_continue_on)', co.ok && seat('ola')?.account === B && !seat('ola')?.frozen, co.text?.slice(0, 200))
  const oTurns = await rig.waitTurns('ola', 3, { timeout: 60000 }).catch(() => rig.turns('ola'))
  const oAfter = log('ola', 'turn').at(-1)
  p.check('ola: the next turn gives the stopped request again', /You now run on the account/.test(oAfter?.prompt ?? '')
    && /PROOF-LIMIT: please do the other thing/.test((oAfter?.prompt ?? '').split('You now run on the account')[1] ?? ''), String(oAfter?.prompt ?? '').slice(-400))
  const oStart = log('ola', 'start').at(-1)
  const oThreads = log('ola', 'thread')
  p.check('ola: her app-server runs in B\'s home and resumed her thread there', same(oStart?.codex_home, homeB)
    && oThreads.at(-1)?.action === 'resume' && oThreads.at(-1).thread === oThread && rollouts(homeB).some(f => f.endsWith(`${oThread}.jsonl`)),
    { home: oStart?.codex_home, threads: oThreads.map(l => [l.action, l.thread]) })
  p.check('ola: the turn on B completed', oTurns.length >= 3 && !oTurns.at(-1).error, oTurns.map(t => t.error))

  // ---------------------------------------------------------------- B turned off, then removed
  await rig.api('PUT', `/api/accounts/${B}/enabled`, { enabled: false })
  await rig.userMail('mia', 'WAIT-1: while B is off.')
  await new Promise(r => setTimeout(r, 5000))
  const held = rig.one(`SELECT state FROM ot.mail WHERE body = 'WAIT-1: while B is off.'`)
  p.check('B off: mia\'s mail waits (no turn on an inactive account)', rig.turns('mia').length === 1 && held?.state === 'pending',
    { turns: rig.turns('mia').length, mail: held?.state })
  await rig.api('PUT', `/api/accounts/${B}/enabled`, { enabled: true })
  const mt2 = await rig.waitTurns('mia', 2, { timeout: 30000 }).catch(() => rig.turns('mia'))
  p.check('B on again: the waiting mail runs on B', mt2.length === 2 && !mt2[1].error
    && same(log('mia', 'start').at(-1)?.codex_home, homeB), { turns: mt2.length, home: log('mia', 'start').at(-1)?.codex_home })
  const removed = await rig.api('DELETE', `/api/accounts/${B}`).then(r => r, e => ({ error: e.message }))
  p.note('removing B', JSON.stringify(removed).slice(0, 800))
  p.check('B removed: mia, ned and ola are back on the primary', ['mia', 'ned', 'ola'].every(n => !seat(n)?.account),
    Object.fromEntries(['mia', 'ned', 'ola'].map(n => [n, seat(n)?.account])))
  await rig.userMail('mia', 'After B: are you there?')
  const mt3 = await rig.waitTurns('mia', 3, { timeout: 30000 }).catch(() => rig.turns('mia'))
  const m3 = log('mia', 'turn').at(-1)
  const mStart = log('mia', 'start').at(-1)
  p.check('B removed: her next turn runs on the primary home, on a fresh thread with the handoff note', mt3.length === 3 && !mt3[2].error
    && !mStart?.codex_home_set && log('mia', 'thread').at(-1)?.action === 'start' && /account was removed/.test(m3?.prompt ?? ''),
    { home: mStart?.codex_home, set: mStart?.codex_home_set, thread: log('mia', 'thread').at(-1)?.action, prompt: String(m3?.prompt ?? '').slice(0, 300) })

  p.keep(rig, { agents: ['mia', 'pat', 'ned', 'ola'], grep: /account|fallback|carried|rollout|continue/ })
  return p.summary()
}
