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
//   5. the turn costs nothing and says so (cost_source "local");
//   5b. the agents-at-once cap: with the server answering slowly, two agents
//      on a server that takes one agent at a time take turns, while agents
//      on two different servers run at the same time (the control);
//   6. with a renderer bundle (`--ui <dir>`, tools/rig/build-ui.mjs): App
//      settings › Providers › Language Server shows both servers, and Add
//      server opens the preset form (screenshots in the evidence folder).
// The follow-ups (coordinator rulings 2026-10-10):
//   1b. "Create a 64K version of this model": only on request, the server
//      makes <model>-64k (Ollama's POST /api/create, from the model, num_ctx
//      65536), from the add form's address or a stored server; with the UI,
//      a real click in the add form does it, and the form then picks the
//      version instead of the original; nothing else ever creates one;
//   4b. Codex's model catalog: the engine writes one per server, the
//      installed Codex checks it, and Codex sends the catalog's instructions
//      with hosted web search off; run directly, the same Codex warns
//      "model metadata not found" without the catalog and not with it;
//   5c. a layout saved from this org (language-server agents) is a usable
//      template whose preview plans those slots on their tiers.
// The GPU spike's rulings (coordinator, 2026-10-10 07:12Z):
//   7. Codex's first turn on a new thread records every call's tokens (the
//      sums the server reported, not only the last call's); the llama.cpp
//      preset offers Codex; a window under 64K is "too small for an agent".
// The user's reports on 4.2.0-alpha.1 (coordinator rulings 2026-10-10 08:17-08:43Z):
//   8a. the Ollama preset's help names OLLAMA_LOAD_TIMEOUT and the CUDA-to-Vulkan fallback;
//   8b. a language-server chip's letter comes from its model, its name says model and server;
//       with the UI: the canvas chips (tooltips), and Quick chat's model menu takes a newly
//       offered model without a reload;
//   8c. a seat price per server: 1 by default, a new price moves the live seats on its
//       models, 0 is allowed, the old flat 0.10 becomes the price when the engine starts;
//   8d. a move to a model on a server with the other harness starts a fresh session;
//   8e. Ollama loads the model before the CLI starts: /api/ps, then a load-only request
//       that waits out the whole load (--load-ms, 45 s by default; over 6 minutes for the
//       hand-in), "loading model on <server>" on the desk meanwhile, then Claude Code; a
//       load that fails fails the turn with Ollama's own words, once, and tells the user.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/langserver-lane.mjs [--ui <dir>] [--load-ms N]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { startFakeLlm } from '../fakellm.mjs'
import { REPO, RIG_DIR, cleanEnv } from '../lib.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const MODEL = 'fake-model:latest'
/** a second model on the fake server: no 64K window and no version of its own */
const OTHER = 'other-model:7b'

/** The run's own Codex, outside the engine, against the fake server: one
 *  `codex exec` turn, with or without a model catalog. Its home and work
 *  folder are the proof's; only the loopback fake is ever asked. */
async function codexDirect(rig, p, llm, { catalog, token }) {
  const root = path.join(p.dir, `codex-direct-${catalog ? 'catalog' : 'none'}`)
  for (const d of ['home', 'codex-home', 'work']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const env = { ...cleanEnv() }
  for (const k of Object.keys(env)) if (/^(ORGTREE_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|OPENROUTER_)/i.test(k)) delete env[k]
  Object.assign(env, { USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex-home'),
    ORGTREE_LANGSERVER_KEY: 'orgtree-local' })
  const q = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const args = [
    '-c', `model_provider=${q('orgtree_langserver')}`, '-c', `model_providers.orgtree_langserver.name=${q('Language Server')}`,
    '-c', `model_providers.orgtree_langserver.base_url=${q(`${llm.url}/v1`)}`,
    '-c', `model_providers.orgtree_langserver.env_key=${q('ORGTREE_LANGSERVER_KEY')}`,
    '-c', `model_providers.orgtree_langserver.wire_api=${q('responses')}`, '-c', `model=${q(MODEL)}`,
    '-c', 'model_context_window=65536', '-c', `web_search=${q('disabled')}`,
    ...(catalog ? ['-c', `model_catalog_json=${q(catalog)}`] : []),
    'exec', '--json', '--skip-git-repo-check', `${token}: answer in one word.`,
  ]
  const exe = path.join(rig.run.dir, 'bin', 'codex.exe')
  const out = await new Promise(resolve => {
    const c = spawn(exe, args, { cwd: path.join(root, 'work'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = '', e = ''
    c.stdout.on('data', d => { o += d })
    c.stderr.on('data', d => { e += d })
    const t = setTimeout(() => c.kill(), 120000)
    c.on('close', code => { clearTimeout(t); resolve({ code, out: o, err: e }) })
  })
  fs.writeFileSync(path.join(root, 'exec.jsonl'), out.out)
  const events = out.out.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const warnings = events.filter(ev => ev.item?.type === 'error' || ev.type === 'error').map(ev => String(ev.item?.message ?? ev.message ?? ''))
  const req = llm.requests.find(r => r.path === '/v1/responses' && (r.last_user ?? '').includes(token))
  return { code: out.code, warnings, metadataWarning: warnings.some(w => /metadata/i.test(w)), instructions_chars: req?.instructions_chars ?? null,
    tool_types: req?.tool_types ?? null, stderr: out.err.slice(0, 400) }
}

export async function setup() {
  return { name: 'langserver', 'real-cli': true, fixture: 'none' }
}

export default async function (rig, { flags = {} } = {}) {
  const p = new Proof('langserver-lane')
  const llm = await startFakeLlm({
    log: path.join(p.dir, 'fakellm.jsonl'),
    bodies: path.join(p.dir, 'bodies'),
    models: [{ name: MODEL, context: 131072, running: 65536 }, { name: OTHER, context: 131072 }],
    rules: [
      { match: ['PROOF-LS-CLAUDE'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-CLAUDE-DONE' } },
      { match: ['PROOF-LS-CODEX'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-CODEX-DONE' } },
      // a slow server: every answer to these waits 4 s
      { match: ['PROOF-LS-SLOW'], text: 'slow answer', delay_ms: 4000 },
      // 8e: turns on a model that must be loaded first (the second turn's token first: rules match substrings)
      { match: ['PROOF-LS-WARM2'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-WARM2-DONE' } },
      { match: ['PROOF-LS-WARM'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-WARM-DONE' } },
      { match: ['PROOF-LS-BROKEN'], tool: 'orgtree_status', input: { status: 'done', summary: 'PROOF-LS-BROKEN-DONE' } },
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

    // ------------------------------------------------------------ 1b. a 64K version, only on request
    const VERSION = `${MODEL}-64k`
    p.check('before anything is asked of it, the server was never told to create a model', !llm.requests.some(r => r.path === '/api/create'),
      llm.requests.map(r => r.path))
    const made = await rig.api('POST', '/api/langservers/ollama-variant', { address: llm.url, model: MODEL })
    const found = id => (made.probe?.models ?? []).find(m => m.id === id)
    p.check('"Create a 64K version" from the add form: the server makes <model>-64k, and the models found again show its 64K Modelfile window',
      made.created === VERSION && made.context === 65536 && found(VERSION)?.configured_context === 65536
      && found(MODEL) && found(MODEL).configured_context == null, made)

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
    p.check('the providers payload carries the lane with both tiers, hireable, at the default seat price of 1', entry?.hire_enabled === true
      && [tierA, tierB].every(t => entry.tiers.some(x => x.tier === t && x.seat === 1)) && a.server?.seat === 1 && b.server?.seat === 1, entry)
    // a server card's button: the stored server's own address
    const made2 = await rig.api('POST', '/api/langservers/ollama-variant', { server: a.server?.id, model: MODEL })
    p.check('"Create a 64K version" on a stored Ollama server uses that server', made2.created === VERSION && made2.probe?.reachable === true, made2)

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

    // ------------------------------------------------------------ 4b. Codex knows the model: the server's catalog
    const catDir = path.join(rig.run.data, 'profiles', 'langserver-codex', 'catalogs')
    const catFiles = fs.existsSync(catDir) ? fs.readdirSync(catDir) : []
    const catName = catFiles.find(f => new RegExp(`^${b.server?.id}-[0-9a-f]{12}\\.json$`).test(f))
    const catPath = catName ? path.join(catDir, catName) : null
    const cat = catPath ? JSON.parse(fs.readFileSync(catPath, 'utf8')) : null
    const checked = !!catName && catFiles.some(f => f.startsWith(catName.replace(/json$/, '')) && f.endsWith('.ok'))
    const entry0 = cat?.models?.[0]
    p.check('the Codex server\'s model catalog is written, checked by the installed Codex, and names the model with its window',
      checked && entry0?.slug === MODEL && entry0?.context_window === 65536 && cat.models.length === 1,
      { catFiles, entry: entry0 && { ...entry0, base_instructions: `<${String(entry0.base_instructions).length} chars>` } })
    const prompt = fs.readFileSync(path.join(REPO, 'engine', 'rs', 'orgtree-engine', 'assets', 'codex-default-instructions.md'), 'utf8')
      .replace(/\r\n/g, '\n')
    p.check('Codex ran with it: its instructions are the catalog\'s (Codex\'s own default prompt), and hosted web search is off',
      !!x0 && x0.instructions_chars === prompt.length && Array.isArray(x0.tool_types) && !x0.tool_types.some(t => t.startsWith('web_search')),
      x0 && { instructions_chars: x0.instructions_chars, want: prompt.length, tool_types: x0.tool_types })
    // the same Codex, run directly: the warning without the catalog, none with it
    const bare = await codexDirect(rig, p, llm, { catalog: null, token: 'PROOF-LS-DIRECT-BARE' })
    const withCat = catPath ? await codexDirect(rig, p, llm, { catalog: catPath, token: 'PROOF-LS-DIRECT-CATALOG' }) : null
    p.check('run directly, the same Codex warns "model metadata not found" without the catalog and not with it, and asks for the same tools',
      bare.code === 0 && bare.metadataWarning && withCat?.code === 0 && !withCat.metadataWarning
      && JSON.stringify(bare.tool_types) === JSON.stringify(withCat.tool_types), { bare, withCat })

    // ------------------------------------------------------------ 5. nothing billed
    const turns = rig.sql(`SELECT a.name, t.cost_usd::float8 AS cost, t.cost_source FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
                           WHERE a.name IN ('lsclaude', 'lscodex') AND t.ended_at IS NOT NULL`)
    p.check('every finished turn costs 0 and says local', turns.length >= 2 && turns.every(t => t.cost === 0 && t.cost_source === 'local'), turns)
    // ------------------------------------------------------------ 5b. the agents-at-once cap
    await rig.op({ op: 'hire', name: 'lsclaude2', tier: tierA, grant: 1, title: 'second agent on the one-at-a-time server' })
    const open = () => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0
    await rig.waitFor(open, { what: 'turns to settle before the cap check', timeout: 120000 })
    const window = async (names, token) => {
      // (not `AS t`: the rig wraps every query as a subquery named t)
      const t0 = rig.one(`SELECT now()::text AS at`).at
      await Promise.all(names.map(n => rig.userMail(n, `${token}: answer in one word.`)))
      const done = () => {
        const rows = rig.sql(`SELECT a.name, extract(epoch FROM t.started_at)::float8 AS s, extract(epoch FROM t.ended_at)::float8 AS e FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
                              WHERE a.name IN (${names.map(n => `'${n}'`).join(',')}) AND t.started_at >= '${t0}' ORDER BY t.started_at`)
        return names.every(n => rows.some(r => r.name === n && r.e)) ? rows : null
      }
      return rig.waitFor(done, { what: `${names.join(' and ')} to finish a slow turn each`, timeout: 240000 }).catch(() => null)
    }
    const overlap = rows => !!rows && rows.length >= 2 && rows[1].s < rows[0].e
    const capped = await window(['lsclaude', 'lsclaude2'], 'PROOF-LS-SLOW one')
    p.check('two agents on a server that takes one agent at a time take turns (no overlap)', !!capped && !overlap(capped), capped)
    await rig.waitFor(open, { what: 'turns to settle before the control', timeout: 120000 })
    const apart = await window(['lsclaude', 'lscodex'], 'PROOF-LS-SLOW two')
    p.check('control: agents on two different servers run at the same time', overlap(apart), apart)

    const c1 = claudeReq[0], x1 = codexReq[0]
    p.note(`prompt sizes: Claude Code ${c1?.body_chars ?? '?'} chars (system ${c1?.system_chars ?? '?'}, ${c1?.tools ?? '?'} tools), `
      + `Codex ${x1?.body_chars ?? '?'} chars (instructions ${x1?.instructions_chars ?? '?'}, ${x1?.tools ?? '?'} tools)`)

    // ------------------------------------------------------------ 5c. a template with language-server agents
    const slug = rig.one(`SELECT slug FROM ot.orgs ORDER BY id DESC LIMIT 1`)?.slug
    const saved = await rig.api('POST', `/api/orgs/${slug}/template`, { name: 'LS proof layout' }).catch(e => ({ error: String(e) }))
    const all = await rig.api('GET', '/api/templates')
    const tpl = (all.templates ?? []).find(t => t.id === 'ls-proof-layout')
    p.check('a layout saved from this org (its agents on language servers) is a usable template, not "unknown tier"',
      !!tpl && Array.isArray(tpl.problems) && tpl.problems.length === 0, { saved, tpl })
    const plan = await rig.api('POST', '/api/templates/resolve', { id: 'ls-proof-layout', name: 'LS copy', dirs: [] }).catch(e => ({ error: String(e) }))
    const lsRows = (plan.agents ?? []).filter(x => /^ls-/.test(x.tier ?? ''))
    p.check('its preview plans every slot on its language-server tier, billing no account, and offers the lane\'s tiers',
      plan.ok === true && lsRows.length === (plan.agents ?? []).length && lsRows.length >= 3
      && lsRows.every(x => x.account === null && x.provider === 'langserver' && !x.blocked)
      && (plan.offered ?? []).some(o => o.provider === 'langserver' && o.tier === tierB), plan)

    // ------------------------------------------------------------ 6. what the user sees
    let clicks = 2
    if (rig.run.ui) {
      const seen = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'langserver-settings.cjs'),
        { preset: 'tall', args: { agent: 'lsclaude', shot: 'langserver', address: llm.url }, out: path.join(p.dir, 'desktop') })
      const v = seen.value ?? {}
      p.check('App settings shows the Language Server section with both servers and their models', seen.ok
        && /Language Server/.test(v.before?.head ?? '') && (v.before?.servers ?? []).length === 2
        && (v.before?.servers ?? []).every(s => s.models.some(m => m.includes('fake-model:latest'))), v.before ?? seen)
      p.check('Add server opens the preset form: the five presets, both harnesses offered for Ollama', seen.ok
        && ['Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'Custom…'].every(x => (v.after?.presets ?? []).includes(x))
        && (v.after?.harnesses ?? []).filter(h => !h.disabled).length === 2, v.after ?? seen)
      const row = (rows, id) => (rows ?? []).find(r => r.id === id)
      const offer = row(v.found, OTHER)
      p.check('Find models: a model without a 64K window offers "Create a 64K version of this model" and says what it adds to Ollama; '
        + 'a model with its 64K version does not', seen.ok && offer?.button === 'Create a 64K version of this model'
        && /adds other-model:7b-64k to your Ollama/.test(offer?.hint ?? '') && row(v.found, MODEL) && !row(v.found, MODEL).button
        && /Modelfile sets 64K/.test(row(v.found, VERSION)?.facts ?? ''), v.found ?? seen)
      p.check('clicking it makes the version on the server, and the form picks the version instead of the original',
        seen.ok && row(v.made, `${OTHER}-64k`)?.picked === true && row(v.made, OTHER)?.picked === false
        && llm.requests.some(r => r.path === '/api/create' && r.from === OTHER && r.model === `${OTHER}-64k`), v.made ?? seen)
      clicks += 1
      // the lane colour per theme (coordinator ruling: the gold, if its contrast passes in both);
      // the bundle's CSS is minified, so #ffffff may read #fff
      const hex6 = s => String(s ?? '').toLowerCase().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3')
      p.check('the lane accent is the gold on the dark theme and the deep gold on the light one, its ink dark and white; the tier colour stays gold',
        seen.ok && hex6(v.dark?.accent) === '#cda206' && hex6(v.dark?.ink) === '#17191d' && hex6(v.light?.accent) === '#4d3a02'
        && hex6(v.light?.ink) === '#ffffff' && hex6(v.dark?.tier) === '#cda206' && hex6(v.light?.tier) === '#cda206',
        { dark: v.dark, light: v.light })
      // every tier chip is grey on a dark backing in the light themes (styles.css); this lane's too
      p.check('on the light theme a language-server tier chip gets the dark backing every tier chip gets',
        seen.ok && v.chip?.background === 'rgb(49, 49, 49)', v.chip ?? seen)
    } else {
      p.note('no renderer bundle for this run (--ui): the settings screenshots were skipped')
    }
    const creates = llm.requests.filter(r => r.path === '/api/create')
    p.check(`nothing else ever asked the server to create a model: ${clicks} requests, one per request made`,
      creates.length === clicks && creates.every(c => c.parameters?.num_ctx === 65536 && c.stream === false && c.model === `${c.from}-64k`), creates)

    // ------------------------------------------------------------ 7. the GPU spike's rulings (coordinator, 2026-10-10 07:12Z)
    // Codex counts tokens for its whole thread; the first turn of a new thread
    // is every call that turn made (the engine used to keep only the last):
    // the turn's tokens are the sums of the usage the server reported to it
    const first = rig.one(`SELECT t.input_tokens::int8 AS input, t.cache_read::int8 AS cached, t.toks::int8 AS toks,
                                  extract(epoch FROM t.started_at)::float8 AS s, extract(epoch FROM t.ended_at)::float8 AS e
                             FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = 'lscodex' ORDER BY t.id LIMIT 1`)
    const served = codexReq.filter(r => first && Date.parse(r.at) / 1000 >= first.s && Date.parse(r.at) / 1000 <= first.e)
    const sum = k => served.reduce((n, r) => n + (r[k] ?? 0), 0)
    p.check('Codex\'s first turn on a new thread records every call it made: its tokens are the sums the server reported',
      served.length >= 2 && Number(first.input) + Number(first.cached) === sum('usage_in') && Number(first.toks) === sum('usage_out'),
      { turn: first, calls: served.length, server_in: sum('usage_in'), server_out: sum('usage_out') })
    // llama.cpp serves Codex too (measured on b11540), and the window floor is 64K
    const lsDoc = await rig.api('GET', '/api/langservers')
    const llama = (lsDoc.presets ?? []).find(x => x.id === 'llamacpp')
    p.check('the llama.cpp preset offers Codex too, and its note says Codex was tested with b11540',
      llama?.codex === true && (llama.harnesses ?? []).find(h => h.id === 'codex-cli')?.available === true && /b11540/.test(llama.note ?? ''), llama)
    const lc = await rig.api('POST', '/api/langservers', { preset: 'llamacpp', address: llm.url, harness: 'codex-cli', label: 'llama.cpp (Codex)',
      models: [{ id: MODEL, context: 49152 }, { id: OTHER, context: 65536 }] })
    const lcModels = lc.server?.models ?? {}
    const lcRow = (lc.doc?.servers ?? []).find(s => s.id === lc.server?.id)
    p.check('a llama.cpp server takes Codex (its base ends in /v1), and below 64K a window is "too small for an agent"',
      lc.doc?.min_context === 65536 && lcRow?.base_url === `${llm.url}/v1` && lcRow?.models?.[MODEL]?.too_small === true
      && lcRow?.models?.[OTHER]?.too_small === false && Object.keys(lcModels).length === 2,
      { min_context: lc.doc?.min_context, server: lcRow && { base_url: lcRow.base_url, models: lcRow.models } })
    await rig.api('DELETE', `/api/langservers/${lc.server?.id}`)

    // ------------------------------------------------------------ 8. the user's reports on 4.2.0-alpha.1 (coordinator, 2026-10-10)
    // 8a. the preset help for slow loads
    const lsDoc8 = await rig.api('GET', '/api/langservers')
    const ollamaNote = (lsDoc8.presets ?? []).find(x => x.id === 'ollama')?.note ?? ''
    p.check('8a. the Ollama preset\'s help names OLLAMA_LOAD_TIMEOUT=30m for a slow disk and the fall back from CUDA to Vulkan',
      /OLLAMA_LOAD_TIMEOUT=30m/.test(ollamaNote) && /5 minutes/.test(ollamaNote) && /CUDA/.test(ollamaNote) && /Vulkan/.test(ollamaNote), ollamaNote)

    // 8b. chip letters from the model: a second model on the Claude Code server
    const withOther = await rig.api('PATCH', `/api/langservers/${a.server?.id}`, { models: [{ id: OTHER, offered: true, context: 65536 }] })
    const tierO = withOther.server?.models?.[OTHER]?.tier
    const lsTierRows = async () => ((await rig.api('GET', '/api/providers')).providers ?? []).find(x => x.id === 'langserver')?.tiers ?? []
    const rows8 = await lsTierRows()
    const row8 = t => rows8.find(x => x.tier === t)
    p.check('8b. a language-server tier\'s chip letter comes from its model (fake-model F, other-model O), never the lane\'s L; its name says model and server',
      row8(tierA)?.letter === 'F' && row8(tierB)?.letter === 'F' && row8(tierO)?.letter === 'O' && !rows8.some(x => x.letter === 'L')
      && row8(tierO)?.name === `${OTHER} · Fake (Claude Code)`, rows8.map(x => ({ tier: x.tier, letter: x.letter, name: x.name, seat: x.seat })))

    // 8c. a seat price per server
    const seatOf = n => Number(rig.one(`SELECT seat::float8 AS seat FROM ot.agents WHERE name = '${n}' AND state = 'live'`)?.seat)
    const seats = () => Object.fromEntries(['lsclaude', 'lsclaude2', 'lscodex'].map(n => [n, seatOf(n)]))
    const reprices = () => rig.sql(`SELECT detail FROM ot.events WHERE op = 'reprice' ORDER BY id`).map(r => r.detail)
    const s0 = seats()
    const up = await rig.api('PATCH', `/api/langservers/${a.server?.id}`, { seat: 2 })
    const s1 = seats()
    const moved = (up.repriced ?? []).flatMap(o => o.repriced ?? [])
    const tierAseat = (await lsTierRows()).find(x => x.tier === tierA)?.seat
    p.check('8c. agents on a new server\'s models sit at the default 1; a price of 2 on the Claude Code server moves the live seats on its models to 2 (an org-log event each), the Codex server\'s stay at 1',
      Object.values(s0).every(x => x === 1) && s1.lsclaude === 2 && s1.lsclaude2 === 2 && s1.lscodex === 1 && tierAseat === 2
      && moved.length === 2 && moved.every(r => r.from === 1 && r.to === 2) && reprices().length === 2,
      { before: s0, after: s1, tier_seat: tierAseat, repriced: up.repriced, events: reprices() })
    const zero = await rig.api('PATCH', `/api/langservers/${a.server?.id}`, { seat: 0 })
    const s2 = seats()
    const refused = []
    for (const bad of [101, -1]) refused.push(await rig.api('PATCH', `/api/langservers/${a.server?.id}`, { seat: bad }).then(() => 'accepted', e => e.status))
    p.check('8c. 0 is a valid price (the seats on that server\'s models drop to 0); a price outside 0 to 100 is refused',
      s2.lsclaude === 0 && s2.lsclaude2 === 0 && s2.lscodex === 1 && refused.every(s => s === 400), { after: s2, refused, repriced: zero.repriced })
    // 4.2.0-alpha.1 priced every language-server seat at a flat 0.10: the first start moves them to their server's price
    rig.exec(`UPDATE ot.agents SET seat = 0.1 WHERE name = 'lscodex' AND state = 'live'`)
    await rig.restart()
    const s3 = await rig.waitFor(() => (seatOf('lscodex') === 1 ? seats() : null), { what: 'the start-up reprice of lscodex', timeout: 90000, every: 1000 })
      .catch(() => seats())
    const fromOld = reprices().filter(d => Number(d.seat_old) === 0.1)
    p.check('8c. an agent at the old flat 0.10 is moved to its server\'s price (the default 1) when the engine starts',
      s3.lscodex === 1 && fromOld.length === 1 && fromOld[0].node === 'lscodex' && fromOld[0].seat === 1, { after: s3, events: fromOld })

    // 8d. a move across harnesses starts a fresh session; across servers on one harness it does not
    await rig.op({ op: 'hire', name: 'lscross', tier: tierA, grant: 1, title: 'moves to the other harness' })
    await rig.op({ op: 'hire', name: 'lssame', tier: tierA, grant: 1, title: 'moves to another server on its harness' })
    rig.exec(`UPDATE ot.agents SET session_id = 'proof-session-cross' WHERE name = 'lscross' AND state = 'live';
              UPDATE ot.agents SET session_id = 'proof-session-same' WHERE name = 'lssame' AND state = 'live'`)
    const c3 = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'claude-code',
      label: 'Fake 3 (Claude Code)', models: [{ id: OTHER, context: 65536 }] })
    const tierC = Object.values(c3.server?.models ?? {})[0]?.tier
    const cross = await rig.op({ op: 'switch_model', node: 'lscross', tier: tierB })
    const same = await rig.op({ op: 'switch_model', node: 'lssame', tier: tierC })
    const rc = rig.agentRow('lscross'), rsame = rig.agentRow('lssame')
    p.check('8d. a move from a Claude Code server\'s model to a Codex server\'s model starts a fresh session (a summary first), restamps the harness and says so',
      rc?.session_id === null && rc?.extra?.harness === 'codex-cli' && !!rc?.extra?.handoff_due
      && /moved from Claude Code to Codex: it continues on a fresh session/.test(JSON.stringify(cross)),
      { op: cross, session_id: rc?.session_id, harness: rc?.extra?.harness, handoff_due: rc?.extra?.handoff_due })
    p.check('8d. control: a move between two servers on one harness keeps the session, with no such warning',
      rsame?.session_id === 'proof-session-same' && rsame?.extra?.harness === 'claude-code' && !/fresh session/.test(JSON.stringify(same)),
      { op: same, session_id: rsame?.session_id, harness: rsame?.extra?.harness })

    // 8b with the UI: the chips on the canvas, and Quick chat's model menu taking a newly offered model live
    if (rig.run.ui) {
      const THIRD = 'third-model:3b'
      llm.add({ name: THIRD, context: 131072, num_ctx: 65536 })
      const out = path.join(p.dir, 'desktop-batch1')
      const ui = runDesktop(rig, path.join(RIG_DIR, 'desktop', 'langserver-batch1.cjs'),
        { preset: 'tall', args: { mode: 'chips', agents: ['lsclaude', 'lssame', 'lscodex'], want: THIRD }, out })
      const ready = await rig.waitFor(() => fs.existsSync(path.join(out, 'quickchat-before.png')),
        { what: 'Quick chat\'s first menu', timeout: 120000, every: 500 }).catch(() => false)
      if (ready) await rig.api('PATCH', `/api/langservers/${a.server?.id}`, { models: [{ id: THIRD, offered: true, context: 65536 }] })
      const seen = await ui
      const v = seen.value ?? {}
      const chip = n => v.chips?.[n]
      p.check('8b. the canvas chips: F for fake-model, O for other-model, in the lane\'s gold, each with a tooltip naming model and server',
        seen.ok && chip('lsclaude')?.letter === 'F' && chip('lssame')?.letter === 'O' && chip('lscodex')?.letter === 'F'
        && chip('lsclaude')?.title === `${MODEL} · Fake (Claude Code)` && chip('lssame')?.title === `${OTHER} · Fake 3 (Claude Code)`
        && chip('lscodex')?.title === `${MODEL} · Fake (Codex)`
        && ['lsclaude', 'lssame'].every(n => [chip(n)?.color, chip(n)?.background].some(c => /^rgba?\(205, 162, 6\b/.test(c ?? ''))),
        v.chips ?? seen)
      p.check('8b. Quick chat\'s model menu lists a model the moment a server offers it, in the same page (no reload)',
        seen.ok && Array.isArray(v.before) && !v.before.some(i => i.includes(THIRD)) && Array.isArray(v.after)
        && v.after.some(i => i.includes(THIRD)) && v.samePage === true && v.waited_ms < 30000,
        { before: v.before, after: v.after, waited_ms: v.waited_ms, samePage: v.samePage, error: seen.error ?? null })
    } else {
      p.note('no renderer bundle for this run (--ui): 8b\'s canvas chips and Quick chat menu were skipped')
    }

    // 8e. Ollama loads the model before the CLI starts
    const LOAD_MS = Number(flags['load-ms'] ?? 45000)
    const SLOW = 'slow-model:latest', BROKEN = 'broken-model:latest'
    const OOM = 'model requires more system memory (18.6 GiB) than is available (11.2 GiB)'
    llm.add({ name: SLOW, context: 131072, num_ctx: 65536, load_ms: LOAD_MS })
    llm.add({ name: BROKEN, context: 131072, num_ctx: 65536, load_ms: 1500, load_error: OOM })
    const dsv = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'claude-code',
      label: 'Fake slow (Claude Code)', models: [{ id: SLOW, context: 65536 }, { id: BROKEN, context: 65536 }] })
    const tierS = dsv.server?.models?.[SLOW]?.tier, tierK = dsv.server?.models?.[BROKEN]?.tier
    await rig.op({ op: 'hire', name: 'lsslow', tier: tierS, grant: 1, title: 'a model that loads slowly' })
    await rig.op({ op: 'hire', name: 'lsbroken', tier: tierK, grant: 1, title: 'a model that cannot load' })
    const detail = n => rig.api('GET', `/api/orgs/${rig.org}/nodes/${n}/detail`).catch(() => null)
    const turnOver = n => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.name = '${n}' AND t.ended_at IS NULL`).length === 0, { what: `${n}'s turn to end`, timeout: 120000 }).catch(() => null)
    const at = r => (r ? Date.parse(r.at) : NaN)
    const brief = rs => rs.map(r => `${r.at.slice(11, 23)} ${r.path} ${r.phase ?? ''} ${r.model ?? (r.loaded ?? []).join(',')}`.trim())
    const mark = llm.requests.length
    await rig.userMail('lsslow', 'PROOF-LS-WARM: report done with orgtree_status.')
    const loadingSeen = await rig.waitFor(async () => (await detail('lsslow'))?.loading_model ?? null,
      { what: 'lsslow\'s desk to say its model is loading', timeout: 60000, every: 300 }).catch(() => null)
    const desk = rig.run.ui ? await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'langserver-batch1.cjs'),
      { preset: 'tall', args: { mode: 'loading', agent: 'lsslow' }, out: path.join(p.dir, 'desktop-loading') }) : null
    const stS = await rig.waitFor(() => (status('lsslow')?.summary === 'PROOF-LS-WARM-DONE' ? status('lsslow') : null),
      { what: 'lsslow\'s done report after the slow load', timeout: LOAD_MS + 240000, every: 2000 }).catch(() => null)
    await turnOver('lsslow')
    const seen1 = llm.requests.slice(mark)
    const ps1 = seen1.find(r => r.path === '/api/ps')
    const g0 = seen1.find(r => r.path === '/api/generate' && r.phase === 'start' && r.model === SLOW)
    const g1 = seen1.find(r => r.path === '/api/generate' && r.phase === 'loaded' && r.model === SLOW)
    const m1 = seen1.find(r => r.path === '/v1/messages' && r.model === SLOW)
    const loadS = (at(g1) - at(g0)) / 1000
    p.file('warmup-requests.json', seen1)
    p.check(`8e. on Ollama /api/ps shows the model not loaded, a load-only request (empty prompt, no stream, no options) waits out the whole ${Math.round(LOAD_MS / 1000)} s load, and Claude Code's first request comes after it`,
      !!ps1 && !ps1.loaded.includes(SLOW) && at(ps1) <= at(g0) && g0?.prompt_chars === 0 && g0?.stream === false
      && JSON.stringify(g0?.keys) === JSON.stringify(['model', 'prompt', 'stream']) && loadS >= LOAD_MS / 1000 - 1 && !!m1 && at(m1) >= at(g1),
      { load_s: loadS, order: brief(seen1.filter(r => r.path !== '/v1/messages' || r === m1)) })
    const after8 = await detail('lsslow')
    p.check('8e. while it loaded the desk said "loading model on Fake slow (Claude Code)"; the turn then finished and the words are gone',
      loadingSeen === 'loading model on Fake slow (Claude Code)' && stS?.summary === 'PROOF-LS-WARM-DONE' && (after8?.loading_model ?? null) === null,
      { loadingSeen, status: stS, after: after8?.loading_model ?? null })
    if (rig.run.ui) {
      p.check('8e. the desk shows the loading banner (screenshot desk-loading-model.png)', !!desk?.ok
        && /^Loading model on Fake slow \(Claude Code\): the turn starts as soon as the model is in memory/.test(desk.value?.banner ?? ''),
        desk?.value ?? desk)
    }
    const mark2 = llm.requests.length
    await rig.userMail('lsslow', 'PROOF-LS-WARM2: report done with orgtree_status.')
    await rig.waitFor(() => (status('lsslow')?.summary === 'PROOF-LS-WARM2-DONE' ? true : null),
      { what: 'lsslow\'s second turn', timeout: 180000, every: 1000 }).catch(() => null)
    await turnOver('lsslow')
    const seen2 = llm.requests.slice(mark2)
    p.check('8e. the next turn finds the model in memory (/api/ps lists it) and loads nothing',
      seen2.some(r => r.path === '/api/ps' && r.loaded.includes(SLOW)) && !seen2.some(r => r.path === '/api/generate')
      && seen2.some(r => r.path === '/v1/messages' && r.model === SLOW), brief(seen2.filter(r => r.path !== '/v1/messages').concat(seen2.filter(r => r.path === '/v1/messages').slice(0, 1))))
    // a load that fails
    const mark3 = llm.requests.length
    await rig.userMail('lsbroken', 'PROOF-LS-BROKEN: report done with orgtree_status.')
    const errK = await rig.waitFor(() => { const e = rig.agentRow('lsbroken')?.last_error; return e && /could not load/.test(e) ? e : null },
      { what: 'lsbroken\'s failed load', timeout: 90000, every: 500 }).catch(() => null)
    await new Promise(r => setTimeout(r, 10000))
    const seen3 = llm.requests.slice(mark3)
    const told = rig.sql(`SELECT body FROM ot.mail WHERE body LIKE 'lsbroken''s turn could not start:%' ORDER BY id`)
    p.check('8e. a load that fails fails the turn with Ollama\'s own words, is not retried, tells the user, and the CLI never asks for the model',
      errK === `Ollama could not load ${BROKEN}: ${OOM}` && seen3.filter(r => r.path === '/api/generate' && r.phase === 'start' && r.model === BROKEN).length === 1
      && seen3.some(r => r.path === '/api/generate' && r.phase === 'failed') && !seen3.some(r => r.path === '/v1/messages' && r.model === BROKEN)
      && told.length === 1 && told[0].body.includes(OOM) && rig.turns('lsbroken').length === 0,
      { last_error: errK, requests: brief(seen3), told, turns: rig.turns('lsbroken') })
    p.keep(rig, { grep: /langserver|ls-ollama|lsclaude|lscodex|lsslow|lsbroken|lscross|lssame|language-server|reprice/ })
  } finally {
    await llm.close()
  }
  return p.summary()
}
