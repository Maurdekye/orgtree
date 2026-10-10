// tools/rig/fakellm.mjs — a fake language server for rig proofs of the
// Language Server lane: answers like Ollama (model list, metadata, running
// windows) and speaks the two APIs the harnesses need — Anthropic Messages
// (`POST /v1/messages`, Claude Code) and OpenAI Responses (`POST
// /v1/responses`, Codex) — streamed the way the real servers stream them.
// Node built-ins only. No model: each request is answered from a script.
//
//   import { startFakeLlm } from './fakellm.mjs'
//   const llm = await startFakeLlm({ log: 'E:\\…\\fakellm.jsonl', rules: [...] })
//   llm.url            → http://127.0.0.1:<port>
//   llm.requests       → every request seen (path, auth headers, model, tools, …)
//   await llm.close()
//
//   node tools/rig/fakellm.mjs [--port N] [--log file] [--bodies dir]   (prints "listening <url>")
//
// THE SCRIPT. `rules` are tried in order against each inference request;
// the first whose `match` substrings all occur in the request's LAST user
// turn (case-insensitive) answers it. A request whose last user turn carries
// a tool result is answered by the first rule whose `afterCall` substrings
// all occur in the arguments of the call that result answers (Responses
// only), else by `afterTool` (default: the text "Done."); each such request
// logs `tool_call` and `tool_output`, so a script can chain steps:
//   { afterCall: ['STEP-1'], tool: 'exec_command', input: { cmd: 'echo STEP-2' } }
// No rule matches: the text "OK.".
//   { match: ['TOKEN'], tool: 'orgtree_status', input: { status: 'done', summary: '…' } }
//   { match: ['TOKEN'], text: 'Hello' }
//   { match: ['TOKEN'], text: 'Slow', delay_ms: 3000 }   (a slow server: waits before answering)
// `tool` names the orgtree tool; the fake calls it by whatever name the
// harness offered it under (Claude Code: `mcp__orgtree__orgtree_status`).
//
// `bodies: '<dir>'` also writes every inference request's whole body there
// (`<n>-messages.json`, `<n>-responses.json`), for checks on exactly what a
// harness sent. A model's `num_ctx` is the window its Modelfile sets (shown
// by /api/show like Ollama shows it); `POST /api/create` (`from` +
// `parameters`) adds a model the way Ollama does, and is logged.
//
// LOADING. A model with `running` (its window) is in memory, and `/api/ps`
// lists it (each /api/ps is logged with what it listed). `POST /api/generate`
// with no prompt is Ollama's load-only request: it answers once the model is
// loaded, after the model's `load_ms` (an already loaded model answers at
// once), and the model then runs at its `num_ctx` (else 4096); a model with
// `load_error` answers 500 with that text instead, the way Ollama reports a
// load that failed. Both ends of a load are logged (phase start, then loaded
// or failed, or client-gone when the client drops the request first and the
// load is given up). `llm.add({ name, ... })` adds a model while the server runs.
//
// STRICT (`strict: true`): each inference request is first turned into chat
// messages the way a llama.cpp-style server turns it, and refused the way
// Qwen 3.8's and Hugging Face's strict chat templates refuse a conversation:
// a system message after the first ("System message must be at the
// beginning."; each block of an Anthropic `system` array counts as one, the
// strictest reading; a Responses `developer` message is a system message),
// or two turns of one role in a row ("... roles must alternate ..."; a tool
// call is the assistant's side, a tool result the user's). A refusal answers
// 500 with llama.cpp's Jinja words and logs `strict_refused`. A rule with
// `refuse: '<words>'` refuses its request that way whatever the mode.
// Every request logs `auth_sha` (sha256 of its Authorization header, 12 hex).

import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODEL = 'fake-model:latest'
const id = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`

export async function startFakeLlm({ port = 0, log = null, rules = [], afterTool = { text: 'Done.' },
  models = [{ name: MODEL, context: 131072, running: 65536 }], bodies = null, strict = false } = {}) {
  models = models.map((m) => ({ ...m }))
  const requests = []
  const note = (r) => {
    const at = new Date().toISOString()
    requests.push({ at, ...r })
    if (log) fs.appendFileSync(log, JSON.stringify({ at, ...r }) + '\n')
  }
  let bodyCount = 0
  const keepBody = (api, b) => {
    if (!bodies) return null
    fs.mkdirSync(bodies, { recursive: true })
    const file = path.join(bodies, `${String(++bodyCount).padStart(3, '0')}-${api}.json`)
    fs.writeFileSync(file, JSON.stringify(b ?? null, null, 1))
    return path.basename(file)
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = null
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { body = null }
      const url = new URL(req.url ?? '/', 'http://x')
      try {
        route(req, res, url.pathname, body)
      } catch (e) {
        note({ path: url.pathname, method: req.method, error: String(e) })
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
  })

  const json = (res, status, v) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(v))
  }
  const auth = (req) => ({
    authorization: req.headers.authorization ? String(req.headers.authorization).replace(/^(Bearer )(.{0,4}).*$/i, '$1$2…') : null,
    x_api_key: req.headers['x-api-key'] ? '…set…' : null,
    anthropic_version: req.headers['anthropic-version'] ?? null,
    anthropic_beta: req.headers['anthropic-beta'] ?? null,
    auth_sha: req.headers.authorization ? crypto.createHash('sha256').update(String(req.headers.authorization)).digest('hex').slice(0, 12) : null,
  })
  // STRICT (see the header): why a strict template refuses this request, or null
  function strictRefusal(api, b) {
    const turns = []
    if (api === 'messages') {
      for (const _ of Array.isArray(b?.system) ? b.system : (b?.system ? [b.system] : [])) turns.push('system')
      for (const m of b?.messages ?? []) turns.push(m.role === 'developer' ? 'system' : m.role)
    } else {
      if (b?.instructions) turns.push('system')
      for (const it of Array.isArray(b?.input) ? b.input : []) {
        const t = it.type ?? 'message'
        if (t === 'message') turns.push(it.role === 'developer' ? 'system' : it.role)
        else if (t === 'function_call' && turns.at(-1) !== 'call') turns.push('call')
        else if (t === 'function_call_output' && turns.at(-1) !== 'result') turns.push('result')
      }
    }
    if (turns.slice(1).includes('system')) return 'System message must be at the beginning.'
    const side = turns.filter((r) => r !== 'system')
    for (let i = 1; i < side.length; i++) {
      if ((side[i] === 'user' || side[i] === 'assistant') && side[i] === side[i - 1])
        return 'After the optional system message, conversation roles must alternate user/assistant/user/assistant/...'
    }
    return null
  }
  // llama.cpp's answer when the chat template raises
  function refuse(req, res, api, b, why, lastText) {
    note({ path: `/v1/${api}`, method: 'POST', ...auth(req), model: b?.model ?? null, strict_refused: why,
      body_file: keepBody(`${api}-refused`, b), last_user: lastText.slice(-200) })
    const where = 'While executing CallExpression at line 106, column 32 in source:'
    json(res, 500, { error: { code: 500, type: 'server_error',
      message: [where, `...{{- raise_exception('${why}') }}`, `Error: Jinja Exception: ${why}`].join(String.fromCharCode(10)) } })
  }

  function route(req, res, p, body) {
    // ── Ollama's own API: what the lane's probe reads
    if (p === '/api/version') return json(res, 200, { version: '0.40.2-fake' })
    if (p === '/api/tags') {
      note({ path: p, method: req.method })
      return json(res, 200, { models: models.map((m) => ({ name: m.name, model: m.name, size: m.size ?? 1_000_000_000,
        details: { family: m.family ?? 'fake', parameter_size: m.params ?? '1B', quantization_level: m.quant ?? 'Q4_K_M' } })) })
    }
    if (p === '/api/show') {
      const m = models.find((x) => x.name === body?.model)
      if (!m) return json(res, 404, { error: `model '${body?.model}' not found` })
      // Ollama lists a Modelfile's parameters as aligned "name value" lines
      const params = [m.num_ctx ? `num_ctx                        ${m.num_ctx}` : null,
        'stop                           "<|im_end|>"'].filter(Boolean).join('\n')
      return json(res, 200, { model_info: { 'fake.context_length': m.context }, parameters: params,
        capabilities: m.capabilities ?? ['completion', 'tools'] })
    }
    if (p === '/api/create' && req.method === 'POST') {
      note({ path: p, method: req.method, model: body?.model ?? null, from: body?.from ?? null,
        parameters: body?.parameters ?? null, stream: body?.stream ?? null })
      const from = models.find((x) => x.name === body?.from)
      if (!body?.model) return json(res, 400, { error: 'model is required' })
      if (!from) return json(res, 404, { error: `model '${body?.from}' not found` })
      const made = { ...from, name: body.model, running: null, num_ctx: body.parameters?.num_ctx ?? from.num_ctx }
      models = [...models.filter((x) => x.name !== made.name), made]
      return json(res, 200, { status: 'success' })
    }
    if (p === '/api/ps') {
      const loaded = models.filter((m) => m.running)
      note({ path: p, method: req.method, loaded: loaded.map((m) => m.name) })
      return json(res, 200, { models: loaded.map((m) => ({ name: m.name, model: m.name, context_length: m.running })) })
    }
    if (p === '/api/generate' && req.method === 'POST') {
      const m = models.find((x) => x.name === body?.model)
      note({ path: p, method: req.method, phase: 'start', model: body?.model ?? null, prompt_chars: String(body?.prompt ?? '').length,
        stream: body?.stream ?? null, keys: Object.keys(body ?? {}).sort() })
      if (!m) return json(res, 404, { error: `model '${body?.model}' not found, try pulling it first` })
      if (body?.prompt) return json(res, 400, { error: 'this fake server only answers load-only requests on /api/generate' })
      const finish = () => {
        if (m.load_error) {
          note({ path: p, method: req.method, phase: 'failed', model: m.name, error: m.load_error })
          return json(res, 500, { error: m.load_error })
        }
        m.running = m.num_ctx ?? 4096
        note({ path: p, method: req.method, phase: 'loaded', model: m.name, running: m.running })
        return json(res, 200, { model: m.name, created_at: new Date().toISOString(), response: '', done: true, done_reason: 'load' })
      }
      if (m.running && !m.load_error) return finish()
      const timer = setTimeout(finish, m.load_ms ?? 0)
      // a client that goes before the load ends (Ollama then gives the load up)
      res.on('close', () => {
        if (res.writableFinished) return
        clearTimeout(timer)
        note({ path: p, method: req.method, phase: 'client-gone', model: m.name })
      })
      return
    }
    if (p === '/v1/models') return json(res, 200, { object: 'list', data: models.map((m) => ({ id: m.name, object: 'model' })) })
    // Claude Code's warm-up probe
    if (p === '/api/hello') { res.writeHead(200); return res.end() }
    // ── the two inference APIs
    if (p === '/v1/messages' && req.method === 'POST') return messages(req, res, body)
    if (p === '/v1/responses' && req.method === 'POST') return responses(req, res, body)
    // Ollama serves no count_tokens: Claude Code estimates instead
    note({ path: p, method: req.method, unanswered: true })
    return json(res, 404, { error: `no route ${req.method} ${p}` })
  }

  /** the reply a request gets, from the last user turn's text */
  function pick(lastText, toolResult, call = '') {
    if (toolResult) {
      const c = call.toLowerCase()
      return rules.find((r) => r.afterCall && r.afterCall.every((m) => c.includes(String(m).toLowerCase()))) ?? afterTool
    }
    const t = (lastText ?? '').toLowerCase()
    return rules.find((r) => !r.afterCall && (r.match ?? []).every((m) => t.includes(String(m).toLowerCase()))) ?? { text: 'OK.' }
  }
  /** the name the harness offered an orgtree tool under */
  const toolName = (names, want) => names.find((n) => n === want || n.endsWith(`__${want}`)) ?? want

  // ── Anthropic Messages (Claude Code)
  function messages(req, res, b, waited = false) {
    const msgs = b?.messages ?? []
    const last = [...msgs].reverse().find((m) => m.role === 'user')
    const parts = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: String(last?.content ?? '') }]
    const toolResult = parts.some((c) => c.type === 'tool_result')
    const lastText = parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    const names = (b?.tools ?? []).map((t) => t.name).filter(Boolean)
    const system = typeof b?.system === 'string' ? b.system : (b?.system ?? []).map((s) => s.text ?? '').join('\n')
    const reply = pick(lastText, toolResult)
    const refusal = reply.refuse ?? (strict ? strictRefusal('messages', b) : null)
    if (refusal) return refuse(req, res, 'messages', b, refusal, lastText)
    // a slow server: the rule's delay before anything is sent
    if (reply.delay_ms && !waited) { setTimeout(() => messages(req, res, b, true), reply.delay_ms); return }
    note({ path: '/v1/messages', method: 'POST', ...auth(req), model: b?.model ?? null, stream: !!b?.stream,
      body_chars: JSON.stringify(b ?? {}).length, body_file: keepBody('messages', b),
      max_tokens: b?.max_tokens ?? null, thinking: b?.thinking ?? null, tools: names.length,
      orgtree_tools: names.filter((n) => n.includes('orgtree_')).length, system_chars: system.length,
      messages: msgs.length, tool_result: toolResult, last_user: lastText.slice(-200), reply })
    const input = Math.ceil((JSON.stringify(b ?? {}).length) / 4)
    const block = reply.tool
      ? { type: 'tool_use', id: id('toolu'), name: toolName(names, reply.tool), input: {} }
      : { type: 'text', text: '' }
    const stop = reply.tool ? 'tool_use' : 'end_turn'
    const msgId = id('msg')
    if (!b?.stream) {
      const content = reply.tool ? [{ ...block, input: reply.input ?? {} }] : [{ type: 'text', text: reply.text ?? 'OK.' }]
      return json(res, 200, { id: msgId, type: 'message', role: 'assistant', model: b?.model, content, stop_reason: stop,
        stop_sequence: null, usage: { input_tokens: input, output_tokens: 8 } })
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model: b?.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 1 } } })
    ev('content_block_start', { index: 0, content_block: block })
    if (reply.tool) {
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input ?? {}) } })
    } else {
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text ?? 'OK.' } })
    }
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } })
    ev('message_stop', {})
    res.end()
  }

  // ── OpenAI Responses (Codex)
  function responses(req, res, b, waited = false) {
    const input = Array.isArray(b?.input) ? b.input : [{ type: 'message', role: 'user', content: String(b?.input ?? '') }]
    const lastUserIdx = input.map((x) => x.role === 'user' || x.type === 'function_call_output').lastIndexOf(true)
    const lastItem = input[lastUserIdx]
    const toolResult = lastItem?.type === 'function_call_output'
    const text = (c) => (typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join('\n'))
    const lastText = toolResult ? '' : text(lastItem?.content)
    const names = (b?.tools ?? []).map((t) => t.name ?? t.function?.name).filter(Boolean)
    // the call a tool result answers: its arguments pick an `afterCall` rule
    const call = toolResult ? input.find((x) => x.type === 'function_call' && x.call_id === lastItem.call_id) : null
    const reply = pick(lastText, toolResult, call?.arguments ?? '')
    const refusal = reply.refuse ?? (strict ? strictRefusal('responses', b) : null)
    if (refusal) return refuse(req, res, 'responses', b, refusal, lastText)
    if (reply.delay_ms && !waited) { setTimeout(() => responses(req, res, b, true), reply.delay_ms); return }
    // the usage this answer reports (Codex sums it into its thread total)
    const usage = { input_tokens: Math.ceil(JSON.stringify(b ?? {}).length / 4), input_tokens_details: { cached_tokens: 0 },
      output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 }
    usage.total_tokens = usage.input_tokens + usage.output_tokens
    note({ path: '/v1/responses', method: 'POST', ...auth(req), model: b?.model ?? null, stream: !!b?.stream,
      usage_in: usage.input_tokens, usage_out: usage.output_tokens,
      body_chars: JSON.stringify(b ?? {}).length, body_file: keepBody('responses', b),
      // each tool as type:name — a `custom` tool (freeform apply_patch) is one Ollama refuses
      tool_types: (b?.tools ?? []).filter((t) => !String(t.name ?? '').includes('orgtree_')).map((t) => `${t.type}:${t.name ?? ''}`),
      store: b?.store ?? null, reasoning: b?.reasoning ?? null, tools: names.length,
      orgtree_tools: names.filter((n) => n.includes('orgtree_')).length, instructions_chars: String(b?.instructions ?? '').length,
      items: input.length, tool_result: toolResult, last_user: lastText.slice(-200), reply,
      tool_call: call?.arguments ?? null, tool_output: toolResult ? text(lastItem.output).slice(0, 2000) : null })
    const respId = id('resp')
    const created = Math.floor(Date.now() / 1000)
    const base = { id: respId, object: 'response', created_at: created, model: b?.model, output: [] }
    let item
    if (reply.tool) {
      item = { type: 'function_call', id: id('fc'), call_id: id('call'), name: toolName(names, reply.tool),
        arguments: JSON.stringify(reply.input ?? {}), status: 'completed' }
    } else {
      item = { type: 'message', id: id('msg'), status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: reply.text ?? 'OK.', annotations: [] }] }
    }
    if (!b?.stream) return json(res, 200, { ...base, status: 'completed', output: [item], usage })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    let seq = 0
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
    ev('response.created', { response: { ...base, status: 'in_progress' } })
    ev('response.in_progress', { response: { ...base, status: 'in_progress' } })
    if (reply.tool) {
      ev('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
      ev('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
      ev('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
      ev('response.output_item.done', { output_index: 0, item })
    } else {
      const t = item.content[0].text
      ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      ev('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } })
      ev('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: t })
      ev('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: t })
      ev('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: t, annotations: [] } })
      ev('response.output_item.done', { output_index: 0, item })
    }
    ev('response.completed', { response: { ...base, status: 'completed', output: [item], usage } })
    res.end()
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const addr = server.address()
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    /** add a model while the server runs (same shape as `models`) */
    add: (m) => { models = [...models.filter((x) => x.name !== m.name), { ...m }] },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const llm = await startFakeLlm({ port: Number(arg('--port') ?? 0), log: arg('--log') ?? null, bodies: arg('--bodies') ?? null })
  console.log(`listening ${llm.url}`)
}
