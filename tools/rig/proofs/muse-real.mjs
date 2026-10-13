// Proof on the REAL Muse Code (user-authorized small synthetic subscription
// tests through the adapter, user 2026-10-12 20:21Z; contributor mode off per
// process, 20:31Z): every model the signed-in account's catalog offers runs one
// small synthetic turn through Orgtree's Muse lane, at the lowest effort it
// names. Claude, Codex and Antigravity stay the rig's fakes.
//   discovery: the real binary, signed in, its catalog; Wonder Full is hired
//         only if the account offers it.
//   per model: the requested model and effort, the model Muse reported for
//         every completion (the turn row and Muse's own session log), tokens,
//         the result or the error. No API key ever reaches Muse (no paid
//         fallback); account fallback stays off.
//   contributor off: every host this run starts carries --contributor-mode
//         off on its command line, and every completion in Muse's session log
//         is the plain model id (a contributor route reports
//         "<model>-contributor", measured 2026-10-12); after an engine restart
//         the resumed session's host and completion too; the user's saved
//         settings.json is byte-identical before and after.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-real.mjs --real-muse <muse-bin-*.exe>

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { processes } from '../lib.mjs'

const ask = (tag) => `${tag}: a synthetic connectivity test. Reply with exactly the word READY and nothing else. Do not call any tools.`
const MUSE_DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'muse')
const SETTINGS = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'muse', 'settings.json')

/** settings.json as a fingerprint: its hash and the contributor keys' values, nothing else */
function settingsFingerprint() {
  if (!fs.existsSync(SETTINGS)) return { present: false }
  const raw = fs.readFileSync(SETTINGS)
  const contributor = {}
  const walk = (v, at) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k)
    else if (/contributor/i.test(at) && (typeof v === 'boolean' || typeof v === 'string')) contributor[at] = v
  }
  try { walk(JSON.parse(raw.toString('utf8')), '') } catch { /* not JSON: the hash still compares */ }
  return { present: true, sha256: crypto.createHash('sha256').update(raw).digest('hex'), contributor }
}

/** Muse's own session log for `sid` (sessions/<yyyy>/<mm>/<dd>/<sid>/session.jsonl) */
function sessionLog(sid) {
  const root = path.join(MUSE_DATA, 'sessions')
  for (const day of [0, 1]) {
    const d = new Date(Date.now() - day * 86400000)
    // the folder's date, local or UTC (both are tried)
    for (const [y, m, dd] of [[d.getFullYear(), d.getMonth(), d.getDate()], [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]]) {
      const f = path.join(root, String(y), String(m + 1).padStart(2, '0'), String(dd).padStart(2, '0'), sid, 'session.jsonl')
      if (fs.existsSync(f)) return f
    }
  }
  return null
}

/** every model the session log names: configured, completed, and the provider's response */
function loggedModels(file) {
  const out = { configured: [], completed: [], responses: [] }
  if (!file) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const pl = e.payload
    if (e.payload_type === 'run.model.configured' && pl?.record?.model_id) out.configured.push(pl.record.model_id)
    if (e.payload_type === 'runtime.session' && pl?.event?.kind === 'model_completed' && pl.event.model) out.completed.push(pl.event.model)
    for (const f of pl?.event?.details?.facets ?? []) if (f?.detail?.model) out.responses.push(f.detail.model)
  }
  return out
}

/** this run's Muse hosts as the OS sees them: their flags, never the prompt values */
function hosts(binDir) {
  const procs = processes(`$_.Name -like 'muse-bin*' -and $_.ExecutablePath -like '${binDir.replace(/'/g, "''")}*'`)
  return procs.map((p) => {
    const cmd = p.CommandLine ?? ''
    return { pid: p.ProcessId, serve: / serve( |$)/.test(cmd), contributorOff: /--contributor-mode\s+off\b/.test(cmd),
      contributorOn: /--contributor-mode\s+on\b/.test(cmd), flags: [...cmd.matchAll(/\s(--[a-z][a-z-]*)/g)].map((m) => m[1]) }
  })
}

export default async function (rig) {
  const p = new Proof('muse-real')
  if (!rig.run.realMuse) throw new Error('run this proof with --real-muse <muse-bin-*.exe>')
  const binDir = path.dirname(rig.run.realMuse)
  const before = settingsFingerprint()
  p.file('settings-before.json', before)
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- discovery
  await rig.api('GET', '/api/muse/usage?force=true')
  const muse = await rig.waitFor(async () => {
    const prov = await rig.api('GET', '/api/providers')
    return (prov?.providers ?? []).find((x) => x.id === 'muse' && x.muse?.catalog)
  }, { what: 'Muse discovery', timeout: 120000 })
  const status = { ...muse.status, email: muse.status?.email ? '<the signed-in account>' : null }
  p.check('discovery: the real Muse Code binary, installed and signed in, its MSP schema verified',
    status.installed && status.connected && /muse-bin-/.test(status.path ?? '') && muse.muse.schema?.verified === true,
    { status, schema: muse.muse.schema, account_state: muse.muse.account_state })
  const catalog = muse.muse.catalog
  p.file('catalog.json', { catalog, tiers: muse.tiers })
  const accountModels = (catalog?.models ?? []).filter((m) => m.account_row).map((m) => m.id)
  const offered = (muse.tiers ?? []).map((t) => t.tier)
  p.check('discovery: the tiers offered are exactly the account catalog\'s own rows', offered.length > 0
    && offered.every((t) => muse.tiers.find((x) => x.tier === t)?.model && accountModels.includes(muse.tiers.find((x) => x.tier === t).model)),
  { offered, accountModels })

  // ---------------------------------------------------------------- one agent per offered model
  const plans = []
  for (const t of muse.tiers ?? []) plans.push({ name: `m-${t.tier}`, tier: t.tier, model: t.model, efforts: t.efforts })
  // a second Spark version the account lists (Spark 1.2), pinned with the agent's model version
  if (offered.includes('spark') && accountModels.includes('muse-spark-1.2') && !plans.some((x) => x.model === 'muse-spark-1.2')) {
    const row = (catalog.models ?? []).find((m) => m.id === 'muse-spark-1.2')
    plans.push({ name: 'm-spark-12', tier: 'spark', version: '1.2', model: 'muse-spark-1.2', efforts: row?.efforts })
  }
  const results = []
  // hire them all, then send every one its synthetic turn at once: the turns run side by side
  for (const plan of plans) {
    plan.effort = (plan.efforts ?? [])[0] ?? ''
    plan.hire = await rig.op({ op: 'hire', parent: 'boss', name: plan.name, tier: plan.tier, title: `real ${plan.model}`,
      effort: plan.effort, account_fallback: false })
      .then((r) => ({ ok: true }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
    if (plan.hire.ok && plan.version) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${plan.name}/scope`, { model_version: plan.version })
  }
  const t0 = Date.now()
  for (const plan of plans.filter((x) => x.hire.ok)) await rig.userMail(plan.name, ask(`PROOF-REAL ${plan.model}`))
  for (const plan of plans) {
    const { effort, hire } = plan
    if (!hire.ok) { results.push({ ...plan }); continue }
    const turns = await rig.waitTurns(plan.name, 1, { timeout: 300000 }).catch((e) => ({ error: String(e.message) }))
    const ended = Array.isArray(turns) ? turns[turns.length - 1] : null
    const row = ended ? rig.one(`SELECT model, input_tokens, cache_read, toks, error, killed, cost_source, cache_ttl_s
      FROM ot.turns WHERE id = ${ended.id}`) : null
    const agent = rig.one(`SELECT a.id, a.session_id, a.frozen FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
      WHERE o.slug = '${rig.org}' AND a.name = '${plan.name}'`)
    const reply = rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${agent.id} ORDER BY seq DESC LIMIT 3`)
      .map((r) => r.body).find((b) => b?.role === 'assistant' || typeof b?.text === 'string')
    const log = agent.session_id ? sessionLog(agent.session_id) : null
    const models = loggedModels(log)
    results.push({ ...plan, effort, wait: turns?.error ?? null, seconds: Math.round((Date.now() - t0) / 1000), turn: row,
      reply: typeof reply?.text === 'string' ? reply.text.slice(0, 200) : reply, session: agent.session_id, frozen: agent.frozen,
      sessionLog: log ? path.relative(MUSE_DATA, log) : null, models, hosts: hosts(binDir) })
  }
  p.file('results.json', results)
  for (const r of results) {
    const tag = `${r.model}${r.version ? ` (version ${r.version})` : ''}`
    if (!r.turn) { p.check(`${tag}: one synthetic turn ran`, false, { hire: r.hire, wait: r.wait, frozen: r.frozen }); continue }
    p.check(`${tag}: one synthetic turn at ${r.effort || 'the default effort'} completed`, !r.turn.error && !r.turn.killed,
      { error: r.turn.error, reply: r.reply, seconds: r.seconds })
    p.check(`${tag}: the model Muse reported is the one requested, on the standard route (no "-contributor")`,
      r.turn.model === r.model && [...r.models.configured, ...r.models.completed, ...r.models.responses].every((m) => m === r.model)
        && r.models.completed.length > 0,
    { requested: r.model, turn_model: r.turn.model, log: r.models })
    p.check(`${tag}: tokens booked, cost unknown, no cache lifetime claimed`,
      r.turn.input_tokens + r.turn.cache_read > 0 && r.turn.cost_source === 'unknown' && r.turn.cache_ttl_s === null,
      { input: r.turn.input_tokens, cached: r.turn.cache_read, out: r.turn.toks })
  }
  const live = hosts(binDir).filter((h) => h.serve)
  p.check('contributor off: every Muse host this run started carries --contributor-mode off, none on',
    live.length > 0 && live.every((h) => h.contributorOff && !h.contributorOn), live)

  // ---------------------------------------------------------------- the resume path
  const first = results.find((r) => r.turn && !r.turn.error)
  if (first) {
    await rig.restart()
    await rig.userMail(first.name, ask(`PROOF-REAL-AGAIN ${first.model}`))
    const turns = await rig.waitTurns(first.name, 2, { timeout: 240000 })
    const again = rig.one(`SELECT model, error FROM ot.turns WHERE id = ${turns[turns.length - 1].id}`)
    const sid = rig.one(`SELECT a.session_id FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
      WHERE o.slug = '${rig.org}' AND a.name = '${first.name}'`)?.session_id
    const models = loggedModels(sessionLog(sid))
    const relaunched = hosts(binDir).filter((h) => h.serve)
    p.file('resume.json', { sid, before: first.session, again, models, relaunched })
    p.check('resume: after an engine restart the same Muse session continues', sid === first.session && !again.error,
      { before: first.session, after: sid, error: again.error })
    p.check('resume: the relaunched host carries --contributor-mode off and the resumed completions are the plain model',
      relaunched.length > 0 && relaunched.every((h) => h.contributorOff && !h.contributorOn)
        && models.completed.length >= 2 && models.completed.every((m) => m === first.model), { relaunched, models })
  }

  // ---------------------------------------------------------------- the user's own setting
  const after = settingsFingerprint()
  p.file('settings-after.json', after)
  p.check('settings: the saved Muse settings are byte-identical (contributor mode unchanged)',
    JSON.stringify(after) === JSON.stringify(before), { before: before.contributor, after: after.contributor, same: before.sha256 === after.sha256 })
  p.keep(rig, { agents: results.map((r) => r.name), grep: /muse|contributor|quota|auth/i })
  return p.summary()
}
