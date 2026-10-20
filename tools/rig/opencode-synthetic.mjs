// Offline OpenAI-compatible model for the OpenCode mail proof. It can only
// return a native read of the test's own file, followed by synthetic text.
import http from 'node:http'

export async function startOpenCodeSynthetic() {
  const requests = [], errors = [], pending = new Set()
  let active = null
  const deferred = () => {
    let resolve
    const promise = new Promise(r => { resolve = r })
    return { promise, resolve }
  }
  const bounded = (promise, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`synthetic model timeout: ${what}`)), 30000)
    promise.then(value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) })
  })
  const handle = async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mail-fixture', context_length: 131072 }] }))
      return
    }
    const chunks = []
    for await (const data of req) chunks.push(data)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const entry = { path: req.url, body, at: new Date().toISOString() }
    requests.push(entry)
    let call
    const main = Array.isArray(body.tools) && body.tools.length > 0
    const phase = active
    if (main && phase && JSON.stringify(body.messages).includes(phase.token)) {
      phase.requests.push(entry)
      const n = phase.requests.length
      if (n === 1) {
        phase.first.resolve(entry)
        await bounded(phase.releaseFirst.promise, 'first response')
      } else if (n === 2) {
        phase.second.resolve(entry)
        await bounded(phase.releaseSecond.promise, 'second response')
      } else if (n === 3 && phase.toolRounds === 2) {
        phase.third.resolve(entry)
        await bounded(phase.releaseThird.promise, 'third response')
      }
      if (n <= phase.toolRounds) {
        const tool = body.tools.find(t => t.function?.name === 'read')?.function
        if (!tool) throw Error('OpenCode native read was not offered')
        const properties = tool.parameters?.properties ?? {}
        const key = ['filePath', 'path', 'file_path'].find(k => k in properties)
        if (!key) throw Error('unknown native read input')
        call = { index: 0, id: `read_${phase.token}_${n}`, type: 'function',
          function: { name: tool.name, arguments: JSON.stringify({ [key]: phase.file }) } }
      }
    }
    if (res.destroyed) return
    const frames = call
      ? [{ choices: [{ delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]
      : [{ choices: [{ delta: { role: 'assistant', content: 'Synthetic mail proof complete.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }]
    frames.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n')
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      errors.push(error.message)
      if (!res.destroyed) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'synthetic fixture failed' }))
      }
    })
  })
  // Never leave a rejected handler or its connection alive after a failed proof.
  server.on('connection', socket => {
    pending.add(socket)
    socket.on('close', () => pending.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, errors,
    arm(token, file, toolRounds = 1) {
      if (active) { active.releaseFirst.resolve(); active.releaseSecond.resolve(); active.releaseThird.resolve() }
      active = { token, file, toolRounds, requests: [], first: deferred(), second: deferred(), third: deferred(),
        releaseFirst: deferred(), releaseSecond: deferred(), releaseThird: deferred() }
      const phase = active
      return {
        first: () => bounded(phase.first.promise, `${token} request 1`),
        second: () => bounded(phase.second.promise, `${token} request 2`),
        third: () => bounded(phase.third.promise, `${token} request 3`),
        releaseFirst: () => phase.releaseFirst.resolve(),
        releaseSecond: () => phase.releaseSecond.resolve(),
        releaseThird: () => phase.releaseThird.resolve(),
        requests: phase.requests,
      }
    },
    async close() {
      if (active) { active.releaseFirst.resolve(); active.releaseSecond.resolve(); active.releaseThird.resolve(); active = null }
      for (const socket of pending) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
