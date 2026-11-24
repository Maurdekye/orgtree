// Measures the user's chats with a long history: what it costs to open a
// chat, to type in it, to take a new tree from the organization and to scroll
// back (USER 2026-11-24 mbbb6c8289d47 "very laggy when viewing in a remote
// org", m1162b904b77f "extremely laggy" with a very long conversation).
//
//   node dm-bench.mjs <build-output> <evidence> <node_modules> <messages> [agents] [--gate]
//
// The page is dm-bench-probe.tsx in the rig's guarded offscreen Electron
// (Session 0, muted, off the real clipboard), walked by dm-bench.cjs. The
// engine is the fake one below: one chat of <messages> messages, all of them
// in the mailbox's first read (the worst case: everything is loaded), in an
// organization of [agents] agents (default 250), a quarter of them holding an
// audience. Timings are this machine's Chromium; they are recorded, and
// --gate checks only the counts that do not depend on the machine.
delete process.env.ELECTRON_RUN_AS_NODE
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, evidenceArg, dependenciesArg, messagesArg, ...rest] = process.argv.slice(2)
if (!outputArg || !evidenceArg || !dependenciesArg || !messagesArg) throw new Error('Supply build-output, evidence, the dependency root and the number of messages')
const gate = rest.includes('--gate')
const N = Number(messagesArg), AGENTS = Number(rest.find(a => /^\d+$/.test(a)) ?? 250)
const output = path.resolve(outputArg), evidence = path.resolve(evidenceArg), dependencies = path.resolve(dependenciesArg)
const require = createRequire(path.join(dependencies, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
const built = await esbuild.build({ entryPoints: [path.join(here, 'dm-bench-probe.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning',
  metafile: true, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  // the profiling build of React's DOM renderer: production speed, with the Profiler's timings
  alias: { 'react-dom/client': 'react-dom/profiling', 'scheduler/tracing': 'scheduler/tracing-profiling' },
  define: { 'process.env.NODE_ENV': '"production"' } })
esbuild.stop()
const reacts = Object.keys(built.metafile.inputs).filter(f => /node_modules[\\/]react[\\/]index\.js$/.test(f))
assert.equal(reacts.length, 1, `one React root in the bundle: ${JSON.stringify(reacts)}`)
let componentCss = ''
try { componentCss = readFileSync(path.join(output, 'probe.css'), 'utf8') } catch { /* no component imported a sheet */ }
const css = readFileSync(path.join(here, '../src/styles.css'), 'utf8') + '\n' + componentCss

const now = Date.now(), M = 60e3
const USER = '@user'
const LINES = ['Done.', 'The second batch is in: **214 rows**, 3 of them flagged for a second look.',
  'One open point before I go on:\n\n- the March total\n- the returns\n\nBoth differ from last week.', 'Noted, continuing with `step 4`.',
  'The check passed on the first run and again after the rebase, so I am treating it as stable for now and moving to the next piece of the list.']
const delivered = [], sent = []
for (let i = 0; i < N; i++) {
  const row = { id: `h${String(i).padStart(5, '0')}`, at: new Date(now - (N - i) * 3 * M).toISOString(), kind: 'message', body: `Note ${i}: ${LINES[i % LINES.length]}` }
  if (i % 4 === 3) sent.push({ ...row, from: USER, to: 'worker' }); else delivered.push({ ...row, from: 'worker' })
}
const audiences = [{ grantee: 'worker', grantor: USER, granted_at: new Date(now).toISOString(), reason: '' },
  ...Array.from({ length: AGENTS }, (_, i) => i).filter(i => i % 4 === 0).map(i => ({ grantee: `agent-${String(i).padStart(3, '0')}`, grantor: USER, granted_at: new Date(now).toISOString(), reason: '' }))]
const requests = { inbox: 0, audiences: 0, other: 0 }
const html = `<!doctype html><meta charset="utf-8"><title>dm bench</title><link rel="stylesheet" href="/probe.css">`
  + `<div id="root"></div><script>window.__bench0=${JSON.stringify({ agents: AGENTS })}</script><script src="/probe.js"></script>`
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
  if (url.pathname === '/') return send(html, 'text/html')
  if (url.pathname === '/probe.js') return send(readFileSync(path.join(output, 'probe.js')), 'text/javascript')
  if (url.pathname === '/probe.css') return send(css, 'text/css')
  if (!url.pathname.startsWith('/api/orgs/mine')) return url.pathname.startsWith('/api/') ? send({}) : send('not found', 'text/plain', 404)
  if (req.method !== 'GET') { for await (const _ of req) { /* drain */ } }
  const p = url.pathname.replace(/^\/api\/orgs\/mine/, '')
  if (p === '/audiences') { requests.audiences++; return send({ audiences, requests: [] }) }
  if (p === '/inbox/read') return send({ read: 0 })
  if (/\/transfers$/.test(p)) return send({ transfers: [], next_cursor: null })
  if (p === '/inbox') {
    requests.inbox++
    const ids = url.searchParams.get('ids')
    if (ids) { const want = JSON.parse(ids); return send({ pending: [], delivered: delivered.filter(m => want.includes(m.id)), sent: sent.filter(m => want.includes(m.id)), refreshed_ids: want }) }
    if (url.searchParams.get('folder') === 'chat') {
      // one chat's own pages, as the engine cuts them (50 a page, newest first, both directions)
      const peer = url.searchParams.get('peer'), before = url.searchParams.get('before')
      requests.chat = (requests.chat ?? 0) + 1
      const rows = peer === 'worker' ? [...delivered, ...sent].sort((a, b) => (a.at < b.at ? 1 : -1)) : []
      const from = before ? Number(before) : 0, page = rows.slice(from, from + 50)
      return send({ pending: [], delivered: page.filter(m => m.from !== USER), sent: page.filter(m => m.from === USER), next_cursor: from + 50 < rows.length ? String(from + 50) : null })
    }
    return send({ pending: [], delivered, sent, next_cursor: null })
  }
  requests.other++
  return send({})
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let result
try {
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '', run: { ui: 'dm-bench-probe' } },
    path.join(here, 'dm-bench.cjs'), { out: path.join(evidence, 'desktop'), timeout: 400000,
      electron: path.join(dependencies, 'electron/dist/electron.exe') })
} finally { server.close() }
result.fixture = { messages: N, agents: AGENTS, holders: audiences.length }; result.requests = requests
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }
const v = result.value
if (gate) {
  assert.equal(result.session.electron, 0, 'the window ran in Session 0'); assert.equal(result.guards.muted, true)
  // counts, not times: what is drawn does not grow with the history
  assert.ok(v.open.bubbles <= 50, `opening draws one page at most: ${v.open.bubbles}`)
  assert.ok(v.scroll.end.bubbles <= 350, `a scroll-back stays a window: ${v.scroll.end.bubbles}`)
}
console.log(JSON.stringify({ ok: true, messages: N, agents: AGENTS, open: v.open, typing: v.typing, treeTick: v.treeTick, treeTickScrolledBack: v.treeTickScrolledBack,
  scroll: { medianWallMs: v.scroll.medianWallMs, maxWallMs: v.scroll.maxWallMs, steps: v.scroll.steps.length, end: v.scroll.end }, requests, session: result.session }))
