import path from 'node:path'
import { RIG_DIR } from '../lib.mjs'
import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'
import { startFakeLlm } from '../fakellm.mjs'

// Claude Code can emit several assistant records for one API message id.
// The projection must preserve their block order, including amended tool results.
function sameMessageSteps() {
  const stream = event => ({ raw: { type: 'stream_event', event } })
  const assistant = block => ({ raw: { type: 'assistant', message: { id: 'same-message', content: [block] } } })
  const text = (value, index) => [
    stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }),
    { sleep_ms: 3500 }, assistant({ type: 'text', text: value }),
  ]
  return [...text('ORDER_FIRST_REPLY \u{1F600}\n\n' + '\u{1F600}'.repeat(4096), 0),
    assistant({ type: 'tool_use', id: 'same-tool', name: 'Bash', input: { command: 'echo ORDER_TOOL' } }),
    { raw: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'same-tool', content: 'done' }] } } },
    ...text('ORDER_SECOND_REPLY', 2), { sleep_ms: 3000 }]
}

export async function setup() {
  return { fixture: { org: { name: 'Stream order' },
    agents: [{ name: 'claude', tier: 'sonnet', grant: 4 }, { name: 'codex', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'Ready.' }] }] } } } }
}

export default async function(rig, { flags = {} } = {}) {
  const p = new Proof('stream-order')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'fixture turns idle', timeout: 60000 })
  const llm = await startFakeLlm({ models: [{ name: 'fake-model:latest', context: 65536 }] })
  try {
    const server = await rig.api('POST', '/api/langservers', { preset: 'llamacpp', address: llm.url,
      harness: 'claude-code', label: 'Order proof llama.cpp', models: [{ id: 'fake-model:latest', context: 65536 }] })
    const tier = Object.values(server.server?.models ?? {})[0]?.tier
    if (!tier) throw new Error('scratch language-server tier not created')
    await rig.op({ op: 'hire', name: 'local', tier, grant: 1, charter: 'Stream order proof only.' })
    const scenario = { default: { turns: [{ match: 'ORDER-PROOF', steps: [
      { text: 'ORDER_FIRST_REPLY', chunk: 64, delay_ms: 1800 },
      { thinking: 'THOUGHT_ONE\nTWO\n\nTHREE', delay_ms: 4000 },
      { tool: 'Bash', args: { command: 'echo ORDER_TOOL', description: 'ORDER_TOOL' }, result: 'tool done' },
      { text: 'ORDER_SECOND_REPLY', chunk: 64, delay_ms: 3500 },
      { sleep_ms: 3000 },
    ] }] } }
    await rig.op({ op: 'hire', name: 'same', tier: 'sonnet', grant: 1, charter: 'Same-message block order proof.' })
    // Keep separate names so earlier replies cannot contaminate the DOM counts.
    await rig.op({ op: 'hire', name: 'direct', tier: 'luna', grant: 1, charter: 'Direct text-tool-text proof.' })
    scenario.agents = { same: { turns: [{ steps: sameMessageSteps() }] },
      direct: { turns: [{ steps: [{ text: 'ORDER_FIRST_REPLY', chunk: 64, delay_ms: 3500 },
        { tool: 'Bash', args: { command: 'echo ORDER_TOOL' }, result: 'done' },
        { text: 'ORDER_SECOND_REPLY', chunk: 64, delay_ms: 3500 }, { sleep_ms: 3000 }] }] } }
    rig.scenario(scenario)
    const only = flags.only?.split(',')
    for (const agent of ['claude', 'codex', 'local', 'same', 'direct'].filter(name => !only || only.includes(name))) {
      const direct = ['same', 'direct'].includes(agent)
      const result = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'stream-order.cjs'), {
        args: { agent, direct }, preset: 'tall', out: path.join(p.dir, agent), timeout: 90000 })
      p.file(`${agent}.json`, result)
      p.check(`${agent}: desktop scenario completed`, result.ok, result.error)
      if (!result.ok) continue
      const v = result.value
      p.check(`${agent}: token frames omit commit metadata; transition frames carry it`,
        v.wire.tokens > 0 && v.wire.commits > 0 && v.wire.badTokens === 0, v.wire)
      if (!direct) p.check(`${agent}: earlier reply precedes the live thought`, v.liveThought.firstBeforeThought, v.liveThought)
      p.check(`${agent}: tool precedes the second live reply; each reply appears once`, v.liveSecond.ordered && v.liveSecond.firstCount === 1 && v.liveSecond.secondCount === 1, v.liveSecond)
      p.check(`${agent}: final order matches the live order, no duplicate replies`, v.final.ordered && v.final.firstCount === 1 && v.final.secondCount === 1, v.final)
      if (!direct) p.check(`${agent}: live and final thoughts have identical HTML, line spacing and block height`,
        JSON.stringify(v.liveThought.metrics) === JSON.stringify(v.finalThought), { live: v.liveThought.metrics, final: v.finalThought })
      p.check(`${agent}: no sampled paint duplicates a reply or places tool/second reply before first`, v.badFrames.length === 0, v.badFrames)
    }
    const rows = rig.sql("SELECT body FROM ot.convo WHERE body ? 'content_blocks'").map(r => r.body)
    const long = rows.find(r => r.text?.length > 8000)
    p.check('long Unicode reply stores prose once and only bounded offset metadata', !!long
      && JSON.stringify(long.content_blocks).length < 300
      && rows.every(r => r.content_blocks.every(b => !('text' in b)))
      && long.text.slice(long.content_blocks[0].start, long.content_blocks[0].end).endsWith('\u{1F600}'.repeat(4096))
      && long.text.slice(long.content_blocks.at(-1).start, long.content_blocks.at(-1).end) === 'ORDER_SECOND_REPLY',
      long && { textCodeUnits: long.text.length, metadataBytes: Buffer.byteLength(JSON.stringify(long.content_blocks)) })
    p.keep(rig, { agents: ['claude', 'codex', 'local', 'same', 'direct'] })
    p.note('Real engine + PostgreSQL + scripted Claude Code and Codex CLIs + offscreen renderer; HTTP chat responses deliberately delayed 2500 ms while real websocket frames flow. The local agent uses a scratch llama.cpp provider and the scripted Claude Code harness; no real model inference or live agent was used.')
    return p.summary()
  } finally { await llm.close() }
}
