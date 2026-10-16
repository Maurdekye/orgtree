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
  const granted = path.join(rig.data, 'next-turn-granted')
  fs.mkdirSync(granted, { recursive: true })
  const grantFiles = ['AGENTS.md', 'CLAUDE.md'].map(n => path.join(granted, n))
  for (const file of grantFiles) fs.writeFileSync(file, 'NEXT_TURN_INSTRUCTION_SECRET_v1\n')
  // The user grants the synthetic parent first; a hire cannot widen its
  // parent's folder ceiling merely by naming an add_dir.
  await rig.op({ op: 'retool', node: 'boss', add_dirs: [{ path: granted, mode: 'rw' }] })
  await rig.op({ op: 'hire', name: 'cacheprobe', parent: 'boss', tier: 'haiku', title: 'next-turn query proof', add_dirs: [{ path: granted, mode: 'rw' }] })
  const id = rig.agentRow('cacheprobe').id
  const root = path.join(rig.data, 'scratch', rig.org)
  const own = path.join(root, 'cacheprobe', 'AGENTS.md')
  const legacy = path.join(root, 'cacheprobe', 'CLAUDE.md')
  const shared = path.join(root, '_shared', 'AGENTS.md')
  const orgNotes = path.join(rig.data, 'workspaces', rig.org, 'org.md')
  const teamFiles = [id, rig.agentRow('boss').id].map(n => path.join(root, '_teams', String(n), 'AGENTS.md'))
  const instructionFiles = [own, legacy, shared, orgNotes, ...teamFiles, ...grantFiles]
  for (const file of instructionFiles) {
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
  for (const file of instructionFiles) {
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
  fs.writeFileSync(shared, 'NEXT_TURN_INSTRUCTION_SECRET_v1\n')
  for (const file of instructionFiles.filter(f => f !== shared)) {
    fs.writeFileSync(file, 'NEXT_TURN_INSTRUCTION_SECRET_v2\n')
    const edited = await query()
    p.check('instruction edit compared against actual session copy: ' + file, edited.ok
      && rows(edited).some(r => norm(r.path) === norm(file) && r.status === 'changed' && r.effective_at === 'next_session_start'), edited.json)
    fs.writeFileSync(file, 'NEXT_TURN_INSTRUCTION_SECRET_v1\n')
  }
  const ordinary = path.join(root, 'cacheprobe', 'ordinary.txt')
  fs.writeFileSync(ordinary, 'this never enters the startup prompt')
  const ordinaryOut = await query()
  p.check('ordinary scratch changes do not count as prefix instructions', ordinaryOut.ok && ordinaryOut.json?.cache?.dirty === false
    && !rows(ordinaryOut).some(r => norm(r.path) === norm(ordinary)), ordinaryOut.json)
  const added = path.join(root, 'cacheprobe', 'CLAUDE.local.md')
  fs.writeFileSync(added, 'NEXT_TURN_INSTRUCTION_SECRET_added\n')
  const addedOut = await query()
  p.check('new participating instruction is added', addedOut.ok && rows(addedOut).some(r => norm(r.path) === norm(added) && r.status === 'added'), addedOut.json)
  fs.unlinkSync(added)
  fs.unlinkSync(legacy)
  const removedOut = await query()
  p.check('removed instruction remains visible against session copy', removedOut.ok && rows(removedOut).some(r => norm(r.path) === norm(legacy) && r.status === 'removed'), removedOut.json)
  fs.mkdirSync(legacy)
  const unreadableOut = await query()
  p.check('unreadable former file stays unknown', unreadableOut.ok && rows(unreadableOut).some(r => norm(r.path) === norm(legacy) && r.status === 'unknown'), unreadableOut.json)
  fs.rmdirSync(legacy)
  fs.writeFileSync(legacy, 'NEXT_TURN_INSTRUCTION_SECRET_v1\n')

  const baseline = rig.one(`SELECT extra->'next_turn_baseline' AS b FROM ot.agents WHERE id=${id}`).b
  rig.exec(`UPDATE ot.agents SET extra=extra-'next_turn_baseline' WHERE id=${id}`)
  const unknown = await query()
  p.check('legacy session does not fabricate per-file baseline', unknown.ok && unknown.json?.cache?.dirty === null
    && rows(unknown).every(r => r.status === 'unknown'), unknown.json)
  rig.exec(`UPDATE ot.agents SET extra=jsonb_set(extra,'{next_turn_baseline}',${quote(JSON.stringify(baseline))}::jsonb) WHERE id=${id}`)
  // Seed the already-durable queued intent, without delivering ApplyQueued:
  // a read must report it, never apply it as an incidental side effect.
  rig.exec(`UPDATE ot.agents SET pending_switch='{"tier":"sonnet","from":"haiku","crossing":false}'::jsonb WHERE id=${id}`)
  const pending = await query()
  p.check('pending model namespace switch is dirty and remains queued', pending.ok && pending.json?.cache?.dirty === true
    && !!rig.one(`SELECT pending_switch FROM ot.agents WHERE id=${id}`).pending_switch, pending.json)
  rig.exec(`UPDATE ot.agents SET pending_switch=NULL, pending_account='{"account":"synthetic-other"}'::jsonb WHERE id=${id}`)
  const account = await query()
  p.check('pending account namespace change remains queued', account.ok && account.json?.cache?.dirty === true
    && account.json.cache.reasons.includes('pending_account_switch') && !!rig.one(`SELECT pending_account FROM ot.agents WHERE id=${id}`).pending_account, account.json)
  rig.exec(`UPDATE ot.agents SET pending_account=NULL,session_id='synthetic-replaced-session' WHERE id=${id}`)
  const session = await query()
  p.check('session replacement is its own dirty namespace', session.ok && session.json?.cache?.dirty === true
    && session.json.cache.reasons.includes('session_namespace'), session.json)
  rig.exec(`UPDATE ot.agents SET session_id=${quote(before.session_id)} WHERE id=${id}`)
  rig.exec(`UPDATE ot.agents SET pending_switch=NULL, occupancy=70000, context_window=100000,
    occupancy_est=false, compacted_unrun=false, charter='Changed prefix for compaction proof',
    scope=jsonb_set(scope,'{auto_cheap_compact}','{"enabled":true,"occ":0.25}'::jsonb,true) WHERE id=${id}`)
  const due = await query()
  p.check('known changed prefix and measured context above policy threshold predicts cheap compact', due.ok
    && due.json?.compaction?.will_compact === true && due.json?.compaction?.kind === 'cheap_compact'
    && due.json?.compaction?.occupancy === 70000, due.json)
  rig.exec(`UPDATE ot.agents SET occupancy_est=true WHERE id=${id}`)
  const estimated = await query()
  p.check('estimated occupancy cannot justify a cheap compact', estimated.ok && estimated.json?.compaction?.kind !== 'cheap_compact'
    && estimated.json?.compaction?.will_compact === null, estimated.json)
  const groups = Object.fromEntries(['docket', 'team', 'messaging', 'inspection', 'watchdogs', 'runtime', 'user', 'logo'].map(k => [k, false]))
  rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{tools}',COALESCE(scope->'tools','{}'::jsonb)
    || jsonb_build_object('orgtree',${quote(JSON.stringify(groups))}::jsonb),true) WHERE id=${id}`)
  const allOff = await query()
  p.check('every agent can read itself with all tool groups off', allOff.ok, allOff)
  const other = await query({ node: 'boss' })
  p.check('a remembered cross-target argument is refused, never silently retargeted', !other.ok, other)
  p.check('retention metadata remains absent in every returned cache/compaction branch', [initial, changed, pending, due, allOff, account, session, estimated, unknown, unreadableOut].every(v => noTiming(v.json)))
  p.file('responses.json', { initial, changed, pending, due, allOff, other, account, session, estimated, unknown, unreadableOut })
  // Independent fresh session: observed live input must replace the durable
  // last-turn count, and the call must also work through the CLI's MCP route.
  rig.scenario({ agents: { liveprobe: { turns: [{ steps: [
    { usage: { input_tokens: 71000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { tool: 'orgtree_next_turn', args: {}, expect_error: false }, { sleep_ms: 6000 }, { text: 'LIVE complete.' },
  ] }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.op({ op: 'hire', name: 'liveprobe', parent: 'boss', tier: 'haiku', title: 'live input proof' })
  await rig.userMail('liveprobe', 'Observe live input and self query.')
  await rig.waitFor(() => rig.fakeLog('liveprobe').some(e => e.kind === 'step' && e.step?.sleep_ms === 6000),
    { what: 'live model input and CLI tool settled', timeout: 20000 })
  const liveOut = await rig.tool('liveprobe', 'orgtree_next_turn', {})
  p.check('live context overrides absent last-completed-turn occupancy', liveOut.ok && liveOut.json?.compaction?.occupancy === 71000
    && liveOut.json.compaction.occupancy_source === 'current_turn' && liveOut.json.compaction.turn_running === true, liveOut.json)
  await rig.waitTurns('liveprobe', 1)
  const liveId = rig.agentRow('liveprobe').id
  const cliCalls = rig.fakeLog('liveprobe').filter(e => e.kind === 'tool_result' && e.tool === 'orgtree_next_turn')
  p.check('native fake CLI self tool completed without an actor deadlock', cliCalls.length === 1 && cliCalls[0].is_error === false
    && JSON.parse(cliCalls[0].text).compaction.occupancy === 71000, cliCalls)
  const preRestart = await rig.tool('liveprobe', 'orgtree_next_turn', {})
  rig.exec(`UPDATE ot.agents SET extra=jsonb_set(extra,'{cache_receipt,at}','"2000-01-01T00:00:00Z"'::jsonb) WHERE id=${liveId}`)
  await rig.restart()
  const aged = await rig.tool('liveprobe', 'orgtree_next_turn', {})
  p.check('aging and actual engine restart preserve clean namespace and per-file baseline', preRestart.ok && aged.ok
    && preRestart.json?.cache?.dirty === false && aged.json?.cache?.dirty === false
    && rows(aged).length > 0 && rows(aged).every(r => r.status === 'unchanged') && noTiming(aged.json), aged.json)
  // Synthetic persisted state only: query an unsupported native boundary,
  // without starting that harness or changing any real provider settings.
  rig.exec(`UPDATE ot.agents SET tier='argon',provider='google',occupancy_est=true WHERE id=${liveId}`)
  const unsupported = await rig.tool('liveprobe', 'orgtree_next_turn', {})
  p.check('unpredictable harness compaction remains unknown', unsupported.ok && unsupported.json?.compaction?.will_compact === null
    && unsupported.json.compaction.harness_threshold === null && noTiming(unsupported.json), unsupported.json)
  rig.exec(`UPDATE ot.agents SET tier='haiku',provider='claude',occupancy_est=false WHERE id=${liveId}`)
  p.file('live-and-restart.json', { liveOut, preRestart, aged, unsupported })
  return p.summary()
}
