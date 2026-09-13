// ghostop.test.tsx — THE SUBMISSION'S OWN NAME (PendingGhost.op / client_op),
// attacked. This is the regression suite for the user-message duplication of
// 2026-09-13 ("agent messages are not doubled anymore, but my own user
// messages still double up").
//
// THE DEFECT. A desk send paints an optimistic ghost, then POSTs. Its only
// identity link to the durable copy — the mail id — arrives WITH THE
// RESPONSE (bindPendingMail). But the server announces the stored mail
// before it answers the sender, and a busy node's own stream events make the
// desk refetch continuously, so the payload showing the typed pending bubble
// routinely lands while the POST is still in flight. An unbound ghost cannot
// recognize a TYPED row (the legacy text-count deliberately skips rows that
// decode known), so the message rendered twice — ghost + bubble — for the
// whole round trip, on every send to a busy agent; and a POST whose
// connection died after the server stored the mail left a permanent "failed"
// ghost beside the delivered message. Agent mail has no ghost, which is why
// only user messages doubled.
//
// THE FIX under test: the composer mints the submission's name BEFORE the
// send (mintClientOp), puts it on the ghost AND the POST (`client_op`); the
// server stores it on the mail entry and every projection carries it
// (pending rows, mail segment rows). The first payload showing the name
// retires the ghost — identity, never text, so two identical bodies from two
// submissions stay two messages.
//
// ⚠ THE FIXTURE ROWS ARE REAL SERVER OUTPUT, not FakeServer sketches: they
// were produced by the actual engine (post_mail → node_chat / the envelope
// composer → wire projection) over a copy of live data — see
// fixtures/real-wire-user-dup.json (op_pending_rows / op_wire_segments).
// Every prior ghost suite runs on legacy shapes without `ev`/segments, which
// is exactly where this defect hid.
//
// Run: cd apps/desktop/renderer && node tests/run.mjs ghostop

import { advance, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import {
  addPending, bindPendingMail, failPending, ingestStream, markBusy,
  mintClientOp, refreshConvo, resetConvos, useConvo,
} from '../src/convo'
import type { Convo } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode, StreamEvent } from '../src/canvas/shared'
import type { OpResult } from '../src/types'
import FIXTURE from './fixtures/real-wire-user-dup.json'

/* eslint-disable @typescript-eslint/no-explicit-any */
const FX: any = FIXTURE
const SL = 'org'
const noop = () => {}
const op_ = () => Promise.resolve({} as OpResult)

// the REAL op-carrying rows the worktree engine produced
const OP: string = FX.client_op
const OP_PENDING: any = FX.op_pending_rows[0]
const OP_SEGMENTS: any = FX.op_wire_segments
const BODY: string = OP_PENDING.body           // 'op fixture message body'
// a REAL steered-row scaffold carrying the REAL op segments — the shape the
// payload takes once the steer commits (segments decide what renders)
const STEERED_OP_ROW: any = { ...FX.steered_rows[0], segments: OP_SEGMENTS }

function node(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
  } as CanvasNode
}

/** copies of `needle` VISIBLE IN THE MESSAGE SCROLLER. Scoped to `.msgs` on
 *  purpose: the `.pinuser` overlay ("↑ you: …") quotes the reader's last
 *  message as a jump target, and jsdom's zero-height geometry mounts it
 *  unconditionally — counting it would fail these legs on an overlay that
 *  real layout only shows when the quoted row is OFF-screen. */
const says = (el: HTMLElement, needle: string): number => {
  const msgs = el.querySelector('.msgs')
  return ((msgs?.textContent ?? '').split(needle).length - 1)
}

interface Phase { messages?: any[]; pending?: any[] }
let _n = 0
function ghostTest(name: string,
  body: (k: { ND: string; el: HTMLElement; sink: Convo[];
    phase: (p: Phase) => Promise<void> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const ND = `go${++_n}`
    const current: { p: Phase } = { p: {} }
    const g = globalThis as unknown as Record<string, unknown>
    g.fetch = (url: string) => Promise.resolve({
      ok: true, headers: { get: () => null },
      json: () => Promise.resolve(/\/chat(\?|$)/.test(String(url))
        ? { busy: true, queued: 0, responding: true, last_error: null,
            occupancy: 1000, messages: current.p.messages ?? [],
            live: [], mail_pending: (current.p.pending ?? []).length,
            pending_mail: current.p.pending ?? [] }
        : { items: [], entries: [], documents: [] }),
    })
    const sink: Convo[] = []
    function Rig() {
      const c = useConvo(SL, ND)
      useEffect(() => { if (!c.loaded) void refreshConvo(SL, ND) }, [c.loaded])
      sink.push(c)
      const nd = node(ND)
      return <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op_}
        slug={SL} toast={noop} pub={false} bare />
    }
    const v = await mountView(<Rig />, () => sink.length)
    t.after(async () => {
      try { await v.unmount() } catch { /* gone */ }
      resetConvos()
      realClock()
    })
    await advance(200)
    assert.ok(sink[sink.length - 1]!.loaded, 'first payload never installed')
    const phase = async (p: Phase) => {
      current.p = p
      await inAct(() => refreshConvo(SL, ND, { force: true }))
      await advance(250)
    }
    await body({ ND, el: v.el, sink, phase })
  })
}

const ghosts = (sink: Convo[]) => sink[sink.length - 1]!.pending

ghostTest('§1 THE WINDOW: an UNBOUND ghost retires on the payload that shows its own pending row', async ({ ND, el, sink, phase }) => {
  // the send has left but its response has NOT returned — no bindPendingMail
  await inAct(() => { addPending(SL, ND, BODY, undefined, undefined, OP); markBusy(SL, ND) })
  await advance(50)
  assert.equal(says(el, BODY), 1, 'the ghost alone must render one copy')
  // a poll triggered by the busy node's own stream lands mid-flight, carrying
  // the typed pending row the server already stored
  await phase({ pending: [OP_PENDING] })
  assert.equal(ghosts(sink).length, 0,
    'the unbound ghost must retire against its own client_op')
  assert.equal(says(el, BODY), 1,
    'one submission, one visible copy — ghost + typed bubble is the reported doubling')
})

ghostTest('§1b CONTROL: identical text under ANOTHER submission’s op keeps the ghost (two submissions are two messages)', async ({ ND, el, sink, phase }) => {
  await inAct(() => { addPending(SL, ND, BODY, undefined, undefined, mintClientOp()) })
  await advance(50)
  // same body, DIFFERENT submission (another tab, an earlier send): its row
  // must not swallow this in-flight ghost
  await phase({ pending: [{ ...OP_PENDING, client_op: 'someone-elses-op' }] })
  assert.equal(ghosts(sink).length, 1,
    'a foreign row with identical text must not retire this ghost')
  assert.equal(says(el, BODY), 2,
    'two genuinely distinct submissions with one body are TWO visible messages')
})

ghostTest('§2 MID-TURN: the steered row’s segments carry the op and retire the unbound ghost', async ({ ND, el, sink, phase }) => {
  await inAct(() => { addPending(SL, ND, BODY, undefined, undefined, OP); markBusy(SL, ND) })
  await advance(50)
  await phase({ messages: [STEERED_OP_ROW] })
  assert.equal(ghosts(sink).length, 0,
    'the steered row’s mail segments carry client_op — the ghost must retire on it')
  assert.equal(says(el, BODY), 1, 'steered row + ghost must collapse to one copy')
})

ghostTest('§2b MID-TURN over the websocket: the steered frame retires the unbound ghost', async ({ ND, el, sink }) => {
  await inAct(() => { addPending(SL, ND, BODY, undefined, undefined, OP); markBusy(SL, ND) })
  await advance(50)
  await inAct(() => ingestStream(SL, {
    node: ND, kind: 'steered', committed_row: STEERED_OP_ROW,
  } as unknown as StreamEvent))
  await advance(50)
  assert.equal(ghosts(sink).length, 0,
    'the steered frame’s committed row carries the op — the ghost must retire')
  assert.equal(says(el, BODY), 1)
})

ghostTest('§3 A FALSE FAILURE HEALS: op-evidence clears a ghost whose POST transport died after the store', async ({ ND, el, sink, phase }) => {
  let ghost = 0
  await inAct(() => { ghost = addPending(SL, ND, BODY, undefined, undefined, OP) })
  await inAct(() => failPending(SL, ND, ghost, 'connection reset'))
  await advance(50)
  assert.equal(ghosts(sink).length, 1, 'the failed ghost stands until evidence')
  await phase({ pending: [OP_PENDING] })
  assert.equal(ghosts(sink).length, 0,
    'the durable copy under this very op proves the send landed — the "failed" bubble was the duplicate')
  assert.equal(says(el, BODY), 1)
})

ghostTest('§3b …but a failure with NO op-evidence stays visible (a real failure is never hidden)', async ({ ND, sink, phase }) => {
  let ghost = 0
  await inAct(() => { ghost = addPending(SL, ND, BODY, undefined, undefined, OP) })
  await inAct(() => failPending(SL, ND, ghost, 'refused'))
  await phase({ pending: [] })
  assert.equal(ghosts(sink).length, 1,
    'no durable copy anywhere — the failure must keep saying so')
})

ghostTest('§4 OLD SERVER: rows without client_op change nothing — the bound mail id still decides', async ({ ND, el, sink, phase }) => {
  let ghost = 0
  await inAct(() => { ghost = addPending(SL, ND, BODY, undefined, undefined, OP) })
  const stripped = { ...OP_PENDING }
  delete (stripped as any).client_op
  await phase({ pending: [stripped] })
  // an old server echoes no op — the unbound ghost cannot retire yet (this is
  // exactly today's window, kept rather than silently re-scoped to text)
  assert.equal(ghosts(sink).length, 1, 'no op on the wire — the ghost must wait for its binding')
  assert.equal(says(el, BODY), 2, 'the old-server window is unchanged by this fix')
  // …the response arrives: the mail id binds, the visible row retires it
  await inAct(() => bindPendingMail(SL, ND, ghost, {
    accepted: true, id: OP_PENDING.id, ev: OP_PENDING.ev,
  }))
  await advance(50)
  assert.equal(ghosts(sink).length, 0, 'the bound mail id retires it exactly as before')
  assert.equal(says(el, BODY), 1)
})

ghostTest('§5 TWO SUBMISSIONS, ONE BODY: each ghost retires only on ITS OWN op, both rows stay', async ({ ND, el, sink, phase }) => {
  const op2 = 'fixture-op-second-submission'
  await inAct(() => {
    addPending(SL, ND, BODY, undefined, undefined, OP)
    addPending(SL, ND, BODY, undefined, undefined, op2)
  })
  await advance(50)
  assert.equal(says(el, BODY), 2, 'two in-flight submissions render two copies')
  await phase({ pending: [OP_PENDING] })
  assert.equal(ghosts(sink).length, 1, 'only the first submission’s ghost retires')
  assert.equal(says(el, BODY), 2, 'first row + second ghost — still two messages')
  const second = { ...OP_PENDING, id: 'mail2ndid001', client_op: op2,
    event_id: `mail:${SL}:x:mail2ndid001` }
  await phase({ pending: [OP_PENDING, second] })
  assert.equal(ghosts(sink).length, 0, 'both retired, each by its own name')
  assert.equal(says(el, BODY), 2, 'two submissions remain two visible messages')
})
