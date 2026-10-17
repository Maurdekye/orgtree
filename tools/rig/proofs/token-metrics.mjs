import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Synthetic token metrics' },
    agents: [{ name: 'worker', tier: 'sonnet', grant: 1 }],
    scenario: { default: { turns: [{ steps: [{ text: 'Ready.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('token-metrics')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn settles', timeout: 30000 })
  const usage = { input_tokens: 12, cache_read_input_tokens: 28, cache_creation_input_tokens: 4,
    output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } }
  const assistant = (id, content, counts = usage, parent_tool_use_id = null) => ({ raw: {
    type: 'assistant', parent_tool_use_id, message: { id, role: 'assistant', content, usage: counts, stop_reason: 'tool_use' } } })
  const output = 'complete synthetic output\n' + 'x'.repeat(12000)
  const steps = [
    assistant('metrics-one', [{ type: 'thinking', thinking: 'synthetic thought' }]),
    assistant('metrics-one', [{ type: 'tool_use', id: 'metrics-call', name: 'Bash', input: { command: 'synthetic-only' } }]),
    assistant('child-only', [{ type: 'text', text: 'child-only marker' }], { input_tokens: 999999, output_tokens: 999999 }, 'metrics-call'),
    { sleep_ms: 2500 },
    { raw: { type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'metrics-call', content: output } ] } } },
    assistant('metrics-last', [{ type: 'text', text: 'METRICS-DONE' }], {
      input_tokens: 88, output_tokens: 6, output_tokens_details: { thinking_tokens: 0 } }),
  ]
  rig.scenario({ agents: { worker: { turns: [
    { match: 'TOKEN-METRICS', steps },
    { match: 'AMBIGUOUS-THOUGHT', steps: [
      assistant('ambiguous', [{ type: 'thinking', thinking: 'first synthetic thought' }]),
      assistant('ambiguous', [{ type: 'thinking', thinking: 'second synthetic thought' }]),
      assistant('after-ambiguous', [{ type: 'text', text: 'AMBIGUOUS-DONE' }]),
    ] },
  ] } }, default: { turns: [{ steps: [{ text: 'Ready.' }] }] } })
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/worker/chat?last=40`)
  await rig.userMail('worker', 'TOKEN-METRICS')
  const live = await rig.waitFor(async () => {
    const c = await chat()
    return c.busy && c.occupancy === 44 ? c : null
  }, { what: 'provider context reading during active turn', timeout: 7000 })
  p.check('live HTTP occupancy is counted-once input/cache and never child usage', live.occupancy === 44 && live.occupancy_estimated === false)
  const persisted = rig.sql("SELECT occupancy FROM ot.agents WHERE name='worker'")[0]?.occupancy
  p.check('mid-turn occupancy does not write the agent database row', persisted !== 44, { persisted })
  await rig.waitFor(async () => !(await chat()).busy, { what: 'metrics turn settles', timeout: 15000 })
  const complete = await chat()
  const call = complete.messages.flatMap(row => row.tools ?? []).find(call => call.id === 'metrics-call')
  p.check('complete original output is estimated before display clipping', call?.output_tokens > 800
    && call.output_tokens_estimated === true && call.result.length < 4500, call && {
      tokens: call.output_tokens, estimated: call.output_tokens_estimated, previewChars: call.result.length })
  const thought = complete.messages.find(row => row.assistant_id === 'metrics-one')
  p.check('split Claude message retains one response thinking receipt', thought?.thinking_tokens === 7)
  p.check('child transcript does not enter parent conversation', !complete.messages.some(row => row.assistant_id === 'child-only'))
  await rig.userMail('worker', 'AMBIGUOUS-THOUGHT')
  await rig.waitFor(async () => {
    const c = await chat()
    return !c.busy && c.messages.some(row => row.assistant_id === 'ambiguous')
  }, { what: 'ambiguous response settles', timeout: 15000 })
  const ambiguous = (await chat()).messages.find(row => row.assistant_id === 'ambiguous')
  p.check('multiple native thought blocks never share an invented per-thought count', ambiguous && !('thinking_tokens' in ambiguous))
  p.note('Synthetic engine/fakeCLI/scratch PostgreSQL smoke only. Renderer and other-harness parser/coalescer coverage are separate focused tests; no real inference or live data.')
  return p.summary()
}
