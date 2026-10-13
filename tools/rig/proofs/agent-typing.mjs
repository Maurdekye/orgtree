// Agent typing in Hubchat (docket show-agent-typing-in-hubchat-using-ordered-
// messa; docs/rust-engine/agent-typing.md): while a Claude-lane agent writes
// orgtree_message to a hub peer, the peer's hub lists the org as typing, from
// the moment the call's `metadata` is whole until the call returns. The run
// hosts a mail hub with the `typing` feature (ORGTREE_RIG_HUB_BIN or --hub
// <orgtree-mailhub.exe>); a person registers over HTTP, as Hubchat does, and
// the proof reads what that person's sync is told (`typing: true`).
// The fake CLI streams a call the way Claude Code does (a tool_use block, its
// arguments as input_json_delta, then the MCP call with
// _meta.claudecode/toolUseId); `raw` steps hold a call open while it is
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

  // what Pat's client receives, and who it is told is writing to it
  const received = (body, what) => rig.waitFor(async () => {
    const r = await call('POST', '/api/poll?wait=5', pat)
    return r.json?.messages?.find(m => m.body === body) ?? null
  }, { what, timeout: 60000 })
  const writers = async () => {
    const r = await call('POST', '/api/sync?wait=0', pat, { device_id: 'proof-pat-1', device_name: 'Pat proof', typing: true, wait: 0 })
    if (r.status !== 200) throw new Error(`sync ${r.status}: ${JSON.stringify(r.json)}`)
    return r.json?.typing ?? null
  }
  // a series of reads while something runs: every typing list seen
  const watch = async (ms, every = 250) => {
    const seen = []
    const end = Date.now() + ms
    while (Date.now() < end) {
      seen.push({ at: Date.now(), typing: await writers() })
      await sleep(every)
    }
    return seen
  }

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
  p.check('nobody is shown typing to Pat after those sends', ((await writers()) ?? []).length === 0, await writers())

  const block = id => ({ raw: { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'mcp__orgtree__orgtree_message', input: {} } } } })
  const delta = text => ({ raw: { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } } } })
  const blockStop = { raw: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } } }
  const meta = JSON.stringify({ to })
  rig.scenario({ default: { turns: [
    // 1. metadata whole, the body "being written" for 8 s, then the call
    { match: ['typing proof one'], steps: [block('toolu_typing_1'), delta(`{"metadata": ${meta}`), { sleep_ms: 8000 },
      { tool: 'orgtree_message', id: 'toolu_typing_1', args: { metadata: { to }, body: 'typed one' } }, { text: 'Sent.' }] },
    // 2. the body written first (an inversion): no typing, the send unaffected
    { match: ['typing proof two'], steps: [block('toolu_typing_2'), delta(`{"body": "typed two", "metadata": ${meta}}`), { sleep_ms: 5000 },
      { tool: 'orgtree_message', id: 'toolu_typing_2', args: { body: 'typed two', metadata: { to } } }, { text: 'Sent.' }] },
    // 3. a block that never becomes a call (a refused permission, a change of
    // mind): typing ends with the turn, not with the hub's TTL
    { match: ['typing proof three'], steps: [block('toolu_typing_3'), delta(`{"metadata": ${meta}, "body": "never sent"}`), blockStop,
      { sleep_ms: 4000 }, { text: 'Never mind.' }] },
    // 4. an ordinary quick call: its stop beats its start, nothing is left
    { match: ['typing proof four'], steps: [{ tool: 'orgtree_message', id: 'toolu_typing_4', args: { metadata: { to }, body: 'typed four' } }, { text: 'Sent.' }] },
    { steps: [{ text: 'OK.' }] },
  ] } })
  const turns = () => rig.turns('rhea').filter(t => t.ended_at).length

  // 1
  let done = turns()
  await rig.userMail('rhea', 'typing proof one')
  const shown = await rig.waitFor(async () => {
    const w = await writers()
    return (w ?? []).find(r => r.from === orgAddr) ?? null
  }, { what: 'Pat to be told the org is typing', timeout: 20000 })
  p.check('while the call is written, Pat is told the org is typing, with an end time',
    shown.from === orgAddr && Number.isFinite(shown.until), { shown, orgAddr })
  const during = await watch(4000)
  p.check('it stays shown while the body is written (refreshed, not ending early)',
    during.every(s => (s.typing ?? []).some(r => r.from === orgAddr)), during.map(s => (s.typing ?? []).length))
  await received('typed one', 'Pat to receive the typed message')
  await rig.waitTurns('rhea', done + 1)
  const after = await rig.waitFor(async () => ((await writers()) ?? []).length === 0 ? 'gone' : null,
    { what: 'the typing to end with the call', timeout: 10000 }).catch(() => null)
  p.check('when the call returns the typing ends (no stuck indicator)', after === 'gone', await writers())

  // 2
  done = turns()
  await rig.userMail('rhea', 'typing proof two')
  const inv = await watch(4000)
  p.check('a call that writes its body first shows no typing', inv.every(s => (s.typing ?? []).length === 0), inv.map(s => (s.typing ?? []).length))
  await received('typed two', 'Pat to receive the message written body first')
  p.check('and its message is sent all the same', true)
  await rig.waitTurns('rhea', done + 1)

  // 3
  done = turns()
  await rig.userMail('rhea', 'typing proof three')
  const orphan = await rig.waitFor(async () => ((await writers()) ?? []).some(r => r.from === orgAddr) ? 'shown' : null,
    { what: 'the orphaned block to show typing', timeout: 15000 }).catch(() => null)
  p.check('a block that never became a call shows typing while it lasts', orphan === 'shown')
  await rig.waitTurns('rhea', done + 1)
  const endT = Date.now()
  const ended = await rig.waitFor(async () => ((await writers()) ?? []).length === 0 ? Date.now() - endT : null,
    { what: 'the orphaned typing to end with the turn', timeout: 12000 }).catch(() => null)
  p.check('it ends with the turn, well before the hub would let it run out (20 s)', ended !== null && ended < 8000, { ended })

  // 4
  done = turns()
  await rig.userMail('rhea', 'typing proof four')
  await received('typed four', 'Pat to receive the quick message')
  await rig.waitTurns('rhea', done + 1)
  const quick = await watch(3000)
  p.check('a quick call leaves no typing behind', quick.every(s => (s.typing ?? []).length === 0), quick.map(s => (s.typing ?? []).length))

  p.note('Engine stream probe, reach gates, roster, hub choice and POST /api/typing are real (fake CLI streaming as Claude Code does); Pat is a person registered over HTTP whose sync asks for typing. Hubchat\'s display is its core rig test (typing_v2) and browser proof.')
  p.keep(rig, { agents: ['rhea'], grep: /typing/i })
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
