// Measurement (not a pass/fail proof of a change): what fills a Language
// Server agent's context before it does any work. Captures whole first
// requests in tools/rig/fakellm.mjs `bodies`, for a later split and token
// count (tools/rig/ctxsplit.py):
//   A. through the engine: a Claude Code agent and a Codex agent on a
//      llama.cpp-preset server, with the scope of the live qwen agents (self
//      visibility, bash + edit, no web, no subagents, no extra MCP servers)
//      and, when CTX_LIVE_IDENTITY names a live `.orgtree-identity.md`
//      (a read-only copy), its team charter and agent charter;
//   B. the installed CLIs pointed straight at the fake (no engine), as they
//      are and with each of their trimming options.
// The manifest (variant → body file) is written to the evidence folder.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/langserver-context.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { cleanEnv } from '../lib.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const MODEL = 'fake-model:latest'
const WINDOW = 65536
const TINY = 'You are a coding agent.'

/** The installed CLI pointed straight at the fake (no engine), stopped once
 *  the fake saw its first request. */
async function direct(rig, p, llm, which, token, extra = [], env2 = {}) {
  const root = path.join(p.dir, `direct-${token}`)
  for (const d of ['home', 'cfg', 'work']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const env = { ...cleanEnv() }
  for (const k of Object.keys(env)) if (/^(ORGTREE_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|OPENROUTER_)/i.test(k)) delete env[k]
  Object.assign(env, { USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home') })
  const q = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  let exe, args
  if (which === 'claude') {
    Object.assign(env, { CLAUDE_CONFIG_DIR: path.join(root, 'cfg'), ANTHROPIC_BASE_URL: llm.url, ANTHROPIC_AUTH_TOKEN: 'orgtree-local',
      ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: MODEL, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(WINDOW) }, env2)
    exe = path.join(rig.run.dir, 'bin', 'claude.exe')
    args = ['-p', `${token}: hello`, '--output-format', 'json', ...extra]
  } else {
    Object.assign(env, { CODEX_HOME: path.join(root, 'cfg'), ORGTREE_LANGSERVER_KEY: 'orgtree-local' }, env2)
    exe = path.join(rig.run.dir, 'bin', 'codex.exe')
    const tiny = path.join(root, 'instructions.md')
    fs.writeFileSync(tiny, TINY)
    const ex = extra.map(a => a.replace('<TINY>', tiny.replace(/\\/g, '\\\\')))
    args = ['-c', `model_provider=${q('ls')}`, '-c', `model_providers.ls.name=${q('ls')}`,
      '-c', `model_providers.ls.base_url=${q(`${llm.url}/v1`)}`, '-c', `model_providers.ls.env_key=${q('ORGTREE_LANGSERVER_KEY')}`,
      '-c', `model_providers.ls.wire_api=${q('responses')}`, '-c', `model=${q(MODEL)}`, '-c', `model_context_window=${WINDOW}`,
      '-c', `web_search=${q('disabled')}`, ...ex.flatMap(kv => ['-c', kv]), 'exec', '--json', '--skip-git-repo-check', `${token}: hello`]
  }
  let stderr = ''
  const child = spawn(exe, args, { cwd: path.join(root, 'work'), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d })
  const seen = await rig.waitFor(() => llm.requests.find(r => (r.last_user ?? '').includes(token) && r.body_file) ?? null,
    { what: `the ${which} CLI's first request (${token})`, timeout: 90000 }).catch(() => null)
  child.kill()
  return { seen, stderr: stderr.slice(0, 1500) }
}

export async function setup() {
  return { name: 'langserver-context', 'real-cli': true, fixture: 'none' }
}

export default async function (rig) {
  const p = new Proof('langserver-context')
  const llm = await startFakeLlm({ log: path.join(p.dir, 'fakellm.jsonl'), bodies: path.join(p.dir, 'bodies'),
    models: [{ name: MODEL, context: 131072, running: WINDOW }], rules: [] })
  const manifest = { window: WINDOW, engine: [], direct: [] }
  try {
    // CTX_ONLY=<token prefix>: only the direct variants it names (no engine part)
    const only = process.env.CTX_ONLY ?? ''
    // ------------------------------------------------------------ A. through the engine
    if (!only) {
    let team = 'Team rules for the context measurement.'
    let charter = 'You are a housekeeping reporter.'
    const live = process.env.CTX_LIVE_IDENTITY
    if (live && fs.existsSync(live)) {
      const lines = fs.readFileSync(live, 'utf8').split('\n')
      const at = pre => lines.findIndex(l => l.startsWith(pre))
      const c = at('Your charter: '), t = at('Standing charter from your superior '), k = at('[CACHE CONTINUITY]')
      if (c > 0 && t > c && k > t) {
        charter = lines.slice(c, t).join('\n').replace(/^Your charter: /, '').trimEnd()
        team = lines.slice(t, k).join('\n').replace(/^Standing charter from your superior [^:]*: /, '').trimEnd()
      }
    }
    const tiers = {}
    for (const [harness, h] of [['claude-code', 'c'], ['codex-cli', 'x']]) {
      const made = await rig.api('POST', '/api/langservers', { preset: 'llamacpp', address: llm.url, harness,
        label: `llama.cpp (${h})`, models: [{ id: MODEL, context: WINDOW }] })
      tiers[h] = Object.values(made.server?.models ?? {})[0]?.tier ?? null
    }
    const scope = { org_visibility: 'self', permission_mode: 'bypassPermissions',
      tools: { bash: true, web: false, edit: true, subagents: false, mcp: [] }, add_dirs: [] }
    await seed(rig, { org: { name: 'Context Measurement Org' }, agents: [
      { name: 'ctxlead', tier: tiers.c, grant: 4, charter: 'You lead the context measurement.', team_charter: team },
      { name: 'ctxclaude', tier: tiers.c, grant: 0, parent: 'ctxlead', charter, ...scope },
      { name: 'ctxcodex', tier: tiers.x, grant: 0, parent: 'ctxlead', charter, ...scope },
    ] })
    for (const [name, token] of [['ctxclaude', 'PROOF-CTX-ENGINE-CLAUDE'], ['ctxcodex', 'PROOF-CTX-ENGINE-CODEX']]) {
      await rig.userMail(name, `${token}: hello`)
      const seen = await rig.waitFor(() => llm.requests.find(r => (r.last_user ?? '').includes(token) && r.body_file) ?? null,
        { what: `${name}'s first request`, timeout: 180000 }).catch(() => null)
      manifest.engine.push({ name, token, body: seen?.body_file ?? null, path: seen?.path ?? null,
        identity: path.join(rig.dir, 'scratch', 'context-measurement-org', name, '.orgtree-identity.md') })
      p.check(`${name}: its first request through the engine was captured`, !!seen?.body_file, seen && { body: seen.body_file })
    }
    manifest.live_identity = live ?? null
    manifest.team_charter_chars = team.length
    manifest.charter_chars = charter.length
    }

    // ------------------------------------------------------------ B. the CLIs as they are, and trimmed
    const variants = [
      ['claude', 'CC-DEFAULT', 'as is (no flags)', []],
      ['claude', 'CC-ORGTREE-SCOPE', '--disallowedTools WebFetch,WebSearch,Task,Agent (the qwen scope)', ['--disallowedTools', 'WebFetch,WebSearch,Task,Agent']],
      ['claude', 'CC-TOOLS-CORE', '--tools Bash,Read,Edit,Write,Glob,Grep', ['--tools', 'Bash,Read,Edit,Write,Glob,Grep']],
      ['claude', 'CC-TOOLS-NONE', '--tools ""', ['--tools', '']],
      ['claude', 'CC-SYSTEM-PROMPT', `--system-prompt "${TINY}"`, ['--system-prompt', TINY]],
      ['claude', 'CC-EXCLUDE-DYNAMIC', '--exclude-dynamic-system-prompt-sections', ['--exclude-dynamic-system-prompt-sections']],
      ['claude', 'CC-RESTRICTED', '--restricted', ['--restricted']],
      ['claude', 'CC-BARE', '--bare', ['--bare'], { ANTHROPIC_API_KEY: 'orgtree-local', ANTHROPIC_AUTH_TOKEN: '' }],
      ['claude', 'CC-MIN', `--bare --system-prompt "${TINY}" --tools ""`, ['--bare', '--system-prompt', TINY, '--tools', ''],
        { ANTHROPIC_API_KEY: 'orgtree-local', ANTHROPIC_AUTH_TOKEN: '' }],
      ['claude', 'CC-PRACTICAL', `--system-prompt "${TINY}" --tools Bash,Read,Edit,Write,Glob,Grep`,
        ['--system-prompt', TINY, '--tools', 'Bash,Read,Edit,Write,Glob,Grep']],
      ['codex', 'CX-DEFAULT', 'as is', []],
      ['codex', 'CX-INSTRUCTIONS-FILE', 'model_instructions_file=<one line>', ['model_instructions_file="<TINY>"']],
      ['codex', 'CX-NO-INCLUDES', 'include_permissions/apps/collaboration_mode_instructions=false, include_environment_context=false',
        ['include_permissions_instructions=false', 'include_apps_instructions=false',
          'include_collaboration_mode_instructions=false', 'include_environment_context=false']],
      ['codex', 'CX-NO-VIEW-IMAGE', 'features.view_image=false', ['features.view_image=false']],
      ['codex', 'CX-NO-SHELL', 'features.shell_tool=false', ['features.shell_tool=false']],
      ['codex', 'CX-NO-UNIFIED-EXEC', 'features.unified_exec=false', ['features.unified_exec=false']],
      ['codex', 'CX-NO-MULTI-AGENT', 'features.multi_agent=false', ['features.multi_agent=false']],
      ['codex', 'CX-NO-GOALS', 'features.goals=false', ['features.goals=false']],
      ['codex', 'CX-NO-REQUEST-INPUT', 'features.default_mode_request_user_input=false', ['features.default_mode_request_user_input=false']],
      ['codex', 'CX-NO-SKILLS', 'skills.include_instructions=false', ['skills.include_instructions=false']],
      ['codex', 'CX-PRACTICAL', 'all of the above except features.shell_tool=false (keeps the shell)', ['model_instructions_file="<TINY>"',
        'include_permissions_instructions=false', 'include_apps_instructions=false', 'include_collaboration_mode_instructions=false',
        'include_environment_context=false', 'features.view_image=false', 'features.multi_agent=false', 'features.goals=false',
        'features.default_mode_request_user_input=false', 'skills.include_instructions=false']],
      ['codex', 'CX-MIN', 'all of the above', ['model_instructions_file="<TINY>"', 'include_permissions_instructions=false',
        'include_apps_instructions=false', 'include_collaboration_mode_instructions=false', 'include_environment_context=false',
        'features.view_image=false', 'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false',
        'features.goals=false', 'features.default_mode_request_user_input=false', 'skills.include_instructions=false']],
    ]
    for (const [which, token, option, extra, env2] of variants.filter(v => v[1].startsWith(only))) {
      const r = await direct(rig, p, llm, which, `PROOF-CTX-${token}`, extra, env2)
      manifest.direct.push({ harness: which === 'claude' ? 'Claude Code' : 'Codex', token, option, extra,
        body: r.seen?.body_file ?? null, stderr: r.seen ? undefined : r.stderr })
      p.check(`${which} ${option}: first request captured`, !!r.seen?.body_file, r.seen ? { body: r.seen.body_file } : { stderr: r.stderr })
    }
  } finally {
    fs.writeFileSync(path.join(p.dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await llm.close()
  }
  return p.summary()
}
