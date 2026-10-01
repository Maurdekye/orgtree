// askhandoff.test.tsx — the message-visibility invariant for submitted ask
// answers (user ruling 2026-09-10 13:22Z, canonical in
// message-visibility-invariant.md): a message is visible EXACTLY ONCE across
// pending → arriving → sent.
//
// User point 31 (2026-09-29, "id rather they disappear immediately and queue
// as the request resolved message immediately") changed WHICH form the pending
// step takes. The card is no longer pinned once answered; it leaves on the
// click, in every view. The answer is queued at once as its "Request
// resolved" entry: this window's own queued entry first (asksubmitted), then
// the server's pending row, then the transcript row. §1-§7 pin the desk's rule
// for server rows. §8-§11 pin the submit itself, including a failed submit.
// §12-§15 pin the same for the single-question form (answer.ask), which the
// docket uses, and the inbox and Attention for an agent outside the tree.
//
// The visible representations are counted structurally:
//   card       = .askcard
//   queued     = .pendrow rows that carry THIS answer
//   transcript = .typed-input .turn-mail row with the answer's mail id
//
// Run:  node apps/desktop/renderer/tests/run.mjs askhandoff

import {
  FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import type { Transport } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { AskCard } from '../src/canvas/asks'
import { askHidden, resetSubmittedAsks, settleFromTree } from '../src/asksubmitted'
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

/** the batch form every open ask takes on the desk (ledger.node_ask) */
const batchAsk = (nid: string): AskInfo => ({
  id: 'ask-1', node: nid, kind: 'batch', status: 'open', at: '2026-09-10T13:00:00Z',
  revs: {}, tabs: [{ kind: 'question', header: 'Go', question: 'Proceed?',
    options: [{ label: 'yes' }, { label: 'no' }] }],
} as AskInfo)

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

/** the batch answer as the server files it (ledger.resolve_batch) */
const batchAnswerRow = (nid: string, id: string = MAIL): PendingMail => ({
  id, from: '@user', kind: 'message', body: 'Request resolved', at: '2026-09-10T13:01:00Z',
  ev: { v: 1, variant: 'answer.batch', actor: { kind: 'user', id: '@user' },
    engine_authored: false,
    object: { kind: 'batch', org: SL, id: 'ask-1', node: nid },
    sections: [{ kind: 'ask', ask_id: 'ask-1',
      questions: [{ label: 'Go', question: 'Proceed?', answer: 'yes' }] }] },
} as PendingMail)

/** the same mail settled: a transcript user row whose mail segment carries it */
const settledMsg = (row: PendingMail) => ({ role: 'user', text: '', seq: 5,
  segments: [{ kind: 'mail', rows: [row] }] })

/** rows in the queue that carry the answer to "Proceed?" */
const queued = (el: HTMLElement) => [...el.querySelectorAll('.pendrow')]
  .filter(b => /Proceed\?/.test(b.textContent ?? ''))

function counts(el: HTMLElement) {
  return {
    card: el.querySelectorAll('.askcard').length,
    queued: queued(el).length,
    transcript: el.querySelectorAll(`.typed-input .turn-mail[data-mail-id="${MAIL}"]`).length,
  }
}

function domTest(name: string, body: (k: { ND: string; s: FakeServer; t: Transport
  mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (tc: TestContext) => {
    useFakeClock()
    const ND = `ah${++_n}`
    const s = new FakeServer()
    const t = installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    tc.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      resetSubmittedAsks()
      realClock()
    })
    await body({ ND, s, t, mount: async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    } })
  })
}

const deskEl = (nd: CanvasNode) =>
  <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL}
    toast={noop} pub={false} bare />

const click = (el: Element | null | undefined) => inAct(async () => {
  assert.ok(el, 'the control exists');
  (el as HTMLElement).click()
})
const option = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('.ask-row')].find(b => (b.textContent ?? '').includes(label))

domTest('§1 an answered card is never pinned: its queued row is the answer\'s one form',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 1, transcript: 0 }, JSON.stringify(c))
    assert.match(queued(el)[0]!.textContent ?? '', /yes/, 'the queued row carries the answer')
  })

domTest('§2 the queued row hands over to the transcript row in one payload',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, answeredAsk(ND))))
    await flush()
    await inAct(async () => {
      s.pending_mail.length = 0
      s.messages.push(settledMsg(answerRow(ND)) as never)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    const c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 0, transcript: 1 }, JSON.stringify(c))
  })

domTest('§5 while an OPEN card is on screen, an early answer mail never doubles as a bubble',
  async ({ ND, s, mount }) => {
    // answered from another window: the chat payload lists the answer while
    // this window's tree still says the ask is open
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { card: 1, queued: 0, transcript: 0 }, JSON.stringify(c))
    assert.ok(el.querySelector('.askcard .ask-submit'), 'and it IS the live form')
  })

domTest('§6 an unrelated pending mail still renders beside the open card',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND),
      { id: 'other-1', from: '@user', kind: 'message',
        body: 'unrelated words', at: '2026-09-10T13:02:00Z' } as PendingMail)
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    assert.equal(counts(el).card, 1)
    assert.equal(counts(el).queued, 0)
    const other = [...el.querySelectorAll('.pendrow')]
      .filter(b => (b.textContent ?? '').includes('unrelated words'))
    assert.equal(other.length, 1, 'the unrelated message keeps its own bubble')
  })

domTest('§7 with no card served, the answer is a queued row',
  async ({ ND, s, mount }) => {
    s.pending_mail.push(answerRow(ND))
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, null)))
    await flush()
    const rows = [...el.querySelectorAll('.pendrow')]
    assert.equal(rows.length, 1, 'exactly one representation, not zero and not two')
    assert.equal(el.querySelectorAll('.askcard').length, 0, 'and no card')
    const text = rows[0]!.textContent ?? ''
    assert.match(text, /Question answered/)
    assert.match(text, /Proceed\?/)
    assert.match(text, /yes/)
  })

domTest('§8 submitting removes the card on the click and queues "Request resolved" at once',
  async ({ ND, t, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, batchAsk(ND))))
    await flush()
    assert.equal(counts(el).card, 1, 'fixture: the open card')
    await click(option(el, 'yes'))
    // the server does not answer during this test step: nothing below may
    // depend on it
    t.holdAll = true
    const before = t.held.length
    await click(el.querySelector('.askcard .ask-submit'))
    assert.ok(t.held.length > before, 'the submit request is still in flight')
    const c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 1, transcript: 0 },
      `gone on the click, queued at once (${JSON.stringify(c)})`)
    const row = queued(el)[0]!
    assert.match(row.textContent ?? '', /Request resolved/)
    assert.match(row.textContent ?? '', /yes/, 'with the answer the user chose')
    assert.ok(el.querySelector('.pending-divider'), 'under the queued divider')
    t.holdAll = false
    t.release()
    await flush()
  })

domTest('§9 the server\'s own row replaces the queued entry in place, never beside it',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, batchAsk(ND))))
    await flush()
    await click(option(el, 'yes'))
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    assert.equal(counts(el).queued, 1, 'fixture: the local queued entry')
    // the server filed the answer: the chat payload lists its pending row
    // while this window's tree still says the ask is open
    await inAct(async () => {
      s.pending_mail.push(batchAnswerRow(ND))
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    let c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 1, transcript: 0 }, `one queued row (${JSON.stringify(c)})`)
    // delivery: the pending row becomes the transcript row
    await inAct(async () => {
      s.pending_mail.length = 0
      s.messages.push(settledMsg(batchAnswerRow(ND)) as never)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 0, transcript: 1 }, `delivered once (${JSON.stringify(c)})`)
    // and the local entry does not come back when the row leaves the window
    await inAct(async () => {
      s.messages.length = 0
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    assert.equal(counts(el).queued, 0, 'the retired queued entry stays retired')
  })

domTest('§10 a failed submit brings the card back with the error and the choice, and unqueues',
  async ({ ND, s, t, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, batchAsk(ND))))
    await flush()
    await click(option(el, 'yes'))
    // the stub decides a response's status when the request is made
    s.fail = 500
    t.holdAll = true
    await click(el.querySelector('.askcard .ask-submit'))
    assert.equal(counts(el).card, 0, 'fixture: hidden while in flight')
    await inAct(async () => { t.holdAll = false; t.release(); await flush() })
    s.fail = null
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { card: 1, queued: 0, transcript: 0 }, JSON.stringify(c))
    assert.match(el.querySelector('.ask-submit-failed')?.textContent ?? '', /not sent/)
    assert.ok(option(el, 'yes')?.classList.contains('on'), 'the user\'s choice is kept')
  })

domTest('§11 every view hides the card on the click, and the tree settles the store',
  async ({ ND, t, mount }) => {
    // the inbox and Attention mount the same AskCard for the same ask
    const a = await mount(<AskCard ask={batchAsk(ND)} slug={SL} toast={noop} />)
    const b = await mount(<AskCard ask={batchAsk(ND)} slug={SL} toast={noop} />)
    await flush()
    assert.equal(a.querySelectorAll('.askcard').length + b.querySelectorAll('.askcard').length, 2)
    await click(option(a, 'yes'))
    t.holdAll = true
    await click(a.querySelector('.askcard .ask-submit'))
    assert.equal(a.querySelectorAll('.askcard').length, 0, 'gone where it was answered')
    assert.equal(b.querySelectorAll('.askcard').length, 0, 'and gone in the other view')
    await inAct(async () => { t.holdAll = false; t.release(); await flush() })
    // a tree that still lists the ask open keeps it hidden; one that no
    // longer does lets the store forget it (after the desk has shown the row
    // or the settle window has passed)
    settleFromTree(SL, { roots: [node(ND, batchAsk(ND))] })
    assert.ok(askHidden(SL, 'ask-1'), 'still open on the server side: still hidden')
    settleFromTree(SL, { roots: [node(ND, null)] }, Date.now() + 11 * 60 * 1000)
    assert.ok(!askHidden(SL, 'ask-1'), 'resolved and settled: forgotten')
  })

domTest('§12 single-question form: gone on the click, and its answer.ask queued at once',
  async ({ ND, t, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    assert.equal(counts(el).card, 1, 'fixture: the open single-question card')
    await click(option(el, 'yes'))
    t.holdAll = true
    await click(el.querySelector('.askcard .ask-submit'))
    const c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 1, transcript: 0 },
      `gone on the click, queued at once (${JSON.stringify(c)})`)
    const text = queued(el)[0]!.textContent ?? ''
    assert.match(text, /Question answered/, 'the answer.ask entry the server will file')
    assert.match(text, /yes/, 'with the answer the user chose')
    t.holdAll = false
    t.release()
    await flush()
  })

domTest('§13 single-question form: the server row, then the transcript row, replace it in place',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    await click(option(el, 'yes'))
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    assert.equal(counts(el).queued, 1, 'fixture: the local queued entry')
    await inAct(async () => {
      s.pending_mail.push(answerRow(ND))
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    let c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 1, transcript: 0 }, `one queued row (${JSON.stringify(c)})`)
    await inAct(async () => {
      s.pending_mail.length = 0
      s.messages.push(settledMsg(answerRow(ND)) as never)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    c = counts(el)
    assert.deepEqual(c, { card: 0, queued: 0, transcript: 1 }, `delivered once (${JSON.stringify(c)})`)
  })

domTest('§14 single-question form: dismissing queues the dismissed answer',
  async ({ ND, t, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    t.holdAll = true
    await click(el.querySelector('.askcard .chip-x'))
    assert.equal(counts(el).card, 0, 'gone on the click')
    const rows = [...el.querySelectorAll('.pendrow')]
    assert.equal(rows.length, 1, 'one queued entry')
    const text = rows[0]!.textContent ?? ''
    assert.match(text, /Question answered/)
    assert.match(text, /Proceed\?/)
    assert.match(text, /Dismissed/i, 'marked dismissed, as ledger.ask_dismiss mints it')
    t.holdAll = false
    t.release()
    await flush()
  })

domTest('§15 single-question form: a failed submit brings the card back and unqueues',
  async ({ ND, s, t, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, openAsk(ND))))
    await flush()
    await click(option(el, 'yes'))
    s.fail = 500
    t.holdAll = true
    await click(el.querySelector('.askcard .ask-submit'))
    assert.deepEqual(counts(el), { card: 0, queued: 1, transcript: 0 }, 'fixture: queued while in flight')
    await inAct(async () => { t.holdAll = false; t.release(); await flush() })
    s.fail = null
    await flush()
    const c = counts(el)
    assert.deepEqual(c, { card: 1, queued: 0, transcript: 0 }, JSON.stringify(c))
    assert.match(el.querySelector('.ask-submit-failed')?.textContent ?? '', /not sent/)
    assert.ok(option(el, 'yes')?.classList.contains('on'), "the user's choice is kept")
  })
