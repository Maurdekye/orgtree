// askhandoff.test.tsx — the message-visibility invariant for submitted ask
// answers (user ruling 2026-09-10 13:22Z, canonical in
// message-visibility-invariant.md): a message is visible EXACTLY ONCE across
// pending → arriving → sent. The submitted question panel IS the answer's
// pending representation — never also a pending bubble — and it stays pinned
// until the answer mail actually RENDERS in the transcript, unpinning in the
// same render that shows the row (server acceptance / ask.status flipping /
// a planned refresh are explicitly not enough).
//
// The three visible representations are counted structurally at every step:
//   panel      = .askcard pinned above the composer
//   bubble     = .pendrow card for the answer's mail id
//   transcript = .typed-input .turn-mail row with that mail id
// and their sum must be exactly 1 at each settled state (0 panels only after
// the transcript shows the row).
//
// Run:  cd frontend && node tests/run.mjs askhandoff

import {
  FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { AskInfo, OpResult, PendingMail } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const SL = 'org'
const MAIL = 'am-1'

function node(id: string, ask: AskInfo | null): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
    ...(ask ? { ask } : {}),
  } as CanvasNode
}

const openAsk = (nid: string): AskInfo => ({
  id: 'ask-1', node: nid, kind: 'question', status: 'open',
  at: '2026-09-10T13:00:00Z', question: 'Proceed?',
  options: [{ label: 'yes' }, { label: 'no' }],
})

const answeredAsk = (nid: string): AskInfo => ({
  ...openAsk(nid), status: 'answered', resolved_at: '2026-09-10T13:01:00Z',
  answer: { selected: ['yes'] }, answer_mail: MAIL,
})

/** the answer as its pending mail row — a schema-valid answer.ask event, the
 *  shape the backend actually files (ledger ask_answer → post_mail ev) */
const answerRow = (nid: string, id: string = MAIL): PendingMail => ({
  id, from: '@user', kind: 'message', body: 'Answer: yes', at: '2026-09-10T13:01:00Z',
  ev: { v: 1, variant: 'answer.ask', actor: { kind: 'user', id: '@user' },
    engine_authored: false,
    object: { kind: 'ask', org: SL, id: 'ask-1', node: nid },
    questions: [{ label: null, question: 'Proceed?', selected: ['yes'] }],
    text: null, dismissed: false, single: true },
} as PendingMail)

/** the same mail settled: a transcript user row whose mail segment carries it */
const settledMsg = (nid: string) => ({ role: 'user', text: '', seq: 5,
  segments: [{ kind: 'mail', rows: [answerRow(nid)] }] })

function counts(el: HTMLElement) {
  return {
    panel: el.querySelectorAll('.askcard').length,
    bubble: [...el.querySelectorAll(`.pendrow [data-mail-id="${MAIL}"], .pendrow`)]
      .filter(b => (b.textContent ?? '').includes('Answer: yes')).length,
    transcript: el.querySelectorAll(`.typed-input .turn-mail[data-mail-id="${MAIL}"]`).length,
  }
}

function domTest(name: string, body: (k: { ND: string; s: FakeServer;
  mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const ND = `ah${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    await body({ ND, s, mount: async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    } })
  })
}

const deskEl = (nd: CanvasNode) =>
  <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL}
    toast={noop} pub={false} bare />

domTest('§1 the resolved panel is the answer\'s ONE representation while its mail is pending',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { panel: 1, bubble: 0, transcript: 0 },
      `the panel stands in, no separate bubble, not yet in the transcript (${JSON.stringify(c)})`)
    // and the panel really shows the submitted answer (the nulled card)
    assert.match(el.querySelector('.askcard')!.textContent ?? '', /answered/)
  })

domTest('§2 the panel unpins IN THE RENDER that shows the transcript row — atomic handoff',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    assert.equal(counts(el).panel, 1, 'fixture: starts as the pinned panel')
    // the delivery: ONE payload retires the pending row and carries the
    // transcript twin — exactly what the backend's shown() handoff produces
    await inAct(async () => {
      s.pending_mail.length = 0
      s.messages.push(settledMsg(ND) as never)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    const c = counts(el)
    assert.deepEqual(c, { panel: 0, bubble: 0, transcript: 1 },
      `after the payload: transcript row only (${JSON.stringify(c)})`)
  })

domTest('§3 ask.status alone never unpins: server acceptance is not visibility',
  async ({ ND, s, mount }) => {
    // the answered ask arrives (tree payload) BEFORE any chat payload lists
    // the mail — the gap the invariant forbids. The panel must stand alone.
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { panel: 1, bubble: 0, transcript: 0 },
      `no interval with the answer absent everywhere (${JSON.stringify(c)})`)
  })

domTest('§4 a buried delivery (window scrolled past) still releases the panel',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    assert.equal(counts(el).panel, 1, 'fixture: pinned while pending')
    // the mail leaves the queue but its transcript row is beyond the fetched
    // window: the panel must not stand pinned forever
    await inAct(async () => {
      s.pending_mail.length = 0
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    assert.equal(counts(el).panel, 0, 'released once the queue has moved on')
  })

domTest('§5 while the OPEN panel exists, an early answer mail never doubles as a bubble',
  async ({ ND, s, mount }) => {
    // the race the id-stamp cannot cover: the chat payload lists the answer
    // (matched by its answer.ask event referencing THIS card) while the tree
    // still says the ask is open (the submit is in flight)
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { panel: 1, bubble: 0, transcript: 0 },
      `the live form is the one representation (${JSON.stringify(c)})`)
    assert.ok(el.querySelector('.askcard .ask-submit'), 'and it IS the live form')
  })

domTest('§6 an unrelated pending mail still renders as a bubble beside the pinned panel',
  async ({ ND, s, mount }) => {
    // the anti-vacuity control: suppression is per-message, not a blanket
    s.pending_mail.push(answerRow(ND),
      { id: 'other-1', from: '@user', kind: 'message',
        body: 'unrelated words', at: '2026-09-10T13:02:00Z' } as PendingMail)
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    assert.equal(counts(el).panel, 1)
    assert.equal(counts(el).bubble, 0)
    const other = [...el.querySelectorAll('.pendrow')]
      .filter(b => (b.textContent ?? '').includes('unrelated words'))
    assert.equal(other.length, 1, 'the unrelated message keeps its own bubble')
  })
