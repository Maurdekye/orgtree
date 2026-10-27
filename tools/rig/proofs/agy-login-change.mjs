// Proof: a sign-in to another Antigravity account takes effect everywhere
// (USER 2026-10-27 m4db0526e54f1 "it should recheck when the account changes",
// m396ea354d094, mb2fa30fd31fd "Yes, restart them"; docket
// argon-keeps-disappearing-from-the-user-s-usable-a). Fake CLI only: the
// shared default sign-in is named by the fake's agy-auth.json `identity`
// (absent: rig-user@example.invalid), and agy-auth-metadata.json's stamp
// stands in for the shared credential's last write. Nothing is written to any
// home folder. No real sign-in, credential or network.
//   - a token rotation (new stamp, same account) reads no catalog and
//     replaces no process
//   - a sign-in to another account (new stamp, new name) closes the warm
//     default-login process gracefully and starts exactly one `agy models`
//     read with no model choice opened; Argon is offered again and no
//     further read follows (never a poll); the next turn runs a new process
//   - orgtree_list_tiers refresh=true re-reads the catalog
//   - with Argon's own weekly bucket (gemini-argon-wtu-weekly) full, a hire
//     naming the default login is refused with that window's reason, a hire
//     naming no account is placed and its turn is held with the same reason,
//     and Flash is still hired
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-login-change.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const ROWS = [
  'gemini-4-argon-high\tGemini 4 Argon (High)', 'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
]
const REUSE_MS = 30_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const refusal = (pr) => pr.then(() => null, (e) => ({ status: e.status ?? -1, message: String(e.message ?? e) }))

export default async function (rig) {
  const p = new Proof('agy-login-change')
  const registry = (rows) => fs.writeFileSync(path.join(rig.fakeDir, 'agy-models.txt'), rows.map((r) => r + '\r\n').join(''))
  const google = async () => ((await rig.api('GET', '/api/providers')).providers ?? []).find((x) => x.id === 'google')
  const offered = async () => ((await google())?.tiers ?? []).map((t) => t.tier)
  const reads = () => {
    const f = path.join(rig.fakeDir, 'log', 'agy-models.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  const metadata = (stamp) => fs.writeFileSync(path.join(rig.data, 'agy-auth-metadata.json'), JSON.stringify({ stamp }))
  const auth = (v) => fs.writeFileSync(path.join(rig.fakeDir, 'agy-auth.json'), JSON.stringify(v))
  const LOGIN_B = 'second@example.invalid'
  const since = (at) => rig.engineLog().slice(at)
  const posts = (text) => (text.match(/POST \/api\/providers\/agy-models\/refresh/g) ?? []).length
  const pids = (name) => rig.fakeLog(name).filter((e) => e.kind === 'start').map((e) => e.pid)
  const exits = (text, pid) => text.split(/\r?\n/).filter((l) => /CLI exit observation/.test(l) && l.includes(`pid=${pid} `))
  const REPLACING = /Antigravity sign-in moved to another account/
  const readFresh = async () => {
    const last = Date.parse(reads().at(-1)?.at ?? 0)
    await sleep(Math.max(0, last + REUSE_MS + 1500 - Date.now()))
  }

  // 0. the fake CLI's own credential path, a registry that lists Argon, login A
  auth({})
  metadata(1)
  registry(ROWS)
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers')).checking === false, { what: 'first discovery', timeout: 60000 })
  await rig.waitFor(() => reads().length >= 1, { what: 'the start-up agy models read', timeout: 60000 })
  await readFresh()
  await rig.api('POST', '/api/providers/agy-models/refresh')
  await rig.waitFor(async () => (await offered()).includes('argon'), { what: 'Argon offered for login A', timeout: 20000 })
  p.check('control: login A lists Argon and the hire strips offer it', (await offered()).includes('argon'), await offered())

  // a warm default-login process: one turn, then it stays open (KEEP_ALIVE)
  await rig.op({ op: 'hire', name: 'swap-flash', parent: 'boss', tier: 'flash', title: 'Login change seat' })
  await rig.userMail('swap-flash', 'ONE-TURN-ON-LOGIN-A')
  await rig.waitTurns('swap-flash', 1)
  const firstPid = pids('swap-flash').at(-1)
  p.check('control: the seat ran on its own agy process', Number.isSafeInteger(firstPid), pids('swap-flash'))

  // 1. a token rotation: same account, new credential stamp
  let at = rig.engineLog().length
  let mark = reads().length
  metadata(2)
  await sleep(25000)
  let text = since(at)
  p.check('rotation: no catalog read starts', reads().length === mark, reads().slice(mark))
  p.check('rotation: no process is replaced', !REPLACING.test(text) && exits(text, firstPid).length === 0, exits(text, firstPid))
  p.check('rotation: Argon stays offered', (await offered()).includes('argon'), await offered())

  // 2. a sign-in to another account
  at = rig.engineLog().length
  mark = reads().length
  auth({ identity: LOGIN_B })
  metadata(3)
  await rig.waitFor(() => REPLACING.test(since(at)), { what: 'the engine to notice another account', timeout: 45000 })
  await rig.waitFor(() => reads().length > mark, { what: 'the new login catalog read', timeout: 45000 })
  await rig.waitFor(async () => (await offered()).includes('argon'), { what: 'Argon offered for login B', timeout: 20000 })
  text = since(at)
  const line = text.split(/\r?\n/).find((l) => REPLACING.test(l)) ?? ''
  p.check('switch: the engine replaces processes on the old login, naming no account', !!line && !line.includes('@'), line)
  await rig.waitFor(() => exits(since(at), firstPid).length > 0, { what: 'the old process to close', timeout: 20000 }).catch(() => null)
  const closed = exits(since(at), firstPid)
  p.check('switch: the warm old-login process closed gracefully (close requested, exit seen)',
    closed.some((l) => /reason=close requested/.test(l) && !/exit status unavailable/.test(l)), closed)
  const kills = path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log')
  const forced = fs.existsSync(kills) ? fs.readFileSync(kills, 'utf8').split(/\r?\n/).filter((l) => /force-kill/.test(l) && l.includes('swap-flash')) : []
  p.check('switch: no forced kill was needed for it', forced.length === 0, forced)
  p.check('switch: exactly one catalog read, with no model choice opened', reads().length === mark + 1 && posts(text) === 0,
    { reads: reads().slice(mark), posts: posts(text) })
  p.check('switch: Argon is offered again for the new login', (await offered()).includes('argon'), await offered())
  await sleep(25000)
  p.check('switch: no further read follows (not a poll)', reads().length === mark + 1, reads().slice(mark))

  // the next turn starts a new process on the new login
  await rig.userMail('swap-flash', 'ONE-TURN-ON-LOGIN-B')
  await rig.waitTurns('swap-flash', 2)
  p.check('switch: the next turn runs on a new process', pids('swap-flash').at(-1) !== firstPid, pids('swap-flash'))

  // 3. orgtree_list_tiers refresh=true re-reads the catalog
  await readFresh()
  mark = reads().length
  const listed = await rig.tool('boss', 'orgtree_list_tiers', { refresh: true }).catch((e) => ({ error: String(e.message ?? e) }))
  p.check('orgtree_list_tiers refresh=true re-reads the catalog', reads().length === mark + 1, { reads: reads().slice(mark), listed })

  // 4. Argon's own weekly bucket at 100% refuses Argon only
  const reset = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()
  auth({ identity: LOGIN_B, usage_groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', remaining_fraction: 0.99, window: '5h', reset_time: reset },
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', remaining_fraction: 0.93, window: 'weekly', reset_time: reset }] },
    { name: 'Gemini 4 Argon', buckets: [
      { id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', remaining_fraction: 0, window: 'weekly', reset_time: reset }] },
  ] })
  const usage = await rig.api('GET', '/api/antigravity/usage?force=true')
  p.check('control: the reading carries the full Argon window',
    (usage.limits ?? []).some((l) => l.group === 'gemini-argon-wtu-weekly' && l.percent >= 100), usage.limits)
  // naming the default login: refused at the hire with the window's reason
  const r = await refusal(rig.op({ op: 'hire', name: 'arg-full', parent: 'boss', tier: 'argon', title: 'Argon seat',
    account: 'google/primary' }))
  p.check('a hire naming Argon on the default login is refused with its own window as the reason',
    r?.status === 409 && /gemini-argon-wtu-weekly/.test(r.message), r)
  p.check('control: the refused hire created no agent', rig.sql("SELECT 1 FROM ot.agents WHERE name = 'arg-full'").length === 0)
  // naming no account: placed; the turn gate holds its turns with the same reason
  const placed = await refusal(rig.op({ op: 'hire', name: 'arg-wait', parent: 'boss', tier: 'argon', title: 'Argon seat' }))
  p.check('a hire naming no account is placed', placed === null, placed)
  await rig.userMail('arg-wait', 'HELD-BY-THE-ARGON-WINDOW')
  const held = await rig.waitFor(async () => {
    const e = (await rig.api('GET', `/api/orgs/${rig.org}/nodes/arg-wait/chat?last=1`))?.last_error ?? ''
    return /gemini-argon-wtu-weekly/.test(e) ? e : null
  }, { what: 'the turn gate to hold arg-wait', timeout: 20000 }).catch(() => null)
  p.check('its turn is held with its own window as the reason, and no turn ran',
    !!held && rig.turns('arg-wait').length === 0, { held, turns: rig.turns('arg-wait') })
  const f = await refusal(rig.op({ op: 'hire', name: 'flash-ok', parent: 'boss', tier: 'flash', title: 'Flash seat' }))
  p.check('Flash is still hired: Argon\'s bucket is not the Gemini pool', f === null, f)

  p.keep(rig, { agents: ['swap-flash'], grep: /agy|Agy|Antigravity|CLI exit observation/ })
  return p.summary()
}
