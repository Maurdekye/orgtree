// Agent typing in Hubchat (docket show-agent-typing-in-hubchat-using-ordered-
// messa; docs/rust-engine/agent-typing.md): while a Claude-lane agent writes
// orgtree_message to a hub peer, the org sends the peer's hub a typing
// heartbeat about every 500 ms, from the moment the call's `metadata` is whole
// until the call's block ends (user 2026-10-13 22:34Z: heartbeats, no start
// and no stop). The run hosts a mail hub with the `typing` feature
// (ORGTREE_RIG_HUB_BIN or --hub <orgtree-mailhub.exe>); a person registers
// over HTTP, as Hubchat does, and polls the way Hubchat does (sending back
// its `typing_seq`), so it is told each heartbeat once. Pat's Hubchat would
// show the org as typing while a heartbeat came within the last second.
// The fake CLI streams a call the way Claude Code does (a tool_use block, its
// arguments as input_json_delta, content_block_stop, then the MCP call with
// _meta.claudecode/toolUseId); `sleep_ms` steps hold a call open while it is
// "written", as a model writing a long body does.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agent-typing.mjs
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function setup(flags) {
  return { hub: flags.hub ?? true, fixture: { org: { name: 'Agent typing' }, agents: [{ name: 'rhea', tier: 'haiku', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('agent-typing')
  const A = rig.org
  const hub = rig.hubUrl
  const q = s => String(s).replace(/'/g, "''")
  const call = async (method, route, who, body) => {
    const res = await fetch(hub + route, {
      method, headers: { 'X-Org-Auth': `${who.slug}:${who.secret}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  await rig.waitFor(async () => (await rig.api('GET', '/api/desktop/hub')).status?.healthy || null, { what: 'the hosted hub to answer', timeout: 120000 })
  const health = await (await fetch(`${hub}/healthz`)).json()
  p.check('the hosted hub lists the typing feature', (health.features ?? []).includes('typing'), { version: health.version, features: health.features })
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  await rig.waitFor(async () => ((await rig.api('GET', `/api/orgs/${A}`)).net?.hubs ?? []).some(h => h.connected) || null,
    { what: 'the org to connect to the hosted hub', timeout: 90000 })
  const orgAddr = rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${q(A)}' AND state = 'active'`).s
  const pat = { slug: `pat.person.${crypto.randomBytes(3).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }
  const reg = await call('POST', '/api/register', pat, { slug: pat.slug, org_name: 'Pat Example', username: 'pat', kind: 'person' })
  p.check('a person registers on the hub over HTTP, as Hubchat does', reg.status === 200, reg.status)
  const to = `@net:${pat.slug}`

  // the mail Pat receives
  const received = (body, what) => rig.waitFor(async () => {
    const r = await call('POST', '/api/poll?wait=5', pat)
    return r.json?.messages?.find(m => m.body === body) ? Date.now() : null
  }, { what, timeout: 60000 })
  // Pat's sync, as Hubchat's: it sends back its mark and is told each heartbeat once
  let mark = true
  const told = [] // { at, from } per heartbeat Pat is told of
  const poll = async () => {
    const r = await call('POST', '/api/sync?wait=0', pat, { device_id: 'proof-pat-1', device_name: 'Pat proof', typing: mark, wait: 0 })
    if (r.status !== 200) throw new Error(`sync ${r.status}: ${JSON.stringify(r.json)}`)
    if (typeof r.json?.typing_seq === 'number') mark = r.json.typing_seq
    for (const row of r.json?.typing ?? []) told.push({ at: Date.now(), from: row.from })
    return r.json?.typing ?? []
  }
  // Pat polls every 150 ms in the background while a scenario runs
  let polling = false
  let poller = null
  const startPolling = () => { polling = true; poller = (async () => { while (polling) { await poll().catch(() => {}); await sleep(150) } })() }
  const stopPolling = async () => { polling = false; await poller }
  const orgBeats = (from, until = Infinity) => told.filter(b => b.from === orgAddr && b.at >= from && b.at <= until).map(b => b.at)
  const longestGap = ts => ts.slice(1).reduce((g, t, i) => Math.max(g, t - ts[i]), 0)

  // both shapes go through the handler, and a send caches the peer in the
  // org's roster (typing never fetches one)
  const flat = await rig.tool('rhea', 'orgtree_message', { to, body: 'flat shape' })
  const split = await rig.tool('rhea', 'orgtree_message', { metadata: { to }, body: 'split shape' })
  const notice = await rig.tool('rhea', 'orgtree_send_notice', { metadata: { to }, body: 'split notice' })
  const inverted = await rig.tool('rhea', 'orgtree_message', { body: 'body written first', metadata: { to, kind: 'message' } })
  p.check('the flat shape, the split shape (any key order) and a split notice are all sent',
    [flat, split, notice, inverted].every(r => r.ok), { flat, split, notice, inverted })
  for (const body of ['flat shape', 'split shape', 'split notice', 'body written first']) await received(body, `Pat to receive "${body}"`)
  const mixed = await rig.tool('rhea', 'orgtree_message', { metadata: { to }, to, body: 'mixed' })
  const unknown = await rig.tool('rhea', 'orgtree_message', { metadata: { to, subject: 'x' }, body: 'unknown key' })
  p.check('a mixed call and an unknown metadata key are refused, saying what is wrong',
    !mixed.ok && /inside metadata/.test(mixed.text) && !unknown.ok && /metadata takes/.test(unknown.text), { mixed, unknown })
  p.check('no heartbeat reaches Pat from those sends', (await poll()).length === 0, told)

  const block = id => ({ raw: { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'mcp__orgtree__orgtree_message', input: {} } } } })
  const delta = text => ({ raw: { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } } } })
  const blockStop = { raw: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } } }
  const meta = JSON.stringify({ to })
  rig.scenario({ default: { turns: [
    // 1. metadata whole, the body "being written" for 6 s, the block ends,
    // then the call
    { match: ['typing proof one'], steps: [block('toolu_typing_1'), delta(`{"metadata": ${meta}`), { sleep_ms: 6000 },
      delta(', "body": "typed one"}'), blockStop,
      { tool: 'orgtree_message', id: 'toolu_typing_1', args: { metadata: { to }, body: 'typed one' } }, { text: 'Sent.' }] },
    // 2. the body written first (an inversion): no typing, the send unaffected
    { match: ['typing proof two'], steps: [block('toolu_typing_2'), delta(`{"body": "typed two", "metadata": ${meta}}`), { sleep_ms: 4000 }, blockStop,
      { tool: 'orgtree_message', id: 'toolu_typing_2', args: { body: 'typed two', metadata: { to } } }, { text: 'Sent.' }] },
    // 3. a block that never becomes a call (a refused permission, a change of
    // mind): the heartbeats end with the block, not with the turn
    { match: ['typing proof three'], steps: [block('toolu_typing_3'), delta(`{"metadata": ${meta}`), { sleep_ms: 3000 },
      delta(', "body": "never sent"}'), blockStop, { sleep_ms: 4000 }, { text: 'Never mind.' }] },
    // 4. an ordinary quick call: nothing reaches Pat but the message
    { match: ['typing proof four'], steps: [{ tool: 'orgtree_message', id: 'toolu_typing_4', args: { metadata: { to }, body: 'typed four' } }, { text: 'Sent.' }] },
    { steps: [{ text: 'OK.' }] },
  ] } })
  const turns = () => rig.turns('rhea').filter(t => t.ended_at).length

  // 1
  let done = turns()
  let t0 = Date.now()
  startPolling()
  await rig.userMail('rhea', 'typing proof one')
  await rig.waitFor(async () => orgBeats(t0).length > 0 || null, { what: 'Pat to be told the org is typing', timeout: 20000 })
  const came = await received('typed one', 'Pat to receive the typed message')
  await rig.waitTurns('rhea', done + 1)
  await sleep(2000)
  await stopPolling()
  let beats = orgBeats(t0)
  p.check('while the call is written, a heartbeat reaches Pat about every half second, never a second apart',
    beats.length >= 8 && longestGap(beats) < 1000, { n: beats.length, gap: longestGap(beats) })
  p.check('they stop when the block ends: none comes after the message (Pat polls every 150 ms)',
    beats.every(at => at <= came + 400), { last: beats.at(-1) - came })

  // 2
  done = turns()
  t0 = Date.now()
  startPolling()
  await rig.userMail('rhea', 'typing proof two')
  await received('typed two', 'Pat to receive the message written body first')
  await rig.waitTurns('rhea', done + 1)
  await stopPolling()
  p.check('a call that writes its body first sends no heartbeat, and its message goes all the same', orgBeats(t0).length === 0, orgBeats(t0))

  // 3
  done = turns()
  t0 = Date.now()
  startPolling()
  await rig.userMail('rhea', 'typing proof three')
  await rig.waitTurns('rhea', done + 1)
  const turnEnded = Date.now()
  await sleep(1500)
  await stopPolling()
  beats = orgBeats(t0)
  p.check('a block that never became a call heartbeats while it is written', beats.length >= 4, beats.length)
  p.check('and its heartbeats end with the block, seconds before the turn ends',
    beats.length > 0 && turnEnded - beats.at(-1) >= 2500 && beats.at(-1) - beats[0] < 4000,
    { span: beats.at(-1) - beats[0], beforeTurnEnd: turnEnded - beats.at(-1) })

  // 4
  done = turns()
  t0 = Date.now()
  startPolling()
  await rig.userMail('rhea', 'typing proof four')
  await received('typed four', 'Pat to receive the quick message')
  await rig.waitTurns('rhea', done + 1)
  await sleep(1500)
  await stopPolling()
  p.check('a quick call sends no heartbeat', orgBeats(t0).length === 0, orgBeats(t0))

  p.note('Engine stream probe, reach gates, roster, hub choice and POST /api/typing heartbeats are real (fake CLI streaming as Claude Code does); the hub accepts a heartbeat only when it carries nothing but addresses. Pat is a person registered over HTTP whose sync asks for heartbeats with its mark. Hubchat\'s display (a second after the last heartbeat) is its own core tests and browser proof.')
  p.keep(rig, { agents: ['rhea'], grep: /typing/i })
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
