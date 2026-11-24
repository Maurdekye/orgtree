// The CLI sessions an export carries beyond Claude Code and Codex
// (docs/rust-engine/agent-export.md, "Sessions"; USER 2026-11-24 m4778ba0aed9e
// "OpenCode + try Antigravity").
// Scratch rig only: the scripted ACP executable and the fake agy, the rig's
// own database and folders, two synthetic organizations, no provider calls.
//
// Proves:
//   1. OpenCode: a duplicate gets its own copy of the agent's store under the
//      same session id, and goes on with it; the original still goes on with
//      its own
//   2. OpenCode: a carried session the CLI cannot load starts a new one in
//      the same start, with the handoff note, and no error
//   3. OpenCode: an export holds the store, and an import into another
//      organization places it in the new agent's own store and goes on with it
//   4. Antigravity: no conversation is carried while the carry is off, and a
//      conversation the CLI cannot resume leaves the handoff note due
// RED controls: each store is read before the step that should fill it, and
// the session a start ran on is read from the CLI's own receipt.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { TOKEN_HEADER } from '../lib.mjs'
import { Proof } from '../proof.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() { return { ...(await keysSetup()), name: 'agent-export-sessions' } }

/** The names of a zip's entries as this engine writes one (ZIP64 records always). */
function zipNames(buf) {
  const loc = buf.length - 22 - 20
  if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw new Error('no ZIP64 locator before the end record')
  const end = Number(buf.readBigUInt64LE(loc + 8))
  const count = Number(buf.readBigUInt64LE(end + 32))
  let at = Number(buf.readBigUInt64LE(end + 48))
  const out = []
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32)
    out.push(buf.toString('utf8', at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}
void zlib

export default async function (rig) {
  const p = new Proof('agent-export-sessions')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns settle', timeout: SEED_SETTLE_TIMEOUT })
  const A = rig.org
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug='${slug}' AND state='active'`).id
  const aId = orgId(A)
  const row = (org, name) => rig.one(`SELECT a.id, a.name, a.state, a.session_id, a.generation, a.scratch_dir, a.extra, a.last_error, p.name AS parent
    FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id WHERE a.org_id=${org} AND a.name='${name}' AND a.state <> 'deleted'`)
  const done = id => rig.one(`SELECT count(*) FILTER (WHERE ended_at IS NOT NULL)::int AS done, count(*) FILTER (WHERE ended_at IS NULL)::int AS open FROM ot.turns WHERE agent_id=${id}`)
  const lastTurn = id => rig.one(`SELECT error, killed FROM ot.turns WHERE agent_id=${id} ORDER BY id DESC LIMIT 1`)
  const oneTurn = async (org, slug, name, text) => {
    const id = row(org, name).id
    const before = done(id).done
    await rig.userMail(name, text, { org: slug })
    await rig.waitFor(() => { const t = done(id); return t.done > before && t.open === 0 ? t : null }, { what: `${name} to finish a turn`, timeout: 90000 })
    return lastTurn(id)
  }
  const ended = (org, kind, id) => rig.waitFor(async () => {
    const s = await rig.api('GET', `/api/orgs/${org}/${kind}/${id}`)
    return s.state !== 'running' ? s : null
  }, { what: `${kind} job ${id} to end`, timeout: 120000, every: 300 })
  const raw = async (method, route, body) => {
    const res = await fetch(rig.url + route, { method, headers: { [TOKEN_HEADER]: rig.token }, body, signal: AbortSignal.timeout(120000) })
    return { ok: res.ok, status: res.status, buf: Buffer.from(await res.arrayBuffer()) }
  }
  // an OpenCode seat's own store, and the sessions the scripted CLI keeps in it (one record a session;
  // beside them the database that says which working folder each session belongs to, as the real CLI's does)
  const store = (org, a) => path.join(rig.data, 'profiles', 'opencode', String(org), String(a.id), String(a.generation))
  const kept = (org, a) => { try { return fs.readdirSync(path.join(store(org, a), 'data')).filter(n => n.endsWith('.json')).sort() } catch { return [] } }
  // the session each start of the CLI ran on, from its own receipt in the agent's folder
  const ranOn = a => {
    try { return fs.readFileSync(path.join(a.scratch_dir, 'acp-observed.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l).session) } catch { return [] }
  }
  const engineLog = () => rig.engineLogFiles().map(f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }).join('\n')
  const section = async (name, fn) => {
    try { await fn() } catch (e) { p.check(`${name}: ran to its end`, false, String(e?.stack ?? e).slice(0, 1500)) }
  }

  // ---- 0. an OpenCode seat with a session
  await rig.waitFor(async () => (await rig.api('GET', '/api/harnesses')).harnesses?.find(h => h.id === 'opencode')?.installed, { what: 'ACP entrypoint discovery', timeout: 30000 })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-1', { harness: 'opencode' })
  await rig.op({ op: 'hire', name: 'oc', parent: 'boss', tier: 'or-rig-fake-model', grant: 1, title: 'OpenCode seat', permission_mode: 'default', tools: { bash: false, edit: true } })
  let turn = await oneTurn(aId, A, 'oc', 'Session proof: first turn.')
  const oc = row(aId, 'oc')
  const S = oc.session_id
  p.check('0. an OpenCode seat took a turn on a session that is in its own store', !turn.error && oc.extra?.harness === 'opencode' && !!S && kept(aId, oc).join() === `${S}.json`
    && ranOn(oc).at(-1) === S, { turn, session: S, kept: kept(aId, oc), ran: ranOn(oc) })

  // ---- 1. a duplicate: its own copy, the same id, gone on with
  await section('1', async () => {
    const copy = await ended(A, 'imports', (await rig.api('POST', `/api/orgs/${A}/nodes/oc/duplicate`, { subtree: false })).id)
    const oc2 = row(aId, copy.result?.root ?? 'no-such-node')
    p.check('1. the copy has its own store with the session, under the same id, marked as carried', copy.state === 'done' && oc2?.name === 'oc-2' && oc2.id !== oc.id
      && oc2.session_id === S && kept(aId, oc2).join() === `${S}.json` && store(aId, oc2) !== store(aId, oc) && oc2.extra?.ported?.carried_session === S
      && copy.result?.sessions_carried === 1, { state: copy.state, error: copy.error, leftovers: copy.result?.leftovers, session: oc2?.session_id, kept: oc2 && kept(aId, oc2),
      ported: oc2?.extra?.ported, carried: copy.result?.sessions_carried })
    if (!oc2) return
    const t2 = await oneTurn(aId, A, 'oc-2', 'Session proof: the copy goes on.')
    const after = row(aId, 'oc-2')
    p.check('1. the copy goes on with it: its CLI loaded that session, and the mark is gone', !t2.error && ranOn(after).at(-1) === S && after.session_id === S
      && after.extra?.ported?.carried_session === undefined && !('handoff_due' in (after.extra ?? {})), { turn: t2, ran: ranOn(after), session: after.session_id, ported: after.extra?.ported })
    // the copy's store is its own: taking the copy's record away leaves the original's
    fs.rmSync(path.join(store(aId, after), 'data', `${S}.json`))
    const t1 = await oneTurn(aId, A, 'oc', 'Session proof: the original goes on.')
    p.check('1. the original still goes on with its own', !t1.error && kept(aId, oc).join() === `${S}.json` && ranOn(row(aId, 'oc')).at(-1) === S && row(aId, 'oc').session_id === S,
      { turn: t1, kept: kept(aId, oc), ran: ranOn(row(aId, 'oc')) })
  })

  // ---- 2. a carried session the CLI cannot load
  await section('2', async () => {
    const copy = await ended(A, 'imports', (await rig.api('POST', `/api/orgs/${A}/nodes/oc/duplicate`, { subtree: false })).id)
    const oc3 = row(aId, copy.result?.root ?? 'no-such-node')
    p.check('2. another copy, carried the same way', copy.state === 'done' && oc3?.session_id === S && kept(aId, oc3).join() === `${S}.json`, { state: copy.state, error: copy.error, kept: oc3 && kept(aId, oc3) })
    if (!oc3) return
    fs.rmSync(path.join(store(aId, oc3), 'data', `${S}.json`))
    const t = await oneTurn(aId, A, oc3.name, 'Session proof: the carried session is gone.')
    const after = row(aId, oc3.name)
    const fresh = after.session_id
    p.check('2. its first start goes on a new session, with no error', !t.error && !after.last_error && !!fresh && fresh !== S && ranOn(after).at(-1) === fresh
      && kept(aId, after).join() === `${fresh}.json`, { turn: t, last_error: after.last_error, session: fresh, ran: ranOn(after), kept: kept(aId, after) })
    p.check('2. and with the handoff note: the earlier conversation is saved in its folder and the mark is gone', after.extra?.ported?.carried_session === undefined
      && !('handoff_due' in (after.extra ?? {})) && new RegExp(`agent=${after.name}[^\\n]*its carried OpenCode session could not be loaded here|its carried OpenCode session could not be loaded here[^\\n]*${after.name}`).test(engineLog()),
      { ported: after.extra?.ported, handoff_due: after.extra?.handoff_due, logged: /its carried OpenCode session could not be loaded here/.test(engineLog()) })
    // a session of its own that later goes missing is still an explicit failure, as before
    fs.rmSync(path.join(store(aId, after), 'data', `${fresh}.json`))
    await rig.restart()
    const id = after.id
    const before = done(id).done
    await rig.userMail(after.name, 'Session proof: its own session is gone.', { org: A })
    const seen = await rig.waitFor(() => { const r = row(aId, after.name); const d = done(id); return (r.last_error || (d.done > before && d.open === 0)) ? { r, d } : null },
      { what: 'the start to fail or the turn to end', timeout: 90000 })
    p.check('2. a session that was its own and went missing is not replaced silently', row(aId, after.name).session_id === fresh
      && /session\/load failed/.test(`${seen.r.last_error ?? ''} ${lastTurn(id)?.error ?? ''}`), { last_error: seen.r.last_error, turn: lastTurn(id), session: row(aId, after.name).session_id })
  })

  // ---- 3. an export and an import into another organization
  await section('3', async () => {
    const second = await rig.api('POST', '/api/orgs', { name: 'Second Org', dirs: [], net_autoconnect: false })
    const B = second.slug
    const bId = orgId(B)
    await rig.op({ op: 'hire', name: 'host', tier: 'opus', grant: 40, title: 'Host' }, { org: B })
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/oc/export`, { subtree: false })
    let job = await ended(A, 'exports', started.id)
    if (job.state === 'confirm') job = await rig.api('POST', `/api/orgs/${A}/exports/${started.id}/confirm`)
    const file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    const names = file.ok ? zipNames(file.buf) : []
    p.check("3. the export holds the agent's store", job.state === 'done' && file.ok && names.some(n => n.endsWith(`/native/opencode/data/${S}.json`)),
      { state: job.state, error: job.error, native: names.filter(n => n.includes('/native/')) })
    if (!file.ok) return
    p.file('oc.orgtree.zip', file.buf)
    const res = await raw('PUT', `/api/orgs/${B}/imports/upload?name=oc.orgtree.zip`, file.buf)
    const up = JSON.parse(res.buf.toString('utf8'))
    const plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    const imported = await ended(B, 'imports', (await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host', expect: plan.digest })).id)
    const ocB = row(bId, imported.result?.root ?? 'no-such-node')
    p.check("3. the imported agent has the session in its own store, under the numbers it has here", imported.state === 'done' && imported.result?.complete === true && ocB?.session_id === S
      && kept(bId, ocB).join() === `${S}.json` && imported.result?.sessions_carried === 1 && store(bId, ocB) !== store(aId, oc),
      { state: imported.state, error: imported.error, leftovers: imported.result?.leftovers, session: ocB?.session_id, kept: ocB && kept(bId, ocB), carried: imported.result?.sessions_carried })
    if (!ocB) return
    const t = await oneTurn(bId, B, ocB.name, 'Session proof: the imported agent goes on.')
    const after = row(bId, ocB.name)
    p.check('3. and goes on with it', !t.error && ranOn(after).at(-1) === S && after.session_id === S && after.extra?.ported?.carried_session === undefined,
      { turn: t, ran: ranOn(after), session: after.session_id })
  })

  // ---- 4. Antigravity: nothing carried while the carry is off; a conversation that cannot be resumed
  await section('4', async () => {
    await rig.op({ op: 'hire', name: 'gem', parent: 'boss', tier: 'flash', title: 'Antigravity seat', grant: 1 })
    let t = await oneTurn(aId, A, 'gem', 'Session proof: first turn.')
    const gem = row(aId, 'gem')
    const C = gem.session_id
    p.check('4. an Antigravity seat took a turn on a conversation', !t.error && !!C, { turn: t, conversation: C })
    const copy = await ended(A, 'imports', (await rig.api('POST', `/api/orgs/${A}/nodes/gem/duplicate`, { subtree: false })).id)
    const gem2 = row(aId, copy.result?.root ?? 'no-such-node')
    p.check('4. a copy carries no conversation: it starts on its own with the handoff note due', copy.state === 'done' && gem2?.session_id === null && copy.result?.sessions_carried === 0
      && gem2?.extra?.ported?.carried_session === undefined, { state: copy.state, error: copy.error, session: gem2?.session_id, carried: copy.result?.sessions_carried, extra: gem2?.extra })
    // the CLI answers a conversation it no longer holds with a new one
    fs.writeFileSync(path.join(gem.scratch_dir, 'agy-forget-conversation'), '')
    await rig.restart()
    t = await oneTurn(aId, A, 'gem', 'Session proof: the conversation is gone.')
    const after = row(aId, 'gem')
    p.check('4. a conversation the CLI could not resume: the new one is recorded and the handoff note is due', !t.error && !!after.session_id && after.session_id !== C
      && /Antigravity conversation could not be resumed/.test(after.extra?.handoff_due ?? ''), { turn: t, was: C, now: after.session_id, handoff_due: after.extra?.handoff_due })
    fs.rmSync(path.join(gem.scratch_dir, 'agy-forget-conversation'))
    const C2 = after.session_id
    t = await oneTurn(aId, A, 'gem', 'Session proof: and on.')
    const last = row(aId, 'gem')
    p.check('4. the next turn starts with that note, once, and a conversation that is resumed leaves none', !t.error && last.session_id === C2 && !('handoff_due' in (last.extra ?? {})),
      { turn: t, session: last.session_id, handoff_due: last.extra?.handoff_due })
  })

  p.keep(rig, { agents: ['oc', 'gem'], grep: /export|import|duplicate|session|handoff|OpenCode|conversation/i })
  return p.summary()
}
