import { Proof } from '../proof.mjs'

export function setup() {
  return { fixture: { org: { name: 'Observed result text' },
    agents: [{ name: 'worker', tier: 'sonnet', grant: 1 }],
    scenario: { default: { turns: [{ steps: [{ text: 'Ready.' }] }] } } } }
}

// The absence cases must reach the actual Claude actor as terminal results;
// an explicitly observed empty string/block is a different, valid zero.
const cases = [
  { id: 'missing' },
  { id: 'null', content: null },
  { id: 'number', content: 0 },
  { id: 'object', content: {} },
  { id: 'empty-array', content: [] },
  { id: 'unknown-block', content: [{ type: 'resource', text: 'not a text block' }] },
  { id: 'missing-text', content: [{ type: 'text' }] },
  { id: 'null-text', content: [{ type: 'text', text: null }] },
  { id: 'image-only', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' } }] },
  { id: 'empty-string', content: '', zero: true },
  { id: 'empty-text-block', content: [{ type: 'text', text: '' }], zero: true },
  { id: 'positive-text', content: 'observed textual result', positive: true },
]

export default async function (rig) {
  const p = new Proof('token-result-observations')
  await rig.waitFor(() => !rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length,
    { what: 'seed turn settled', timeout: 30000 })
  const assistant = (id, content) => ({ raw: { type: 'assistant', parent_tool_use_id: null,
    message: { id, role: 'assistant', content, usage: { input_tokens: 20, output_tokens: 10 } } } })
  const ids = cases.map(c => 'observation-' + c.id)
  rig.scenario({ agents: { worker: { turns: [{ match: 'OBSERVED-RESULTS', steps: [
    assistant('observation-calls', ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'synthetic-only' } }))),
    { raw: { type: 'user', parent_tool_use_id: null, message: { content: cases.map((c, i) => ({
      type: 'tool_result', tool_use_id: ids[i], ...(Object.hasOwn(c, 'content') ? { content: c.content } : {}),
    })) } } },
    assistant('observations-finished', [{ type: 'text', text: 'OBSERVATIONS-FINISHED' }]),
  ] }] } }, default: { turns: [{ steps: [{ text: 'Ready.' }] }] } })
  await rig.userMail('worker', 'OBSERVED-RESULTS')
  const chat = await rig.waitFor(async () => {
    const c = await rig.api('GET', `/api/orgs/${rig.org}/nodes/worker/chat?last=80`)
    return !c.busy && c.messages.some(row => row.assistant_id === 'observations-finished') && c
  }, { what: 'all result observations committed', timeout: 30000 })
  const chips = chat.messages.flatMap(row => row.tools ?? [])
  p.check('all terminal result cases reached the real actor', ids.every(id => chips.some(c => c.id === id && c.ended_at)))
  for (const [i, c] of cases.entries()) {
    const chip = chips.find(chip => chip.id === ids[i])
    if (c.zero) p.check(`${c.id}: observed empty text has estimated zero`, chip?.output_tokens === 0 && chip.output_tokens_estimated === true)
    else if (c.positive) p.check(`${c.id}: observed text has a positive estimate`, chip?.output_tokens > 0 && chip.output_tokens_estimated === true)
    else p.check(`${c.id}: no count without observed text`, !!chip && !Object.hasOwn(chip, 'output_tokens'))
  }
  p.file('chips.json', chips.filter(c => ids.includes(c.id)))
  p.note('Actual scratch engine/Claude adapter with synthetic raw result events; no real inference or live data.')
  return p.summary()
}
