// Spike: the Language Server lane against a REAL local model server (not a
// proof of the regular set: it needs a running server and a GPU). The run's
// agents are the installed Claude Code and Codex (`--real-cli`, their home the
// run's fake one); each gets one small docket ticket, one after the other
// (one server slot: two agents at once would evict each other's prompt cache).
// Measured per agent: the ticket's outcome (item status, evidence, the files,
// the script's real output), the turn (time, tokens, errors), every tool call
// in its transcript, and, from the server's own log, each request's new
// prompt tokens, context in use, prefill and generation speed.
//   node tools/rig/rig.mjs run tools/rig/proofs/langserver-real.mjs --url http://127.0.0.1:9931
//        --model qwen3.6-35b-a3b --ctx 131072 --server-log <llama-server stderr log> [--only claude|codex]
//        [--preset llamacpp] [--codex-preset custom --codex-base-path v1]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { name: 'langserver-real', 'real-cli': true, fixture: 'none' }
}

const CHARTER = 'You are a developer in this test org. You own the docket items assigned to you: do the work in your working folder, '
  + 'record evidence on the item, keep its status true, and report with orgtree_status when you finish.'

const ticket = who => ({
  title: `Word counter script (${who})`,
  objective: 'The team has no quick way to count the words in a text file, so write a small Node script for it.\n\n'
    + '- In your working folder, create `wordcount.js`: it reads the file named by its first command-line argument and prints '
    + 'the number of words in it (words are separated by whitespace).\n'
    + '- Create `sample.txt` in the same folder containing exactly: the quick brown fox jumps over the lazy dog\n'
    + '- Run `node wordcount.js sample.txt`. It must print 9.\n'
    + '- Add the command and its output to this item as evidence (kind log), then set this item\'s status to done.',
})

/** llama-server's per-request timing lines in a slice of its log. */
function serverRequests(text) {
  const out = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/task (\d+) \| prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/)
    if (m) { cur = { task: +m[1], prompt_ms: +m[2], prompt_tokens: +m[3], prefill_tps: +m[4] }; out.push(cur); continue }
    m = line.match(/task (\d+) \|\s+eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/)
    if (m && cur && cur.task === +m[1]) { Object.assign(cur, { gen_ms: +m[2], gen_tokens: +m[3], gen_tps: +m[4] }); continue }
    m = line.match(/task (\d+) \| stop processing: n_tokens = (\d+), truncated = (\d+)/)
    if (m && cur && cur.task === +m[1]) Object.assign(cur, { n_tokens: +m[2], truncated: +m[3] })
  }
  return out
}

export default async function (rig, { flags }) {
  const p = new Proof('langserver-real')
  const URL_ = flags.url ?? 'http://127.0.0.1:9931'
  const MODEL = flags.model ?? 'qwen3.6-35b-a3b'
  const CTX = Number(flags.ctx ?? 131072)
  const LOG = flags['server-log']
  const only = flags.only
  const results = { url: URL_, model: MODEL, ctx: CTX, agents: {} }
  const save = () => p.file('results.json', results)

  // ------------------------------------------------------------ the probe and the servers
  const probe = await rig.api('POST', '/api/langservers/probe', { preset: flags.preset ?? 'llamacpp', address: URL_, harness: 'claude-code' })
  results.probe = probe
  p.check('the probe reaches the real server and reads its model and window', probe.reachable === true
    && (probe.models ?? []).some(m => m.id === MODEL), probe)
  const a = await rig.api('POST', '/api/langservers', { preset: flags.preset ?? 'llamacpp', address: URL_, harness: 'claude-code',
    label: 'Local (Claude Code)', models: [{ id: MODEL, context: CTX }] })
  const b = await rig.api('POST', '/api/langservers', { preset: flags['codex-preset'] ?? 'custom', address: URL_, harness: 'codex-cli',
    base_path: flags['codex-base-path'] ?? 'v1', label: 'Local (Codex)', models: [{ id: MODEL, context: CTX }] })
  const tierA = Object.values(a.server?.models ?? a.models ?? {})[0]?.tier
  const tierB = Object.values(b.server?.models ?? b.models ?? {})[0]?.tier
  results.servers = { claude: { id: a.server?.id ?? a.id, tier: tierA }, codex: { id: b.server?.id ?? b.id, tier: tierB } }
  save()

  await seed(rig, { org: { name: 'Local Model Spike' }, agents: [
    ...(only === 'codex' ? [] : [{ name: 'lsclaude', tier: tierA, grant: 1, charter: CHARTER }]),
    ...(only === 'claude' ? [] : [{ name: 'lscodex', tier: tierB, grant: 1, charter: CHARTER }]),
  ] })

  const agentId = name => rig.agentRow(name)?.id
  for (const [name, who] of [['lsclaude', 'Claude Code'], ['lscodex', 'Codex']]) {
    if ((only === 'claude' && name !== 'lsclaude') || (only === 'codex' && name !== 'lscodex')) continue
    const r = { harness: who }
    results.agents[name] = r
    const made = await rig.tool(name, 'orgtree_work', { action: 'create', kind: 'code', owner: name, ...ticket(who) })
    const slug = made.json?.slug
    r.slug = slug
    const logStart = LOG && fs.existsSync(LOG) ? fs.statSync(LOG).size : 0
    const t0 = Date.now()
    r.started = new Date(t0).toISOString()
    await rig.userMail(name, `You own docket item \`${slug}\`. Read it with orgtree_work (action get), do it, and report done with orgtree_status.`)
    // the ticket ends when the agent has no turn running for 15 s after at least one finished
    let quietSince = null
    await rig.waitFor(() => {
      const t = rig.turns(name)
      const running = t.some(x => !x.ended_at)
      if (running || !t.some(x => x.ended_at)) { quietSince = null; return null }
      quietSince = quietSince ?? Date.now()
      return Date.now() - quietSince > 15000 ? t : null
    }, { what: `${name} to finish its ticket`, timeout: Number(flags.timeout ?? 25 * 60000), every: 3000 }).catch(e => { r.timeout = e.message })
    r.wall_ms = Date.now() - t0
    const id = agentId(name)
    r.turns = rig.sql(`SELECT id, started_at, ended_at, ms, toks, input_tokens, cache_read, cache_write, cost_usd, cost_source, killed, error, model,
                              denials, approvals FROM ot.turns WHERE agent_id = ${id} ORDER BY id`)
    r.status = rig.one(`SELECT last_status->>'status' AS status, last_status->>'summary' AS summary, last_error FROM ot.agents WHERE id = ${id}`)
    const item = await rig.tool(name, 'orgtree_work', { action: 'get', slug, projection: 'full' })
    r.item = item.json ? { status: item.json.status, done_so_far: item.json.done_so_far, evidence: item.json.evidence } : { text: item.text }
    const convo = rig.sql(`SELECT seq, at, body, tool_inputs FROM ot.convo WHERE agent_id = ${id} ORDER BY seq`)
    p.file(`${name}-convo.json`, convo)
    // the work itself: the agent's folder, and its script run again here
    const scratch = path.join(rig.run.data, 'scratch', rig.org, name)
    r.files = fs.existsSync(scratch) ? fs.readdirSync(scratch).filter(f => !f.startsWith('.')) : []
    const js = path.join(scratch, 'wordcount.js')
    if (fs.existsSync(js)) {
      p.file(`${name}-wordcount.js`, fs.readFileSync(js, 'utf8'))
      const run = spawnSync('node', ['wordcount.js', 'sample.txt'], { cwd: scratch, encoding: 'utf8', timeout: 20000, windowsHide: true })
      r.rerun = { code: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim().slice(0, 300) }
    }
    if (LOG && fs.existsSync(LOG)) {
      const fd = fs.openSync(LOG, 'r')
      const size = fs.statSync(LOG).size
      const buf = Buffer.alloc(size - logStart)
      fs.readSync(fd, buf, 0, buf.length, logStart)
      fs.closeSync(fd)
      p.file(`${name}-server.log`, buf)
      const reqs = serverRequests(buf.toString('utf8'))
      r.server = { requests: reqs.length, new_prompt_tokens: reqs.reduce((s, x) => s + x.prompt_tokens, 0),
        gen_tokens: reqs.reduce((s, x) => s + (x.gen_tokens ?? 0), 0), first: reqs[0] ?? null,
        peak_context: Math.max(0, ...reqs.map(x => x.n_tokens ?? 0)), truncated: reqs.some(x => x.truncated),
        prompt_ms: Math.round(reqs.reduce((s, x) => s + x.prompt_ms, 0)), gen_ms: Math.round(reqs.reduce((s, x) => s + (x.gen_ms ?? 0), 0)) }
      p.file(`${name}-requests.json`, reqs)
    }
    save()
    p.check(`${name} (${who}): the ticket is done, the script prints 9, and the turn cost nothing`,
      r.item.status === 'done' && r.rerun?.out === '9' && r.turns.every(t => Number(t.cost_usd ?? 0) === 0),
      { item: r.item.status, rerun: r.rerun, files: r.files, turns: r.turns.length, timeout: r.timeout })
  }
  save()
  return p.summary()
}
