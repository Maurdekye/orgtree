// JSON helpers for agent-tools-smoke.sh (4.6.1: they were inline `python3 -c`
// snippets; the runners have node from actions/setup-node). Each subcommand is
// one of those snippets, with the same input, output and silence on a missing
// file.
//
//   codex-auth FILE           write a fake Codex auth.json (unsigned id_token)
//   fakecli-scenario FILE     write the fake CLI's scenario.json
//   free-port                 print a free 127.0.0.1 TCP port
//   ready-port FILE           print the port of the first {"type":"ready"} line
//   spawned-pid FILE          print child_pid of the first {"kind":"spawned"} line
//   providers-summary         stdin /api/providers -> one line per provider
//   field NAME                stdin JSON -> print its NAME field
//   status-verdict LOG OUT    write pass|fail: ... for the orgtree_status result
//   noshell-verdict LOG       print pass|fail: ... for the denied run_command
import fs from 'node:fs'
import net from 'node:net'

const [command, ...args] = process.argv.slice(2)

function lines(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    try { out.push(JSON.parse(line)) } catch { /* not a JSON line */ }
  }
  return out
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stdin = () => JSON.parse(fs.readFileSync(0, 'utf8'))
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const show = value => (JSON.stringify(value) ?? 'null').slice(0, 300)

switch (command) {
  case 'codex-auth':
    fs.writeFileSync(args[0], JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: b64({ alg: 'none' }) + '.' + b64({ email: 'smoke@example.com' }) + '.' } }))
    break
  case 'fakecli-scenario': {
    const hang = { turns: [{ name: 'spawn-and-hang', steps: [{ spawn: 'sleep 300' }, { hang: true }] }] }
    const finish = { turns: [{ name: 'spawn-and-finish', steps: [{ spawn: 'sleep 300' }, { text: 'Started it.' }] }] }
    const noshell = { turns: [{ name: 'shell', steps: [
      { tool: 'run_command', args: { CommandLine: 'echo hi', Cwd: '.' }, result: 'hi' },
      { text: 'I may not use the shell.' }] }] }
    fs.writeFileSync(args[0], JSON.stringify({
      agents: { 'left-retire': hang, 'left-close': finish, 'left-shutdown': hang, 'tools-agy-noshell': noshell },
      default: { turns: [{ name: 'tool-smoke', steps: [
        { tool: 'orgtree_status', args: { status: 'done', summary: 'agent tool smoke' }, expect: 'Status recorded' },
        { text: 'OK.' }] }] },
    }, null, 1))
    break
  }
  case 'free-port': {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => console.log(port)) })
    break
  }
  case 'ready-port': {
    const ready = lines(args[0]).find(m => isObject(m) && m.type === 'ready')
    if (ready) console.log(ready.port)
    break
  }
  case 'spawned-pid': {
    const spawned = lines(args[0]).find(m => isObject(m) && m.kind === 'spawned' && m.child_pid)
    if (spawned) console.log(spawned.child_pid)
    break
  }
  case 'providers-summary': {
    const data = stdin()
    for (const [key, value] of Object.entries(data)) {
      if (!isObject(value)) continue
      const picked = Object.fromEntries(['installed', 'connected', 'hire', 'path', 'version'].filter(x => x in value).map(x => [x, value[x]]))
      console.log(key, JSON.stringify(picked))
    }
    break
  }
  case 'field':
    console.log(stdin()[args[0]])
    break
  case 'status-verdict': {
    let verdict = ''
    for (const m of lines(args[0])) {
      if (isObject(m) && m.kind === 'tool_result' && m.tool === 'orgtree_status') {
        verdict = m.ok === true && !m.is_error ? 'pass' : 'fail: ' + String(m.text).slice(0, 300)
      }
    }
    if (verdict) fs.writeFileSync(args[1], verdict)
    break
  }
  case 'noshell-verdict': {
    let hook = null, result = null
    for (const m of lines(args[0])) {
      if (!isObject(m)) continue
      if (m.kind === 'hook' && m.event === 'PreToolUse' && m.tool === 'run_command') hook = m
      if (m.kind === 'tool_result' && m.tool === 'run_command') result = m
    }
    if (result !== null) {
      const ok = hook !== null && hook.decision === 'deny' && /shell rights/.test(String(hook.reason ?? ''))
        && result.denied === true && /denied by pre-tool hook/.test(String(result.text ?? ''))
      console.log(ok ? 'pass' : `fail: hook ${show(hook)}; result ${show(result)}`)
    }
    break
  }
  default:
    console.error(`unknown smoke-json command: ${command}`)
    process.exit(2)
}
