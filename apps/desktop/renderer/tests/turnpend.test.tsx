// turnpend.test.tsx — THE QUESTION RENDERS ABOVE ITS OWN ANSWER.
//
// User report, 2026-09-01, about codex agents:
//
//   "they appear out of order after a user message: the message appears to
//    still be mid-transit, but the streamed response begins appearing before
//    it enters the transcript properly, visually."
//
// The backend half of that was D-221 (the journal now opens before `turn/start`
// goes on the wire, so the user's row is durable before any assistant output
// exists). This file holds the OTHER half, which D-221 could not reach: the
// desk drew its own render order, and pending mail was pinned to the very
// bottom of it — under the transcript, under the live tail, under the streamed
// draft. So for the whole window between "the mailbox handed this message to
// the turn" and "the transcript carries it", the answer was on screen above
// the question no matter how promptly the server committed anything.
//
// The distinction the fix rests on is one the payload already makes:
//
//   · `delivering` + `via: 'turn'` — the mailbox has handed this message to
//     the turn that is RUNNING. It is that turn's question, and every live row
//     below is that turn's answer. It sorts ABOVE them.
//   · anything else — still queued for a turn that has not started (or steered
//     mid-task, which really did arrive after the rows above it). It sorts at
//     the bottom, which is where it is true.
//
// ⚠ WHAT jsdom CAN PROVE HERE. There is no layout and no stylesheet, so
// "above" is not a pixel measurement. But it was never a styling accident:
// the bubbles were rendered after the live feed in the same scroller, so the
// checkable — and the thing that actually differed — is DOCUMENT ORDER inside
// `.msgs`. `compareDocumentPosition` answers exactly that.
//
// ⚠ BOTH DIRECTIONS, or this is not a test. A fix that simply moved every
// pending bubble upward would pass a one-legged version of this and would be
// wrong: a message queued behind a running turn genuinely happens after that
// turn's output. §3 is the leg that fails if the split is dropped.
//
// Run:  cd frontend && node tests/run.mjs turnpend

import {
  FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ingestStream, refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
  }
}

function domTest(name: string,
  body: (k: { SL: string; ND: string; s: FakeServer;
    mount: () => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `tp${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    const nd = node(ND)
    await body({
      SL, ND, s,
      mount: async () => {
        const v = await mountView(
          <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL}
            toast={noop} pub={false} bare />,
          (host) => host)
        open.push(v)
        return v.el
      },
    })
  })
}

/** every renderable row of the chat scroller, in document order, labelled by
 *  what it IS — the one list this whole file is about */
function rows(el: HTMLElement): { kind: string; text: string }[] {
  const msgs = el.querySelector('.msgs')
  assert.ok(msgs, 'the chat scroller is mounted')
  const out: { kind: string; text: string }[] = []
  // direct descendants only where it matters: transcript rows are wrapped one
  // level deep (the seq key + gap divider), the rest are children of .msgs
  for (const n of msgs!.querySelectorAll('.msg')) {
    const c = n.classList
    const kind = c.contains('pending') && c.contains('pendrow') ? 'pending'
      : c.contains('pending') ? 'ghost'
        : c.contains('draft') ? 'draft'
          : c.contains('live') ? 'live'
            : c.contains('user') ? 'user'
              : c.contains('sys') ? 'sys' : 'assistant'
    out.push({ kind, text: (n.textContent || '').trim().slice(0, 40) })
  }
  return out
}

const idxOf = (r: { kind: string }[], kind: string) => r.findIndex((x) => x.kind === kind)

// ── §1 the running turn's own question ──────────────────────────────────────
domTest('§1 a message being delivered INTO the running turn renders above that '
  + "turn's live output", async ({ SL, ND, s, mount }) => {
  s.assistantMsg('an answer from some earlier turn')
  s.postMail('what is the status?')
  s.drain()                       // delivering + via:'turn' — this turn's input
  s.liveRow('thought', 'considering')
  s.liveRow('text', 'here is the status')
  const el = await mount()
  await refreshConvo(SL, ND, { force: true })
  await flush()

  const r = rows(el)
  const q = idxOf(r, 'pending')
  const live = idxOf(r, 'live')
  assert.ok(q >= 0, `the delivering bubble is on screen — got ${JSON.stringify(r)}`)
  assert.ok(live >= 0, `the live tail is on screen — got ${JSON.stringify(r)}`)
  assert.ok(q < live,
    `the question must precede the answer it is being asked of — got ${JSON.stringify(r)}`)
  // …and it is still BELOW the durable transcript, which is older than it
  const older = r.findIndex((x) => x.text.startsWith('an answer from some earlier'))
  assert.ok(older >= 0 && older < q,
    `an earlier turn's durable row stays above the new question — ${JSON.stringify(r)}`)
})

// ── §2 the streamed draft is answer too ─────────────────────────────────────
domTest('§2 …and above the streamed draft, which is the first thing a codex '
  + 'turn puts on screen', async ({ SL, ND, s, mount }) => {
  s.postMail('stream something for me')
  s.drain()
  const el = await mount()
  await refreshConvo(SL, ND, { force: true })
  await flush()
  // the token stream: what `_flush_draft` pushes over the websocket, and the
  // only assistant output that exists before any durable row does
  ingestStream(SL, { node: ND, kind: 'delta', text: 'answering already', t: Date.now() })
  await flush()

  const r = rows(el)
  const q = idxOf(r, 'pending')
  const d = idxOf(r, 'draft')
  assert.ok(d >= 0, `the draft is on screen — got ${JSON.stringify(r)}`)
  assert.ok(q >= 0 && q < d,
    `the question must precede the streamed answer — got ${JSON.stringify(r)}`)
})

// ── §3 the leg that fails if the split is dropped ───────────────────────────
domTest('§3 mail merely QUEUED behind a running turn stays at the bottom — it '
  + 'has not been asked yet', async ({ SL, ND, s, mount }) => {
  s.busy = true
  s.liveRow('text', 'still answering the previous message')
  s.postMail('and one more thing')      // no drain: nothing has taken it
  const el = await mount()
  await refreshConvo(SL, ND, { force: true })
  await flush()

  const r = rows(el)
  const q = idxOf(r, 'pending')
  const live = idxOf(r, 'live')
  assert.ok(q >= 0 && live >= 0, `both rows are on screen — got ${JSON.stringify(r)}`)
  assert.ok(live < q,
    `a message nobody has taken yet sorts AFTER the output that preceded it — `
    + `got ${JSON.stringify(r)}`)
})

// ── §4 both at once, which is the ordinary busy desk ────────────────────────
domTest('§4 one of each: the delivered question above, the queued one below, '
  + 'the answer between them', async ({ SL, ND, s, mount }) => {
  s.postMail('the question this turn is answering')
  s.drain()
  s.liveRow('text', 'the answer to it')
  s.postMail('the one that has to wait')
  const el = await mount()
  await refreshConvo(SL, ND, { force: true })
  await flush()

  const r = rows(el)
  const pend = r.map((x, i) => ({ ...x, i })).filter((x) => x.kind === 'pending')
  assert.equal(pend.length, 2, `both bubbles render — got ${JSON.stringify(r)}`)
  const live = idxOf(r, 'live')
  assert.ok(pend[0]!.i < live && live < pend[1]!.i,
    `question · answer · the next question — got ${JSON.stringify(r)}`)
  assert.ok(pend[0]!.text.includes('this turn is answering'),
    `the hoisted bubble is the delivered one — got ${JSON.stringify(pend)}`)
})

// ── §5 the handover still lands in one payload (D-54 is not weakened) ───────
domTest('§5 when the transcript takes over, the bubble goes and the durable '
  + 'row arrives — never both, never neither', async ({ SL, ND, s, mount }) => {
  s.postMail('deliver me')
  s.drain()
  const el = await mount()
  await refreshConvo(SL, ND, { force: true })
  await flush()
  const before = rows(el)
  assert.equal(before.filter((x) => x.kind === 'pending').length, 1,
    `exactly one bubble before the echo — got ${JSON.stringify(before)}`)
  assert.equal(before.filter((x) => x.text.includes('deliver me')).length, 1,
    'the message is on screen exactly once before the echo')

  s.echo()                              // the transcript catches up
  await refreshConvo(SL, ND, { force: true })
  await flush()
  const after = rows(el)
  assert.equal(after.filter((x) => x.kind === 'pending').length, 0,
    `the bubble is gone once the row exists — got ${JSON.stringify(after)}`)
  assert.equal(after.filter((x) => x.text.includes('deliver me')).length, 1,
    `…and the message is STILL on screen exactly once — got ${JSON.stringify(after)}`)
})
