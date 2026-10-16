// Red first: the real tool dispatcher currently refuses orgtree_next_turn.
// Synthetic PostgreSQL and fake CLIs only; no provider traffic or live data.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const norm = p => String(p ?? '').replaceAll('\\', '/').toLowerCase()
const quote = s => "'" + String(s).replaceAll("'", "''") + "'"
const noTiming = obj => !Object.keys(obj ?? {}).some(k => /ttl|expiry|expires|receipt/i.test(k))
  && Object.values(obj ?? {}).every(v => !v || typeof v !== 'object' || noTiming(v))

export default async function (rig) {
  const p = new Proof('next-turn-query')
  rig.scenario({ default: { turns: [{ name: 'normal', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns complete', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'cacheprobe', parent: 'boss', tier: 'haiku', title: 'next-turn query proof' })
  const id = rig.agentRow('cacheprobe').id
  const root = path.join(rig.data, 'scratch', rig.org)
  const own = path.join(root, 'cacheprobe', 'AGENTS.md')
  const shared = path.join(root, '_shared', 'AGENTS.md')
  const teamFiles = [id, rig.agentRow('boss').id].map(n => path.join(root, '_teams', String(n), 'AGENTS.md'))
  for (const file of [own, shared, ...teamFiles]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'NEXT_TURN_INSTRUCTION_SECRET_v1\n')
  }
  await rig.userMail('cacheprobe', 'Establish a real fake-CLI launch and session prefix.')
  await rig.waitTurns('cacheprobe', 1)
  const status = await rig.tool('cacheprobe', 'orgtree_status', { status: 'working', summary: 'next-turn query proof' })
  p.check('control: existing self status route and fake session are available', status.ok
    && !!rig.agentRow('cacheprobe').session_id && rig.fakeLog('cacheprobe').some(e => e.kind === 'start'))
  const query = args => rig.tool('cacheprobe', 'orgtree_next_turn', args ?? {})
  const initial = await query()
  if (!p.check('self read tool is served through the real dispatcher', initial.ok, initial)) {
    p.note('RED: dispatcher rejected the missing tool; remaining new-tool behavioral checks NOT EXECUTED.')
    return p.summary()
  }
  p.check('unchanged current prefix is clean, without a hit promise or retention metadata', initial.json?.cache?.dirty === false
    && noTiming(initial.json) && initial.json?.cache?.guaranteed_hit !== true, initial.json)
  const rows = out => out.json?.cache?.instruction_files ?? []
  for (const file of [own, shared, ...teamFiles]) {
    p.check('session copy initially unchanged: ' + file, rows(initial).some(r => norm(r.path) === norm(file) && r.status === 'unchanged'), rows(initial))
  }
  const before = rig.one(`SELECT session_id, cost_usd, scope, pending_switch, pending_account FROM ot.agents WHERE id=${id}`)
  const turns = rig.one('SELECT count(*) AS n FROM ot.turns').n
  const after = await query()
  p.check('query is read only: session, configuration, pending requests, spend and turn count remain unchanged', after.ok
    && JSON.stringify(before) === JSON.stringify(rig.one(`SELECT session_id, cost_usd, scope, pending_switch, pending_account FROM ot.agents WHERE id=${id}`))
    && rig.one('SELECT count(*) AS n FROM ot.turns').n === turns)
  p.check('instruction text and hashes never appear in the response', !JSON.stringify(after.json).includes('NEXT_TURN_INSTRUCTION_SECRET')
    && !JSON.stringify(after.json).includes('sha256') && !JSON.stringify(after.json).includes('digest'))
  fs.writeFileSync(shared, 'NEXT_TURN_INSTRUCTION_SECRET_v2\n')
  const changed = await query()
  p.check('shared instruction edit reports changed and next session start effect', changed.ok
    && rows(changed).some(r => norm(r.path) === norm(shared) && r.status === 'changed' && r.effective_at === 'next_session_start'), changed.json)
  // Seed the already-durable queued intent, without delivering ApplyQueued:
  // a read must report it, never apply it as an incidental side effect.
  rig.exec(`UPDATE ot.agents SET pending_switch='{"tier":"sonnet","from":"haiku","crossing":false}'::jsonb WHERE id=${id}`)
  const pending = await query()
  p.check('pending model namespace switch is dirty and remains queued', pending.ok && pending.json?.cache?.dirty === true
    && !!rig.one(`SELECT pending_switch FROM ot.agents WHERE id=${id}`).pending_switch, pending.json)
  rig.exec(`UPDATE ot.agents SET pending_switch=NULL, occupancy=70000, context_window=100000,
    occupancy_est=false, compacted_unrun=false, charter='Changed prefix for compaction proof',
    scope=jsonb_set(scope,'{auto_cheap_compact}','{"enabled":true,"occ":0.25}'::jsonb,true) WHERE id=${id}`)
  const due = await query()
  p.check('known changed prefix and measured context above policy threshold predicts cheap compact', due.ok
    && due.json?.compaction?.will_compact === true && due.json?.compaction?.kind === 'cheap_compact'
    && due.json?.compaction?.occupancy === 70000, due.json)
  const groups = Object.fromEntries(['docket', 'team', 'messaging', 'inspection', 'watchdogs', 'runtime', 'user', 'logo'].map(k => [k, false]))
  rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{tools}',COALESCE(scope->'tools','{}'::jsonb)
    || jsonb_build_object('orgtree',${quote(JSON.stringify(groups))}::jsonb),true) WHERE id=${id}`)
  const allOff = await query()
  p.check('every agent can read itself with all tool groups off', allOff.ok, allOff)
  const other = await query({ node: 'boss' })
  p.check('a remembered cross-target argument is refused, never silently retargeted', !other.ok, other)
  p.check('retention metadata remains absent in every returned cache/compaction branch', [initial, changed, pending, due, allOff].every(v => noTiming(v.json)))
  p.file('responses.json', { initial, changed, pending, due, allOff, other })
  p.note('Separate production helper coverage and follow-up rig cases will cover receipt aging invariance, account/session changes, legacy absent manifests, granted notes/org.md, added/removed/unreadable notes, live occupancy, and unsupported harness compaction. These are not claimed executed by this initial red proof.')
  return p.summary()
}
