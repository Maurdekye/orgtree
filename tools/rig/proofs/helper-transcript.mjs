import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('helper-transcript')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns idle', timeout: 60000 })
  const raw = event => ({ raw: event })
  const child = event => raw({ parent_tool_use_id: 'helper-root', ...event })
  const stream = event => child({ type: 'stream_event', event })
  const start = () => raw({ type: 'assistant', parent_tool_use_id: null, message: { id: 'root-message', content: [
    { type: 'tool_use', id: 'helper-root', name: 'Agent', input: { prompt: 'synthetic helper task' } },
  ] } })
  const begin = () => [stream({ type: 'message_start', message: { id: 'helper-message' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC-HELPER-LIVE' } })]
  rig.scenario({ agents: { boss: { turns: [
    { match: 'HELPER-LIVE-PROOF', steps: [start(), ...begin(), { sleep_ms: 1600 },
      child({ type: 'assistant', message: { id: 'helper-message', usage: { input_tokens: 999999 }, content: [
        { type: 'text', text: 'SYNTHETIC-HELPER-FINAL' },
        { type: 'tool_use', id: 'nested-helper', name: 'Agent', input: { prompt: 'one level only' } },
      ] } }),
      raw({ type: 'assistant', parent_tool_use_id: 'nested-helper', message: { id: 'grandchild', content: [{ type: 'text', text: 'MUST-NOT-APPEAR' }] } }),
      child({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nested-helper', content: 'nested summary' }] } }),
      child({ type: 'result', subtype: 'success', result: 'child complete' }), { sleep_ms: 1600 },
      raw({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'helper-root', content: 'helper complete' }] } }),
      { text: 'PARENT-DONE' }] },
    { match: 'HELPER-HALT-PROOF', steps: [start(), ...begin(), { sleep_ms: 15000 }] },
  ] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/boss/chat?last=80`)
  const root = c => c.messages.flatMap(m => m.tools || []).find(t => t.id === 'helper-root')
  const read = seq => rig.api('GET', `/api/orgs/${rig.org}/nodes/boss/helpertranscript/${seq}/helper-root`)
  await rig.userMail('boss', 'HELPER-LIVE-PROOF')
  const active = await rig.waitFor(async () => {
    const c = await chat(); const tool = root(c)
    if (!tool) return null
    const helper = await read(tool.input_seq)
    return helper.live && JSON.stringify(helper).includes('SYNTHETIC-HELPER-LIVE') ? { c, tool, helper } : null
  }, { what: 'helper text while parent runs', timeout: 15000 })
  p.check('helper snapshot streams before the parent tool returns', active.c.busy && active.helper.live)
  p.check('parent chat never contains private helper prose', !JSON.stringify(active.c).includes('SYNTHETIC-HELPER-LIVE'))
  const finalWhileRunning = await rig.waitFor(async () => {
    const helper = await read(active.tool.input_seq)
    return JSON.stringify(helper).includes('SYNTHETIC-HELPER-FINAL') ? helper : null
  }, { what: 'full child message replaces draft', timeout: 5000 })
  p.check('child result cannot finish the parent turn', (await chat()).busy)
  p.check('grandchild internals are excluded, nested call result stays', !JSON.stringify(finalWhileRunning).includes('MUST-NOT-APPEAR')
    && JSON.stringify(finalWhileRunning).includes('nested summary'))
  await rig.waitFor(async () => !(await chat()).busy, { what: 'parent settles', timeout: 10000 })
  const completed = await read(active.tool.input_seq)
  p.check('saved helper survives completion and is no longer live', !completed.live && JSON.stringify(completed).includes('SYNTHETIC-HELPER-FINAL'))
  const wrongCall = await rig.api('GET', `/api/orgs/${rig.org}/nodes/boss/helpertranscript/${active.tool.input_seq}/not-that-call`).then(() => false, () => true)
  p.check('unrelated tool identifier cannot retrieve the snapshot', wrongCall)
  await rig.userMail('boss', 'HELPER-HALT-PROOF')
  const halted = await rig.waitFor(async () => {
    const c = await chat()
    const tool = c.messages.flatMap(m => m.tools || []).filter(t => t.id === 'helper-root').at(-1)
    return c.busy && tool?.input_seq !== active.tool.input_seq && (await read(tool.input_seq)).messages.length ? tool : null
  }, { what: 'second turn helper', timeout: 15000 })
  await rig.op({ op: 'halt', nodes: ['boss'] })
  await rig.waitFor(async () => !(await chat()).busy, { what: 'halt settles parent', timeout: 20000 })
  p.check('halt retains already observed helper text and ends liveness', !(await read(halted.input_seq)).live)
  p.file('snapshots.json', { active: active.helper, finalWhileRunning, completed, halted: await read(halted.input_seq) })
  p.note('Synthetic fake Claude only. Other harness adapters, historical recovery and helper work continuing after the parent turn are deferred.')
  return p.summary()
}
