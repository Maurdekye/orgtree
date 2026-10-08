// Proof: a slow provider cannot stall an agent through the account fallback.
//   S is the first other login and has room, but its usage read takes 20 s
//   ("rig_delay_ms"); F has room and answers at once.
//   sam (haiku, account fallback) hits a usage limit: his turn ends at once
//   (frozen first, the search runs off his actor), S's read is cut off after
//   5 s and counts as no proven room, and he moves to F.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/fallback-slow-read.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const future = hours => new Date(Date.now() + hours * 3600e3).toISOString()
const room = extra => ({ available: true, ...extra, limits: [
  { kind: 'session', percent: 10, resets_at: future(3), is_active: false },
  { kind: 'weekly_all', percent: 20, resets_at: future(72), is_active: false }] })
function claudeHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return dir
}

export default async function (rig) {
  const p = new Proof('fallback-slow-read')
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  rig.scenario({
    agents: { sam: { turns: [{ name: 'limited', match: 'PROOF-LIMIT', once: true, steps: [
      { text: 'Starting on it.' },
      { rate_limit: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour', overageStatus: 'rejected' } },
      { result: { is_error: true, text: "You've hit your limit · resets 7am" } },
    ] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usageDir, { recursive: true })
  fs.writeFileSync(path.join(usageDir, 'claude@claude-s.json'), JSON.stringify(room({ rig_delay_ms: 20000 })))
  fs.writeFileSync(path.join(usageDir, 'claude@claude-f.json'), JSON.stringify(room()))
  const S = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-s'), 'rig-s@example.invalid') })).id
  const F = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-f'), 'rig-f@example.invalid') })).id
  await rig.op({ op: 'hire', name: 'sam', parent: 'boss', tier: 'haiku', title: 'Slow-read agent', account_fallback: true })
  const seat = () => rig.one(`SELECT a.account, a.frozen FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${rig.org}' AND o.state = 'active' AND a.name = 'sam'`)

  await rig.userMail('sam', 'PROOF-LIMIT: please do the big thing.')
  const [t1] = await rig.waitTurns('sam', 1, { timeout: 60000 })
  const ended = rig.fakeLog('sam').find(l => l.kind === 'turn_end' || (l.kind === 'send' && l.line?.type === 'result'))
  const lag = (Date.parse(t1.ended_at) - Date.parse(ended?.ts)) / 1000
  p.check('sam: his turn ends at once, not held by the slow usage read (under 3 s after the CLI\'s result)', lag < 3,
    { lag_s: lag, cli_result: ended?.ts, turn_ended: t1.ended_at })
  const moved = await rig.waitFor(() => { const s = seat(); return s?.account ? s : null }, { what: 'sam to move', timeout: 40000 }).catch(() => seat())
  const after = (Date.now() - Date.parse(t1.ended_at)) / 1000
  p.check('sam: the slow login counts as no proven room; he moves to F', moved.account === F && !moved.frozen,
    { account: moved.account, S, F, seconds_after_turn: Math.round(after) })
  p.keep(rig, { agents: ['sam'], grep: /fallback|usage read|continue/ })
  return p.summary()
}
