// Coordinator-approved real app-server, synthetic loopback SSE and fake home.
// Run ONLY in rig-opus's contained batch. No account, model or live profile.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('codex-generation-signal')
  const root = path.resolve(rig.data, 'codex-generation-probe')
  if (!/^D:\\orgtree-work\\rig\\/i.test(root + '\\')) throw new Error('Probe requires the authorized D rig root')
  const home = path.join(root, 'home'), cwd = path.join(root, 'cwd')
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
  const binary = process.env.CODEX_GENERATION_CLI
  if (!binary || !fs.existsSync(binary)) throw new Error('Set CODEX_GENERATION_CLI to the installed Codex 0.160 exe')
  const events = [], jobs = new Set(), waiters = new Map()
  const begin = performance.now()
  const record = (side, name, data = {}) => {
    const row = { at: new Date().toISOString(), ms: performance.now() - begin, side, name, ...data }
    events.push(row)
    fs.appendFileSync(path.join(p.dir, 'timestamps.jsonl'), JSON.stringify(row) + '\n')
    return row
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  let requests = 0, child, closed = false, stopped = false, exit
  const server = http.createServer((req, res) => {
    const job = (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404); res.end(); return
      }
      let text = ''; for await (const chunk of req) text += chunk
      const input = JSON.parse(text)
      requests++
      record('http', 'request', { path: req.url, model: input.model, bytes: text.length, number: requests })
      const afterTool = (input.input ?? []).some(i => i.type === 'function_call_output')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const id = afterTool ? 'resp_probe_final' : 'resp_probe_call'
      let sequence = 0
      const ev = (name, data) => {
        record('sse', name, { data })
        res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: sequence++, ...data })}\n\n`)
      }
      ev('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      ev('response.in_progress', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      const message = { type: 'message', id: afterTool ? 'msg_final' : 'msg_before', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: afterTool ? 'PROBE COMPLETE' : 'Preparing synthetic fixture.', annotations: [] }] }
      ev('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } })
      ev('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } })
      ev('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text })
      ev('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text: message.content[0].text })
      ev('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] })
      ev('response.output_item.done', { output_index: 0, item: message })
      const output = [message]
      if (!afterTool) {
        await pause(700) // previous item's end is deliberately NOT generation start
        const call = { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'probe_tool',
          arguments: '{"value":"synthetic"}', status: 'completed' }
        ev('response.output_item.added', { output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } })
        await pause(800)
        ev('response.function_call_arguments.delta', { item_id: call.id, output_index: 1, delta: '{"value":' })
        await pause(900)
        ev('response.function_call_arguments.delta', { item_id: call.id, output_index: 1, delta: '"synthetic"}' })
        await pause(800)
        ev('response.function_call_arguments.done', { item_id: call.id, output_index: 1, arguments: call.arguments })
        ev('response.output_item.done', { output_index: 1, item: call })
        output.push(call)
      }
      ev('response.completed', { response: { id, object: 'response', status: 'completed', output,
        usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } } })
      res.end()
    })().catch(error => { record('http', 'error', { message: String(error) }); res.destroy() })
    jobs.add(job); job.finally(() => jobs.delete(job))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1`
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model="timing-probe"\nmodel_provider="timing_probe"\n[model_providers.timing_probe]\nname="Synthetic timing probe"\nbase_url=${JSON.stringify(url)}\nwire_api="responses"\nrequires_openai_auth=false\n[analytics]\nenabled=false\n`)
  // Whitelist OS plumbing; no inherited auth, bridge, provider or account vars.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') })
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  let next = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { waiters.delete(id); reject(new Error(`${method} timeout`)) }, 25000)
    waiters.set(id, { resolve, reject, timer }); send({ id, method, params })
  })
  try {
    const version = spawnSync(binary, ['--version'], { env, cwd, encoding: 'utf8', windowsHide: true })
    p.check('installed actual CLI is Codex 0.160.0', version.status === 0 && /codex-cli 0\.160\.0\b/.test(version.stdout), version.stdout.trim())
    child = spawn(binary, ['app-server', '--stdio'], { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    exit = new Promise(resolve => { child.once('close', code => { closed = true; record('process', 'closed', { code }); resolve(code) }) })
    child.on('error', error => record('process', 'error', { message: String(error) }))
    child.stderr.on('data', text => fs.appendFileSync(path.join(p.dir, 'fake-home-stderr.log'), text))
    readline.createInterface({ input: child.stdout }).on('line', text => {
      let msg; try { msg = JSON.parse(text) } catch { return }
      record('app-server', msg.method ?? 'response', { msg }) // synthetic-only fake profile
      if (msg.id != null && !msg.method) {
        const waiter = waiters.get(msg.id)
        if (waiter) { clearTimeout(waiter.timer); waiters.delete(msg.id); msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result) }
      } else if (msg.id != null && msg.method) {
        if (msg.method === 'item/tool/call') {
          const job = pause(1000).then(() => {
            if (!closed && !child.stdin.writableEnded) send({ id: msg.id, result: { contentItems: [{ type: 'inputText', text: 'Synthetic result' }], success: true } })
          })
          jobs.add(job); job.finally(() => jobs.delete(job))
        } else send({ id: msg.id, error: { code: -32601, message: 'Synthetic probe refuses unexpected request' } })
      }
    })
    await rpc('initialize', { clientInfo: { name: 'orgtree_timing_probe', version: '1' }, capabilities: { experimentalApi: true } })
    send({ method: 'initialized', params: {} })
    const thread = await rpc('thread/start', { cwd, model: 'timing-probe', modelProvider: 'timing_probe', sandbox: 'read-only', approvalPolicy: 'never',
      dynamicTools: [{ type: 'function', name: 'probe_tool', description: 'Synthetic inert timing probe', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] })
    const started = await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Run the synthetic timing fixture.' }], model: 'timing-probe' })
    await rig.waitFor(() => events.some(e => e.name === 'turn/completed' && e.msg?.params?.turn?.id === started.turn.id),
      { what: 'real app-server synthetic tool turn completes', timeout: 60000 })
    const added = events.find(e => e.side === 'sse' && e.name === 'response.output_item.added' && e.data.item.id === 'fc_probe')
    const done = events.find(e => e.side === 'sse' && e.name === 'response.function_call_arguments.done')
    const tool = events.find(e => e.side === 'app-server' && e.name === 'item/started' && e.msg.params.item.type === 'dynamicToolCall')
    const request = events.find(e => e.side === 'app-server' && e.name === 'item/tool/call')
    const early = events.filter(e => e.side === 'app-server' && e.ms >= added?.ms && e.ms < done?.ms)
    const generation = early.filter(e => {
      const value = JSON.stringify(e.msg)
      return /arguments.*delta|tool.*input.*delta/i.test(e.name)
        || value.includes('"fc_probe"') || value.includes('"call_probe"') || value.includes('"probe_tool"')
    })
    p.check('synthetic controlled argument-generation span exceeds two seconds', !!added && !!done && done.ms - added.ms >= 2400, { added: added?.ms, done: done?.ms })
    p.check('actual dynamic tool begins with already complete arguments', tool?.msg.params.item.arguments?.value === 'synthetic'
      && request?.msg.params.arguments?.value === 'synthetic', { tool: tool?.ms, request: request?.ms })
    p.check('tool item starts only after SSE arguments are complete', !!tool && !!done && tool.ms >= done.ms, { tool: tool?.ms, done: done?.ms })
    p.check('no per-call app-server generation signal was emitted during the controlled span', generation.length === 0, { generation, otherEvents: early.map(e => ({ ms: e.ms, name: e.name })) })
    p.check('previous item end cannot stand in for this call generation start', !!added && events.some(e => e.side === 'sse'
      && e.name === 'response.output_item.done' && e.data.item.id === 'msg_before' && added.ms - e.ms >= 650))
    p.check('only the local synthetic Responses requests were needed', requests === 2, { requests, url })
    p.file('timeline.json', events)
    p.note('Observation of this installed CLI/protocol, not a guarantee about future versions. If early events exist, inspect them before any product timing change.')
  } finally {
    for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('probe ending')) }
    waiters.clear()
    if (child && !closed) {
      record('process', 'graceful-stdin-close', { pid: child.pid }); child.stdin.end()
      await Promise.race([exit, pause(5000)])
      if (!closed) {
        const file = path.join(p.dir, 'forcedkill.json')
        const why = { at: new Date().toISOString(), pid: child.pid, binary, fakeHome: codexHome, reason: 'No exit after graceful stdin close and 5s wait' }
        fs.writeFileSync(file, JSON.stringify(why, null, 2)) // durable BEFORE forced termination
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
        fs.writeFileSync(file, JSON.stringify({ ...why, status: killed.status, stdout: killed.stdout, stderr: killed.stderr }, null, 2))
        await Promise.race([exit, pause(5000)])
      }
      stopped = closed
    } else stopped = !child || closed
    await Promise.allSettled([...jobs])
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve))
    p.file('timeline.json', events)
    if (!stopped) throw new Error('Owned synthetic Codex process did not stop; see forcedkill record')
  }
  p.check('owned app-server is stopped before proof returns', stopped)
  return p.summary()
}
