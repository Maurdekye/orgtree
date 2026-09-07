// convo.test.tsx — the shared per-node conversation store, attacked.
//
// The governing invariant (D-38, state-architecture-review §8.5):
//
//     the websocket is an OPTIMIZATION, not a requirement — nothing on screen
//     may depend on having caught an event.
//
// §1 takes the socket away by degrees: every frame, every second frame, none
// of them, frames doubled, reversed, late — and asserts the store still
// converges on the server from polling alone. §2 asserts that two views of one
// node can never disagree. §3 attacks the pending-ghost graduation rule, which
// has now been wrong four times (D-51, D-52, D-57 ③, D-57 ④). §4 attacks the
// paging window (D-56). §5 is store hygiene.
//
// Run:  cd frontend && node tests/run.mjs convo
//       node tests/run.mjs convo --reps 5     (more seeds per drop rate)

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock, REPS,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import {
  addPending, bindPendingMail, CHAT_WINDOW, CMD_GRACE, dismissPending, dropPending, ingestPulse,
  ingestStream, loadOlder, MAX_WINDOW, markBusy, markGhostCommand,
  dropConvo, refreshConvo, renameConvo, resetConvos, STALL_MS, useConvo,
} from '../src/convo'
import type { Convo } from '../src/convo'
import type { StreamEvent } from '../src/canvas/shared'

// --------------------------------------------------------------- the view
// A DeskChat stripped to its store contract: subscribe, and ask for a first
// load if nobody has (desk.tsx:234). Everything else a desk does is rendering.
function View({ slug, nid, sink }: { slug: string; nid: string; sink: Convo[] }) {
  const c = useConvo(slug, nid)
  useEffect(() => { if (!c.loaded) void refreshConvo(slug, nid) }, [slug, nid, c.loaded])
  sink.push(c)
  return null
}

interface Desk {
  now(): Convo
  frames: Convo[]
  unmount(): Promise<void>
}

/** the store is a module-level Map keyed by slug․nid; a suite that reuses one
 *  key inherits the previous test's Entry — poller, in-flight flag, subscriber
 *  set. Real pages get a fresh module; tests have to ask. */
let _n = 0

interface Kit {
  SL: string
  ND: string
  s: FakeServer
  desk(): Promise<Desk>
  deskFor(nid: string): Promise<Desk>
}

/** Every test gets a mocked clock, a fresh key, a FakeServer with the fetch
 *  stub installed — and a teardown that runs EVEN WHEN THE TEST FAILS. An
 *  assertion firing mid-test used to leave a mounted root, a live poller and a
 *  running thinking clock behind, and the next four tests inherited them; two
 *  "failures" in the first draft of this file were that and nothing else. An
 *  order-dependent suite is worth less than no suite. */
function convoTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `n${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const open: Desk[] = []
    t.after(async () => {
      for (const d of open) { try { await d.unmount() } catch { /* already gone */ } }
      resetConvos()
      realClock()
    })
    const deskFor = async (nid: string): Promise<Desk> => {
      const sink: Convo[] = []
      const v = await mountView(<View slug={SL} nid={nid} sink={sink} />, () => sink.length)
      const d: Desk = {
        frames: sink,
        now: () => sink[sink.length - 1]!,
        unmount: v.unmount,
      }
      open.push(d)
      return d
    }
    await body({
      SL,
      ND,
      s,
      deskFor,
      desk: () => deskFor(ND),
    })
  })
}

/** every place a USER message is rendered by desk.tsx, in one list: the
 *  transcript, the durable pending bubble, and the optimistic ghost. The
 *  message-visibility invariant is a statement about this list. */
function userRows(c: Convo): string[] {
  return [
    ...(c.chat?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text),
    ...(c.chat?.pending_mail ?? []).filter((m) => m.from === '@user').map((m) => m.body),
    ...c.pending.map((g) => g.text),
  ]
}
const copies = (c: Convo, needle: string) =>
  userRows(c).filter((t) => (t || '').includes(needle)).length

// deterministic RNG — a failing drop rate has to be re-runnable
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------- turn script
/** One turn as a list of (what the SERVER does, what the socket WOULD say).
 *  The server half always happens — that is the whole point: the client is the
 *  only thing that can miss anything. */
interface Step { server: () => void; frame?: StreamEvent | { pulse: string } }

function turnScript(s: FakeServer, reply: string, opts: { tools?: number } = {}): Step[] {
  const steps: Step[] = [
    { server: () => { s.drain() }, frame: { pulse: 'turn_start' } },
    { server: () => { s.echo() } },
    { server: () => {}, frame: { node: '', kind: 'thinking_start', text: '', t: 0 } },
    { server: () => {}, frame: { node: '', kind: 'thinking', text: 'hmm', t: 0 } },
    { server: () => {}, frame: { node: '', kind: 'delta', text: reply.slice(0, 4), t: 0 } },
    { server: () => {}, frame: { node: '', kind: 'delta', text: reply.slice(4), t: 0 } },
  ]
  for (let i = 0; i < (opts.tools ?? 1); i++) {
    const id = `t${i}`
    steps.push({
      server: () => { s.liveRow('tool', `Read · f${i}.txt`, id) },
      frame: { node: '', kind: 'tool', text: `Read · f${i}.txt`, id, t: 0 },
    })
  }
  steps.push(
    {
      server: () => { s.liveRow('text', reply) },
      frame: { node: '', kind: 'text', text: reply, t: 0 },
    },
    { server: () => { s.assistantMsg(reply); s.sweepLive() } },
    { server: () => { s.endTurn() }, frame: { pulse: 'turn_done' } },
  )
  return steps
}

const send = (f: NonNullable<Step['frame']>, slug: string, nid: string) => {
  if ('pulse' in f) ingestPulse(slug, { node: nid, event: f.pulse, t: Date.now() })
  else ingestStream(slug, { ...f, node: nid })
}

async function runTurn(steps: Step[],
  deliver: (f: NonNullable<Step['frame']>) => void, gapMs = 150) {
  for (const st of steps) {
    await inAct(() => { st.server() })
    if (st.frame) deliver(st.frame)
    await advance(gapMs)
  }
}

/** force one refresh, where React can see the patch it makes. Advancing the
 *  clock is NOT a substitute: the idle heartbeat is 7 s, so a test that only
 *  advances 3 s asserts on a payload from before the step it just took — which
 *  is how the first draft of §3.2 passed while testing nothing. */
async function poll(slug: string, nid: string): Promise<void> {
  await inAct(async () => { await refreshConvo(slug, nid, { force: true }) })
}

/** the scroll handler's call, where React can see the patch it makes */
async function page(slug: string, nid: string): Promise<boolean> {
  let r = false
  await inAct(() => { r = loadOlder(slug, nid) })
  return r
}

// ===================================================================== §1
// CONVERGENCE WITH A LOSSY SOCKET
// ===================================================================== §1

convoTest('§1.1 drop sweep 0→100 %: converges on the server from polling alone',
  async ({ SL, ND, s, desk }) => {
    const rates = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
    const bad: string[] = []
    const d = await desk()
    await advance(3000)
    for (const p of rates) {
      for (let rep = 0; rep < REPS; rep++) {
        const r = rng(1000 + Math.round(p * 100) + rep)
        const token = `ping-${Math.round(p * 100)}-${rep}`
        s.postMail(token)
        await inAct(() => { addPending(SL, ND, token); markBusy(SL, ND) })
        await runTurn(turnScript(s, `reply ${token}`),
          (f) => { if (r() >= p) send(f, SL, ND) })
        // the socket has said everything it is ever going to say. Only the
        // heartbeat is left.
        await advance(30000)
        const c = d.now()
        const label = `p=${p} rep=${rep}`
        if (copies(c, token) !== 1) bad.push(`${label}: ${copies(c, token)} copies of the user message`)
        if ((c.chat?.messages.length ?? 0) !== Math.min(CHAT_WINDOW, s.messages.length)) {
          bad.push(`${label}: ${c.chat?.messages.length} transcript rows, server has ${s.messages.length}`)
        }
        if (c.live.length !== s.live.length) bad.push(`${label}: live ${c.live.length} vs server ${s.live.length}`)
        if (c.draft !== '') bad.push(`${label}: a streamed draft survived the turn (${JSON.stringify(c.draft)})`)
        if (c.thinkSecs !== null) bad.push(`${label}: the thinking clock never stopped (thinkSecs=${c.thinkSecs})`)
        if (c.thinking !== '') bad.push(`${label}: thinking text survived the turn`)
        if (c.pending.length) bad.push(`${label}: ${c.pending.length} ghost(s) stranded`)
      }
    }
    assert.deepEqual(bad, [], `${bad.length} divergences across ${rates.length * REPS} runs`)
  })

convoTest('§1.2 a fully deaf socket, three turns back to back',
  async ({ SL, ND, s, desk }) => {
    const d = await desk()
    await advance(3000)
    for (let i = 0; i < 3; i++) {
      const token = `deaf-${i}`
      s.postMail(token)
      await inAct(() => { addPending(SL, ND, token); markBusy(SL, ND) })
      await runTurn(turnScript(s, `answer ${i}`), () => { /* swallowed */ })
      await advance(20000)
      const c = d.now()
      assert.equal(copies(c, token), 1, `turn ${i}: exactly one copy of the message`)
      assert.equal(c.chat?.messages.length, s.messages.length, `turn ${i}: transcript converged`)
      assert.equal(c.draft, '', `turn ${i}: no stale draft`)
      assert.equal(c.thinkSecs, null, `turn ${i}: no stale thinking clock`)
    }
  })

convoTest('§1.3 duplicated frames change nothing', async ({ SL, ND, s, desk }) => {
  const d = await desk()
  await advance(3000)
  s.postMail('dup-token')
  await inAct(() => { addPending(SL, ND, 'dup-token'); markBusy(SL, ND) })
  await runTurn(turnScript(s, 'doubled reply'),
    (f) => { send(f, SL, ND); send(f, SL, ND) })
  await advance(20000)
  const c = d.now()
  assert.equal(copies(c, 'dup-token'), 1)
  assert.equal(c.chat?.messages.length, s.messages.length)
  assert.equal(c.draft, '')
  assert.equal(c.thinkSecs, null)
})

convoTest('§1.4 frames delivered out of order and late', async ({ SL, ND, s, desk }) => {
  const d = await desk()
  await advance(3000)
  s.postMail('ooo-token')
  await inAct(() => { addPending(SL, ND, 'ooo-token'); markBusy(SL, ND) })
  // buffer three frames and deliver them reversed — the shape a reconnect
  // burst or a coalescing proxy actually produces
  let buf: NonNullable<Step['frame']>[] = []
  const late: NonNullable<Step['frame']>[] = []
  await runTurn(turnScript(s, 'scrambled reply'), (f) => {
    buf.push(f)
    if (buf.length === 3) {
      const take = buf.reverse()
      buf = []
      late.push(take.pop()!)      // one arrives after the turn is over
      take.forEach((x) => send(x, SL, ND))
    }
  })
  await advance(10000)
  await inAct(() => { [...buf, ...late].forEach((x) => send(x, SL, ND)) })
  await advance(30000)
  const c = d.now()
  assert.equal(copies(c, 'ooo-token'), 1, 'exactly one copy of the user message')
  assert.equal(c.chat?.messages.length, s.messages.length, 'transcript converged')
  assert.equal(c.draft, '', 'no stale draft from a late delta')
  assert.equal(c.thinkSecs, null, 'no stale clock from a late thinking_start')
})

convoTest('§1.5 a lone thinking_start does not leave the panel thinking forever',
  async ({ SL, ND, s, desk }) => {
    // the minimal reproduction of §1.1's failure: the only frame that gets
    // through is the one that STARTS the clock. Nothing in the payload path
    // may leave that clock running once the server says the turn is over.
    const d = await desk()
    await advance(3000)
    s.busy = true
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'thinking_start', text: '', t: Date.now() })
      ingestStream(SL, { node: ND, kind: 'delta', text: 'half a sen', t: Date.now() })
    })
    await advance(2000)
    assert.notEqual(d.now().thinkSecs, null, 'the clock did start')
    assert.equal(d.now().draft, 'half a sen', 'the draft is on screen')
    // the turn ends and the transcript carries the real row — but every frame
    // that would have said so is lost
    s.assistantMsg('half a sentence and the rest')
    s.endTurn()
    await advance(30000)
    assert.equal(d.now().thinkSecs, null, 'the thinking clock retires on the payload')
    assert.equal(d.now().draft, '', 'the superseded draft retires on the payload')
  })

convoTest('§1.6 a dropped turn_done does not double-render the reply',
  async ({ SL, ND, s, desk }) => {
    // the draft and the durable row say the same words. If the draft outlives
    // its replacement the reply is on screen twice — the mirror image of the
    // gap D-50 closed, and just as visible.
    const d = await desk()
    await advance(3000)
    s.drain()
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'the whole reply', t: Date.now() })
    })
    await advance(500)
    s.assistantMsg('the whole reply')
    s.endTurn()
    await advance(30000)
    const c = d.now()
    const shown = [...(c.chat?.messages ?? []).map((m) => m.text), c.draft]
      .filter((t) => (t || '').includes('the whole reply')).length
    assert.equal(shown, 1, `the reply is on screen ${shown} times`)
  })

convoTest('§1.8 the `text` handover retires a draft while the turn is STILL BUSY',
  async ({ SL, ND, s, desk }) => {
    // WHY THIS IS SEPARATE FROM §1.6. That one ends the turn, so `busy` goes
    // false and the payload's own idleness retires the draft. It therefore
    // says nothing about the window this test owns: the durable row landing
    // MID-TURN, with the turn still running.
    //
    // `{kind:"text"}` is the only signal that closes that window, and a
    // provider leg that omits it renders the reply twice — once as the grey
    // draft, once as its own transcript row — until `turn_done`. The
    // antigravity leg did exactly that (user report 2026-09-04: "i see double
    // messages in antigravity agents"); it now emits the frame the claude and
    // codex legs always have, and the backend half is pinned by
    // test_antigravity_dispatch's "the streamed draft is handed over".
    // This is the client half: the frame must retire the draft even while the
    // payload still says busy.
    //
    // ⚠ RESIDUAL, stated rather than hidden: this retirement is still driven
    // by an EVENT. A dropped `text` frame leaves the draft up until the turn
    // ends, for every provider — convo.ts says so where `staleDraft` is set,
    // and closing it needs a server-carried fact the payload does not yet
    // have. What this test pins is that the frame, when it arrives, works
    // mid-turn.
    const d = await desk()
    await advance(3000)
    s.drain()
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'the whole reply', t: Date.now() })
    })
    await advance(500)
    assert.equal(d.now().draft, 'the whole reply', 'the draft is on screen')
    // the durable row lands and the seam hands over — but the turn KEEPS
    // RUNNING: `s.busy` stays true, so nothing here can be credited to idleness
    s.assistantMsg('the whole reply')
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'text', text: 'the whole reply', t: Date.now() })
    })
    await advance(30000)
    const c = d.now()
    assert.equal(c.chat?.busy, true, 'the turn must still be busy for this to mean anything')
    assert.equal(c.draft, '', 'the superseded draft outlived its replacement')
    const shown = [...(c.chat?.messages ?? []).map((m) => m.text), c.draft]
      .filter((t) => (t || '').includes('the whole reply')).length
    assert.equal(shown, 1, `the reply is on screen ${shown} times`)
  })

convoTest('§1.9 a DROPPED text frame still retires the draft — on state alone',
  async ({ SL, ND, s, desk }) => {
    // THE GUARANTEE §1.8 does not give. That test proves the handover works
    // when the frame ARRIVES; this one takes the frame away, which is the
    // governing invariant of this file — the websocket is an optimisation and
    // nothing on screen may depend on having caught an event.
    //
    // Before `draft_epoch` the only mid-turn retirement was `staleDraft`, and
    // that becomes true ONLY because a frame arrived. So one dropped frame put
    // the reply on screen twice until the turn ended, on EVERY provider. The
    // server now advances an opaque token whenever a turn's streamed text
    // becomes durable, so an ordinary poll carries the same news.
    const d = await desk()
    await advance(3000)
    s.drain()
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'the whole reply', t: Date.now() })
    })
    await advance(500)
    assert.equal(d.now().draft, 'the whole reply', 'the draft is on screen')
    // the reply becomes durable and the epoch advances — and the `text` frame
    // is NEVER delivered. The turn also keeps running, so idleness cannot be
    // credited with the retirement either.
    s.textDurable('the whole reply')
    await advance(30000)
    const c = d.now()
    assert.equal(c.chat?.busy, true, 'the turn must still be busy for this to mean anything')
    assert.equal(c.draft, '', 'the draft outlived its replacement with no frame to retire it')
    const shown = [...(c.chat?.messages ?? []).map((m) => m.text), c.draft]
      .filter((t) => (t || '').includes('the whole reply')).length
    assert.equal(shown, 1, `the reply is on screen ${shown} times`)
  })

convoTest('§1.10 a draft that is still being typed is NOT retired by the epoch',
  async ({ SL, ND, s, desk }) => {
    // the other direction, and the one D-50 actually cares about: retiring
    // early is a GAP, which is worse than the double. An epoch that moved for
    // some EARLIER message must not blank a draft that is still growing.
    const d = await desk()
    await advance(3000)
    s.drain()
    // an earlier reply in this turn goes durable BEFORE this draft starts
    s.textDurable('first message')
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'text', text: 'first message', t: Date.now() })
    })
    await advance(3000)
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'second mess', t: Date.now() })
    })
    await advance(8000)
    // nothing new became durable, so the epoch has not moved since this draft
    // began — the draft must survive, however many polls land
    assert.equal(d.now().draft, 'second mess', 'a live draft was blanked by a stale epoch')
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'age', t: Date.now() })
    })
    await advance(8000)
    assert.equal(d.now().draft, 'second message', 'a GROWING draft must keep its baseline')
  })

convoTest('§1.11 a backend restart cannot leave the desk permanently ahead',
  async ({ SL, ND, s, desk }) => {
    // The count lives in memory, so a restart puts it back to 0. If the desk
    // kept comparing against the old sequence it would sit permanently ahead
    // of the server and NO later handover would ever retire a draft again — a
    // stuck double that appears only after a deploy, which is the worst
    // possible time to meet it.
    //
    // So a changed boot half RE-SYNCS rather than decides. It deliberately
    // does not retire on the spot: a restart kills the turn, so `idle` clears
    // the draft on the next payload anyway (and in the real app `noteInstance`
    // has already reloaded the page). What must be true is that the desk is
    // working again immediately, which is what this asserts.
    const d = await desk()
    await advance(3000)
    s.drain()
    s.textDurable('one'); s.textDurable('two'); s.textDurable('three')
    await advance(3000)
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'mid-flight', t: Date.now() })
    })
    await advance(500)
    assert.equal(d.now().draft, 'mid-flight')
    // orgtree restarts under the page: new process, count back to 0
    s.boot = 'boot1'
    s.epoch = 0
    await advance(30000)
    // a NEW handover on the new sequence, with its frame dropped. If the desk
    // were still holding 3 it would need four more before it noticed anything;
    // having re-synced, this one is enough.
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'after the restart', t: Date.now() })
    })
    await advance(500)
    s.textDurable('after the restart')
    await advance(30000)
    const c = d.now()
    assert.equal(c.chat?.busy, true, 'the turn must still be busy for this to mean anything')
    assert.equal(c.draft, '',
      'the desk stayed ahead of the restarted server and stopped retiring drafts')
  })

convoTest('§1.7 a fetch already in flight may not blank a live draft',
  async ({ SL, ND, s, desk }) => {
    // the mirror image of §1.5, and the trap D-50 fell into: a request issued
    // BEFORE the stream began answers with `busy:false` — a world in which
    // nothing was being typed. Honouring it would blank a draft that is still
    // growing, which is a gap, which is the failure this whole design refuses.
    const d = await desk()
    await advance(3000)
    s.latency = 4000
    const before = s.requests.length
    void refreshConvo(SL, ND, { force: true })   // goes out while the server is idle
    await advance(100)
    assert.equal(s.requests.length, before + 1, 'the slow request is in the air')
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'delta', text: 'now typing…', t: Date.now() })
    })
    s.busy = true                     // the turn started after that request left
    await advance(6000)               // …and the stale payload lands
    assert.equal(d.now().draft, 'now typing…',
      'the in-flight payload blanked a draft it could not have known about')
  })

// ===================================================================== §2
// TWO VIEWS OF ONE NODE
// ===================================================================== §2

convoTest('§2.1 a card and a switchboard panel never disagree, under interleaving',
  async ({ SL, ND, s, desk }) => {
    const card = await desk()
    const board = await desk()
    await advance(3000)
    const diffs: string[] = []
    const compare = (where: string) => {
      if (card.now() !== board.now()) diffs.push(`${where}: the two views hold different snapshots`)
    }
    s.postMail('agree-token')
    await inAct(() => { addPending(SL, ND, 'agree-token') })
    compare('after addPending')
    const r = rng(7)
    await runTurn(turnScript(s, 'shared reply', { tools: 3 }), (f) => {
      if (r() > 0.35) send(f, SL, ND)
      compare('mid-turn')
    })
    await advance(20000)
    compare('after convergence')
    assert.deepEqual(diffs, [])
    assert.equal(card.now().chat?.messages.length, s.messages.length)
    // and ONE fetch serves both views (convo.ts's stated cost claim)
    const before = s.requests.length
    await advance(7100)
    assert.ok(s.requests.length - before <= 2,
      `two mounted views produced ${s.requests.length - before} fetches in one idle period`)
  })

convoTest('§2.2 a view mounted mid-turn catches up to the one that was there',
  async ({ SL, ND, s, desk }) => {
    const first = await desk()
    await advance(3000)
    s.postMail('late-join')
    await inAct(() => { addPending(SL, ND, 'late-join') })
    const steps = turnScript(s, 'joined reply')
    for (let i = 0; i < 5; i++) {
      await inAct(() => { steps[i]!.server() })
      if (steps[i]!.frame) send(steps[i]!.frame!, SL, ND)
      await advance(150)
    }
    const second = await desk()
    await flush()
    assert.equal(second.now(), first.now(), 'the new view starts from the shared state')
    for (let i = 5; i < steps.length; i++) {
      await inAct(() => { steps[i]!.server() })
      if (steps[i]!.frame) send(steps[i]!.frame!, SL, ND)
      await advance(150)
      assert.equal(second.now(), first.now(), `step ${i}: still identical`)
    }
    await advance(20000)
    assert.equal(second.now(), first.now())
  })

convoTest('§2.3 unmounting one view does not stop the other from refreshing',
  async ({ s, desk }) => {
    await desk()
    const board = await desk()
    await advance(3000)
    await board.unmount()
    const before = s.requests.length
    await advance(30000)
    assert.ok(s.requests.length > before,
      'the surviving view still polls after its twin unmounted')
  })

// ===================================================================== §3
// THE GRADUATION RULE
// ===================================================================== §3

convoTest('§3.1 one send: continuously on screen, exactly once, all the way through',
  async ({ SL, ND, s, desk }) => {
    const d = await desk()
    await advance(3000)
    const token = 'single-send-token'
    await inAct(() => { addPending(SL, ND, token) })
    const seen: number[] = []
    const sample = () => seen.push(copies(d.now(), token))
    sample()
    s.postMail(token)
    await advance(500); sample()
    s.drain()
    await advance(500); sample()
    s.echo()
    await advance(3000); sample()
    s.assistantMsg('ok')
    s.endTurn()
    await advance(10000); sample()
    assert.ok(!seen.includes(0), `the message went off screen: ${seen.join(',')}`)
    assert.ok(!seen.some((n) => n > 1), `the message rendered twice: ${seen.join(',')}`)
  })

convoTest('§3.2 the SAME text sent twice before any refresh keeps both previews',
  async ({ SL, ND, s, desk }) => {
    // D-52 fixed "the same text in two different turns". This is the tighter
    // case its count baseline does not cover: two ghosts alive at the same
    // instant, both made from the same payload, so both carry the same `seen`
    // and one server copy retires BOTH.
    const d = await desk()
    await advance(3000)
    await inAct(() => {
      addPending(SL, ND, 'continue')
      addPending(SL, ND, 'continue')
    })
    assert.equal(d.now().pending.length, 2, 'two ghosts')
    s.postMail('continue')                       // the server sees the first
    await poll(SL, ND)
    assert.equal(copies(d.now(), 'continue'), 2,
      'both sends still on screen — one server copy, one ghost')
    s.postMail('continue')                       // …and the second
    await poll(SL, ND)
    await advance(8000)
    assert.equal(copies(d.now(), 'continue'), 2, 'and neither renders twice')
  })

convoTest('§3.3 a failed send retires ONE ghost, not every ghost with that text',
  async ({ SL, ND, desk }) => {
    const d = await desk()
    await advance(3000)
    await inAct(() => {
      addPending(SL, ND, 'yes')
      addPending(SL, ND, 'yes')
    })
    // the second POST fails; desk.tsx's catch drops that send's ghost
    await inAct(() => { dropPending(SL, ND, 'yes') })
    assert.equal(d.now().pending.length, 1,
      'the send that succeeded still has its preview')
  })

convoTest('§3.4 a steered frame retires one ghost, not every matching ghost',
  async ({ SL, ND, desk }) => {
    const d = await desk()
    await advance(3000)
    await inAct(() => {
      addPending(SL, ND, 'stop')
      addPending(SL, ND, 'stop')
    })
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'steered', text: '[user] stop', t: Date.now() })
    })
    assert.equal(d.now().pending.length, 1,
      'only the steered message graduated')
  })

convoTest('§3.5 a >2 kB body graduates against the server-truncated copy',
  async ({ SL, ND, s, desk }) => {
    s.bodyCap = 250            // the tightest tier node_chat applies
    const d = await desk()
    await advance(3000)
    const big = 'X'.repeat(10000)
    await inAct(() => { addPending(SL, ND, big) })
    s.postMail(big)
    await advance(12000)
    assert.equal(d.now().pending.length, 0, 'the ghost graduated against the truncated body')
    assert.equal(copies(d.now(), 'X'.repeat(200)), 1, 'and it is on screen exactly once')
  })

convoTest('§3.6 a turn that buries the message strands no ghost, at any depth',
  async ({ SL, ND, s, desk }) => {
    // D-53 lead 3 → D-55 flagged it → D-57 ④ raised COPIES_WINDOW 20 → 200
    // against a measured maximum burial of 138 rows. The raise did nothing:
    // `read_chat` returns CHAT_WINDOW = 120 rows, so the newest-200 slice is
    // the whole payload and the effective window stayed at 120 — UNDER the
    // measured maximum. Past it the baseline is unreachable and the optimistic
    // bubble sits at the bottom of the desk for the rest of the session,
    // presenting an answered message as though it were still queued.
    //
    // The invariant is not "always exactly one copy": a message 260 rows back
    // is legitimately off the top of the window, like any other old message.
    // It is "never two, and never a ghost that cannot die".
    const d = await desk()
    await advance(3000)
    for (const depth of [10, 138, 260]) {
      const token = `burial-${depth}`
      await inAct(() => { addPending(SL, ND, token) })
      s.postMail(token)
      await advance(3000)
      assert.equal(copies(d.now(), token), 1, `${depth}: on screen while queued`)
      s.drain()
      s.echo()
      await advance(3000)
      assert.equal(copies(d.now(), token), 1, `${depth}: on screen at the handover`)
      for (let i = 0; i < depth; i++) s.assistantMsg(`filler ${depth} step ${i}`)
      s.endTurn()
      await advance(20000)
      const inWindow = (d.now().chat?.messages ?? [])
        .some((m) => m.role === 'user' && (m.text || '').includes(token))
      assert.ok(copies(d.now(), token) <= 1, `${depth}: rendered twice`)
      assert.equal(d.now().pending.length, 0,
        `${depth}: a ghost survived (in-window=${inWindow}) — nothing can retire it`)
      if (inWindow) {
        assert.equal(copies(d.now(), token), 1,
          `${depth}: the transcript has it, so it must be on screen`)
      }
    }
  })

convoTest('§3.6b …even when no refresh lands while the message is visible',
  async ({ SL, ND, s, desk }) => {
    // §3.6 exercises the happy path, where a fetch lands while the message is
    // in `pending_mail` and the ghost graduates there. The stranding case needs
    // the OTHER ordering — the D-55 race: the mail is drained and echoed before
    // any refresh, so the ghost is still alive when the turn buries the row
    // past the fetched window. Then the count can never rise again.
    const d = await desk()
    await advance(3000)
    for (const depth of [138, 260]) {
      const token = `strand-${depth}`
      await inAct(() => { addPending(SL, ND, token) })
      s.postMail(token)
      s.drain()
      s.echo()
      // ⚠ the filler must NOT contain the token: the first draft named the
      // rows `${token} step N`, so the precondition check found the token in
      // the FILLER and the test passed either way
      for (let i = 0; i < depth; i++) s.assistantMsg(`filler ${depth} step ${i}`)
      s.endTurn()
      await advance(20000)
      assert.equal((d.now().chat?.messages ?? [])
        .some((m) => m.role === 'user' && (m.text || '').includes(token)), false,
      `${depth}: precondition — the row really is outside the fetched window`)
      assert.equal(d.now().pending.length, 0,
        `${depth}: the ghost is stranded; nothing can ever retire it`)
    }
  })

convoTest('§3.7 GET /chat returning 500 strands nothing', async ({ SL, ND, s, desk }) => {
  const d = await desk()
  await advance(3000)
  const token = 'five-hundred'
  await inAct(() => { addPending(SL, ND, token) })
  s.postMail(token)
  s.fail = 500
  await advance(20000)
  assert.equal(copies(d.now(), token), 1, 'still exactly one copy while the API is down')
  s.fail = null
  await advance(20000)
  assert.equal(copies(d.now(), token), 1, 'and after it recovers')
  assert.equal(d.now().pending.length, 0, 'the ghost graduated once a payload landed')
})

convoTest('§3.8 rapid-fire distinct sends all stay on screen',
  async ({ SL, ND, s, desk }) => {
    const d = await desk()
    await advance(3000)
    const tokens = Array.from({ length: 8 }, (_, i) => `burst-${i}`)
    for (const t of tokens) {
      await inAct(() => { addPending(SL, ND, t) })
      s.postMail(t)
      await advance(80)
      for (const seen of tokens.slice(0, tokens.indexOf(t) + 1)) {
        assert.equal(copies(d.now(), seen), 1, `${seen} while sending ${t}`)
      }
    }
    await advance(20000)
    for (const t of tokens) assert.equal(copies(d.now(), t), 1, `${t} after convergence`)
  })

convoTest('§3.9 a long transcript never hides the message being sent',
  async ({ SL, ND, s, desk }) => {
    for (let i = 0; i < 900; i++) s.assistantMsg(`history ${i}`)
    const d = await desk()
    await advance(3000)
    const token = 'long-transcript-token'
    await inAct(() => { addPending(SL, ND, token) })
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      if (i === 1) s.postMail(token)
      if (i === 2) { s.drain(); s.echo() }
      if (i === 3) { s.assistantMsg('done'); s.endTurn() }
      await advance(3000)
      seen.push(copies(d.now(), token))
    }
    assert.ok(!seen.includes(0), `went off screen: ${seen.join(',')}`)
    assert.ok(!seen.some((n) => n > 1), `rendered twice: ${seen.join(',')}`)
  })

// ===================================================================== §4
// PAGING (D-56)
// ===================================================================== §4

convoTest('§4.1 loadOlder grows one window at a time and stops at the API cap',
  async ({ SL, ND, s, desk }) => {
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    const d = await desk()
    await advance(3000)
    assert.equal(d.now().chat?.messages.length, CHAT_WINDOW)
    let win = CHAT_WINDOW
    let guard = 0
    while (await page(SL, ND)) {
      win += CHAT_WINDOW
      assert.equal(d.now().win, Math.min(MAX_WINDOW, win), 'one window per call')
      await advance(1000)
      assert.ok((guard += 1) < 50, 'loadOlder never terminated')
    }
    assert.equal(d.now().win, MAX_WINDOW, 'stopped exactly at the cap')
    assert.equal(d.now().chat?.messages.length, MAX_WINDOW)
    assert.equal(await page(SL, ND), false, 'and refuses further paging')
  })

convoTest('§4.2 a scroll gesture cannot page several windows',
  async ({ SL, ND, s, desk }) => {
    // the desk fires loadOlder from onScroll, which emits many events per
    // gesture; only the first may page.
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    s.latency = 400
    const d = await desk()
    await advance(3000)
    const fired: boolean[] = []
    for (let i = 0; i < 5; i++) fired.push(await page(SL, ND))
    assert.deepEqual(fired, [true, false, false, false, false], 'one gesture, one page')
    assert.equal(d.now().win, CHAT_WINDOW * 2)
    await advance(2000)
  })

convoTest('§4.3 a heartbeat landing mid-page does not re-open the pager',
  async ({ SL, ND, s, desk }) => {
    // `loadingOlder` is the pager's only guard, and ANY fetch completing
    // clears it — including one already in flight when the page was asked for,
    // which carries the SMALLER window and does not answer the page.
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    const d = await desk()
    await advance(3000)
    s.latency = 3000                              // the heartbeat now hangs
    await advance(2600)                           // …and one is issued
    s.latency = 200
    assert.equal(await page(SL, ND), true)
    await advance(3400)                           // both land
    assert.equal(d.now().win, CHAT_WINDOW * 2, 'still one page')
    assert.equal(d.now().chat?.messages.length, CHAT_WINDOW * 2,
      'the older window is on screen — not the stale small one')
  })

convoTest('§4.4 a stale in-flight response never shrinks the transcript',
  async ({ SL, ND, s, desk }) => {
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    const d = await desk()
    await advance(3000)
    const sizes: number[] = []
    const wins: number[] = []
    const record = () => {
      sizes.push(d.now().chat?.messages.length ?? 0)
      wins.push(d.now().win)
    }
    record()
    s.latency = 2000                 // a slow heartbeat at win=120 is in the air
    await advance(2600)
    s.latency = 100
    await page(SL, ND)               // …when the reader pages to 240
    for (let i = 0; i < 20; i++) { await advance(200); record() }
    const shrank = sizes.filter((n, i) => i > 0 && n < sizes[i - 1]!)
    assert.deepEqual(shrank, [],
      `the transcript shrank mid-page: ${sizes.join(' → ')} (win ${wins.join(' → ')})`)
  })

// ===================================================================== §5
// STORE HYGIENE
// ===================================================================== §5

convoTest('§5.1 resetConvos leaves a still-mounted view polling',
  async ({ s, desk }) => {
    // it deliberately resets entries IN PLACE so a mounted view keeps its
    // subscription (D-34). The subscription also gates the heartbeat, so a
    // reset must not leave that view alive but frozen.
    s.assistantMsg('before')
    const d = await desk()
    await advance(3000)
    assert.equal(d.now().chat?.messages.length, 1)
    resetConvos()
    s.assistantMsg('after')
    const before = s.requests.length
    await advance(30000)
    assert.ok(s.requests.length > before, 'the view kept fetching after the reset')
    assert.equal(d.now().chat?.messages.length, 2, 'and converged on the server again')
  })

convoTest('§5.2 a delayed pre-rename response cannot overwrite the renamed or reused Entry',
  async ({ SL, ND, s, desk, deskFor }) => {
    // First load a real current snapshot into A. The held response below is a
    // different, stale snapshot requested before A is renamed to B.
    s.assistantMsg('B current')
    const b = await desk()
    await advance(100)
    assert.deepEqual(b.now().chat?.messages.map((m) => m.text), ['B current'])

    const t = installFetch(s)
    t.holdAll = true
    s.messages = []
    s.assistantMsg('stale pre-rename payload')
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'thinking', text: 'still thinking', t: Date.now() })
    })
    void refreshConvo(SL, ND, { force: true })
    await flush()

    // Exercise the normal App ordering where a pulse can create B before the
    // rename event arrives. renameConvo must replace that placeholder rather
    // than dropping the old Entry or leaving a permanent name alias.
    ingestPulse(SL, { node: 'b', event: 'turn_done', t: Date.now() })
    renameConvo(SL, ND, 'b')

    // A distinct new hire reuses A's name. Its real view and fetch must remain
    // isolated from the old request, even when that request settles first.
    s.messages = []
    s.assistantMsg('fresh A payload')
    const a = await deskFor(ND)
    t.holdAll = false
    t.release()
    await flush(10)

    assert.deepEqual(b.now().chat?.messages.map((m) => m.text), ['B current'],
      'the stale pre-rename response did not replace B current data')
    assert.equal(b.now().thinking, 'still thinking',
      'the stale response did not retire renamed Entry thinking state')
    assert.equal(b.now().thinkSecs, 0,
      'the stale response did not rewrite renamed Entry clock state')
    assert.deepEqual(a.now().chat?.messages.map((m) => m.text), ['fresh A payload'],
      'a newly hired A did not inherit B or the old A response')

    // Reverse/chained renames must not overwrite that active fresh A with the
    // former B Entry. This is the name-reuse case that permanent aliases made
    // unsafe; the destination identity wins when it is already live.
    renameConvo(SL, 'b', ND)
    assert.deepEqual(a.now().chat?.messages.map((m) => m.text), ['fresh A payload'],
      'B→A did not overwrite the distinct newly hired A')

    // Removal has the same publication boundary: a held response for a
    // dropped node must not recreate its key or update the mounted stale view.
    s.messages = []
    s.assistantMsg('late removed A')
    t.holdAll = true
    void refreshConvo(SL, ND, { force: true })
    await flush()
    dropConvo(SL, ND)
    t.holdAll = false
    t.release()
    await flush(10)
    assert.deepEqual(a.now().chat?.messages.map((m) => m.text), ['fresh A payload'],
      'a response settling after removal did not repopulate the dropped A')
  })

convoTest('§5.3 no timer outlives the last view', async ({ SL, ND, s, desk }) => {
  const d = await desk()
  await advance(3000)
  await inAct(() => {
    ingestStream(SL, { node: ND, kind: 'thinking_start', text: '', t: Date.now() })
  })
  await advance(3000)
  await d.unmount()
  const before = s.requests.length
  await advance(60000)
  assert.equal(s.requests.length, before, 'no fetch after the last unmount')
})

convoTest('§5.4 an unmount mid-fetch is not a crash and not a leak',
  async ({ s, desk }) => {
    s.assistantMsg('one')
    const d = await desk()
    s.latency = 5000
    await advance(3000)               // a fetch is in the air
    await d.unmount()
    await advance(10000)              // …and lands with nobody listening
    const before = s.requests.length
    await advance(30000)
    assert.equal(s.requests.length, before, 'nothing kept polling')
  })

// ═══════════════════════════════════════════════════════════════════════ §6
// COMMAND GHOSTS — a command that becomes a turn is not a command that vanishes
// ═══════════════════════════════════════════════════════════════════════ §6
//
// User bug 2026-08-09: "messages sent to an idle chat appear immediately,
// commands don't appear until the turn starts." The send path dropped the
// optimistic ghost for anything carrying `command: true`, on the reasoning
// that a command never enters pending_mail and so has nothing to graduate
// against. That reasoning holds for the IMMEDIATE shape only (a throwaway
// session fork whose output rides the live feed, writing no transcript row).
// An ordinary command is delivered VERBATIM as its own user event, so a row
// IS coming — dropping its ghost left the desk blank until the turn started.
//
// desk.tsx now keys the drop on `immediate || compacting`. What THIS suite can
// prove is the half the fix depends on: that keeping such a ghost terminates —
// it graduates on the row like any message, rather than sitting forever.

convoTest('§6.1 a ghost for a command graduates on the transcript row it '
  + 'eventually becomes', async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    // the desk keeps the ghost for a non-immediate command (desk.tsx)
    await inAct(() => { addPending(SL, ND, '/status') })
    assert.equal(d.now().pending.length, 1,
      'the ghost is what the user sees between send and turn start')
    // …the turn starts and the command lands verbatim as its own user event
    s.userMsg('/status')
    await inAct(() => refreshConvo(SL, ND, { force: true }))
    await advance(100)
    assert.equal(d.now().pending.length, 0,
      'the ghost never retired against its own transcript row — kept, it '
      + 'would sit on the desk forever, which is why the drop existed')
    const rows = (d.now().chat?.messages ?? []).filter((m) => m.text === '/status')
    assert.equal(rows.length, 1, 'the command should appear exactly once')
  })

convoTest('§6.2 …and an IMMEDIATE command, which never becomes a row, is the '
  + 'case the explicit drop still exists for', async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    await inAct(() => { addPending(SL, ND, '/context') })
    // no transcript row is EVER written for this shape — only live-feed output
    await inAct(() => refreshConvo(SL, ND, { force: true }))
    await advance(100)
    assert.equal(d.now().pending.length, 1,
      'without an explicit drop this ghost is immortal — the store cannot '
      + 'retire what the server never shows, so desk.tsx must drop it')
    await inAct(() => { dropPending(SL, ND, '/context') })
    assert.equal(d.now().pending.length, 0)
  })

// ═══════════════════════════════════════════════════════════════════════ §7
// A REQUEST THAT NEVER ANSWERS MUST NOT FREEZE THE DESK
// ═══════════════════════════════════════════════════════════════════════ §7
//
// User report 2026-08-10: "unconfirmed messages in flight get stuck during API
// outages — chiefly a frontend bug." Traced to a latch. `refreshConvo` gates
// on `inflight`, and `inflight` is cleared only by the fetch SETTLING. `fetch`
// has no timeout, so a backend that accepts the connection and then goes quiet
// — a wedged update thread, a half-open socket — held the gate true for the
// life of the tab: every later poll tick took the early return and the desk
// stopped updating, with the just-sent message pinned at the bottom as a ghost
// that could neither graduate (no payload) nor retire (no error).
//
// Two independent fixes, because a frozen desk must not be reachable by ANY
// route: api.ts bounds every request, and the gate below expires. This suite
// can only exercise the second — the stub's `holdAll` IS a request that never
// answers, which is precisely the condition an AbortSignal would end.

convoTest('§7.1 a fetch that never answers does not stop the desk from ever '
  + 'fetching again', async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    // the transport handle: same server, same stub, but now we can hold
    const t = installFetch(s)
    await inAct(() => { addPending(SL, ND, 'sent during the outage') })
    assert.equal(d.now().pending.length, 1, 'precondition: the ghost exists')

    t.holdAll = true
    void refreshConvo(SL, ND)          // goes out, and never comes back
    await advance(1000)
    const during = t.requests
    assert.ok(during >= 1, 'the held request never left the client')

    // …the poll keeps ticking, and before the fix every one of those ticks
    // early-returned on the latched gate. Past the stall window one must get
    // through, or nothing on this desk can ever recover without a reload.
    await advance(STALL_MS + 10_000)
    assert.ok(t.requests > during,
      'no request was issued in the 70 s after the first one hung: the '
      + 'refresh gate is latched by a fetch that never settles, so the desk '
      + `is frozen until the tab is reloaded (requests ${during} → ${t.requests})`)

    // and when the wire comes back the desk catches up — the ghost graduates
    // against the server's own copy rather than sitting there
    s.userMsg('sent during the outage')
    t.holdAll = false
    t.release()
    await advance(10_000)      // > one idle poll interval
    assert.equal(d.now().pending.length, 0,
      'the ghost survived a payload that carries its own message')
  })

// ═══════════════════════════════════════════════════════════════════════ §8
// AN UNKNOWN COMMAND'S GHOST — the one shape that can never graduate
// ═══════════════════════════════════════════════════════════════════════ §8
//
// User bug 2026-09-03: "i sent an invalid command and it got stuck as a
// permanently undelivered message that i cant cancel."
//
// §6 proved the two command shapes the desk knew about. This is the third,
// and it falls between them. `api.node_message` treats any COMMAND-SHAPED
// first token as a session command (`/[A-Za-z?][\w-]*`), and orgtree only
// recognises four words of its own — `/compact` and IMMEDIATE_CMDS
// {context, cost, todos}. Everything else is handed to the CLI verbatim on
// the theory that the CLI might know it. When it doesn't:
//
//   · no `pending_mail` row — the command path files no durable copy
//     (api.py: "the command path persists no copy anywhere"), so the first
//     of the two graduation routes in refreshConvo never opens;
//   · no transcript row — nothing ran, so the second never opens either;
//   · no retract ✕ — that button needs `m.id`, and a ghost has no id
//     because it was never durable.
//
// So the bubble sits dimmed forever and the user cannot dismiss it. §6.2
// already stated the mechanism in as many words ("without an explicit drop
// this ghost is immortal — the store cannot retire what the server never
// shows"); what it did not say is that desk.tsx's drop covers `immediate ||
// compacting` and NOTHING ELSE, so the immortal case is reachable in one
// keystroke by anyone who mistypes a command.
//
// The fix is NOT a validator: the CLI's command vocabulary — including the
// user's own project skills — is not ours and changes under us, so a list
// here would rot into a guard that stops catching things. Instead: the ghost
// resolves on EVIDENCE, the same rule the rest of this file runs on. A turn
// that has ended is the server saying nothing is coming.

convoTest('§8.1 an unknown command RESOLVES when the turn ends without '
  + 'writing anything', async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    // the user types /orgtree-ensure. It is command-SHAPED, so it takes the
    // command path; it is not one of orgtree's four, so it goes to the CLI,
    // which has no such command. desk.tsx keeps the ghost — `immediate` and
    // `compacting` are both false — on the reasoning that "a row IS coming".
    await inAct(() => {
      addPending(SL, ND, '/orgtree-ensure')
      markGhostCommand(SL, ND, '/orgtree-ensure')
      markBusy(SL, ND)
    })
    assert.equal(d.now().pending.length, 1, 'the ghost is on screen, as intended')
    // …the turn runs and ends. NOTHING was written: no user row, no mail row.
    s.busy = false
    await advance(CMD_GRACE + 1000)
    await poll(SL, ND)
    // the premise. NOT `copies`, which counts the ghost itself among the
    // places a user message is rendered — the claim here is narrower and is
    // about the SERVER: neither a transcript row nor a mailbox row exists.
    const srv = d.now()
    assert.equal(
      (srv.chat?.messages ?? []).filter((m) => m.role === 'user'
        && (m.text || '').includes('/orgtree-ensure')).length
      + (srv.chat?.pending_mail ?? []).filter((m) =>
        (m.body || '').includes('/orgtree-ensure')).length, 0,
      'the premise: the server never showed this text in EITHER place a ghost '
      + 'can graduate against')
    const g = d.now().pending
    assert.equal(g.length, 1,
      'it must NOT vanish — a message that disappears is worse than one that '
      + 'hangs, because the user cannot tell whether it went')
    assert.equal(g[0]?.failed, true,
      'the node is idle and the row is never coming: say so, rather than '
      + 'leaving a bubble indistinguishable from one genuinely still queued')
    assert.equal(g[0]?.text, '/orgtree-ensure',
      'the text the user typed is still recoverable from the ghost')
  })

convoTest('§8.2 …and a command that DOES run still graduates on its row, '
  + 'never failing first (anti-vacuity for §8.1)',
  async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    await inAct(() => {
      addPending(SL, ND, '/context')
      markGhostCommand(SL, ND, '/context')
      markBusy(SL, ND)
    })
    // the CLI knows this one: it runs, and the command lands verbatim as its
    // own user row — the ordinary graduation, well inside the grace window
    s.userMsg('/context')
    await poll(SL, ND)
    await advance(100)
    assert.equal(d.now().pending.length, 0,
      'a real command graduates on its row exactly as before — §8.1 must not '
      + 'be reachable by simply outliving a grace timer')
  })

convoTest('§8.3 the grace window protects a slow CLI boot: idle alone does '
  + 'NOT condemn a command', async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    await inAct(() => {
      addPending(SL, ND, '/context')
      markGhostCommand(SL, ND, '/context')
      markBusy(SL, ND)
    })
    // the optimistic markBusy is corrected by a payload from the gap before
    // the CLI has started: the server says "no turn running" about a command
    // that is about to run perfectly well.
    s.busy = false
    await advance(2000)
    await poll(SL, ND)
    assert.equal(d.now().pending[0]?.failed, undefined,
      'condemning a command on `busy:false` alone turns a slow boot into a '
      + 'phantom failure — the same defect wearing the other face')
    // …and it then runs, inside the window
    s.userMsg('/context')
    await poll(SL, ND)
    await advance(100)
    assert.equal(d.now().pending.length, 0, 'it graduated normally')
  })

convoTest('§8.4 a PLAIN message ghost is never condemned by the idle rule',
  async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    // no markGhostCommand: this is correspondence, and correspondence has a
    // durable copy waiting for it in pending_mail. Only commands file nothing.
    await inAct(() => { addPending(SL, ND, 'please look at the log') })
    s.busy = false
    await advance(CMD_GRACE + 5000)
    await poll(SL, ND)
    assert.equal(d.now().pending[0]?.failed, undefined,
      'the idle rule is scoped to commands — a message ghost retires against '
      + 'its own mailbox row, and failing it here would fire on every send to '
      + 'an idle node')
    assert.equal(d.now().pending.length, 1, 'still waiting, as it should be')
  })

convoTest('§8.5 every ghost can be dismissed — the thing the user asked for',
  async ({ SL, ND, s, desk }) => {
    s.assistantMsg('idle')
    const d = await desk()
    await advance(100)
    await inAct(() => { addPending(SL, ND, 'one'); addPending(SL, ND, 'two') })
    const first = d.now().pending[0]!
    await inAct(() => { dismissPending(SL, ND, first.id) })
    const left = d.now().pending
    assert.equal(left.length, 1, 'the dismissed ghost is gone')
    assert.equal(left[0]?.text, 'two',
      'and it took only its own bubble with it — dismissing by id, not by '
      + 'text, so two sends of the same words do not collapse into one')
  })


// Typed delivery identities must distinguish identical authored messages.
const typedRow = (id: string) => ({ id, from: '@user', kind: 'message', at: '2026-09-06T12:00:00Z', body: 'continue',
  ev: { v: 1, variant: 'ordinary.message', actor: {kind: 'user', id: '@user'}, object: null, engine_authored: false, body: 'continue' } })
convoTest('typed mail IDs retire only the matching repeated send through poll and steer', async ({SL,ND,s,desk}) => {
  const d = await desk(); await flush()
  let a=0,b=0
  await inAct(() => { a=addPending(SL,ND,'continue'); b=addPending(SL,ND,'continue')
    bindPendingMail(SL,ND,a,typedRow('a')); bindPendingMail(SL,ND,b,typedRow('b')) })
  assert.equal(d.now().pending.length,2)
  const row=s.userMsg('continue'); row.segments=[{kind:'mail',rows:[typedRow('a')]}]
  await refreshConvo(SL,ND); await flush()
  assert.deepEqual(d.now().pending.map(g=>g.mailId),['b'])
  await inAct(()=>ingestStream(SL,{node:ND,kind:'steered',text:'continue',t:Date.now(),segments:[{kind:'mail',rows:[typedRow('a')]}]}))
  assert.deepEqual(d.now().pending.map(g=>g.mailId),['b'],'a replay cannot retire b')
  await inAct(()=>ingestStream(SL,{node:ND,kind:'steered',text:'unrelated transport text',t:Date.now(),segments:[{kind:'mail',rows:[typedRow('b')]}]}))
  assert.equal(d.now().pending.length,0,'matching durable ID retires without body match')
})
convoTest('typed rows never graduate unbound ghosts by body and late response binds to current payload', async ({SL,ND,s,desk}) => {
  const d=await desk(); await flush(); let id=0
  await inAct(()=>{id=addPending(SL,ND,'continue')})
  const row=s.userMsg('continue'); row.segments=[{kind:'mail',rows:[typedRow('other')]}]
  await refreshConvo(SL,ND); await flush()
  assert.equal(d.now().pending.length,1)
  await inAct(()=>bindPendingMail(SL,ND,id,{id:'other',ev:{variant:'ordinary.message'}}))
  assert.equal(d.now().pending[0].mailId,undefined,'malformed response cannot supply identity')
  await inAct(()=>bindPendingMail(SL,ND,id,typedRow('other')))
  assert.equal(d.now().pending.length,0,'late response sees its existing durable row')
})
