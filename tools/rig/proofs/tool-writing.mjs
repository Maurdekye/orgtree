import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Proof } from '../proof.mjs'

export default async function (rig, { flags = {} } = {}) {
  const p = new Proof('tool-writing')
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  p.note('engine/fake source hashes', { engine: rig.run.engineSource, engineSha256: hash(rig.run.engineSource),
    fakeCli: process.env.ORGTREE_RIG_FAKECLI, fakeSha256: hash(process.env.ORGTREE_RIG_FAKECLI) })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns idle', timeout: 60000 })
  const stream = event => ({ raw: { type: 'stream_event', event, parent_tool_use_id: null } })
  const start = (id, name, index) => stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
  const stop = index => stream({ type: 'content_block_stop', index })
  const delta = text => stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } })
  const assistant = (id, tool) => ({ raw: { type: 'assistant', parent_tool_use_id: null,
    message: { id, role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'synthetic-only' } }] } } })
  const results = ids => ({ raw: { type: 'user', parent_tool_use_id: null,
    message: { content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: `${id}-result` })) } } })
  rig.scenario({ agents: { boss: { turns: [
    { match: 'PREVIEW-PROOF', steps: [start('preview', 'Bash', 0), delta('{"command":"echo hel'), { sleep_ms: 4000 },
      delta('lo","description":"Say hello"}'), { sleep_ms: 4000 }, stop(0), assistant('preview-row', 'preview'),
      results(['preview']), { text: 'PREVIEW-PROOF-DONE' }] },
    { match: 'WRITING-PROOF', steps: [start('write-a', 'Bash', 0), { sleep_ms: 1600 },
      start('write-b', 'Bash', 1), { sleep_ms: 1200 }, stop(0), { sleep_ms: 100 },
      assistant('write-row', 'write-a'), { sleep_ms: 1200 }, stop(1),
      assistant('write-row', 'write-b'), assistant('write-row', 'write-a'),
      { sleep_ms: 800 }, results(['write-a', 'write-b']), { text: 'WRITING-PROOF-DONE' }] },
    { match: 'UNOBSERVED-PROOF', steps: [assistant('unknown-row', 'no-start'), { sleep_ms: 300 }, results(['no-start'])] },
    { match: 'CANCEL-WRITING', steps: [start('write-cancel', 'Bash', 0), { sleep_ms: 15000 }] },
  ] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/boss/chat?last=80`)
  const active = async () => ((await chat()).transient ?? []).filter(row => row.kind === 'tool_writing')
  await rig.userMail('boss', 'PREVIEW-PROOF')
  const partial = await rig.waitFor(async () => (await active()).find(r => r.tool_id === 'preview' && r.tool?.arg === 'echo hel'),
    { what: 'partial command is visible before closing its JSON string', timeout: 2500 }).catch(() => null)
  p.check('partial input appears as the same real tool chip before the JSON string closes', partial?.tool?.name === 'Bash'
    && partial.tool.preview_input.command === 'echo hel' && !('description' in partial.tool.preview_input)
    && partial.tool.writing_started_at === partial.started_at, partial)
  const updated = await rig.waitFor(async () => (await active()).find(r => r.tool_id === 'preview' && r.tool?.arg === 'Say hello'),
    { what: 'later streamed description updates the same chip', timeout: 6500 }).catch(() => null)
  p.check('later streamed fields update the same call without restarting its writing clock', !!updated
    && updated.tool.preview_input.command === 'echo hello' && (!partial || updated.started_at === partial.started_at), updated)
  p.file('live-preview.json', { partial, updated })
  if (flags['preview-only']) return p.summary()
  await rig.waitFor(async () => !(await chat()).busy, { what: 'preview turn settles', timeout: 15000 })
  await rig.userMail('boss', 'WRITING-PROOF')
  let first
  await rig.waitFor(async () => { const rows = await active(); first = rows.find(r => r.tool_id === 'write-a'); return !!first },
    { what: 'first writing snapshot', timeout: 20000 })
  p.check('real stream start exposes call ID/name/start timestamp before admission', first.text === 'Bash' && !!first.started_at)
  let paired
  await rig.waitFor(async () => { paired = await active(); return paired.length === 2 }, { what: 'interleaved writing snapshots', timeout: 10000 })
  p.check('parallel IDs and stable start timestamp survive second start', new Set(paired.map(r => r.tool_id)).size === 2
    && paired.find(r => r.tool_id === 'write-a').started_at === first.started_at)
  await rig.waitFor(async () => { const c = await chat(); return !c.busy && c.messages.some(m => m.text?.includes('WRITING-PROOF-DONE')) },
    { what: 'writing fixture completes', timeout: 20000 })
  const sql = rig.sql("SELECT body FROM ot.convo WHERE body @? '$.tools[*].id ? (@ == \"write-a\" || @ == \"write-b\")'")
  const chips = sql.flatMap(r => r.body.tools ?? []).filter(t => ['write-a', 'write-b'].includes(t.id))
  p.check('one durable chip per actual call despite repeated full assistant record', chips.length === 2 && new Set(chips.map(t => t.id)).size === 2)
  p.check('both observed writing clocks persisted on existing tool chips', chips.length === 2
    && chips.every(t => typeof t.writing_secs === 'number' && t.writing_secs > 1 && t.writing_secs < 10))
  p.check('execution start/result clocks independently present and ordered', chips.length === 2
    && chips.every(t => t.started_at && t.ended_at && Date.parse(t.ended_at) > Date.parse(t.started_at)))
  const reloaded = (await chat()).messages.flatMap(m => m.tools ?? []).filter(t => ['write-a', 'write-b'].includes(t.id))
  p.check('fresh authenticated chat projection retains exact persisted writing times', reloaded.length === 2
    && chips.every(t => reloaded.find(r => r.id === t.id)?.writing_secs === t.writing_secs))
  p.check('completed turn has no orphan writing snapshots', (await active()).length === 0)
  await rig.userMail('boss', 'UNOBSERVED-PROOF')
  await rig.waitFor(async () => (await chat()).messages.some(m => m.tools?.some(t => t.id === 'no-start' && t.result !== undefined)),
    { what: 'unobserved full call completed', timeout: 15000 })
  const unknown = (await chat()).messages.flatMap(m => m.tools ?? []).find(t => t.id === 'no-start')
  p.check('full call without observed generation never receives fabricated zero duration', unknown && !('writing_secs' in unknown))
  await rig.waitFor(() => rig.sql("SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id=t.agent_id WHERE a.name='boss' AND t.ended_at IS NULL").length === 0,
    { what: 'unobserved turn settles', timeout: 15000 })
  await rig.userMail('boss', 'CANCEL-WRITING')
  await rig.waitFor(async () => (await active()).some(r => r.tool_id === 'write-cancel'), { what: 'cancel target writing', timeout: 15000 })
  await rig.op({ op: 'halt', nodes: ['boss'] })
  await rig.waitFor(async () => !(await chat()).busy, { what: 'halt settles writing turn', timeout: 20000 })
  p.check('cancellation clears active writing and admits no fictitious tool chip', (await active()).length === 0
    && !(await chat()).messages.some(m => m.tools?.some(t => t.id === 'write-cancel')))
  p.file('durable-chips.json', { chips, reloaded, unknown })
  p.keep(rig, { agents: ['boss'] })
  p.note('Real scratch engine/SQL/chat endpoints and scripted fake Claude only; no model turn, actual tool execution or live data.')
  return p.summary()
}
