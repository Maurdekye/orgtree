import path from 'node:path'
import { RIG_DIR } from '../lib.mjs'
import { seed } from '../fixture.mjs'
import { startFakeLlm } from '../fakellm.mjs'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
export async function setup() { return { 'real-cli': true, fixture: 'none' } }
export default async function(rig) {
  const p = new Proof('reasoning-order')
  const llm = await startFakeLlm({ log: path.join(p.dir, 'server.jsonl'), models: [{ name: 'fake-model:latest', context: 131072 }],
    rules: [{ match: ['THOUGHT-FIRST'], stream_blocks: [
      { kind: 'thinking', text: 'REASON_FIRST\nnext line\n\nlast paragraph', chunks: 100, delay_ms: 200 },
      { kind: 'text', text: 'REPLY_SECOND', chunks: 100, delay_ms: 5000 }] },
      { match: ['TEXT-FIRST'], stream_blocks: [
      { kind: 'text', text: 'REPLY_FIRST', chunks: 100, delay_ms: 200 },
      { kind: 'thinking', text: 'REASON_SECOND\nnext line\n\nlast paragraph', chunks: 100, delay_ms: 5000 }] }] })
  try {
    const created = await rig.api('POST', '/api/langservers', { preset: 'llamacpp', address: llm.url,
      harness: 'claude-code', label: 'Isolated reasoning stream', models: [{ id: 'fake-model:latest', context: 131072 }] })
    const tier = Object.values(created.server.models)[0].tier
    await seed(rig, { org: { name: 'Reasoning order' }, agents: [{ name: 'reasoner', tier, grant: 1, charter: 'Isolated streaming proof.' }] })
    for (const thoughtFirst of [true, false]) {
      const label = thoughtFirst ? 'thought-first' : 'text-first'
      const result = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'reasoning-order.cjs'), {
        args: { agent: 'reasoner', thoughtFirst }, preset: 'tall', out: path.join(p.dir, label), timeout: 180000 })
      p.file(`${label}.json`, result)
      p.check(`${label}: real Claude CLI scenario`, result.ok, result.error)
      if (result.ok) {
        p.check(`${label}: live order remains stable`, result.value.bad.length === 0, result.value)
        p.check(`${label}: bounded transcript requests during 200 token chunks`, result.value.requests.length <= 18, { count: result.value.requests.length })
        p.check(`${label}: final order matches production`, result.value.final.ordered, result.value.final)
      }
      await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
        { what: 'turn finished', timeout: 60000 })
    }
    p.check('inference reached fake llama.cpp server through lsproxy',
      llm.requests.some(r => r.path === '/v1/messages' && r.reply?.stream_blocks), llm.requests.filter(r => r.reply?.stream_blocks).map(r => ({path:r.path, model:r.model})))
    p.keep(rig, { grep: /language-server pass-through/ })
    return p.summary()
  } finally { await llm.close() }
}
