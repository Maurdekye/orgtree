// Proof: websocket watchdogs and send (docket
// native-websocket-watchdog-plus-a-tool-to-send-on; user 2026-10-19
// 21:00Z/21:01:59Z), through the real engine and a dependency-free
// WebSocket server on 127.0.0.1 (no external services):
//   a dog dials with credentials from a file (bearer), sends its hello after
//   the upgrade, and fires with matching messages behind the EXTERNAL tag
//   send writes on the live connection after the hello; the echo fires it
//   inline credentials from a fakeCLI turn (bearer, query, a secret hello)
//   reach the server and nowhere else: not ot.convo, ot.watchdogs, ot.events,
//   ot.mail, the sealed row's plaintext, list output or the engine log
//   a fire action takes credentials only as a file path: inline ones (either
//   kind) and credential keys are refused at create, from a fakeCLI turn too,
//   and reach no table, list or log; one with a file path fires and works
//   a refused login says so at create and in list; send refuses while not
//   connected, on another kind and for an agent that cannot manage the dog
//   after an engine restart the dogs reconnect (the inline one unsealed) and
//   send their hellos again; an outage of a minute is reported, and the
//   recovery once the connection has held for a minute
// Run (debug engine, own rig home):
//   ORGTREE_RIG_HOME=C:/orgtree-build/<you>/rig ORGTREE_RIG_ENGINE=<debug orgtree-engine.exe>
//   node tools/rig/rig.mjs run tools/rig/proofs/websocket-watchdogs.mjs

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'

const CANARY_FILE = 'WSPROOF-FILE-7c1e'
const CANARY_BEARER = 'WSPROOF-BEARER-29af'
const CANARY_QUERY = 'WSPROOF-QUERY-5d03'
const CANARY_HELLO = 'WSPROOF-HELLO-b84e'
const CANARY_FA_WS = 'WSPROOF-FA-WS-31c7'
const CANARY_FA_MQTT = 'WSPROOF-FA-MQTT-8e52'
const CANARY_FA_STRAY = 'WSPROOF-FA-STRAY-f019'
const CANARY_TOP = 'WSPROOF-TOP-QUERY-6a2d'
const CANARIES_FA = [CANARY_FA_WS, CANARY_FA_MQTT, CANARY_FA_STRAY, CANARY_TOP]
const CANARIES = [CANARY_FILE, CANARY_BEARER, CANARY_QUERY, CANARY_HELLO, ...CANARIES_FA]

export async function setup() {
  // recover: a restarted rig engine re-arms its dogs as a normal start does
  // (a safe start without it re-arms event dogs only)
  return { recover: true, fixture: { org: { name: 'WebSocket watchdogs' }, agents: [
    { name: 'boss', tier: 'sol', grant: 100 },
    { name: 'carol', tier: 'sol', grant: 0 },
  ] } }
}

/** A minimal RFC 6455 server: records every upgrade and text message,
 * answers pings, echoes a `{"cmd"…}` message as `event: echo …`, refuses
 * `/secure` without the expected bearer, and can stop and listen again. */
function wsServer({ bearer }) {
  const st = { upgrades: [], got: [], sockets: new Set(), server: null, port: 0 }
  const accept = key => crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  const frame = (op, payload) => {
    const n = payload.length
    let head
    if (n < 126) head = Buffer.from([0x80 | op, n])
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2) }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2) }
    return Buffer.concat([head, payload])
  }
  const onUpgrade = (req, socket) => {
    st.upgrades.push({ url: req.url, headers: req.headers, at: Date.now() })
    if (req.url.startsWith('/secure') && req.headers.authorization !== `Bearer ${bearer}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept(req.headers['sec-websocket-key'])}`, '', ''].join('\r\n'))
    st.sockets.add(socket)
    let buf = Buffer.alloc(0)
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 2) return
        const op = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let n = buf[1] & 0x7f
        let off = 2
        if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4 }
        else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); off = 10 }
        const need = off + (masked ? 4 : 0) + n
        if (buf.length < need) return
        let payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need))
        if (masked) { const mask = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4] }
        buf = buf.subarray(need)
        if (op === 0x1) {
          const text = payload.toString('utf8')
          st.got.push({ url: req.url, text, at: Date.now() })
          if (text.startsWith('{"cmd"')) socket.write(frame(0x1, Buffer.from('event: echo ' + text)))
        } else if (op === 0x8) {
          socket.write(frame(0x8, payload.subarray(0, 2)))
          socket.end()
        } else if (op === 0x9) socket.write(frame(0xA, payload))
      }
    })
    const gone = () => st.sockets.delete(socket)
    socket.on('close', gone)
    socket.on('error', gone)
  }
  const listen = port => new Promise((resolve, reject) => {
    const server = http.createServer((_, res) => { res.writeHead(426); res.end() })
    server.on('upgrade', onUpgrade)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { st.server = server; st.port = server.address().port; resolve() })
  })
  return {
    st, listen,
    url: p => `ws://127.0.0.1:${st.port}${p}`,
    push: text => { for (const s of st.sockets) s.write(frame(0x1, Buffer.from(text))) },
    stop: () => new Promise(resolve => {
      for (const s of st.sockets) s.destroy()
      st.sockets.clear()
      st.server.close(() => resolve())
    }),
  }
}

export default async function (rig) {
  const p = new Proof('websocket-watchdogs')
  const ws = wsServer({ bearer: CANARY_FILE })
  await ws.listen(0)
  // the server closes whatever happens: its open sockets would keep node running
  try {
    await flow(rig, p, ws)
  } finally {
    await ws.stop()
  }
  p.file('dogs.json', rig.sql(`SELECT kind, name, state, fired, memo->'run'->'websocket' AS connection FROM ot.watchdogs WHERE kind = 'websocket' ORDER BY id`))
  p.keep(rig, { agents: ['boss'], grep: /websocket|WEBSOCKET/ })
  return p.summary()
}

async function flow(rig, p, ws) {
  const settle = what => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what, timeout: 60000 }).catch(() => {})
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 600)
  const node = name => rig.one(`SELECT id FROM ot.agents WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mails = like => rig.sql(`SELECT id, body, ev::text AS ev FROM ot.mail WHERE recipient_agent_id = ${node('boss').id} AND body LIKE '%${like}%' ORDER BY id`)
  const dog = name => rig.one(`SELECT id, state, fired, memo FROM ot.watchdogs WHERE owner_agent_id = ${node('boss').id} AND name = '${name}' AND state <> 'removed'`)
  const listed = async name => ((await rig.tool('boss', 'orgtree_watchdog', { action: 'list' })).json?.watchdogs ?? []).find(d => d.name === name)
  const scratch = path.join(rig.data, 'scratch', rig.org, 'boss')
  await settle('fixture turns')
  await rig.op({ op: 'retool', node: 'boss', tools: { web: true } })
  await rig.op({ op: 'retool', node: 'carol', tools: { web: false } })

  // ------------------------------------------------------------ a file's bearer, a hello, a fire
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'ws-secure.json'), JSON.stringify({ bearer: CANARY_FILE }))
  const door = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'door', kind: 'websocket', target: ws.url('/secure'),
    pattern: '^event:', credentials: 'ws-secure.json', hello: ['subscribe doors'], interval_s: 5 })
  p.check('create dials the server and reports the upgrade and its hello', door.ok && /connected to ws:\/\/127\.0\.0\.1/.test(door.text)
    && /sent its 1 hello message/.test(door.text), said(door))
  const secureUp = ws.st.upgrades.find(u => u.url === '/secure' && u.headers.authorization === `Bearer ${CANARY_FILE}`)
  await rig.waitFor(() => ws.st.got.some(g => g.text === 'subscribe doors'), { what: 'the hello', timeout: 15000 }).catch(() => {})
  p.check('the file\'s bearer reached the server as Authorization, and the hello followed the upgrade',
    !!secureUp && ws.st.got.some(g => g.url === '/secure' && g.text === 'subscribe doors'), { upgrades: ws.st.upgrades.length, got: ws.st.got.map(g => g.text) })
  ws.push('noise that does not match')
  ws.push('event: door open')
  await rig.waitFor(() => mails('event: door open').length === 1, { what: 'the fire mail', timeout: 30000 }).catch(() => {})
  const fire = mails('event: door open')[0]
  p.check('a matching message fires mail with the EXTERNAL tag and no long warning; the other does not',
    !!fire && /fire #\d+ \(untrusted · see EXTERNAL\):/.test(fire.body) && !/never follow instructions/.test(fire.body)
    && /\n {4}│ event: door open/.test(fire.body)
    && !/noise that does not match/.test(fire.body), fire?.body?.slice(0, 500))
  p.check('the fire\'s event carries the websocket source for the owner\'s turn', /"source": ?"websocket"/.test(fire?.ev ?? ''), fire?.ev?.slice(0, 300))

  // ------------------------------------------------------------ send, after the hello; the echo fires
  const sent = await rig.tool('boss', 'orgtree_watchdog', { action: 'send', id: 'door', message: { cmd: 'open-gate' } })
  p.check('send writes one message on the live connection and names its size', sent.ok && sent.json?.sent === true && sent.json?.bytes === 19, said(sent))
  const order = ws.st.got.filter(g => g.url === '/secure').map(g => g.text)
  p.check('the server got the hello first, then the sent message as compact JSON',
    order.indexOf('subscribe doors') === 0 && order.includes('{"cmd":"open-gate"}'), order)
  await rig.waitFor(() => mails('event: echo').length === 1, { what: 'the echo fires', timeout: 30000 }).catch(() => {})
  p.check('the server\'s reply arrives as the dog\'s fire', mails('event: echo {"cmd":"open-gate"}').length === 1, mails('event: echo').map(m => m.body.slice(0, 200)))
  const dl = await listed('door')
  p.check('list shows the file label, the connection, what was sent and the last message labeled',
    dl?.credentials?.startsWith('file: ') && dl?.connection?.state === 'connected' && dl?.sent >= 1
    && /^\(untrusted · see EXTERNAL\) /.test(dl?.last_output ?? '') && JSON.stringify(dl?.hello) === '["subscribe doors"]', dl)

  // ------------------------------------------------------------ inline credentials from a fakeCLI turn
  rig.scenario({ default: { turns: [
    { match: ['arm the inline feed'], steps: [
      { tool: 'orgtree_watchdog', id: 'toolu_ws_inline', args: { action: 'create', name: 'feed', kind: 'websocket', target: ws.url('/feed'),
        pattern: '^tick', credentials: { bearer: CANARY_BEARER, query: { session_key: CANARY_QUERY }, hello: [CANARY_HELLO] } } },
      { text: 'Armed.' }] },
    { name: 'default', steps: [{ text: 'OK.' }] },
  ] } })
  const before = rig.turns('boss').length
  await rig.userMail('boss', 'arm the inline feed')
  await rig.waitTurns('boss', before + 1).catch(() => {})
  await rig.waitFor(() => dog('feed')?.state === 'armed', { what: 'the inline dog', timeout: 30000 }).catch(() => {})
  const feedUp = ws.st.upgrades.filter(u => u.url.startsWith('/feed'))
  await rig.waitFor(() => ws.st.got.some(g => g.text === CANARY_HELLO), { what: 'the secret hello', timeout: 15000 }).catch(() => {})
  p.check('inline credentials reached the server: bearer, query and the secret hello (positive control)',
    feedUp.some(u => u.url === `/feed?session_key=${CANARY_QUERY}` && u.headers.authorization === `Bearer ${CANARY_BEARER}`)
    && ws.st.got.some(g => g.url.startsWith('/feed') && g.text === CANARY_HELLO), { feedUp: feedUp.map(u => u.url), hello: ws.st.got.filter(g => g.url.startsWith('/feed')).length })
  const sealed = rig.one(`SELECT count(*) AS n FROM ot.watchdog_secrets WHERE watchdog_id = ${dog('feed')?.id ?? 0}`)
  p.check('the inline credentials are sealed in ot.watchdog_secrets', Number(sealed?.n) === 1, sealed)

  // ------------------------------------------------------------ fire actions take credentials only as a file path
  // (coordinator 2026-10-20, @rig-sol-b's review of 1cbaac2): a fire action's
  // arguments are stored and listed as written, so inline credentials in one
  // are refused, websocket and mqtt alike; the refused calls' saved
  // transcript and the log keep none of them (and the sweep at the end)
  fs.writeFileSync(path.join(scratch, 'chain.log'), '')
  const chained = (name, args, target = 'never.log') => ({ action: 'create', name, kind: 'file', target, pattern: 'open', interval_s: 15,
    fire_actions: [{ tool: 'orgtree_watchdog', args }] })
  const faWs = secret => ({ action: 'create', name: 'spawned', kind: 'websocket', target: ws.url('/feed'),
    credentials: { bearer: secret, query: { session_key: secret } } })
  const faMqtt = secret => ({ action: 'create', name: 'spawned', kind: 'mqtt', target: 'mqtts://broker.invalid', pattern: '#',
    credentials: { username: 'ha', password: secret } })
  // the rig's own /api/rig/tool route logs its whole request (rig mode only),
  // so these direct calls carry secrets of their own; the swept canaries go
  // only through the fakeCLI turn below, the path an agent's call takes
  const DIRECT = ['DIRECT-ROUTE-WS-77a1', 'DIRECT-ROUTE-MQTT-77a2']
  const directWs = await rig.tool('boss', 'orgtree_watchdog', chained('fa-direct-ws', faWs(DIRECT[0])))
  const directMqtt = await rig.tool('boss', 'orgtree_watchdog', chained('fa-direct-mqtt', faMqtt(DIRECT[1])))
  p.check('a fire action with inline websocket or mqtt credentials is refused, naming a credentials file path, quoting no secret',
    [directWs, directMqtt].every(r => !r.ok && /credentials file path/.test(r.text) && !DIRECT.some(c => r.text.includes(c))),
    [said(directWs), said(directMqtt)])
  for (const n of ['fa-direct-ws', 'fa-direct-mqtt']) if (dog(n)) await rig.tool('boss', 'orgtree_watchdog', { action: 'remove', id: n })
  rig.scenario({ default: { turns: [
    { match: ['arm the chained dogs'], steps: [
      { tool: 'orgtree_watchdog', id: 'toolu_fa_ws', args: chained('fa-ws', faWs(CANARY_FA_WS)) },
      { tool: 'orgtree_watchdog', id: 'toolu_fa_mqtt', args: chained('fa-mqtt', faMqtt(CANARY_FA_MQTT)) },
      { tool: 'orgtree_watchdog', id: 'toolu_fa_stray', args: chained('fa-stray', { action: 'create', name: 'spawned', kind: 'websocket',
        target: ws.url('/feed'), bearer: CANARY_FA_STRAY, query: { sig: CANARY_FA_STRAY } }) },
      { tool: 'orgtree_watchdog', id: 'toolu_top_query', args: { action: 'create', name: 'fa-top', kind: 'websocket', target: ws.url('/feed'),
        query: { sig: CANARY_TOP }, headers: { 'X-Auth': CANARY_TOP } } },
      { tool: 'orgtree_watchdog', id: 'toolu_fa_file', args: chained('fa-file', { action: 'create', name: 'spawned', kind: 'websocket',
        target: ws.url('/secure'), pattern: '^event:', credentials: 'ws-secure.json' }, 'chain.log') },
      { text: 'Chained.' }] },
    { name: 'default', steps: [{ text: 'OK.' }] },
  ] } })
  const beforeFa = rig.turns('boss').length
  await rig.userMail('boss', 'arm the chained dogs')
  await rig.waitTurns('boss', beforeFa + 1).catch(() => {})
  const refusedFa = ['fa-ws', 'fa-mqtt', 'fa-stray', 'fa-top']
  p.check('from a turn: the fire actions with inline credentials or credential keys are refused, the one with a credentials file path is armed',
    refusedFa.every(n => !dog(n)) && dog('fa-file')?.memo?.fire_actions?.[0]?.args?.credentials === 'ws-secure.json',
    { armed: refusedFa.filter(n => dog(n)), file: dog('fa-file')?.memo?.fire_actions })
  const faTurn = rig.one(`SELECT count(*) AS n FROM ot.convo WHERE tool_inputs::text LIKE '%toolu_fa_ws%' AND tool_inputs::text LIKE '%toolu_fa_stray%'`)
  p.check('positive control: the refused calls are in the saved transcript', Number(faTurn?.n) >= 1, faTurn)
  const faMemo = CANARIES_FA.filter(c => Number(rig.one(`SELECT count(*) AS n FROM ot.watchdogs WHERE memo::text LIKE '%${c}%'`)?.n) !== 0)
  const faList = JSON.stringify((await rig.tool('boss', 'orgtree_watchdog', { action: 'list' })).json ?? {})
  p.check('no inline credential is in a dog\'s memo or the list output; list shows the file-path fire action',
    faMemo.length === 0 && faList.includes('ws-secure.json') && !CANARIES_FA.some(c => faList.includes(c)),
    { memo: faMemo, list: CANARIES_FA.filter(c => faList.includes(c)) })
  const faLog = rig.engineLog()
  p.check('nor the engine log, where every call is logged on entry (a query or headers object included)',
    !CANARIES_FA.some(c => faLog.includes(c)), CANARIES_FA.filter(c => faLog.includes(c)))
  // the file-path fire action works: its dog fires, and the dog it creates dials with the file's bearer
  const upsChain = ws.st.upgrades.length
  fs.appendFileSync(path.join(scratch, 'chain.log'), 'door open\n')
  const chainedUp = () => ws.st.upgrades.slice(upsChain).some(u => u.url === '/secure' && u.headers.authorization === `Bearer ${CANARY_FILE}`)
  await rig.waitFor(() => dog('spawned')?.state === 'armed' && chainedUp(), { what: 'the chained dog dials', timeout: 60000 }).catch(() => {})
  p.check('when it fires, its fire action creates a websocket dog that dials with the credentials file\'s bearer (positive control)',
    dog('spawned')?.memo?.websocket?.credentials?.kind === 'file' && chainedUp(),
    { spawned: dog('spawned')?.memo?.websocket?.credentials, upgrades: ws.st.upgrades.slice(upsChain).map(u => u.url) })
  for (const n of ['spawned', 'fa-file', ...refusedFa]) if (dog(n)) await rig.tool('boss', 'orgtree_watchdog', { action: 'remove', id: n })

  // ------------------------------------------------------------ refusals
  const locked = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'locked', kind: 'websocket', target: ws.url('/secure'),
    credentials: { bearer: 'not-the-right-one' } })
  p.check('a refused login arms the dog and says so', locked.ok && /ARMED, BUT NOT CONNECTED/.test(locked.text) && /HTTP 401/.test(locked.text), said(locked))
  const lockedSend = await rig.tool('boss', 'orgtree_watchdog', { action: 'send', id: 'locked', message: 'hello?' })
  p.check('send refuses while the dog is not connected, and nothing is sent', !lockedSend.ok && /not connected/.test(lockedSend.text)
    && !ws.st.got.some(g => g.text === 'hello?'), said(lockedSend))
  const secretTarget = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'leaky', kind: 'websocket', target: ws.url('/feed?token=abc') })
  p.check('a target with a secret-named query parameter is refused', !secretTarget.ok && /looks like a secret/.test(secretTarget.text), said(secretTarget))
  const noWeb = await rig.tool('carol', 'orgtree_watchdog', { action: 'create', name: 'c', kind: 'websocket', target: ws.url('/feed') })
  p.check('an owner without the web tool cannot create one', !noWeb.ok && /web tool/.test(noWeb.text), said(noWeb))
  const carolSend = await rig.tool('carol', 'orgtree_watchdog', { action: 'send', id: 'boss/door', message: 'x' })
  p.check('an agent that cannot manage the dog cannot send on it', !carolSend.ok, said(carolSend))
  await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'plainfile', kind: 'file', target: 'some.log' })
  const wrongKind = await rig.tool('boss', 'orgtree_watchdog', { action: 'send', id: 'plainfile', message: 'x' })
  p.check('send refuses on another kind', !wrongKind.ok && /websocket watchdog/.test(wrongKind.text), said(wrongKind))
  const ll = await listed('locked')
  p.check('list shows the refusal', ll?.connection?.state === 'refused' && /HTTP 401/.test(ll?.health ?? ''), ll)

  // ------------------------------------------------------------ restart: reconnect and hello again
  const upsBefore = ws.st.upgrades.length
  const gotBefore = ws.st.got.length
  await rig.restart()
  await settle('after restart')
  await rig.waitFor(() => ws.st.upgrades.slice(upsBefore).some(u => u.url === '/secure' && u.headers.authorization === `Bearer ${CANARY_FILE}`)
    && ws.st.upgrades.slice(upsBefore).some(u => u.url === `/feed?session_key=${CANARY_QUERY}`), { what: 'both dogs redial', timeout: 60000 }).catch(() => {})
  // by position: a hello can arrive in the same millisecond as its upgrade
  const hellosAfter = ws.st.got.slice(gotBefore).map(g => g.text)
  p.check('after an engine restart both dogs reconnect (the inline one from its sealed row) and send their hellos again',
    hellosAfter.includes('subscribe doors') && hellosAfter.includes(CANARY_HELLO), hellosAfter.filter(t => t !== CANARY_HELLO).concat(hellosAfter.includes(CANARY_HELLO) ? ['<secret hello>'] : []))

  // ------------------------------------------------------------ an outage of a minute, then recovery
  // (the refused dog goes first: its old refusal would date the outage)
  await rig.tool('boss', 'orgtree_watchdog', { action: 'remove', id: 'locked' })
  const port = ws.st.port
  const doorDown = () => mails('has been unreachable for').filter(m => m.body.startsWith('Watchdog "door"'))
  await ws.stop()
  await rig.waitFor(() => doorDown().length >= 1, { what: 'the outage alert (60 s)', timeout: 150000 }).catch(() => {})
  p.check('an outage of a minute is reported once, as an alert and not a fire',
    doorDown().length === 1 && /WebSocket connection: its WebSocket server ws:\/\/127\.0\.0\.1:\d+\/secure has been unreachable/.test(doorDown()[0]?.body ?? '')
    && (dog('door')?.fired ?? 0) === 2, { down: doorDown().map(m => m.body.slice(0, 240)), fired: dog('door')?.fired })
  await ws.listen(port)
  const doorBack = () => mails('is reachable again').filter(m => m.body.startsWith('Watchdog "door"'))
  // the dog redials on its own backoff (up to about a minute after a long
  // outage), then holds the connection a minute before saying so
  await rig.waitFor(() => doorBack().length >= 1, { what: 'the recovered alert', timeout: 300000 }).catch(() => {})
  p.check('recovery is reported once the connection has held for a minute', doorBack().length === 1
    && /Messages sent while it was disconnected were missed/.test(doorBack()[0]?.body ?? ''), doorBack().map(m => m.body.slice(0, 240)))

  // ------------------------------------------------------------ the canaries reached nothing else
  const hit = (sql, c) => Number(rig.one(sql.replaceAll('$C', c))?.n ?? -1)
  const where = {
    convo: `SELECT count(*) AS n FROM ot.convo WHERE body::text LIKE '%$C%' OR coalesce(tool_inputs::text, '') LIKE '%$C%'`,
    watchdogs: `SELECT count(*) AS n FROM ot.watchdogs WHERE memo::text LIKE '%$C%' OR target LIKE '%$C%' OR coalesce(pattern, '') LIKE '%$C%' OR coalesce(events::text, '') LIKE '%$C%'`,
    events: `SELECT count(*) AS n FROM ot.events WHERE coalesce(detail::text, '') LIKE '%$C%'`,
    mail: `SELECT count(*) AS n FROM ot.mail WHERE body LIKE '%$C%' OR coalesce(ev::text, '') LIKE '%$C%'`,
    sealed_plaintext: `SELECT count(*) AS n FROM ot.watchdog_secrets WHERE encode(sealed, 'escape') LIKE '%$C%'`,
  }
  const found = {}
  for (const c of CANARIES) for (const [table, sql] of Object.entries(where)) { const n = hit(sql, c); if (n !== 0) found[`${table}:${c}`] = n }
  const listText = JSON.stringify((await rig.tool('boss', 'orgtree_watchdog', { action: 'list' })).json ?? {})
  for (const c of CANARIES) if (listText.includes(c)) found[`list:${c}`] = 1
  const log = rig.engineLog()
  for (const c of CANARIES) if (log.includes(c)) found[`engine log:${c}`] = log.split('\n').filter(l => l.includes(c)).length
  const convoTurn = rig.one(`SELECT count(*) AS n FROM ot.convo WHERE tool_inputs::text LIKE '%toolu_ws_inline%' OR body::text LIKE '%toolu_ws_inline%'`)
  p.check('positive control: the inline create is in the saved transcript', Number(convoTurn?.n) >= 1, convoTurn)
  p.check('no credential reached a table, the list output or the engine log', Object.keys(found).length === 0, found)
  p.check('positive control: the engine log has the connections\' own lines', /websocket connected/.test(log) && /websocket message sent/.test(log),
    { connected: /websocket connected/.test(log), sent: /websocket message sent/.test(log) })
}
