// Proof: the desk is told when the running turn started, so it times live only
// that turn's tool calls (docket tool-calls-left-open-by-an-earlier-turn-count-up:
// yesterday's open call counted "23h 08m" again under today's turn). The
// engine publishes the running turn's admission, `turn_started_at`, beside
// `busy`, in the agent's node (runtime overlay) and in its chat payload; idle,
// both are null. On the seed org's Claude fake (alice), a turn whose Bash call
// runs 6 s.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/turn-start-clock.mjs

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('turn-start-clock')
  rig.scenario({ default: { turns: [
    { name: 'slow call', match: ['PROOF-TURN-START'], steps: [
      { tool: 'Bash', args: { command: 'sleep 6' }, result: 'slept', run_ms: 6000 },
      { text: 'TURN-START-DONE.' },
    ] },
    { name: 'default', steps: [{ text: 'OK.' }] },
  ] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: SEED_SETTLE_TIMEOUT })

  // a node carries the agent's name in `id`; the tree is the feed's snapshot
  const find = (nodes, name) => {
    for (const n of nodes ?? []) {
      if (n.id === name) return n
      const kid = find(n.children, name)
      if (kid) return kid
    }
    return null
  }
  const nodeOf = async () => find((await rig.api('GET', `/api/orgs/${rig.org}`))?.roots, 'alice')
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/alice/chat`)
  const slowChip = (c) => (c?.messages ?? []).flatMap((m) => m.tools ?? []).find((t) => String(t?.arg ?? '').includes('sleep 6'))

  // Ledger completion precedes the final runtime publication. Synchronize on
  // independent idle signals, never on the clock field this proof tests.
  const idleSamples = []
  const idleReady = await rig.waitFor(async () => {
    const [n, c] = [await nodeOf(), await chat()]
    const row = rig.one(`SELECT a.inflight_at, EXISTS (SELECT 1 FROM ot.turns t
      WHERE t.agent_id=a.id AND t.ended_at IS NULL) AS unfinished FROM ot.agents a
      JOIN ot.orgs o ON o.id=a.org_id WHERE o.slug='${rig.org}' AND a.name='alice'`)
    idleSamples.push({ at: new Date().toISOString(), node: n && { busy: n.busy, starting: n.starting, turn_started_at: n.turn_started_at },
      chat: c && { busy: c.busy, turn_started_at: c.turn_started_at }, row })
    return n?.busy === false && n?.starting === false && c?.busy === false
      && row?.inflight_at === null && row?.unfinished === false
  }, { what: 'seed alice published idle with cleared inflight', timeout: 10000, every: 200 }).then(() => true, () => false)
  p.file('initial-idle-state.json', { ready: idleReady, samples: idleSamples })
  // A missing/unknown precondition must fail the existing check, even if a
  // later read would happen to look idle. Do not retry any clock assertion.
  const [idleNode, idleChat] = idleReady ? [await nodeOf(), await chat()] : [null, null]
  p.check('idle: neither the node nor the chat payload names a running turn',
    idleNode?.turn_started_at === null && idleChat?.turn_started_at === null,
    { node: idleNode?.turn_started_at, chat: idleChat?.turn_started_at })

  const before = rig.turns('alice').filter((t) => t.ended_at).length
  const mailAt = Date.now()
  await rig.userMail('alice', 'PROOF-TURN-START: run the slow call.')
  let seen = null
  await rig.waitFor(async () => {
    const [n, c] = [await nodeOf(), await chat()]
    const chip = slowChip(c)
    if (n?.busy && c?.busy && chip && chip.result === undefined) {
      seen = { node: n.turn_started_at, chat: c.turn_started_at, chip: chip.started_at }
      return true
    }
    return false
  }, { what: "alice's slow call running on the desk", timeout: 30000, every: 200 }).catch(() => null)
  const row = rig.turns('alice').at(-1)
  p.check('running: the node and the chat payload name the same turn start',
    typeof seen?.node === 'string' && seen.node === seen.chat, seen)
  p.check("running: the turn's call started at or after it",
    Number.isFinite(Date.parse(seen?.chip)) && Date.parse(seen.chip) >= Date.parse(seen.node), seen)
  p.check("it is this turn's admission: after the mail was sent, within 2 s of the turn row's start",
    Date.parse(seen?.node) >= mailAt - 1000 && Math.abs(Date.parse(seen.node) - Date.parse(row?.started_at)) < 2000,
    { seen, mailAt: new Date(mailAt).toISOString(), turn: row })

  await rig.waitTurns('alice', before + 1, { timeout: 60000 })
  // the node's runtime overlay follows the turn row's end a moment later
  await rig.waitFor(async () => (await nodeOf())?.busy === false, { what: 'alice idle on the desk', timeout: 10000, every: 200 }).catch(() => null)
  const [endNode, endChat] = [await nodeOf(), await chat()]
  const done = rig.turns('alice').at(-1)
  p.check('the call ran and the turn ended well (control)',
    !done?.error && !done?.killed && slowChip(endChat)?.result === 'slept', { turn: done, chip: slowChip(endChat) })
  p.check('after the turn: neither names a running turn again',
    endNode?.turn_started_at === null && endChat?.turn_started_at === null,
    { node: endNode?.turn_started_at, chat: endChat?.turn_started_at })
  p.keep(rig, { agents: ['alice'] })
  return p.summary()
}
