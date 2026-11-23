// Captures the user's mailbox panel as chats (dm-panel-probe.tsx) in the rig's
// guarded offscreen Electron (muted, off the real clipboard), walking every
// ruling of the 4.7.0 revamp (dm-panel-visual.cjs), and checks what it
// measured with --expect.
//
//   node dm-panel-visual.mjs <build-output> <evidence> <node_modules> [--expect]
//
// Launch it from a Session 0 turn, the whole command (bundling included) under
// tests/joblimit.ps1 and a @build-slot permit. Everything the page asks goes
// to the fake engine below: a synthetic organization, no real mail or names.
// The receipt (evidence/result.json) carries the harness's guards, the
// Electron process's PID and SessionId, and every request the page made.
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
// the probe and the CSS its components import (dm.css among them); the app's
// own sheet goes first, as in the real bundle
const built = await esbuild.build({ entryPoints: [path.join(here, 'dm-panel-probe.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning',
  metafile: true, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' } })
esbuild.stop()
// one React in the bundle, or the page mounts nothing (the C capture collision)
const reacts = Object.keys(built.metafile.inputs).filter(f => /node_modules[\\/]react[\\/]index\.js$/.test(f))
assert.equal(reacts.length, 1, `one React root in the bundle: ${JSON.stringify(reacts)}`)
let componentCss = ''
try { componentCss = readFileSync(path.join(output, 'probe.css'), 'utf8') } catch { /* no component imported a sheet */ }
const css = readFileSync(path.join(here, '../src/styles.css'), 'utf8') + '\n' + componentCss
  + '\n.dm-probe-bar{position:fixed;top:8px;left:12px;z-index:5;display:flex;align-items:center;gap:10px;font-size:12px}\n'
assert.match(css, /\.dm-bubble\.notice/, 'the chat sheet is in the page')

// ------------------------------------------------------------ the fake engine
const now = Date.now(), M = 60e3, H = 60 * M, D = 24 * H
const ago = ms => new Date(now - ms).toISOString()
const USER = '@user'
const grant = grantee => ({ grantee, grantor: USER, granted_at: ago(9 * D), reason: '' })
const mail = (id, from, when, body, extra = {}) => ({ id, from, at: ago(when), kind: 'message', body, ...extra })
const sent = (id, to, when, body, extra = {}) => ({ id, from: USER, to, at: ago(when), kind: 'message', body, ...extra })
const world = {
  audiences: [grant('worker'), grant('solo'), grant('crew')],
  requests: [
    { from: 'scout', target: USER, currently_at: USER, reason: 'to report the nightly check to you directly', at: ago(20 * M) },
    { from: 'drafter', target: USER, currently_at: USER, reason: 'to ask you about the wording of the 4.7.0 notes', at: ago(40 * M) },
  ],
  delivered: [
    mail('w1', 'worker', 27 * H, 'The export finished: **214 rows**, 3 of them flagged.\n\n- 2 duplicates\n- 1 with an empty date'),
    mail('w2', 'worker', 3 * H, 'The nightly check passed (38 of 38).', { notice: true }),
    mail('w3', 'worker', 2 * H, 'Please confirm the release window: Tuesday 10:00 or Wednesday 14:00?', { kind: 'request' }),
    mail('l1', 'lead', 5 * H, 'Plan for today: finish the 4.7.0 notes, then the review of the export.'),
    mail('so1', 'solo', 25 * H, 'The import is at 80%. Two files need a second pass.'),
    mail('mem1', 'member', 3 * D, 'The crew finished the weekly report.'),
    // member holds the user's job in crew's queue and answered its copy of it
    mail('ca1', 'member', 3.5 * H, 'Two numbers were off: the March total and the returns. Both are fixed.',
      { reply_to: { id: 'cj1c', kind: 'mail', from: USER, at: ago(4 * H), gist: 'Please check the numbers in the weekly report.', org: 'mine', box: 'user' } }),
    mail('sys0', '@system', 2 * D, 'Orgtree restarted after an update.', { notice: true, kind: 'system' }),
  ],
  pending: [
    mail('w4', 'worker', 90 * M, 'The summary and the chart are attached.', { attachments: [
      { name: 'summary.pdf', path: 'outbox/summary.pdf', bytes: 48211 }, { name: 'chart.png', path: 'outbox/chart.png', bytes: 1532 }] }),
    mail('w5', 'worker', 85 * M, 'One open point: the **beta** list has 3 addresses that bounced.'),
    mail('sys1', '@system', 10 * M, 'Usage limit reached on one account: 2 agents were frozen until 20:00.', { kind: 'decision' }),
  ],
  sent: [
    sent('s1', 'worker', 26.9 * H, 'Thanks. Send me the summary when the review is done.'),
    sent('s2', 'solo', 26 * H, 'How is the import going?'),
    // a megaphone send to crew: one copy per member, sharing one send id
    sent('g1a', 'member', 6 * H, 'The standup moves to 10:00 from tomorrow.', { megaphone: { name: 'crew', send: 'g1', to: 2 } }),
    sent('g1b', 'mate', 6 * H, 'The standup moves to 10:00 from tomorrow.', { megaphone: { name: 'crew', send: 'g1', to: 2 } }),
    // the user's message to crew is a job in its queue; the engine keeps a copy for the member it handed it to
    sent('cj1', 'crew', 4 * H, 'Please check the numbers in the weekly report.', { queue: { held_by: 'member', ack: true } }),
    sent('cj1c', 'member', 4 * H - 4000, 'Please check the numbers in the weekly report.', { queue: { job: { id: 9, name: 'crew', mail: 'cj1', ack: true } } }),
    sent('cj2', 'crew', 3.4 * H, 'Also: who owns the chart on page 3?'),
  ],
}
const everyMail = () => [...world.delivered, ...world.pending, ...world.sent]
/** every state-changing request, in order: what the page really asked the engine */
const calls = []
// a 2x2 grey PNG, so the image attachment has something to show
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYGD4z8DAwMAEYoAAAA0DAQGd2HvOAAAAAElFTkSuQmCC', 'base64')
const html = `<!doctype html><meta charset="utf-8"><title>dm panel probe</title><link rel="stylesheet" href="/probe.css">`
  + `<div id="root"></div><script>window.__dmAt=${JSON.stringify(ago(30 * M))}</script><script src="/probe.js"></script>`
let seq = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
  if (url.pathname === '/') return send(html, 'text/html')
  if (url.pathname === '/probe.js') return send(readFileSync(path.join(output, 'probe.js')), 'text/javascript')
  if (url.pathname === '/probe.css') return send(css, 'text/css')
  // the page script's own view of what the page has asked so far (not an engine route)
  if (url.pathname === '/__calls') return send(calls)
  // the probe's tree takes its unread count from here, as the engine's tree counts its own inbox
  if (url.pathname === '/__state') return send({ unread: world.pending.length })
  if (!url.pathname.startsWith('/api/')) return send('not found', 'text/plain', 404)
  let body = null
  if (req.method !== 'GET') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.length } }
    calls.push({ method: req.method, path: url.pathname, body })
  }
  const p = url.pathname.replace(/^\/api\/orgs\/mine/, '')
  if (!url.pathname.startsWith('/api/orgs/mine')) return send({})
  if (p === '/audiences') {
    if (req.method === 'POST') {
      if (body.action === 'revoke') world.audiences = world.audiences.filter(g => g.grantee !== body.node)
      if (body.action === 'grant') { world.audiences.push(grant(body.node)); world.requests = world.requests.filter(r => r.from !== body.node) }
      if (body.action === 'deny') world.requests = world.requests.filter(r => r.from !== body.node)
      return send({ ok: true })
    }
    return send({ audiences: world.audiences, requests: world.requests })
  }
  if (p === '/inbox/read') {
    const read = world.pending.filter(m => body.ids.includes(m.id))
    world.pending = world.pending.filter(m => !body.ids.includes(m.id)); world.delivered.push(...read)
    return send({ read: read.length })
  }
  if (p === '/inbox/clear') { world.delivered.push(...world.pending); world.pending = []; return send({ ok: true }) }
  const message = p.match(/^\/nodes\/([^/]+)\/message$/)
  if (message && req.method === 'POST') {
    const id = `sent-${++seq}`
    let to = decodeURIComponent(message[1]), queue
    // a reply keeps a small snapshot of what it answers, as the engine's sent mail does
    const answered = body.target?.kind === 'mail' ? everyMail().find(m => m.id === body.target.id) : null
    // the user's follow-up to their own job in a project goes to the job's holder, marked as following
    // that job (engine follow_up_plain, held and not acknowledged)
    if (answered && answered.from === USER && answered.to === to && answered.queue?.held_by && !answered.queue.acked_at) {
      queue = { job: { id: 9, name: to, mail: answered.id }, follow_up_to: answered.id }
      to = answered.queue.held_by
    }
    world.sent.push({ id, from: USER, to, at: new Date().toISOString(), kind: 'message', body: body.text, notice: !!body.notice, ...(queue ? { queue } : {}),
      ...(answered ? { reply_to: { id: answered.id, kind: 'mail', from: answered.from, at: answered.at, gist: answered.body.slice(0, 120), org: 'mine', box: 'user' } } : {}) })
    return send({ accepted: true, id, ref: `@mail:${id}` })
  }
  if (/^\/nodes\/[^/]+\/batch$/.test(p)) return send({ resolved: 'ok' })
  if (/^\/nodes\/[^/]+\/file$/.test(p)) return /\.png$/.test(url.searchParams.get('path') ?? '') ? send(PNG, 'image/png') : send('synthetic file', 'application/octet-stream')
  if (/\/transfers$/.test(p)) return send({ transfers: [], next_cursor: null })
  if (p === '/inbox') return send({ pending: world.pending, delivered: world.delivered, sent: world.sent, next_cursor: null })
  return send({})
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let result
try {
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '', run: { ui: 'dm-panel-probe' } },
    path.join(here, 'dm-panel-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 300000,
      electron: path.join(dependencies, 'electron/dist/electron.exe') })
} finally { server.close() }
result.engineCalls = calls
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

/** the path an icon of the app's set draws, read from the package the bundle used */
const drawn = name => /d:\s*"([^"]+)"/.exec(readFileSync(path.join(dependencies, '@mui/icons-material', `${name}.js`), 'utf8'))?.[1]
const BUBBLE = drawn('ChatBubbleOutlineOutlined'), MAIL = drawn('MailOutlined')
// Electron's own notice about a page served without a content security policy: the harness's page, not the app
const errors = result.consoleErrors.filter(e => !/Electron Security Warning/.test(e))
const checked = []
if (flag === '--expect') {
  const v = result.value
  const posts = re => calls.filter(c => c.method === 'POST' && re.test(c.path))
  const onScreen = (box, what) => { assert.ok(box && box.w > 0 && box.h > 0 && box.x >= 0 && box.y >= 0, `${what} is laid out on screen: ${JSON.stringify(box)}`) }
  // where it ran: the harness's own guards, and Session 0
  assert.equal(result.session.electron, 0, 'the window ran in Session 0')
  assert.equal(result.guards.muted, true); assert.equal(result.guards.clipboardStub, true); assert.equal(result.guards.clipboardPermissions, 'denied')
  assert.deepEqual(errors, [], 'no console errors')
  assert.ok(BUBBLE && MAIL && BUBBLE !== MAIL, 'the two icons are known')
  assert.equal(v.start.hasFocus, false, 'the walk starts with the window inactive (an offscreen window has no user)')

  // ---- 6: newest first, each with its unread count; a chat is bubbles, the user's on the right
  for (const [theme, s] of Object.entries(v.themes)) {
    assert.deepEqual(s.rows.map(r => r.peer), ['scout', 'drafter', '@system', 'lead', 'worker', 'crew', 'member', 'mate', 'solo'], `${theme}: the two audience requests, then newest message first`)
    assert.deepEqual(s.rows.filter(r => r.request).map(r => r.peer), ['scout', 'drafter'], `${theme}: the requests are marked`)
    assert.equal(s.strip, 0, `${theme}: no request strip above the chats`)
    const of = peer => s.rows.find(r => r.peer === peer)
    assert.equal(of('worker').unread, '2'); assert.equal(of('@system').unread, '1'); assert.equal(of('lead').asks, '?')
    assert.equal(of('@system').name, 'Orgtree')
    for (const r of s.rows) onScreen(r.box, `${theme} row ${r.peer}`)
    assert.equal(s.head.peer, 'worker', 'it opens on the chat with the oldest unread mail')
    assert.deepEqual(s.bubbles.map(b => b.id), ['w1', 's1', 'w2', 'w3', 'w4', 'w5'], 'oldest first')
    const out = s.bubbles.find(b => b.id === 's1'), incoming = s.bubbles.find(b => b.id === 'w1')
    assert.ok(out.box.x + out.box.w > incoming.box.x + incoming.box.w, `${theme}: the user's bubble sits to the right`)
    assert.ok(incoming.box.x - s.timeline.x < 80, `${theme}: an incoming bubble starts at the left`)
    assert.notEqual(out.background, incoming.background, `${theme}: the two sides are different fills`)
    // 5, as changed on the prototype (USER 2026-11-23 mae2b1aa37a9b, m7012356beca4): a notice keeps its
    // fill; its border is the chat background's colour, thick, with wide gaps; it wears no label
    const notice = s.bubbles.find(b => b.id === 'w2')
    assert.equal(notice.notice, true); assert.equal(notice.label, null, `${theme}: a notice wears no label`)
    assert.equal(notice.background, incoming.background, `${theme}: a notice has the fill of any incoming bubble`)
    assert.ok(notice.edge, `${theme}: a notice has its drawn border`)
    assert.equal(notice.edge.background, s.chatBackground, `${theme}: in the chat background's colour`)
    assert.notEqual(notice.edge.background, notice.background, `${theme}: which is not the bubble's fill, so it shows`)
    assert.match(decodeURIComponent(notice.edge.mask), /stroke-width='4' stroke-dasharray='7 7'/, `${theme}: 2px inside the edge, 7px dashes, 7px gaps`)
    assert.equal(incoming.edge, null, `${theme}: an ordinary message has none`)
    assert.equal(s.bubbles.find(b => b.id === 'w3').label, 'Request')
    assert.equal(s.bubbles.find(b => b.id === 'w4').files.length, 2, 'two files on the message')
    assert.match(s.bubbles.find(b => b.id === 'w4').files[0], /summary\.pdf/)
    assert.equal(s.newmark, '2 new messages')
    assert.equal(s.bellIcon, BUBBLE, 'the panel\'s icon is a chat bubble')
    assert.equal(s.titleIcon, BUBBLE); assert.equal(s.title, 'Your inbox')
    assert.equal(s.bell, '1', 'the header count is today\'s rule: the open request, ahead of 3 unread')
    assert.match(s.bellTitle, /1 ask waiting on your answer · 3 unread/)
    onScreen(s.composer, `${theme} message box`)
    checked.push(theme)
  }
  assert.deepEqual(v.hover, ['Reply', 'Copy message text'])

  // ---- seeing a chat reads it, once the window has the user
  assert.deepEqual(v.read.inactive, { hasFocus: false, visibility: 'visible', badge: '2', bell: '1', reads: [] }, 'nothing is read while the window is not the user\'s')
  assert.equal(v.read.active.hasFocus, true); assert.equal(v.read.active.badge, null)
  assert.deepEqual(v.read.active.reads, [['w4', 'w5']], 'one save for the whole chat')
  assert.equal(v.read.active.newmark, '2 new messages', 'the new-messages line stays while the chat is on screen')
  assert.equal(v.read.system.badgeBefore, '1'); assert.equal(v.read.system.badgeAfter, null)
  // w3 is the mail the reply answered: a reply marks its original read, as in the classic mailbox
  assert.deepEqual(posts(/\/inbox\/read$/).map(c => c.body.ids), [['w4', 'w5'], ['w3'], ['sys1'], ['ca1']], 'each chat read once, when seen; a reply reads what it answers')
  checked.push('read on view')

  // ---- 1: a top-level agent's chat cannot be closed, and says why
  assert.equal(v.lead.closeDisabled, true); assert.equal(v.lead.rowClosable, false)
  assert.match(v.lead.closeTitle, /lead is a top-level agent: it always has a direct line to you, so this chat can't be closed\./)
  assert.equal(v.member.closeDisabled, true, 'a top-level agent inside a project is top-level too')
  assert.equal(v.system.head.closeDisabled, true); assert.match(v.system.head.closeTitle, /can't be closed/)
  // …with a grant: close revokes the grant, the chat stays, and the tooltip said so
  assert.equal(v.solo.before.closeDisabled, false)
  assert.match(v.solo.before.closeTitle, /Revoke solo's audience grant\. The chat stays: a top-level agent always has a direct line to you\./)
  assert.equal(v.solo.stillListed, true); assert.equal(v.solo.stillOpen, true); assert.equal(v.solo.after.closeDisabled, true)
  assert.ok(v.solo.before.badges.some(b => /audience/.test(b)) && !v.solo.after.badges.some(b => /audience/.test(b)), 'its audience badge goes')
  // an audience chat closes, revoking exactly that grant
  assert.equal(v.worker.header.closeDisabled, false)
  assert.match(v.workerClose.title, /Close this chat: revoke worker's audience with you\. Its history is kept\./)
  assert.equal(v.workerClose.listedAfter, false)
  assert.deepEqual(posts(/\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'solo' }, { action: 'revoke', node: 'worker' }, { action: 'grant', node: 'helper' },
    { action: 'deny', node: 'drafter', target: USER }, { action: 'grant', node: 'scout' }])
  // ---- 2: no confirmation
  assert.equal(v.end.confirms, 0, 'closing asked for no confirmation'); assert.deepEqual(v.end.toasts, [])
  checked.push('close rules')

  // ---- 3: New chat is the agents list, and picking grants an audience
  assert.equal(v.picker.title, 'New chat')
  assert.deepEqual(v.picker.rows, ['lead', 'worker', 'helper', 'scout', 'drafter', 'solo', 'crew', 'member', 'mate'])
  assert.equal(v.picker.filter, true); assert.deepEqual(v.picker.active, { checked: false }); assert.match(v.picker.archivedToggle, /show 1 archived/)
  assert.ok(v.picker.withArchived.rows.includes('archivist') && !v.picker.rows.includes('archivist'), 'the archived fold')
  assert.deepEqual(v.picker.activeOnly.rows, ['lead', 'solo'], 'only agents running a turn')
  assert.deepEqual(v.picker.filtered.rows, ['lead', 'helper'], 'the filter box: the match, under its superior')
  assert.deepEqual(v.picker.open, ['lead', 'solo', 'crew', 'member', 'mate'], 'the agents and the project that can already write to the user are marked')
  assert.deepEqual(v.search.rows, ['solo'], 'the chat search')
  assert.equal(v.picker.opened.peer, 'helper'); assert.equal(v.picker.closedAfterPick, true)
  assert.ok(v.picker.opened.badges.some(b => /audience/.test(b)), 'the new chat holds an audience')
  checked.push('new chat')

  // ---- 4: a request is one bubble per tab with one submit, through the ordinary route
  assert.deepEqual(v.request.kinds, ['Question', 'Question', 'Scope request']); assert.equal(v.request.submits, 1); assert.equal(v.request.tabstrip, false)
  assert.deepEqual(v.request.other, [true, false, false]); assert.deepEqual(v.request.freeResponse, [false, true, false])
  // (a question with options offers Other, one without is a free answer: each question takes a typed answer)
  assert.equal(v.request.skipAll, true)
  assert.equal(v.request.resolved.cards.length, 2, 'resolved, the question card and the scope decision stay in the chat')
  for (const b of v.request.boxes) onScreen(b, 'a request bubble')
  assert.deepEqual(v.request.afterAnswers.decided, [true, true, true]); assert.equal(v.request.afterAnswers.submitText, 'submit all 3')
  assert.deepEqual(posts(/\/nodes\/lead\/batch$/).map(c => c.body), [{ revs: { ask: 2, scope: 1 }, answers: ['Alpha', 'the classic switch'], scope: ['approve'] }])
  assert.equal(v.request.badgeAfterSubmit, null, 'nothing waits on the user any more')
  checked.push('requests')

  // ---- the send mark: a reply names its mail and says nothing; a new message says dm
  const messages = posts(/\/nodes\/worker\/message$/).map(c => c.body)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0].target, { kind: 'mail', org: 'mine', box: 'user', id: 'w3' }); assert.equal('surface' in messages[0], false)
  assert.equal(messages[1].surface, 'dm'); assert.equal('target' in messages[1], false)
  assert.equal(v.reply.sendLabel, 'reply'); assert.equal(v.message.sendLabel, 'send'); assert.equal(v.reply.barGone, true)
  assert.deepEqual(v.reply.bar, ['Please confirm the release window: Tuesday 10:00 or Wednesday 14:00?'])
  assert.equal(v.reply.quote.role, 'link', 'the sent reply\'s quote leads to its original'); assert.deepEqual(v.reply.quote.flashed, ['w3'])
  assert.equal(v.message.after.last.id, 'sent-2'); assert.equal(v.message.after.last.out, true)
  checked.push('send')

  // ---- audience requests are chats (c): marked, first, answered in the chat, approved by writing
  assert.deepEqual(v.audreq.first, ['scout', 'drafter']); assert.equal(v.audreq.strip, 0)
  for (const r of v.audreq.rows) { onScreen(r.box, `the request row of ${r.peer}`); assert.equal(r.badge, true); assert.match(r.preview, /^Audience request · /); assert.notEqual(r.background, v.audreq.plainRow, 'a request row is marked') }
  assert.equal(v.audreq.card.peer, 'drafter'); assert.deepEqual(v.audreq.card.buttons, ['Approve', 'Deny']); onScreen(v.audreq.card.box, 'the request in its chat')
  assert.match(v.audreq.card.text, /drafter asks for an audience with you: ?to ask you about the wording of the 4\.7\.0 notes/)
  assert.match(v.audreq.closeTitle, /Deny drafter's audience request and close this chat\./)
  assert.equal(v.audreq.denied.rows.includes('drafter'), false); assert.equal(v.audreq.denied.open, null)
  assert.equal(v.audreq.approved.card, null); assert.equal(v.audreq.approved.row.request, false)
  assert.ok(v.audreq.approved.head.badges.some(b => /audience/.test(b)), 'scout holds the audience after the user wrote to it')
  const toScout = posts(/\/nodes\/scout\/message$/).map(c => c.body)
  assert.equal(toScout.length, 1); assert.equal(toScout[0].text, 'Yes, report the nightly check to me here.'); assert.equal(toScout[0].surface, 'dm')
  const order = calls.filter(c => c.method === 'POST' && (/\/nodes\/scout\/message$/.test(c.path) || (/\/audiences$/.test(c.path) && c.body.node === 'scout'))).map(c => c.path.replace(/^.*\/mine/, ''))
  assert.deepEqual(order, ['/audiences', '/nodes/scout/message'], 'the grant first, then the message')
  checked.push('audience requests')

  // ---- (d) the top-level chip has the audience badge's box
  const chips = v.solo.before.badgeBoxes, top = chips.find(b => b.text === 'top-level'), aud = chips.find(b => /audience/.test(b.text))
  assert.ok(top && aud, 'both chips are beside the name')
  for (const k of ['padding', 'radius', 'border', 'display', 'gap', 'font', 'h']) assert.equal(top[k], aud[k], `the top-level chip's ${k} is the audience badge's`)
  assert.equal(top.borderShown, true, 'with a visible border, as the audience badge has')
  // ---- (e) fast mode and effort in the message box; (f) the gear; (g) the agent link
  onScreen(v.agentbox.controls.effort.box, 'the effort control'); onScreen(v.agentbox.controls.fast.box, 'the fast mode control')
  assert.equal(v.agentbox.controls.fast.label, 'Fast mode'); onScreen(v.agentbox.effortTrack, 'the effort track')
  assert.ok(v.agentbox.controls.effort.box.x > v.agentbox.composer.x + v.agentbox.composer.w - 4, 'the controls sit after the text, beside send')
  assert.equal(v.agentbox.head.gear, "Open solo's settings"); assert.deepEqual(v.agentbox.settings, [{ scope: 'agent', org: 'mine', agentId: 'solo' }])
  assert.equal(v.agentbox.head.link.tag, 'BUTTON'); assert.match(v.agentbox.head.link.cls, /ref-chip ref-agent ref-ready/); assert.equal(v.agentbox.head.link.agent, 'solo')
  assert.deepEqual(v.agentbox.focused, ['solo'])
  checked.push('header and message box')

  // ---- a project's chat is one thread (R1-R4) and records a megaphone send once
  const thread = v.project.bubbles
  assert.deepEqual(thread.map(b => b.id), ['megaphone:g1', 'cj1', 'ca1', 'cj2'], 'no bubble for the queue\'s copy; the megaphone send once')
  for (const b of thread) onScreen(b.box, `the project chat bubble ${b.id}`)
  assert.equal(thread[0].megaphone, 'Megaphone · 2 agents'); assert.equal(thread[0].job, null)
  assert.match(thread[1].job, /^held by .*member$/, 'R1: the message says who holds it'); assert.equal(thread[3].job, 'waiting in the queue')
  assert.equal(thread[2].via, 'member', 'R2: the member\'s answer is in the project\'s chat'); assert.match(thread[2].viaText, /member$/)
  assert.equal(v.project.replyPlaceholder, 'reply to member…'); assert.equal(v.project.followPlaceholder, 'follow up on your message to crew…')
  const toMember = posts(/\/nodes\/member\/message$/).map(c => c.body), toCrew = posts(/\/nodes\/crew\/message$/).map(c => c.body)
  assert.deepEqual(toMember.map(b => b.target), [{ kind: 'mail', org: 'mine', box: 'user', id: 'ca1' }], 'R3: Reply on the member\'s bubble writes to the member')
  assert.deepEqual(toCrew.map(b => b.target), [{ kind: 'mail', org: 'mine', box: 'user', id: 'cj1' }], 'a follow-up goes to the project, naming the user\'s own message')
  const after = v.project.after
  assert.deepEqual(after.map(b => [b.out, b.via]), [[true, null], [true, null], [false, 'member'], [true, null], [true, 'member'], [true, 'member']],
    'the reply and the follow-up are in the thread, each marked with the member it went to')
  assert.deepEqual(v.project.mate, [{ id: 'g1b', megaphone: 'Megaphone · crew', job: null }], 'a member\'s chat: its megaphone copy only')
  checked.push('project thread')

  // ---- narrow: the list becomes the overlay the other two-pane panels use
  assert.equal(v.narrow.collapsed, true); onScreen(v.narrow.rail, 'the list control'); assert.equal(v.narrow.closedOnPick, true)
  // ---- 7: the classic switch brings back today's panel and its mail icon, and returns
  assert.equal(v.classic.bellIcon, MAIL, 'the mail icon is back'); assert.equal(v.classic.titleIcon, MAIL); assert.equal(v.classic.title, 'Your inbox')
  assert.equal(v.classic.folders, true); assert.equal(v.classic.chats, false); assert.equal(v.classic.checked, true); assert.equal(v.classic.stored, '1')
  assert.ok(v.classic.mailrows > 0, 'with its mail list')
  assert.equal(v.back.bellIcon, BUBBLE); assert.equal(v.back.chats, true); assert.equal(v.back.checked, false); assert.equal(v.back.stored, '0')
  checked.push('narrow', 'classic')
}
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked, shots: result.shots?.length, session: result.session, guards: result.guards, out: evidence }))
