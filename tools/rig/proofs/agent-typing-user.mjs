// An agent writing to the user (4.7.0, the user's chats; docs/rust-engine/agent-typing.md, "Writing to
// the user"): while a Claude-lane agent writes an orgtree_message or orgtree_send_notice call whose
// `metadata` names the user, its tree node says `writing_to_user: true`, from the moment the metadata is
// whole until the call's block ends, and never after the turn ended, however it ended.
// The fake CLI streams a call the way Claude Code does (a tool_use block, its arguments as
// input_json_delta, content_block_stop, then the MCP call); `sleep_ms` holds a call open while it is
// "written". No hub is needed.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agent-typing-user.mjs
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function setup() {
  return { fixture: { org: { name: 'Agent typing to the user' }, agents: [{ name: 'rhea', tier: 'haiku', grant: 4 }, { name: 'otto', tier: 'haiku', grant: 0 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('agent-typing-user')
  const find = (nodes, id) => { for (const n of nodes ?? []) { if (n.id === id) return n; const hit = find(n.children, id); if (hit) return hit } return null }
  const node = async id => find((await rig.api('GET', `/api/orgs/${rig.org}`))?.roots, id)
  const writing = async id => (await node(id))?.writing_to_user
  // the flag as the desktop would see it over time: sampled every 100 ms while a scenario runs
  let sampling = false, sampler = null
  const seen = []
  const start = () => { sampling = true; seen.length = 0; sampler = (async () => { while (sampling) { seen.push({ at: Date.now(), on: await writing('rhea').catch(() => null) }); await sleep(100) } })() }
  const stop = async () => { sampling = false; await sampler; return seen.slice() }
  const span = samples => { const on = samples.filter(s => s.on === true); return on.length ? on[on.length - 1].at - on[0].at : 0 }

  const block = (id, name = 'mcp__orgtree__orgtree_message') => ({ raw: { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } } })
  const delta = text => ({ raw: { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } } } })
  const blockStop = { raw: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } } }
  const call = (id, to, body, name = 'orgtree_message') => ({ tool: name, id, args: { metadata: { to }, body } })
  rig.scenario({ default: { turns: [
    // 1. to the user: metadata whole, the body "written" for 4 s, the block ends, then the call
    { match: ['user proof one'], steps: [block('toolu_user_1'), delta('{"metadata": {"to": "user"}'), { sleep_ms: 4000 },
      delta(', "body": "typed one"}'), blockStop, { sleep_ms: 1500 }, call('toolu_user_1', 'user', 'typed one'), { text: 'Sent.' }] },
    // 2. to another agent: never
    { match: ['user proof two'], steps: [block('toolu_user_2'), delta('{"metadata": {"to": "otto"}'), { sleep_ms: 2500 },
      delta(', "body": "typed two"}'), blockStop, call('toolu_user_2', 'otto', 'typed two'), { text: 'Sent.' }] },
    // 3. a list that includes the user, as a notice: it counts
    { match: ['user proof three'], steps: [block('toolu_user_3', 'mcp__orgtree__orgtree_send_notice'), delta('{"metadata": {"to": ["otto", "user"]}'), { sleep_ms: 2500 },
      delta(', "body": "typed three"}'), blockStop, { text: 'Never mind.' }] },
    // 4. THE STALE CASE: the turn is interrupted while the call is being written; no block end comes
    { match: ['user proof four'], steps: [block('toolu_user_4'), delta('{"metadata": {"to": "user"}'), { sleep_ms: 60000 }, { text: 'never reached' }] },
    { steps: [{ text: 'OK.' }] },
  ] } })
  const ended = () => rig.turns('rhea').filter(t => t.ended_at).length
  const run = async (text, during) => {
    const before = ended()
    start()
    await rig.userMail('rhea', text)
    if (during) await during()
    await rig.waitFor(async () => ended() > before || null, { what: `the turn for "${text}" to end`, timeout: 60000 })
    await sleep(400)
    return stop()
  }

  p.check('an idle agent says it is not writing to the user', (await writing('rhea')) === false, await writing('rhea'))

  // 1
  let s = await run('user proof one')
  const on1 = span(s)
  p.check('while the call to the user is written the node says writing_to_user, for about as long as the body takes',
    on1 >= 2500 && on1 <= 6000, { ms: on1, samples: s.length })
  const lastOn = s.filter(x => x.on === true).pop()?.at ?? 0
  p.check('it ends with the call\'s block, before the turn ends', s.filter(x => x.at > lastOn && x.on === false).length >= 5 && (await writing('rhea')) === false,
    { after: s.filter(x => x.at > lastOn).length })
  p.check('and the message reached the user', rig.sql(`SELECT count(*)::int AS n FROM ot.mail WHERE sender='rhea' AND recipient_kind='user' AND body='typed one'`)[0].n === 1)

  // 2
  s = await run('user proof two')
  p.check('a call to another agent never sets it', s.every(x => x.on === false) && s.length > 10, { samples: s.length, on: s.filter(x => x.on).length })

  // 3
  s = await run('user proof three')
  p.check('a notice to a list that includes the user sets it', span(s) >= 1500, { ms: span(s) })
  p.check('and it is off after a block that never became a call', (await writing('rhea')) === false)

  // 4
  s = await run('user proof four', async () => {
    await rig.waitFor(async () => (await writing('rhea')) === true || null, { what: 'the flag to show', timeout: 20000, every: 100 })
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/rhea/interrupt`)
  })
  p.check('a turn interrupted while the call is written leaves no flag behind', s.some(x => x.on === true) && (await writing('rhea')) === false,
    { shown: s.filter(x => x.on === true).length, now: await writing('rhea') })
  await sleep(1500)
  p.check('and it stays off', (await writing('rhea')) === false)
  return p.summary()
}
