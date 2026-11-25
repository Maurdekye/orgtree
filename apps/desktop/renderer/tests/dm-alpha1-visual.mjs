// Captures the user's chats for the points of the 4.7.0-alpha.1 feedback (USER
// 2026-11-24 m15c78be3a1db and after): dm-alpha1-probe.tsx in the rig's guarded
// offscreen Electron (muted, off the real clipboard), walked by
// dm-alpha1-visual.cjs, and checks what it measured with --expect.
//
//   node dm-alpha1-visual.mjs <build-output> <evidence> <node_modules> [--expect]
//
// Launch it from a Session 0 turn under tests/joblimit.ps1 and a @build-slot
// permit. The engine is the fake one below: a synthetic organization.
//
// ⚠ WHAT "POPPED OUT" MEANS HERE. This page has no second window to open. The
// popped-out layout is measured by giving the page the classes a popped-out
// window's own frame has (`.popout-mount`, `.overlay-detached`,
// `.modalpin-detached`), which is what the rules under test are keyed on. A
// real popped-out window is not opened by this capture.
delete process.env.ELECTRON_RUN_AS_NODE
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, evidenceArg, dependenciesArg, flag] = process.argv.slice(2)
if (!outputArg || !evidenceArg || !dependenciesArg) throw new Error('Supply build-output, evidence and the real dependency root (a node_modules folder)')
const output = path.resolve(outputArg), evidence = path.resolve(evidenceArg), dependencies = path.resolve(dependenciesArg)
const require = createRequire(path.join(dependencies, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
const built = await esbuild.build({ entryPoints: [path.join(here, 'dm-alpha1-probe.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning',
  metafile: true, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' } })
esbuild.stop()
const reacts = Object.keys(built.metafile.inputs).filter(f => /node_modules[\\/]react[\\/]index\.js$/.test(f))
assert.equal(reacts.length, 1, `one React root in the bundle: ${JSON.stringify(reacts)}`)
let componentCss = ''
try { componentCss = readFileSync(path.join(output, 'probe.css'), 'utf8') } catch { /* no component imported a sheet */ }
const css = readFileSync(path.join(here, '../src/styles.css'), 'utf8') + '\n' + componentCss + `
.alpha1-desk { position: fixed; left: 440px; top: 150px; width: 840px; z-index: 60; padding: 10px 12px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
.alpha1-list { position: fixed; left: 460px; top: 110px; z-index: 60; }
.alpha1-fulldesk { position: fixed; right: 12px; top: 60px; width: 600px; height: 880px; z-index: 60; display: flex; flex-direction: column; padding: 10px 12px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
.alpha1-fulldesk > :not(.alpha1-cap) { flex: 1; min-height: 0; }
.alpha1-cap { display: block !important; font-size: 11px; color: var(--dim); margin: 0 0 6px !important; }
`
assert.match(css, /\.dm-list > \.tray-panel\.dm-newchat/, 'the chat sheet is in the page')

// ------------------------------------------------------------ the fake engine
const now = Date.now(), M = 60e3, H = 60 * M, D = 24 * H
const ago = ms => new Date(now - ms).toISOString()
const USER = '@user'
/** a synthetic outside sender (stream privacy hides outside names) */
const OUTSIDE = '@net:casey.4f2a9c'
const grant = (grantee, extra = {}) => ({ grantee, grantor: USER, granted_at: ago(9 * D), reason: '', ...extra })
const mail = (id, from, when, body, extra = {}) => ({ id, from, at: ago(when), kind: 'message', body, ...extra })
const sent = (id, to, when, body, extra = {}) => ({ id, from: USER, to, at: ago(when), kind: 'message', body, ...extra })
const typed = (variant, actor, body, extra = {}) => ({ v: 1, variant, actor, object: null, engine_authored: false, body, ...extra })
/** a resolved request's answers, the card the user's own answer is shown as */
const answers = (actor) => ({ v: 1, variant: 'answer.batch', actor, object: { kind: 'batch', org: 'mine', id: 'ask-cards', node: 'quoter' }, engine_authored: false,
  sections: [{ kind: 'ask', ask_id: 'ask-cards', questions: [
    { label: 'Mid-turn', question: 'While an inbox agent is mid-turn, what should the contact line say?', answer: '"active now" (Rec.)' },
    { label: 'Older hubs', question: 'On a mail hub older than 2.6.0, what should Hubchat show there?', answer: 'No time (Rec.)' }] }] })
const LINES = ['Done.', 'The second batch is in: 214 rows, 3 of them flagged for a second look.',
  'One open point before I go on:\n\n- the March total\n- the returns\n\nBoth differ from last week.', 'Noted, continuing.',
  'The check passed on the first run and again after the rebase, so I am treating it as stable for now and moving to the next piece of the list.']
/** worker's long history, oldest first: 420 messages, both sides, of mixed height */
const HISTORY = Array.from({ length: 420 }, (_, i) => {
  const id = `h${String(i).padStart(3, '0')}`, when = 2 * D + (420 - i) * 7 * M, body = `Note ${i}: ${LINES[i % LINES.length]}`
  return i % 4 === 3 ? sent(id, 'worker', when, body, { delivered: true }) : mail(id, 'worker', when, body)
})
const PAGE = 60
const head = HISTORY.slice(-PAGE), olderPages = []
for (let end = HISTORY.length - PAGE; end > 0; end -= PAGE) olderPages.push(HISTORY.slice(Math.max(0, end - PAGE), end))
// sparse's older mail: two short messages on each of the first three older pages
const SPARSE_OLD = [0, 1, 2].map(p => [0, 1].map(k => mail(`sp-old-${p}${k}`, 'sparse', 3 * D + (p * 2 + k) * H, `Earlier note ${p * 2 + k + 1}.`)))
let quoterTranscript = true
const world = {
  // the grants the engine really lists: also a retired agent's (paused) and two names this tree does not hold
  audiences: [grant('quoter'), grant('worker'), grant('sparse'), grant('retired-one', { paused: true }), grant('accept-field'), grant('account-card')],
  requests: [],
  delivered: [
    mail('q1', 'quoter', 5 * H, 'The first draft of the notes is ready. Which section should I tighten first?'),
    // the agent's answer to the user's message: a typed reply, whose original lives in the AGENT's mailbox
    mail('q2', 'quoter', 4.5 * H, 'Shortening the summary now; the table stays as it is.', {
      ev: typed('reply.mail', { kind: 'agent', id: 'quoter' }, 'Shortening the summary now; the table stays as it is.', {
        object: { kind: 'mail', org: 'mine', box: 'node', node: 'quoter', id: 'u1', sender: USER, at: ago(4.8 * H) },
        quote: { from: USER, at: ago(4.8 * H), gist: 'The summary, please. Keep the table.' } }) }),
    // and the same card in the agent's bubble
    mail('ans0', 'quoter', 2.8 * H, '[ANSWERS to your questions]', { ev: answers({ kind: 'agent', id: 'quoter' }) }),
    mail('sp1', 'sparse', 3 * H, 'Nothing new today.'),
    mail('sp2', 'sparse', 2 * H, 'Still nothing.'),
    ...head.filter(m => m.from !== USER),
  ],
  pending: [],
  sent: [
    // the user's reply to q1: an older snapshot, which names no mailbox
    sent('u1', 'quoter', 4.8 * H, 'The summary, please. Keep the table.', { delivered: true, reply_to: { id: 'q1', from: 'quoter', at: ago(5 * H), gist: 'The first draft of the notes is ready. Which section should I tighten first?' } }),
    // a message typed in the chats: a typed event, the user's
    sent('u2', 'quoter', 4 * H, 'also there is this context dropdown under every message', { delivered: true, ev: typed('ordinary.message', { kind: 'user', id: USER }, 'also there is this context dropdown under every message') }),
    sent('u3', 'quoter', 3.5 * H, 'Here is the chart I meant.', { delivered: true, attachments: [{ name: 'chart.png', path: 'outbox/chart.png', bytes: 1532 }],
      reply_to: { id: 'q2', kind: 'mail', from: 'quoter', at: ago(4.5 * H), gist: 'Shortening the summary now; the table stays as it is.', org: 'mine', box: 'user' } }),
    sent('u4', 'quoter', 3.2 * H, 'And the raw numbers.', { delivered: false, dnd_held: true, attachments: [{ name: 'numbers.csv', path: 'outbox/numbers.csv', bytes: 48211 }] }),
    // the newest one is not read yet (the grey check), the ones before it are read (the green check)
    sent('u5', 'quoter', 3 * H, 'ok', { delivered: false }),
    // a whole card in the user's bubble: the answers to a request, as the engine records them (point 19)
    sent('ans1', 'quoter', 2.6 * H, '[ANSWERS to your questions]', { delivered: true, ev: answers({ kind: 'user', id: USER }) }),
    ...head.filter(m => m.from === USER),
  ],
}
const older = olderPages.map((page, i) => ({
  delivered: [...page.filter(m => m.from !== USER), ...(SPARSE_OLD[i] ?? [])], sent: page.filter(m => m.from === USER) }))
const everyMail = () => [...world.delivered, ...world.pending, ...world.sent, ...older.flatMap(p => [...p.delivered, ...p.sent])]
const calls = [], pages = [], mentionAsks = []
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYGD4z8DAwMAEYoAAAA0DAQGd2HvOAAAAAElFTkSuQmCC', 'base64')
const html = `<!doctype html><meta charset="utf-8"><title>dm alpha.1 probe</title><link rel="stylesheet" href="/probe.css">`
  + `<div id="root"></div><script src="/probe.js"></script>`
let seq = 0
// quoter's transcript: notes before and after the message whose send call wrote q2 (desk.tsx finds it by the call's mail)
const TRANSCRIPT = [
  ...Array.from({ length: 24 }, (_, i) => ({ role: 'assistant', text: `Working note ${i + 1}: checked one more table of the spring figures.`, seq: i, ts: ago(6 * H - i * M), event_id: `ev-before-${i}` })),
  { role: 'assistant', text: 'Sending the summary now', seq: 24, ts: ago(4.5 * H), event_id: 'ev-send',
    tools: [{ name: 'mcp__orgtree__orgtree_message', id: 'toolu_q2', event_id: 'ev-send-tool', mail: { id: 'q2', to: 'user' } }] },
  ...Array.from({ length: 24 }, (_, i) => ({ role: 'assistant', text: `Later note ${i + 1}: the table stays as it is.`, seq: 25 + i, ts: ago(4 * H - i * M), event_id: `ev-after-${i}` })),
]
let holdSends = false
const held = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
  if (url.pathname === '/') return send(html, 'text/html')
  if (url.pathname === '/probe.js') return send(readFileSync(path.join(output, 'probe.js')), 'text/javascript')
  if (url.pathname === '/probe.css') return send(css, 'text/css')
  if (url.pathname === '/__calls') return send({ calls, pages, mentionAsks })
  // 2026-11-25 (job G): the agent reads the waiting "ok" (u5); a message arrives in worker's chat; quoter's
  // desk has a transcript whose send call wrote q2. The first two only when the walk asks, at its end.
  // quoter's transcript off, then on again: the integrator's late case (a desk open on an empty transcript
  // when View in transcript is asked; the rows come with a later refresh)
  if (url.pathname === '/__transcript') { quoterTranscript = url.searchParams.get('on') === '1'; return send({ ok: true }) }
  // section 23: hold the user's sends (the clock), then let them all go
  if (url.pathname === '/__hold') { holdSends = url.searchParams.get('on') === '1'; if (!holdSends) held.splice(0).forEach(go => go()); return send({ ok: true }) }
  if (url.pathname === '/__read') { const u5 = world.sent.find(m => m.id === 'u5'); if (u5) u5.delivered = true; return send({ ok: true }) }
  if (url.pathname === '/__arrive') {
    const n = url.searchParams.get('n')
    // stamped now (not `ago`, whose clock is the server's start): it is the newest message of the chat
    world.delivered.push({ ...mail(`arrived-${n}`, 'worker', 0, `A new message (${n}): the figures for the north region are in.`), at: new Date().toISOString() })
    return send({ ok: true })
  }
  // STREAM PRIVACY (job E): an outside sender writes, and an agent quotes it. Added only when the walk asks,
  // at its end, so every count before it is what it was.
  if (url.pathname === '/__privacy') {
    world.pending.push(mail('n1', OUTSIDE, 3 * M, 'You can reach me at casey@example.org, or on the box at 10.20.30.40.'))
    world.delivered.push(mail('qp', 'quoter', 2 * M, 'Passing this on: the address is in the message I quote.', {
      reply_to: { id: 'n1', kind: 'mail', from: OUTSIDE, at: ago(3 * M), gist: 'You can reach me at casey@example.org, or on the box at 10.20.30.40.', org: 'mine', box: 'user' } }))
    return send({ ok: true })
  }
  if (!url.pathname.startsWith('/api/orgs/mine')) return url.pathname.startsWith('/api/') ? send({}) : send('not found', 'text/plain', 404)
  let body = null
  if (req.method !== 'GET') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.length } }
    calls.push({ method: req.method, path: url.pathname, body })
  }
  const p = url.pathname.replace(/^\/api\/orgs\/mine/, '')
  if (p === '/audiences') {
    if (req.method === 'POST') {
      if (body.action === 'revoke') world.audiences = world.audiences.filter(g => g.grantee !== body.node)
      if (body.action === 'grant') world.audiences.push(grant(body.node))
      return send({ ok: true })
    }
    return send({ audiences: world.audiences, requests: world.requests })
  }
  if (p === '/inbox/read') return send({ read: 0 })
  const message = p.match(/^\/nodes\/([^/]+)\/message$/)
  if (message && req.method === 'POST') {
    // the clock (section 23): the engine has not taken it until the kit lets it go
    const wasHeld = holdSends
    if (holdSends) await new Promise(resolve => held.push(resolve))
    const id = `sent-${++seq}`
    // a reply names what it answers; the engine hands the quote back with the mail
    const original = body.target?.kind === 'mail' ? everyMail().find(x => x.id === body.target.id) : null
    // a held send (section 23) is stored as an engine that reports delivery does: not yet delivered, so its clock becomes the sent check
    world.sent.push({ id, from: USER, to: decodeURIComponent(message[1]), at: new Date().toISOString(), kind: 'message', body: body.text, ...(wasHeld ? { delivered: false } : {}),
      ...(original ? { reply_to: { id: original.id, kind: 'mail', from: original.from, at: original.at, gist: original.body, org: 'mine', box: 'user' } } : {}) })
    return send({ accepted: true, id, ref: `@mail:${id}` })
  }
  // the desk's retract (http::nodes::retract): the user's own mail, still pending, is taken back (section 27)
  const retract = req.method === 'DELETE' ? p.match(/^\/nodes\/([^/]+)\/mail\/([^/]+)$/) : null
  if (retract) {
    const m = world.sent.find(x => x.id === decodeURIComponent(retract[2]) && x.delivered === false)
    if (!m) return send({ error: 'that message was already delivered (or is not yours to retract)' }, 'application/json', 409)
    m.retracted = true; delete m.delivered
    return send({ retracted: m.id })
  }
  // the @ menu's read of live things: two tickets, in the engine's order (their latest status change)
  if (p === '/mention-candidates') {
    const kinds = (url.searchParams.get('kinds') ?? '').split(','), q = (url.searchParams.get('q') ?? '').toLowerCase()
    const rows = [{ kind: 'item', id: 'spring-figures', label: 'Check the spring figures', at: ago(2 * H), status: 'in_progress' },
      { kind: 'item', id: 'march-returns', label: 'Explain the March returns', at: ago(3 * D), status: 'open' }]
    mentionAsks.push(url.searchParams.get('kinds'))
    return send({ items: rows.filter(r => kinds.includes(r.kind) && (!q || q.split(/\s+/).every(w => (r.label + ' ' + r.id).toLowerCase().includes(w)))), next_cursor: null, nodes: [], outside: [] })
  }
  // a desk's own read of its chat: an empty transcript (only its message box is shown); quoter's has its
  // transcript from the start (the desk-box step hides it), for View in transcript
  if (/^\/nodes\/[^/]+\/chat$/.test(p)) return send({ messages: p === '/nodes/quoter/chat' && quoterTranscript ? TRANSCRIPT : [], live: [], pending_mail: [], busy: false, responding: false, windowed: true, has_older: false, before: null, draft_epoch: 'synthetic:0' })
  if (/^\/nodes\/[^/]+\/file$/.test(p)) return /\.png$/.test(url.searchParams.get('path') ?? '') ? send(PNG, 'image/png') : send('synthetic file', 'application/octet-stream')
  if (/\/transfers$/.test(p)) return send({ transfers: [], next_cursor: null })
  if (p.startsWith('/mail/user/')) { const found = everyMail().find(m => m.id === decodeURIComponent(p.slice('/mail/user/'.length))) ?? null; return send({ found: !!found, mail: found }) }
  if (p === '/inbox') {
    const ids = url.searchParams.get('ids'), before = url.searchParams.get('before'), folder = url.searchParams.get('folder')
    if (ids) {
      const want = JSON.parse(ids), all = everyMail()
      return send({ pending: [], delivered: all.filter(m => m.from !== USER && want.includes(m.id)), sent: all.filter(m => m.from === USER && want.includes(m.id)), refreshed_ids: want })
    }
    if (folder === 'chat') {
      // one chat's own pages, as the engine cuts them: both directions of `peer`, newest first, 50 a page
      const peer = url.searchParams.get('peer')
      if (!peer) return send({ detail: 'the chat folder needs a peer' }, 'application/json', 400)
      const rows = everyMail().filter(m => (m.from === USER ? m.to === peer : m.from === peer)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      const from = before ? Number(before) : 0
      if (before) pages.push(`chat:${before}`)
      const page = rows.slice(from, from + 50)
      return send({ pending: [], delivered: page.filter(m => m.from !== USER), sent: page.filter(m => m.from === USER), next_cursor: from + 50 < rows.length ? String(from + 50) : null })
    }
    if (before) {
      pages.push(`${folder}:${before}`)
      const page = older[Number(before) - 1] ?? { delivered: [], sent: [] }
      return send({ pending: [], delivered: folder === 'sent' ? [] : page.delivered, sent: folder === 'sent' ? page.sent : [],
        next_cursor: Number(before) < older.length ? String(Number(before) + 1) : null })
    }
    return send({ pending: world.pending, delivered: world.delivered, sent: world.sent, next_cursor: older.length ? '1' : null })
  }
  return send({})
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let result
try {
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '', run: { ui: 'dm-alpha1-probe' } },
    path.join(here, 'dm-alpha1-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 300000,
      electron: path.join(dependencies, 'electron/dist/electron.exe') })
} finally { server.close() }
result.engineCalls = calls; result.historyPages = pages; result.fixture = { history: HISTORY.length, firstPage: PAGE, olderPages: older.length }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

const errors = result.consoleErrors.filter(e => !/Electron Security Warning/.test(e))
const checked = []
if (flag === '--expect') {
  const v = result.value
  assert.equal(result.session.electron, 0, 'the window ran in Session 0')
  assert.equal(result.guards.muted, true); assert.equal(result.guards.clipboardStub, true); assert.equal(result.guards.clipboardPermissions, 'denied')
  assert.deepEqual(errors, [], 'no console errors')
  const near = (a, b, what, by = 1) => assert.ok(Math.abs(a - b) <= by, `${what}: ${a} against ${b}`)

  // ---- 1: only agents the user can write to
  assert.deepEqual(v.list.rows.slice().sort(), ['interim-coordinator', 'quoter', 'sparse', 'worker'], 'the top-level agent and the three live holders; no retired agent, no unknown name')
  assert.equal(v.list.text.includes('No messages yet'), true, 'POSITIVE CONTROL: a live agent without mail still has its row')
  checked.push('1 list')

  // ---- 2: the chat's message box against the desk's own
  assert.deepEqual(v.box.chat.order, v.box.desk.order, 'the same parts in the same order')
  for (const part of Object.keys(v.box.desk.parts)) {
    assert.ok(v.box.chat.parts[part], `the chat's box has ${part}`)
    assert.deepEqual(v.box.chat.parts[part].style, v.box.desk.parts[part].style, `${part} is styled as on the desk`)
    for (const k of ['w', 'h']) if (part !== 'textarea' && part !== 'box') near(v.box.chat.parts[part].box[k], v.box.desk.parts[part].box[k], `${part} ${k}`)
    // where it sits in its box: from the right edge and from the bottom edge (the text, from the left and the top)
    if (part !== 'box') for (const k of Object.keys(v.box.desk.parts[part].at)) near(v.box.chat.parts[part].at[k], v.box.desk.parts[part].at[k], `${part} ${k}`)
  }
  assert.deepEqual(v.box.chat.parts.box.style, v.box.desk.parts.box.style, 'the box itself: padding, gap, radius, border, alignment')
  checked.push('2 composer')

  // ---- 3: drafts
  assert.equal(v.draft.other, '', 'another chat starts empty'); assert.equal(v.draft.back, 'half a thought for quoter')
  checked.push('3 drafts')

  // ---- 6, 7: quotes
  for (const [bubble, original] of [['u1', 'q1'], ['q2', 'u1'], ['u3', 'q2']]) {
    const q = v.quotes[bubble]
    assert.ok(q, `${bubble} shows a quote`); assert.doesNotMatch(q.text, /unavailable/i, `${bubble}: the original is in this chat`)
    assert.equal(q.role, 'link'); assert.deepEqual(q.flashed, [original], `${bubble}: its click shows ${original} here`)
    assert.equal(q.inView, true, `${bubble}: and the original is in view`)
  }
  assert.equal(v.quotes.contextFolds, 0, 'no Context fold under any bubble'); assert.deepEqual(v.quotes.opened, [], 'no quote navigated away')
  checked.push('6 quotes', '7 context')

  // ---- 8: even padding, with and without a quote and files
  // u5 is a plain message of the user's ("ok"): every other bubble's text starts where its text starts
  const plain = v.padding.u5
  assert.equal(v.padding.u2.typed, true, 'POSITIVE CONTROL: u2 is a typed event, as a message written in the app is')
  for (const [id, b] of Object.entries(v.padding)) {
    near(b.textLeft, b.padLeft, `${id}: its text starts at the bubble's side padding`, 0.6)
    near(b.timeBottom, plain.timeBottom, `${id}: the same room under the time`, 0.6)
    if (b.quoteTop === null) near(b.textTop, plain.textTop, `${id}: as much room above its first line as above a plain message's`, 0.6)
    else {
      near(b.quoteTop, b.padLeft, `${id}: the quote card is as far from the top edge as from the side`, 0.6)
      near(b.quoteLeft, b.padLeft, `${id}: quote left`, 0.6); near(b.quoteRight, b.padLeft, `${id}: quote right`, 0.6)
    }
  }
  checked.push('8 padding')

  // ---- 17: the one check mark; 5: typing
  assert.deepEqual([v.receipts.u1, v.receipts.u2, v.receipts.u3], ['dm-tick t-read', 'dm-tick t-read', 'dm-tick t-read'], 'a read message has the green check')
  assert.deepEqual([v.receipts.u4, v.receipts.u5], ['dm-tick t-sent', 'dm-tick t-sent'], 'one not read yet has the grey check')
  assert.equal(v.receiptsIn, 0, 'the agent\'s messages have no mark')
  for (const [id, r] of Object.entries(v.tickBox)) {
    assert.ok(r.afterTime, `${id}: the mark comes after the time`)
    assert.ok(Math.abs(r.metaHeight - v.metaPlain) <= 0.6, `${id}: the mark does not make the time row taller (${r.metaHeight} against ${v.metaPlain})`)
  }
  assert.equal(v.typing.before, 0, 'POSITIVE CONTROL: no dots before the agent writes')
  assert.deepEqual(v.typing.rows, ['quoter'], 'the row of the agent that writes says typing')
  assert.equal(v.typing.dots, 3, 'three dots under the last message'); assert.equal(v.typing.text, 'quoter is typing…')
  assert.ok(v.typing.underLast, 'under the last message, inside the view')
  assert.equal(v.typing.after, 0, 'gone when the call ends')
  checked.push('17 receipt', '5 typing')

  // ---- 19: a whole card in a bubble is as far from the bubble's edge on every side, in both colours
  for (const id of ['ans0', 'ans1']) {
    const k = v.cards[id]
    assert.ok(k && k.typed && k.card, `POSITIVE CONTROL: ${id} is a whole card in a bubble`)
    near(k.left, k.top, `${id}: as far from the left edge as from the top`, 0.6); near(k.right, k.top, `${id}: and from the right`, 0.6)
    near(k.toTime, k.top, `${id}: and down to the time`, 0.6)
    assert.ok(k.top >= 6, `${id}: with room (${k.top}px)`)
  }
  near(v.cards.ans0.top, v.cards.ans1.top, 'the same in the agent\'s bubble and the user\'s', 0.1)
  checked.push('19 cards')

  // ---- 9, 14: the window, lazy pages, nothing moves
  assert.equal(v.older.button, false, 'no "Load older" button'); assert.equal(v.older.atOpen.drawn, 50, 'the newest 50 are drawn when the chat opens')
  assert.deepEqual(v.older.atOpen.pages, [], 'and no page is asked for at the newest message')
  assert.equal(v.older.atOpen.loaded, 60, 'POSITIVE CONTROL: only the first page of the mailbox is loaded when the chat opens')
  assert.ok(v.older.steps.length >= 6, 'scrolled back through the loaded mail and into older pages')
  for (const s of v.older.steps) assert.ok(Math.abs(s.drift) <= 1, `step to ${s.drawn} drawn (${s.pages} pages): the message in view moved ${s.drift}px`)
  assert.ok(v.older.steps.some(s => s.pages > 0), 'older pages were fetched while scrolling'); assert.ok(v.older.steps.some(s => s.pages === 0 && s.drawn > 50), 'after the loaded mail was drawn')
  // lazily: each step drew at most one page more, and asked the engine for at most one page more
  let was = { drawn: v.older.atOpen.drawn, pages: 0 }
  for (const s of v.older.steps) { assert.ok(s.drawn - was.drawn <= 50, `one page at a time: ${was.drawn} to ${s.drawn}`); assert.ok(s.pages - was.pages <= 1, `one engine page at a time: ${was.pages} to ${s.pages}`); was = s }
  assert.ok(v.older.most > 300, `POSITIVE CONTROL: the scroll-back drew more than 300 (${v.older.most})`)
  assert.ok(v.older.trimmed.drawn <= 100 && v.older.trimmed.atBottom, `back at the newest message the long scroll-back is let go: ${v.older.trimmed.drawn} drawn`)
  assert.equal(v.fill.drawn, 8, 'a chat that did not fill its view loaded its older mail by itself: two messages on the first page, six on older ones')
  assert.equal(v.fill.atBottom, true, 'and stayed at its newest message')
  checked.push('9 lazy pages', '14 window')

  // ---- 11: no "sent to" line
  assert.equal(v.sentLine.state, null, 'nothing under the box after a send'); assert.equal(v.sentLine.bubble, true)
  checked.push('11 sent line')

  // ---- 15: both entries of the bubble's menu
  assert.ok(v.menu.items.some(i => /^View in @worker.s inbox$/.test(i)), `the bubble's menu has the inbox entry (${v.menu.items.join(' | ')})`)
  // the View in group's order (USER 2026-11-25 md7da554ce837; mailidentity VIEW_IN_ORDER): transcript, then the other View in
  assert.equal(v.menu.items[v.menu.items.findIndex(i => /^View in @worker/.test(i)) - 1], 'View in transcript', 'and View in transcript next to it')
  checked.push('15 transcript entry')

  // ---- 12, 13: the sweep
  for (const k of ['x', 'y', 'w', 'h']) near(v.sweep.box[k], v.sweep.column[k], `the sweep covers the chat list's column: ${k}`)
  assert.equal(v.sweep.headPeer, 'worker', 'the open chat stays beside it'); assert.equal(v.sweep.overlays, 1, 'no second surface'); assert.equal(v.sweep.windowBar, false)
  assert.ok(v.sweep.box.y + v.sweep.box.h <= v.sweep.panel.y + v.sweep.panel.h, 'it ends inside the inbox')
  assert.ok(v.sweep.scrolls, 'and its rows scroll inside it')
  for (const id of Object.keys(v.sweep.reference)) {
    const mine = v.sweep.rows[id], theirs = v.sweep.reference[id]
    assert.ok(mine, `${id} is listed`); assert.deepEqual(mine.style, theirs.style, `${id}: the row is styled as on the canvas`)
    near(mine.indent, theirs.indent, `${id}: the same indent`); near(mine.h, theirs.h, `${id}: the same height`)
    assert.equal(mine.nameCut, false, `${id}: its name is not cut`)
  }
  assert.equal(v.sweep.afterEscape.gone, true); assert.equal(v.sweep.afterEscape.closed, 0, 'Escape closed only the sweep'); assert.equal(v.sweep.afterEscape.headPeer, 'worker')
  assert.equal(v.sweep.afterClose.gone, true); assert.equal(v.sweep.afterClose.closed, 0)
  assert.equal(v.sweep.afterPick.gone, true); assert.equal(v.sweep.afterPick.headPeer, 'build-sol', 'picking an agent opens its chat')
  checked.push('12 sweep', '13 agents list')

  // ---- 15: the bubble's menu
  assert.ok(v.menu.items.includes('View in @worker’s inbox'), `the entry is in the menu: ${v.menu.items.join(' | ')}`)
  assert.deepEqual(v.menu.opened, [{ kind: 'mail', org: 'mine', box: 'node', node: 'worker', id: v.menu.id }])
  assert.deepEqual(v.menu.after.mailboxed, [v.menu.id], 'the mail-link router opens worker\u2019s mailbox at it (USER md19d9582d5f0)')
  assert.equal(v.menu.after.headPeer, 'worker', 'the chat stays as it was'); assert.deepEqual(v.menu.after.flashed, [], 'and nothing in it flashes')
  checked.push('15 inbox entry', '15b inbox entry reaches the mailbox')

  // ---- 10: the chats fill their frame: the modal, pinned, and the popped-out layout (the frame's classes; see the header)
  const fills = (f, what) => {
    assert.equal(f.panelPadding, '0px', `${what}: no padding around the panes`); assert.equal(f.mailerBorder, '0px', `${what}: no frame inside the frame`)
    near(f.mailer.x, f.panel.x + f.border, `${what}: the panes start at the panel's left edge`); near(f.mailer.w, f.panel.w - 2 * f.border, `${what}: and fill its width`)
    near(f.mailer.y + f.mailer.h, f.panel.y + f.panel.h - f.border, `${what}: down to its bottom edge`)
  }
  fills(v.modal, 'the modal')
  assert.ok(v.modal.title, 'the modal keeps its title'); near(v.modal.mailer.y, v.modal.title.y + v.modal.title.h, 'the panes start right under the title row')
  assert.ok(v.modal.bar.y >= v.modal.title.y && v.modal.bar.y + v.modal.bar.h <= v.modal.title.y + v.modal.title.h, 'its controls are in the title row')
  for (const control of ['Classic mailbox', 'pin this to the window']) assert.ok(v.modal.controls.includes(control), `the modal keeps "${control}": ${v.modal.controls.join(', ')}`)
  assert.ok(v.modal.controls.length >= 4, 'classic, pop out, pin and close')
  if (v.pinned.real) {
    fills(v.pinned, 'pinned'); assert.equal(v.pinned.title, null, 'pinned, the window bar is the title')
    near(v.pinned.bar.x, v.pinned.panel.x + v.pinned.border, 'the pinned window\'s bar is flush'); near(v.pinned.mailer.y, v.pinned.bar.y + v.pinned.bar.h, 'and the panes start under it')
  }
  fills(v.popout, 'popped out')
  near(v.popout.panel.x, 0, 'the panel starts at the window\'s left edge'); near(v.popout.panel.w, v.popout.window.w, 'and is as wide as the window')
  near(v.popout.panel.y + v.popout.panel.h, v.popout.window.h, 'down to its bottom edge')
  near(v.popout.bar.x, 0, 'the title bar is flush'); near(v.popout.bar.w, v.popout.window.w, 'across the whole window')
  for (const k of ['x', 'y', 'w', 'h']) near(v.popout.sweep.box[k], v.popout.sweep.column[k], `popped out, the sweep covers the list's column: ${k}`)
  assert.equal(v.popout.sweep.overlays, 1, 'popped out, New chat is no second panel'); assert.equal(v.popout.sweep.closed, 0)
  checked.push('10 popped-out layout', '12 sweep popped out')

  // ---- 20: a reply to my own message
  assert.equal(v.own.menuHasReply, true, 'my own bubble\'s menu has Reply'); assert.equal(v.own.bar, 'Thanks, that is all for today.', 'the reply bar shows my message')
  assert.deepEqual(v.own.target, { kind: 'mail', org: 'mine', box: 'user', id: 'sent-1' }, 'the reply names my own message'); assert.equal(v.own.to, 'worker', 'and goes to the chat\'s agent')
  assert.match(v.own.quote, /Thanks, that is all for today\./, 'the new bubble quotes it'); assert.equal(v.own.out, true)
  checked.push('20 reply to my own')

  // ---- 24: the Sender submenu is the agent's own menu
  assert.ok(v.sender.beforeMenu >= 3, 'POSITIVE CONTROL: the menu of the bubble is open'); assert.equal(v.sender.before, false, 'and without a canvas it has no Sender entry')
  assert.equal(v.sender.entry, true, 'an agent\'s bubble has Sender…'); assert.ok(v.sender.items.length >= 4, `the submenu is open: ${v.sender.items.join(' | ')}`)
  for (const entry of ['Copy mention', 'Focus', 'Settings']) assert.ok(v.sender.items.includes(entry), `the agent's own menu: ${entry}`)
  assert.ok(v.sender.items.some(i => /^Open/.test(i)), 'with Open'); assert.deepEqual(v.sender.closedAt, [0, 0], 'closing a menu closed nothing else')
  checked.push('24 sender submenu')

  // ---- 27: Escape removes the file added last, one a press, and nothing else
  assert.deepEqual(v.escape.files, [['notes.txt', 'totals.csv'], ['notes.txt'], []], 'two files, one, none')
  assert.equal(v.escape.text, 'With two files', 'the text stays'); assert.deepEqual(v.escape.closedAt, [0, 0, 0], 'the inbox stays open at each press'); assert.equal(v.escape.peer, 'sparse', 'and so does the chat')
  checked.push('27 escape removes a file')

  // ---- stream privacy ON: a chat row, the chat header, a quote card, typing
  const pv = v.privacy
  assert.ok(pv.off.leaks.length >= 3, `POSITIVE CONTROL: with privacy off the outside name and the two addresses are readable (${pv.off.leaks.length} places)`)
  assert.equal(pv.on.class, true, 'privacy is on')
  for (const [where, s] of Object.entries({ 'the outside sender\'s chat': pv.outside, 'the quoting agent\'s chat': pv.quote })) {
    assert.deepEqual(s.leaks, [], `${where}: no place shows the outside name or an address`)
    assert.ok(s.hidden >= 2, `${where}: POSITIVE CONTROL: they are on the page, hidden (${s.hidden} places)`)
  }
  assert.equal(pv.outside.row.name, true, 'the chat row: the outside sender\'s name'); assert.equal(pv.outside.row.picture, true, 'its letter picture')
  assert.equal(pv.outside.row.preview, true, 'and the address in its preview')
  assert.equal(pv.outside.header.chip, true, 'the chat header: its name'); assert.equal(pv.outside.header.picture, true, 'and its picture')
  assert.equal(pv.outside.bubble, 2, 'the message itself: the mail address and the IP address')
  assert.equal(pv.quote.card.sender, true, 'the quote card: who is quoted'); assert.equal(pv.quote.card.words, 2, 'and both addresses in the quoted words')
  assert.equal(pv.quote.typing.text, 'quoter is typing…', 'typing: an agent of this organization, whose name stream privacy never hides')
  assert.equal(pv.quote.typing.rows.join(), 'quoter')
  assert.equal(pv.after.class, false, 'and off again'); assert.ok(pv.after.leaks.length >= 3, 'everything is readable again')
  checked.push('privacy row', 'privacy header', 'privacy quote card', 'privacy typing')

  // ---- the ticket form: @ticket: lists the tickets as @item: does, and picking one writes @ticket:
  assert.deepEqual(v.ticket.item, ['Check the spring figures', 'Explain the March returns'], 'POSITIVE CONTROL: @item: lists the tickets')
  assert.deepEqual(v.ticket.ticket, v.ticket.item, '@ticket: lists the same tickets in the same order')
  assert.equal(v.ticket.kinds.every(k => !String(k).includes('ticket')), true, 'the engine is asked for its own kind')
  assert.equal(v.ticket.picked, 'see @ticket:mine/spring-figures ', 'picking writes the ticket form')
  checked.push('ticket prefix')

  // ---- one check, grey while sent, green once read, live (USER 2026-11-25 mcc1bee9a2771, ma76e93d834d1)
  const rd = v.read
  assert.equal(rd.before.u5.cls, 'dm-tick t-sent'); assert.equal(rd.before.u5.label, 'Sent: quoter has not read it yet')
  assert.equal(rd.before.u5.color, rd.before.u5.sentColor, 'sent: the darker grey of the panel, --dm-tick-sent (USER 2026-11-25 mb3ad4035c5bb)')
  assert.notEqual(rd.before.u5.sentColor, rd.before.u5.ok, 'POSITIVE CONTROL: the two marks are not one colour')
  assert.equal(rd.before.u1.cls, 'dm-tick t-read'); assert.equal(rd.before.u1.color, rd.before.u1.ok, 'read: the brighter green of the panel, --dm-tick-read')
  // the production bundle's icons carry no test ids: the glyph is compared by its path (MUI Check)
  for (const t of [rd.before.u5, rd.before.u1]) { assert.equal(t.svgs, 1); assert.match(t.icon ?? '', /^M9 16\.17/, 'one check, never a clock or two') }
  assert.equal(rd.before.u5.icon, rd.before.u1.icon, 'the same check, sent and read')
  assert.equal(rd.after.u5.cls, 'dm-tick t-read'); assert.equal(rd.after.u5.color, rd.after.u5.ok, 'the grey check turned green by itself')
  assert.equal(rd.after.u4.cls, 'dm-tick t-sent', 'and only that one')
  checked.push('read tick')

  // ---- the chat stays at its newest message; the jump button whenever it is not stuck
  const st = v.stick
  assert.ok(st.bottom.gap <= 1 && !st.bottom.button, 'POSITIVE CONTROL: at the newest message, no button')
  assert.equal(st.received.last, 'arrived-1'); assert.ok(st.received.gap <= 1, `a received message keeps it at the newest (${st.received.gap} px)`)
  assert.equal(st.received.button, false)
  assert.ok(Math.abs(st.up50.gap - 50) <= 2 && !st.up50.button, 'within 80 px it is stuck: no button')
  assert.ok(Math.abs(st.up150.gap - 150) <= 2 && st.up150.button, 'from 80 px it is not stuck: the button')
  assert.equal(st.up150.label, 'Jump to the newest message'); assert.ok(st.up150.box.hit, 'the button is on top')
  assert.deepEqual([st.up150.box.right, st.up150.box.bottom, st.up150.box.w, st.up150.box.h], [22, 16, 40, 40], 'Hubchat\'s 40 px button at the lower right')
  // round, as the browser draws it inside the settings window (whose `.settings button` once squared it)
  assert.deepEqual(st.up150.box.style, { tl: '50%', br: '50%', pl: '0px', fs: '20px' }, 'a circle: computed corners 50%, no padding, the 20 px glyph')
  assert.ok(st.receivedUp.gap >= 150 && st.receivedUp.button, 'scrolled up, a received message leaves the reader where they are')
  assert.ok(st.jumped.gap <= 1 && !st.jumped.button && st.jumped.last === 'arrived-2', 'the button goes to the newest message')
  assert.ok(st.farUp.gap > 1000 && st.farUp.button, 'POSITIVE CONTROL: far up before sending')
  assert.ok(st.sent.gap <= 1 && !st.sent.button && /Sent from far up the chat/.test(st.sent.lastText), `sending goes to the newest message (${st.sent.gap} px)`)
  checked.push('stick to bottom', 'jump button')

  // ---- View in transcript flashes the row it lands on (USER 2026-11-25 m6b1d486777c1)
  assert.deepEqual(v.flash.focused.slice(-1), ['quoter'], 'it goes to quoter\'s desk')
  assert.equal(v.flash.row.flashing, 1, 'one row flashes'); assert.ok(v.flash.row.inView, 'in view')
  assert.match(v.flash.row.text, /orgtree_message/, 'the line of the call that sent q2 (desk.tsx: the call, else the message)')
  assert.match(v.flash.row.cls, /\btline\b/, 'a tool line')
  assert.notEqual(v.flash.row.bg, 'rgba(0, 0, 0, 0)', 'with the located-mail highlight')
  assert.equal(v.flash.after, 0, 'once: gone when its animation ends')
  checked.push('transcript flash')
  // ---- the late case: the desk was empty when asked; its rows came with a later refresh (4.7.0 bounce)
  const late = v.lateFlash
  assert.equal(late.emptyBefore, true, 'POSITIVE CONTROL: quoter\'s desk showed no transcript when asked')
  assert.equal(late.row.flashing, 1, 'the call line flashes when it comes in'); assert.match(late.row.text, /orgtree_message/)
  assert.ok(late.row.inView && late.settled.inView, `the desk went to it: in view as it flashes (${late.row.top}..${late.row.bottom}) and after (${late.settled.top}..${late.settled.bottom})`)
  assert.deepEqual(late.toasts, [], 'the empty desk did not say the message was gone')
  checked.push('late transcript row')
  // ---- an arriving message never closes an open context menu (USER 2026-11-25 m1f747c2836f9)
  const mn = v.menus
  assert.ok(mn.gapBefore <= 1, `POSITIVE CONTROL: the chat was at its newest message (${mn.gapBefore} px)`)
  assert.equal(mn.open, 1, 'POSITIVE CONTROL: the bubble menu opened')
  assert.equal(mn.after.menus, 1, 'a message arrived and the menu is still open')
  assert.ok(mn.after.gap > 1, `the chat held still under it, the new message below (${mn.after.gap} px)`)
  assert.equal(mn.closed.menus, 0, 'Escape closes the menu')
  assert.ok(mn.closed.gap <= 1 && mn.closed.last === 'arrived-3', `and the chat goes to the newest message (${mn.closed.gap} px, ${mn.closed.last})`)
  checked.push('menu stays open')
  // ---- the sent check a darker grey, the read check a brighter green, every theme; the clock unchanged (section 23)
  {
    // a computed colour: rgb()/rgba(), or color(srgb r g b / a) for a color-mix; a translucent one over the bubble
    const parse = (c) => {
      let m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/)
      if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] }
      m = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/)
      if (m) return { rgb: [+m[1] * 255, +m[2] * 255, +m[3] * 255], a: m[4] === undefined ? 1 : +m[4] }
      throw new Error(`an unread colour: ${c}`)
    }
    const over = (c, under) => { const f = parse(c), u = parse(under).rgb; return f.rgb.map((v, i) => v * f.a + u[i] * (1 - f.a)) }
    const lum = (c) => { const [r, g, b] = c.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q); return (y + 0.05) / (x + 0.05) }
    const OLD_READ = { charcoal: [111, 211, 119], 'obsidian-black': [111, 211, 119], light: [35, 114, 45], 'solarized-light': [35, 114, 45] } // --ok before
    const seen = {}
    for (const theme of ['charcoal', 'light', 'solarized-light', 'obsidian-black']) {
      const { newest, higher } = v.tickColours[theme]
      const of = (rows, cls) => rows.filter(r => r.inView).find(r => r.cls === `dm-tick ${cls}`)
      const list = (rows) => rows.map(r => r.cls + (r.inView ? '' : ' (off)')).join(', ')
      const read = of(newest, 't-read'), clock = of(newest, 't-queued'), sent = of(higher, 't-sent')
      assert.ok(read && clock, `${theme}: a read check and the clock on screen at the newest message (${list(newest)})`)
      assert.ok(sent, `${theme}: the sent check on screen once u4 is in view (${list(higher)})`)
      assert.equal(clock.label, 'Sending', `${theme}: the clock is the held send`)
      const bubble = parse(sent.bubble).rgb, readBubble = parse(read.bubble).rgb
      const s = over(sent.color, sent.bubble), r = over(read.color, read.bubble), wasSent = over(sent.time, sent.bubble)
      assert.ok(Math.abs(s[0] - s[1]) < 1 && Math.abs(s[1] - s[2]) < 1, `${theme}: the sent check is grey (${sent.color})`)
      assert.ok(lum(s) < lum(wasSent), `${theme}: darker than the grey of the time it had (${sent.color} against ${sent.time})`)
      assert.ok(r[1] > r[0] + 80 && r[1] > r[2] + 50, `${theme}: the read check is green (${read.color})`)
      assert.ok(lum(r) > lum(OLD_READ[theme]), `${theme}: brighter than the old read green (${read.color})`)
      assert.ok(contrast(s, bubble) >= 3, `${theme}: sent ${contrast(s, bubble).toFixed(2)}:1 on the bubble ${sent.bubble}`)
      assert.ok(contrast(r, readBubble) >= 3, `${theme}: read ${contrast(r, readBubble).toFixed(2)}:1 on the bubble ${read.bubble}`)
      assert.equal(clock.color, clock.time, `${theme}: the clock keeps the grey of the time`)
      seen[theme] = { sent: sent.color, read: read.color, clock: clock.color, bubble: sent.bubble,
        sentContrast: +contrast(s, bubble).toFixed(2), readContrast: +contrast(r, readBubble).toFixed(2) }
    }
    assert.notEqual(seen.charcoal.sent, seen.light.sent, 'POSITIVE CONTROL: the theme switch reached the ticks')
    const rel = v.tickColours.released
    assert.equal(rel.filter(r => r.cls === 'dm-tick t-queued').length, 0, 'the engine took it: no clock left')
    const last = rel[rel.length - 1]
    assert.equal(last.cls, 'dm-tick t-sent', `the clock became the sent check (${rel.map(r => r.entry + ':' + r.cls).join(', ')})`)
    assert.ok(last.inView, 'on screen, at the newest message')
    v.tickSeen = seen
  }
  checked.push('tick colours')
  // ---- 24. "loading older messages…" never flickers; the clock bubble keeps its size and place (frame trace)
  {
    const send = v.olderSend, short = v.olderShort
    assert.ok(send.length > 60 && short.length > 120, `POSITIVE CONTROL: frames were traced (${send.length}, ${short.length})`)
    assert.deepEqual(send.filter(f => f.older).map(f => f.t), [], 'no frame of a send drew "loading older messages"')
    assert.deepEqual(short.filter(f => f.older).map(f => f.t), [], 'no frame of a short chat drew it, over seven seconds')
    const clock = send.filter(f => f.tick === 'dm-tick t-queued'), sentF = send.filter(f => f.tick === 'dm-tick t-sent' && f.t > (clock[clock.length - 1]?.t ?? Infinity))
    assert.ok(clock.length > 5 && sentF.length > 5, `POSITIVE CONTROL: frames with the clock (${clock.length}) and then the sent check (${sentF.length})`)
    const span = (fs, k) => Math.max(...fs.map(f => f[k])) - Math.min(...fs.map(f => f[k]))
    const lastClock = clock[clock.length - 1], firstSent = sentF[0]
    assert.ok(Math.abs(lastClock.h - firstSent.h) <= 0.5, `the bubble keeps its height from clock to sent (${lastClock.h} -> ${firstSent.h} px)`)
    assert.ok(Math.abs(lastClock.top - firstSent.top) <= 0.5, `and its place (${lastClock.top} -> ${firstSent.top} px)`)
    assert.ok(span(sentF, 'h') <= 0.5 && span(sentF, 'top') <= 0.5, 'and holds still once sent')
    const between = send.filter(f => f.t >= lastClock.t && f.t <= firstSent.t)
    assert.ok(between.every(f => f.n === lastClock.n), `no frame with an extra or a missing bubble at the swap (${between.map(f => f.n).join(',')})`)
    v.olderSummary = { sendFrames: send.length, shortFrames: short.length, clockH: lastClock.h, sentH: firstSent.h, clockTop: lastClock.top, sentTop: firstSent.top, shortPages: v.olderShortPages }
  }
  checked.push('no loading-older flicker')
  // ---- 25. View in classic inbox; 26. the window's name follows the view, and the switch reads "classic inbox"
  {
    const c = v.classic
    assert.ok(c.target, 'POSITIVE CONTROL: a message of quoter to click')
    assert.ok(c.menu.includes('View in classic inbox'), `the menu has it (${c.menu.join(' | ')})`)
    assert.match(c.landed.folder ?? '', /^inbox/i, `on the Inbox folder (${c.landed.folder})`)
    assert.ok(c.landed.row && c.landed.row.includes(c.target.text.slice(0, 20).trim()) || (c.landed.reading ?? '').includes(c.target.text.slice(0, 20).trim()),
      `that message is selected (${c.landed.row})`)
    assert.ok(c.landed.inView, 'and its row is in view')
    assert.equal(c.chats.title, 'Chats'); assert.equal(c.classic.title, 'Your inbox'); assert.equal(c.back.title, 'Chats', 'and back, live')
    for (const s of [c.chats, c.classic, c.back]) {
      assert.equal(s.label, 'classic inbox')
      assert.equal(s.clipped, false, 'the switch label is not cut')
      assert.notEqual(s.inside, false, 'and sits inside the title bar')
    }
  }
  checked.push('view in classic inbox', 'window title')
  // ---- 27. the take-back x; 28. the notice toggle's slashed bell and sparser dashes
  {
    const tb = v.takeBack
    const u4 = tb.before.find(m => m.entry === 'u4')
    assert.ok(u4 && u4.x, `POSITIVE CONTROL: u4, unread, has the x (${JSON.stringify(tb.before.filter(m => m.x).map(m => m.entry))})`)
    assert.equal(u4.title, 'retract (undelivered)', 'the desk’s tooltip')
    assert.ok(u4.inside, 'inside its bubble')
    // USER 2026-11-25 m0c7ae1b9c32d: the x in the top right, the read arrow where it is without it
    assert.ok(u4.xAt.top <= 6 && u4.xAt.right <= 6, `the x is over the top-right corner (${JSON.stringify(u4.xAt)})`)
    const plain = tb.before.find(m => !m.x && m.tickAt && /t-(sent|read)/.test(m.tick ?? ''))
    assert.ok(plain, 'POSITIVE CONTROL: a message of the user's without the x')
    assert.ok(Math.abs(u4.tickAt.right - plain.tickAt.right) < 0.5 && Math.abs(u4.tickAt.bottom - plain.tickAt.bottom) < 0.5,
      `the tick sits in the same place with and without the x (${JSON.stringify(u4.tickAt)} vs ${plain.entry} ${JSON.stringify(plain.tickAt)})`)
    const readWithX = tb.before.filter(m => m.x && /t-read/.test(m.tick ?? ''))
    assert.deepEqual(readWithX.map(m => m.entry), [], 'no read message has it')
    assert.equal(tb.after.some(m => m.entry === 'u4'), false, 'the bubble went')
    const del = result.engineCalls.filter(c => c.method === 'DELETE')
    assert.deepEqual(del.map(c => c.path), ['/api/orgs/mine/nodes/quoter/mail/u4'], 'the desk’s own call, once')
    assert.deepEqual(tb.toasts.filter(t => /error/.test(t)), [], 'no error')
    // the bundle is a production build (no data-testid on icons): name each by its MUI path
    const iconByPath = new Map(['NotificationsOutlined', 'NotificationsOffOutlined', 'NotificationsActiveOutlined', 'NotificationsActive'].map(n =>
      [readFileSync(path.join(dependencies, '@mui/icons-material', n + '.mjs'), 'utf8').match(/d: "([^"]+)"/)[1], n + 'Icon']))
    const named = st => { st.icons = st.icons.map(d => iconByPath.get(d) ?? `unknown path ${String(d).slice(0, 24)}`); return st }
    for (const t of Object.values(v.notice)) { named(t.off); named(t.on) }
    for (const [theme, { off, on }] of Object.entries(v.notice)) {
      assert.equal(off.armed, false); assert.equal(on.armed, true, `${theme}: POSITIVE CONTROL: armed`)
      assert.deepEqual(off.icons, ['NotificationsOutlinedIcon'], `${theme}: off is the plain bell`)
      assert.deepEqual(on.icons, ['NotificationsOffOutlinedIcon'], `${theme}: on is the slashed bell (${on.icons})`)
      assert.deepEqual(on.rect, off.rect, `${theme}: nothing moves when it toggles`)
      assert.equal(on.borderWidth, off.borderWidth, `${theme}: the same border width`)
      assert.match(on.borderColor, /rgba\(0, 0, 0, 0\)|transparent/, `${theme}: the border box stays, drawn over (${on.borderColor})`)
      assert.match(on.dashes.mask, /stroke-dasharray='4 7'|stroke-dasharray=%274 7%27|4 7/, `${theme}: the sparser dashes`)
      assert.doesNotMatch(on.dashes.bg, /rgba\(0, 0, 0, 0\)/, `${theme}: in a colour (${on.dashes.bg})`)
    }
  }
  checked.push('take-back x', 'notice toggle icon and dashes')
  // ---- 29. View in chat from the classic mailbox
  {
    const vc = v.viewChat
    assert.ok(vc.row, 'POSITIVE CONTROL: a row of quoter\'s in the classic mailbox')
    assert.ok(vc.menu.includes('View in chat'), `the row's menu has View in chat (${vc.menu})`)
    assert.equal(vc.landed.classicTicked, false, 'the chats are on')
    assert.equal(vc.landed.title, 'Chats')
    assert.equal(vc.landed.peer, 'quoter', 'quoter\'s chat')
    assert.ok(vc.landed.entry, 'a message is flashed')
    assert.ok(vc.landed.inView, 'and in view')
    assert.ok(vc.landed.text && vc.row.text.includes(vc.landed.text.trim().slice(0, 20)), `the same message (${vc.landed.text} / ${vc.row.text})`)
    // the whole row lights up (USER mba561e16fb40): tinted, reaching both edges of the chat, the bubble without its own ring
    const hl = vc.landed.row
    assert.ok(hl, 'the flashed row was measured')
    assert.doesNotMatch(hl.bg, /^rgba\(0, 0, 0, 0\)$|^transparent$/, `the row is tinted (${hl.bg})`)
    const spread = Number(hl.shadow.match(/(\d+(?:\.\d+)?)px\s*$/)?.[1] ?? 0)
    assert.ok(spread >= Math.max(hl.leftGap, hl.rightGap), `the tint reaches both edges of the chat (spread ${spread}px, gaps ${hl.leftGap}/${hl.rightGap}px)`)
    assert.match(hl.clip, /inset/, `clipped to the row's height (${hl.clip})`)
    assert.ok(hl.bubbleShadow === 'none' || !hl.bubbleShadow, `no second ring on the bubble (${hl.bubbleShadow})`)
    checked.push('view in chat', 'whole-row highlight')
  }
  // View in transcript goes to the agent's desk, which closes the inbox (DmPanel focusAgent): that once, and only then
  assert.equal(v.flash.closedBefore, 0, 'the inbox was never closed before View in transcript')
  assert.equal(v.end.confirms, 0); assert.equal(v.end.closed, 2, 'closed twice, once by each View in transcript')
}
console.log(JSON.stringify({ ok: true, out: evidence, pinned: result.value.pinned?.real ? 'the app\'s own pin' : 'not pinned in this page', shots: result.value.shots.length, checked, ticks: result.value.tickSeen ?? null, older: result.value.olderSummary ?? null, consoleErrors: errors.length, session: result.session, guards: result.guards }))
