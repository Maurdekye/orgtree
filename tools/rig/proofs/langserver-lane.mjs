// Proof: the Language Server lane through the real engine AND the real
// harnesses. The run's agents are the installed Claude Code and Codex
// (`--real-cli`, their home the run's fake one); the "language server" is
// tools/rig/fakellm.mjs, which answers like Ollama and speaks Anthropic
// Messages and OpenAI Responses from a script. No model, no GPU, no account:
//   1. the settings probe reads the server's models and windows;
//   2. one server per harness on the same address; each offered model is a
//      tier on the providers payload and in the hire offers;
//   3. lsclaude (Claude Code) and lscodex (Codex) each get mail, and the fake
//      server answers with a call to orgtree_status: the call reaches the
//      engine through each harness's own tool channel and the status lands;
//   4. what reached the server: the hired model id, the lane's placeholder
//      key (never a login), the orgtree tools, the window the CLI was told;
//   5. the turn costs nothing and says so (cost_source "local").
// Run: node tools/rig/rig.mjs run tools/rig/proofs/langserver-lane.mjs

import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const MODEL = 'fake-model:latest'

export async function setup() {
  return { name: 'langserver', 'real-cli': true, fixture: 'none' }
}

export default async function (rig) {
  const p = new Proof('langserver-lane')
  const llm = await startFakeLlm({
    log: path.join(p.dir, 'fakellm.jsonl'),
    rules: [
      { match: ['PROOF-LS-CLAUDE'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-CLAUDE-DONE' } },
      { match: ['PROOF-LS-CODEX'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-CODEX-DONE' } },
    ],
  })
  try {
    // ------------------------------------------------------------ 1. the probe
    const probe = await rig.api('POST', '/api/langservers/probe', { preset: 'ollama', address: llm.url, harness: 'claude-code' })
    const pm = probe.models?.[0]
    p.check('the probe reaches the server and lists its model with both windows', probe.reachable === true
      && pm?.id === MODEL && pm?.max_context === 131072 && pm?.loaded_context === 65536 && pm?.tools === true, probe)
    const dead = await rig.api('POST', '/api/langservers/probe', { preset: 'ollama', address: 'http://127.0.0.1:9', harness: 'claude-code' })
    p.check('a server that is not running is named as such', dead.reachable === false && /nothing is answering|did not answer/.test(dead.error ?? ''), dead)

    // ------------------------------------------------------------ 2. servers and tiers
    const a = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'claude-code',
      label: 'Fake (Claude Code)', models: [{ id: MODEL, context: 65536 }] })
    const b = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'codex-cli',
      label: 'Fake (Codex)', models: [{ id: MODEL, context: 65536 }] })
    const tierA = Object.values(a.server?.models ?? {})[0]?.tier
    const tierB = Object.values(b.server?.models ?? {})[0]?.tier
    const listed = id => (b.doc?.servers ?? []).find(s => s.id === id)
    p.check('one server per harness on the same address, each model a tier, each harness pointed at its API',
      tierA === 'ls-ollama-fake-model-latest' && tierB === 'ls-ollama-2-fake-model-latest'
      && listed(a.server?.id)?.base_url === llm.url && listed(b.server?.id)?.base_url === `${llm.url}/v1`,
    { a: listed(a.server?.id), b: listed(b.server?.id) })
    const prov = await rig.api('GET', '/api/providers')
    const entry = (prov.providers ?? []).find(x => x.id === 'langserver')
    p.check('the providers payload carries the lane with both tiers, hireable', entry?.hire_enabled === true
      && [tierA, tierB].every(t => entry.tiers.some(x => x.tier === t && x.seat === 0.1)), entry)

    // ------------------------------------------------------------ 3. two agents, one turn each
    await seed(rig, { org: { name: 'Language Server Org' }, agents: [
      { name: 'lsclaude', tier: tierA, grant: 1, charter: 'You test the Language Server lane on Claude Code.' },
      { name: 'lscodex', tier: tierB, grant: 1, charter: 'You test the Language Server lane on Codex.' },
    ] })
    const harness = n => rig.one(`SELECT extra->>'harness' AS h FROM ot.agents WHERE name = '${n}'`)?.h
    p.check('each agent carries its server\'s harness', harness('lsclaude') === 'claude-code' && harness('lscodex') === 'codex-cli',
      { lsclaude: harness('lsclaude'), lscodex: harness('lscodex') })
    const status = n => rig.one(`SELECT last_status->>'status' AS status, last_status->>'summary' AS summary FROM ot.agents WHERE name = '${n}'`)
    for (const [name, token] of [['lsclaude', 'PROOF-LS-CLAUDE'], ['lscodex', 'PROOF-LS-CODEX']]) {
      await rig.userMail(name, `${token}: report done with orgtree_status.`)
      const st = await rig.waitFor(() => (status(name)?.summary === `${token}-DONE` ? status(name) : null),
        { what: `${name}'s orgtree_status from the fake server's tool call`, timeout: 180000 }).catch(() => null)
      // "done" is a report, stored as idle with its summary (tools/mailtools.rs status)
      p.check(`${name}: the server's tool call reached the engine (its done report is on record)`,
        st?.summary === `${token}-DONE` && st?.status === 'idle', { status: status(name), last_error: rig.agentRow(name)?.last_error })
      await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}' AND t.ended_at IS NULL`).length === 0,
        { what: `${name}'s turn to end`, timeout: 120000 }).catch(() => null)
    }

    // ------------------------------------------------------------ 4. what reached the server
    const claudeReq = llm.requests.filter(r => r.path === '/v1/messages')
    const codexReq = llm.requests.filter(r => r.path === '/v1/responses')
    p.file('requests.json', llm.requests)
    const c0 = claudeReq.find(r => /PROOF-LS-CLAUDE/.test(r.last_user ?? ''))
    p.check('Claude Code asked the server for the hired model, with the lane key as a bearer token and no x-api-key',
      !!c0 && c0.model === MODEL && /^Bearer orgt/.test(c0.authorization ?? '') && c0.x_api_key === null && c0.stream === true, c0)
    p.check('Claude Code offered the orgtree tools and kept its reply small for the window', !!c0 && c0.orgtree_tools > 10
      && Number(c0.max_tokens) <= 16384, c0 && { orgtree_tools: c0.orgtree_tools, tools: c0.tools, max_tokens: c0.max_tokens })
    p.check('Claude Code sent the tool result back and got the final answer', claudeReq.some(r => r.tool_result === true), claudeReq.map(r => r.tool_result))
    const x0 = codexReq.find(r => /PROOF-LS-CODEX/.test(r.last_user ?? ''))
    p.check('Codex asked the server\'s Responses API for the hired model, with the lane key', !!x0 && x0.model === MODEL
      && /^Bearer orgt/.test(x0.authorization ?? '') && x0.stream === true && x0.orgtree_tools > 10, x0)
    p.check('Codex sent the tool output back', codexReq.some(r => r.tool_result === true), codexReq.map(r => r.tool_result))

    // ------------------------------------------------------------ 5. nothing billed
    const turns = rig.sql(`SELECT a.name, t.cost_usd::float8 AS cost, t.cost_source FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
                           WHERE a.name IN ('lsclaude', 'lscodex') AND t.ended_at IS NOT NULL`)
    p.check('every finished turn costs 0 and says local', turns.length >= 2 && turns.every(t => t.cost === 0 && t.cost_source === 'local'), turns)
    p.keep(rig, { grep: /langserver|ls-ollama|lsclaude|lscodex/ })
  } finally {
    await llm.close()
  }
  return p.summary()
}
