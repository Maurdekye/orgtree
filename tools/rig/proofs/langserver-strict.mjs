// Proof: the Language Server lane passes STRICT chat templates on every
// preset and both harnesses. The live bug (2026-10-10, llama.cpp + Qwen 3.8
// 27B): every turn failed with "System message must be at the beginning"
// and was retried every 30 s. The server here is tools/rig/fakellm.mjs in
// strict mode: it turns each request into chat messages the way a
// llama.cpp-style server does and refuses it the way Qwen 3.8's and Hugging
// Face's strict templates do (a system message after the first, two turns of
// one role in a row), with llama.cpp's 500 and Jinja words. The agents are
// the installed Claude Code and Codex (`--real-cli`).
//   1. control: the installed Claude Code and Codex, pointed straight at the
//      strict server, are refused on their first request (the bug, on the rig);
//   2. through the engine (its pass-through, engine lsproxy.rs), an agent on
//      each preset (Ollama, LM Studio, llama.cpp, vLLM, custom) and each
//      harness finishes a turn with a tool call, and the strict server
//      refused none of its requests;
//   3. a server receives its own key (or the lane's placeholder), never the
//      pass-through key the CLI holds;
//   4. a template that still refuses a conversation fails the turn once with
//      the server's words, on Claude Code and on Codex: no retry by the CLI,
//      no connection freeze, the error on the agent.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/langserver-strict.mjs

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { cleanEnv } from '../lib.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const MODEL = 'fake-model:latest'
const PRESETS = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'custom']
const HARNESSES = [['claude-code', 'c', 'Claude Code'], ['codex-cli', 'x', 'Codex']]
const SERVER_KEY = 'PROOF-SERVER-KEY'
const ALTERNATE = 'After the optional system message, conversation roles must alternate user/assistant/user/assistant/...'
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)

/** The installed CLI pointed straight at the strict server (no engine). Its
 *  first request is all this needs: the run stops once the server saw it. */
async function direct(rig, p, llm, which, token) {
  const root = path.join(p.dir, `direct-${which}`)
  for (const d of ['home', 'cfg', 'work']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const env = { ...cleanEnv() }
  for (const k of Object.keys(env)) if (/^(ORGTREE_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|OPENROUTER_)/i.test(k)) delete env[k]
  Object.assign(env, { USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home') })
  const q = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  let exe, args
  if (which === 'claude') {
    Object.assign(env, { CLAUDE_CONFIG_DIR: path.join(root, 'cfg'), ANTHROPIC_BASE_URL: llm.url, ANTHROPIC_AUTH_TOKEN: 'orgtree-local',
      ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: MODEL, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' })
    exe = path.join(rig.run.dir, 'bin', 'claude.exe')
    args = ['-p', `${token}: answer in one word.`, '--output-format', 'json']
  } else {
    Object.assign(env, { CODEX_HOME: path.join(root, 'cfg'), ORGTREE_LANGSERVER_KEY: 'orgtree-local' })
    exe = path.join(rig.run.dir, 'bin', 'codex.exe')
    args = ['-c', `model_provider=${q('ls')}`, '-c', `model_providers.ls.name=${q('ls')}`,
      '-c', `model_providers.ls.base_url=${q(`${llm.url}/v1`)}`, '-c', `model_providers.ls.env_key=${q('ORGTREE_LANGSERVER_KEY')}`,
      '-c', `model_providers.ls.wire_api=${q('responses')}`, '-c', `model=${q(MODEL)}`, '-c', 'model_context_window=65536',
      '-c', `web_search=${q('disabled')}`, 'exec', '--json', '--skip-git-repo-check', `${token}: answer in one word.`]
  }
  const child = spawn(exe, args, { cwd: path.join(root, 'work'), env, windowsHide: true, stdio: 'ignore' })
  const seen = await rig.waitFor(() => llm.requests.find(r => (r.last_user ?? '').includes(token)) ?? null,
    { what: `the ${which} CLI's first request`, timeout: 90000 }).catch(() => null)
  child.kill()
  return seen
}

export async function setup() {
  return { name: 'langserver-strict', 'real-cli': true, fixture: 'none' }
}

export default async function (rig) {
  const p = new Proof('langserver-strict')
  const combos = PRESETS.flatMap(pr => HARNESSES.map(([harness, h, label]) => ({
    pr, harness, label, name: `st${pr.slice(0, 4)}${h}`, token: `PROOF-STRICT-${pr.toUpperCase()}-${h.toUpperCase()}` })))
  const rules = [
    { match: ['PROOF-STRICT-REFUSE'], refuse: ALTERNATE },
    ...combos.map(c => ({ match: [c.token], tool: 'orgtree_status', input: { status: 'done', summary: `${c.token}-DONE` } })),
  ]
  const llm = await startFakeLlm({ strict: true, log: path.join(p.dir, 'fakellm.jsonl'), bodies: path.join(p.dir, 'bodies'),
    models: [{ name: MODEL, context: 131072, running: 65536 }], rules })
  try {
    // ------------------------------------------------------------ 1. control
    for (const [which, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
      const r = await direct(rig, p, llm, which, `PROOF-STRICT-DIRECT-${which.toUpperCase()}`)
      p.check(`control: the installed ${label}, pointed straight at the strict server, is refused (the live bug, on the rig)`,
        !!r?.strict_refused, r && { strict_refused: r.strict_refused, path: r.path, body: r.body_file })
    }

    // ------------------------------------------------------------ 2. every preset, both harnesses
    for (const c of combos) {
      const body = { preset: c.pr, address: llm.url, harness: c.harness, label: `${c.pr} (${c.label})`, models: [{ id: MODEL, context: 65536 }] }
      if (c.pr === 'custom' && c.harness === 'codex-cli') body.base_path = 'v1'
      if (c.pr === 'llamacpp' && c.harness === 'claude-code') body.key = SERVER_KEY
      const made = await rig.api('POST', '/api/langservers', body)
      c.tier = Object.values(made.server?.models ?? {})[0]?.tier ?? null
    }
    p.check('a server per preset and harness on the strict server, each model a tier', combos.every(c => c.tier),
      combos.map(c => ({ name: c.name, preset: c.pr, harness: c.harness, tier: c.tier })))
    await seed(rig, { org: { name: 'Strict Templates Org' },
      agents: combos.map(c => ({ name: c.name, tier: c.tier, grant: 1, charter: `You test the ${c.pr} preset on ${c.label}.` })) })
    const status = n => rig.one(`SELECT last_status->>'status' AS status, last_status->>'summary' AS summary FROM ot.agents WHERE name = '${n}'`)
    const turnOver = n => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.name = '${n}' AND t.ended_at IS NULL`).length === 0, { what: `${n}'s turn to end`, timeout: 120000 }).catch(() => null)
    const markAll = llm.requests.length
    for (const c of combos) {
      const mark = llm.requests.length
      await rig.userMail(c.name, `${c.token}: report done with orgtree_status.`)
      const st = await rig.waitFor(() => (status(c.name)?.summary === `${c.token}-DONE` ? status(c.name) : null),
        { what: `${c.name}'s done report`, timeout: 180000 }).catch(() => null)
      await turnOver(c.name)
      const api = c.harness === 'claude-code' ? '/v1/messages' : '/v1/responses'
      const seen = llm.requests.slice(mark).filter(r => r.path === api)
      const refused = seen.filter(r => r.strict_refused)
      p.check(`${c.pr} · ${c.label}: a turn with a tool call through the engine; the strict template refused none of its requests`,
        st?.summary === `${c.token}-DONE` && seen.length > 0 && refused.length === 0,
        { status: st, requests: seen.length, refused: refused.map(r => r.strict_refused), last_error: rig.agentRow(c.name)?.last_error })
    }

    // ------------------------------------------------------------ 3. keys
    const inference = llm.requests.slice(markAll).filter(r => r.path === '/v1/messages' || r.path === '/v1/responses')
    const keys = [...new Set(inference.map(r => r.auth_sha))]
    const allowed = [sha(`Bearer ${SERVER_KEY}`), sha('Bearer orgtree-local')]
    p.check('a server receives its own key (the keyed llama.cpp server) or the lane\'s placeholder, never the key the CLI holds',
      keys.every(k => allowed.includes(k)) && keys.includes(allowed[0]) && keys.includes(allowed[1]),
      { seen: keys, server_key: allowed[0], placeholder: allowed[1] })

    // ------------------------------------------------------------ 4. a template that still refuses
    for (const c of combos.filter(x => x.pr === 'ollama')) {
      const mark = llm.requests.length
      await rig.userMail(c.name, 'PROOF-STRICT-REFUSE: report done with orgtree_status.')
      const err = await rig.waitFor(() => { const e = rig.agentRow(c.name)?.last_error; return e && /must alternate/.test(e) ? e : null },
        { what: `${c.name}'s refused turn`, timeout: 120000 }).catch(() => null)
      await turnOver(c.name)
      await new Promise(r => setTimeout(r, 15000))
      // refusals by their words: the log keeps only the last 200 characters
      // of the user turn, and a reminder may follow the token there
      const api = c.harness === 'claude-code' ? '/v1/messages' : '/v1/responses'
      const asked = llm.requests.slice(mark).filter(r => r.path === api && r.strict_refused === ALTERNATE)
      const row = rig.agentRow(c.name)
      const extra = row?.extra ?? {}
      p.check(`${c.label}: a template that still refuses fails the turn once with the server's words; neither the CLI nor the engine retries`,
        !!err && /chat template/i.test(err) && asked.length === 1 && !extra.net_fail_run && !row?.frozen,
        { last_error: err, requests: asked.length, net_fail_run: extra.net_fail_run ?? null, frozen: row?.frozen ?? null })
    }
    p.keep(rig, { grep: /langserver|lsproxy|pass-through|ls-|^st[a-z]{4}[cx]\b|Strict Templates|template/ })
  } finally {
    await llm.close()
  }
  return p.summary()
}
