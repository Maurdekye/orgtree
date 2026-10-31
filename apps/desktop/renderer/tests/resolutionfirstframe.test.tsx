// resolutionfirstframe.test.tsx — a submitted request resolution is drawn in its
// final form from its first frame.
//
// USER 2026-10-30 15:12:41Z m3ce0d2554ce0: "regression: submitted request
// resolutiohs are briefly unformatted". The answer is queued at once as its
// "Request resolved" / "Question answered" entry (asksubmitted.ts), built from
// what the user chose, before the server files its own row. The server's row
// (ledger.resolve_batch / ask_answer) carries the OFFERED options, their
// descriptions, `multi` and the chosen labels (`selected`); the queued entry
// carried only the joined answer text, so the card drew the answer as one bare
// line ("yes") for a frame and then redrew as the option list with the chosen
// row marked, the descriptions in Markdown. The queued entry must be the same
// card, markup for markup, as the row that replaces it.
//
// "same card" = the .answered-card the queued .pendrow draws equals the one
// the delivered transcript row draws (the header clock aside).
//
// Run:  node apps/desktop/renderer/tests/run.mjs resolutionfirstframe

import {
  FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { AskCard } from '../src/canvas/asks'
import { answeredAsk, resetSubmittedAsks } from '../src/asksubmitted'
import { miniFromAskInfo } from '../src/events/answered'
import type { CanvasNode } from '../src/canvas/shared'
import type { AskInfo, OpResult, PendingMail } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const SL = 'org'
const MAIL = 'am-1'
const Q = 'Proceed with **bold** and `code`?'
const OPTS = [{ label: 'yes', description: 'do **it** now' }, { label: 'no' }, { label: 'later', description: 'not _yet_' }]

const node = (id: string, ask: AskInfo | null): CanvasNode => ({
  id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, model_id: 'haiku', ...(ask ? { ask } : {}),
} as CanvasNode)

/** the batch form every open ask takes on the desk (ledger.node_ask) */
const batchAsk = (nid: string, multi: boolean, options: typeof OPTS | null = OPTS): AskInfo => ({
  id: 'ask-1', node: nid, kind: 'batch', status: 'open', at: '2026-09-10T13:00:00Z', revs: {},
  tabs: [{ kind: 'question', header: 'Go', question: Q, ...(options ? { options } : {}), ...(multi ? { multi: true } : {}) }],
} as AskInfo)

/** the single-question form (ledger.node_ask for one question) */
const singleAsk = (nid: string): AskInfo => ({
  id: 'ask-1', node: nid, kind: 'question', status: 'open', at: '2026-09-10T13:00:00Z',
  question: Q, options: OPTS,
} as AskInfo)

/** the answer as the server files it. ledger.resolve_batch: label, question,
 *  answer (joined), selected, and offered() = options + multi when any. */
const batchRow = (nid: string, picked: string[], multi: boolean, options: typeof OPTS | null = OPTS): PendingMail => ({
  id: MAIL, from: '@user', kind: 'message', body: 'Request resolved', at: '2026-09-10T13:01:00Z',
  ev: { v: 1, variant: 'answer.batch', actor: { kind: 'user', id: '@user' }, engine_authored: false,
    object: { kind: 'batch', org: SL, id: 'ask-1', node: nid },
    sections: [{ kind: 'ask', ask_id: 'ask-1', questions: [{ label: 'Go', question: Q,
      answer: picked.length ? picked.join(' · ') : null, selected: picked,
      ...(options ? { options, multi } : {}) }] }] },
} as unknown as PendingMail)

/** ledger.ask_answer: label, question, selected, offered() */
const askRow = (nid: string, picked: string[]): PendingMail => ({
  id: MAIL, from: '@user', kind: 'message', body: 'Answer: ' + picked.join(', '), at: '2026-09-10T13:01:00Z',
  ev: { v: 1, variant: 'answer.ask', actor: { kind: 'user', id: '@user' }, engine_authored: false,
    object: { kind: 'ask', org: SL, id: 'ask-1', node: nid },
    questions: [{ label: null, question: Q, selected: picked, options: OPTS, multi: false }],
    text: null, dismissed: false, single: true },
} as unknown as PendingMail)

const settledMsg = (row: PendingMail) => ({ role: 'user', text: '', seq: 5,
  segments: [{ kind: 'mail', rows: [row] }] })

function domTest(name: string, body: (k: { ND: string; s: FakeServer
  mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (tc: TestContext) => {
    useFakeClock()
    const ND = `rf${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    tc.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      resetSubmittedAsks()
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
  <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL} toast={noop} bare />
const click = (el: Element | null | undefined) => inAct(async () => {
  assert.ok(el, 'the control exists');
  (el as HTMLElement).click()
})
const option = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('.ask-row')].find(b => b.querySelector('.ask-option-label')?.textContent === label)

/** the resolved card the queued row draws, as markup */
const queuedCard = (el: HTMLElement): string => {
  const rows = [...el.querySelectorAll('.pendrow')]
  assert.equal(rows.length, 1, 'exactly one queued row')
  const card = rows[0]!.querySelector('.answered-card')
  assert.ok(card, 'the queued row draws the answered card')
  return card.outerHTML
}

/** submit what the open card offers, then hand the answer over to the
 *  server's own row and return the card the transcript draws for it */
async function deliveredCard(el: HTMLElement, s: FakeServer, nid: string, row: PendingMail): Promise<string> {
  await inAct(async () => {
    s.pending_mail.push(row)
    await refreshConvo(SL, nid, { force: true })
    await flush()
  })
  await inAct(async () => {
    s.pending_mail.length = 0
    s.messages.push(settledMsg(row) as never)
    await refreshConvo(SL, nid, { force: true })
    await flush()
  })
  const card = el.querySelector(`.typed-input .turn-mail[data-mail-id="${MAIL}"] .answered-card`)
  assert.ok(card, 'the delivered transcript row draws the answered card')
  return card.outerHTML
}

domTest('§1 batch card, one pick: the queued entry is the option list with the pick marked, as the server row draws it',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, batchAsk(ND, false))))
    await flush()
    await click(option(el, 'yes'))
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const queued = queuedCard(el)
    const q = el.querySelector('.pendrow .answered-card')!
    assert.equal(q.querySelector('.answered-typed'), null, 'no bare typed line for an answer to an offered option')
    assert.equal(q.querySelectorAll('.answered-opt').length, OPTS.length, 'every offered option is listed')
    assert.deepEqual([...q.querySelectorAll('.answered-opt')].map(o => o.getAttribute('data-chosen')),
      ['true', 'false', 'false'], 'with the user\'s pick marked')
    assert.match(q.querySelector('.answered-opt-desc')?.innerHTML ?? '', /<strong>it<\/strong>/,
      'the option description is rendered as Markdown')
    assert.equal(queued, await deliveredCard(el, s, ND, batchRow(ND, ['yes'], false)),
      'the queued card is the delivered card, markup for markup')
  })

domTest('§2 batch card, multi-select: both picks marked in the queued entry',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, batchAsk(ND, true))))
    await flush()
    await click(option(el, 'yes'))
    await click(option(el, 'later'))
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const queued = queuedCard(el)
    assert.deepEqual([...el.querySelectorAll('.pendrow .answered-opt')].map(o => o.getAttribute('data-chosen')),
      ['true', 'false', 'true'])
    assert.equal(queued, await deliveredCard(el, s, ND, batchRow(ND, ['yes', 'later'], true)))
  })

domTest('§3 single-question card (answer.ask): the queued entry is the option list too',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, singleAsk(ND))))
    await flush()
    await click(option(el, 'no'))
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const queued = queuedCard(el)
    assert.deepEqual([...el.querySelectorAll('.pendrow .answered-opt')].map(o => o.getAttribute('data-chosen')),
      ['false', 'true', 'false'])
    assert.equal(queued, await deliveredCard(el, s, ND, askRow(ND, ['no'])))
  })

domTest('§4 a typed answer (no offered options): the queued entry is the delivered card, the typed text as the chosen row',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, batchAsk(ND, false, null))))
    await flush()
    const box = el.querySelector('.askcard .ask-free-response-input') as HTMLTextAreaElement | null
    assert.ok(box, 'fixture: a free-text card')
    await inAct(async () => {
      const proto = Object.getPrototypeOf(box)
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(box, 'because')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const queued = queuedCard(el)
    assert.equal(el.querySelector('.pendrow .answered-typed'), null, 'the server draws the pick as a chosen row, not a typed line')
    assert.equal(el.querySelector('.pendrow .answered-opt.chosen .answered-opt-label')?.textContent, 'because')
    assert.equal(queued, await deliveredCard(el, s, ND, batchRow(ND, ['because'], false, null)))
  })

domTest('§5 the inbox row of a just-submitted card (answeredAsk) lists the options with the pick marked',
  async ({ ND, mount }) => {
    const ask = batchAsk(ND, true)
    const el = await mount(<AskCard ask={ask} slug={SL} toast={noop} />)
    await flush()
    await click(option(el, 'yes'))
    await click(option(el, 'no'))
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const done = answeredAsk(SL, ask)
    assert.ok(done, 'the submit is in flight, so the card is answered')
    const mini = miniFromAskInfo(done).questions
    assert.equal(mini.length, 1)
    assert.deepEqual(mini[0]!.options.map(o => o.label), ['yes', 'no', 'later'], 'the offered options')
    assert.equal(mini[0]!.options[0]!.description, 'do **it** now')
    assert.equal(mini[0]!.multi, true)
    assert.deepEqual(mini[0]!.selected, ['yes', 'no'], 'both picks are the chosen options')
    assert.equal(mini[0]!.typed, null, 'not a bare typed line')
  })

// -- the multi-tab ask (USER 2026-10-31 14:12:01Z m3d59a64516f5: "resolved request submitted
// messages appear unformatted briefly still", after answering two-tab asks with Markdown in
// the question text) --
const Q2 = 'Which **scope**? See `docs/x.md`'
const TYPED = 'the _second_ one, `now`'
const twoTabs = (nid: string): AskInfo => ({
  id: 'ask-1', node: nid, kind: 'batch', status: 'open', at: '2026-09-10T13:00:00Z', revs: {},
  tabs: [
    { kind: 'question', header: 'Go', question: Q, options: OPTS },
    { kind: 'question', header: 'Scope', question: Q2 },
  ],
} as AskInfo)
const twoTabRow = (nid: string): PendingMail => ({
  id: MAIL, from: '@user', kind: 'message', body: 'Request resolved', at: '2026-09-10T13:01:00Z',
  ev: { v: 1, variant: 'answer.batch', actor: { kind: 'user', id: '@user' }, engine_authored: false,
    object: { kind: 'batch', org: SL, id: 'ask-1', node: nid },
    sections: [{ kind: 'ask', ask_id: 'ask-1', questions: [
      { label: 'Go', question: Q, answer: 'yes', selected: ['yes'], options: OPTS, multi: false },
      { label: 'Scope', question: Q2, answer: TYPED, selected: [TYPED] },
    ] }] },
} as unknown as PendingMail)

domTest('§6 two-tab batch with Markdown question text: the queued entry draws every question card as the server row does',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, twoTabs(ND))))
    await flush()
    await click(option(el, 'yes'))
    await click([...el.querySelectorAll('.ask-tabbtn')][1])
    const box = el.querySelector('.askcard .ask-free-response-input') as HTMLTextAreaElement | null
    assert.ok(box, 'fixture: the second tab is a free-text question')
    await inAct(async () => {
      const win = box.ownerDocument.defaultView as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, TYPED)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const rows = [...el.querySelectorAll('.pendrow')]
    assert.equal(rows.length, 1, 'exactly one queued row')
    const queuedAll = [...rows[0]!.querySelectorAll('.answered-card')].map(c => c.outerHTML)
    assert.ok(queuedAll.length >= 1, 'the queued row draws the answered card')
    assert.match(queuedAll.join(''), /<strong>bold<\/strong>/, 'the first question is rendered as Markdown')
    assert.match(queuedAll.join(''), /<strong>scope<\/strong>/, 'the second question is rendered as Markdown')
    await inAct(async () => {
      s.pending_mail.push(twoTabRow(ND))
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    await inAct(async () => {
      s.pending_mail.length = 0
      s.messages.push(settledMsg(twoTabRow(ND)) as never)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    const delivered = [...el.querySelectorAll(`.typed-input .turn-mail[data-mail-id="${MAIL}"] .answered-card`)].map(c => c.outerHTML)
    assert.deepEqual(queuedAll, delivered, 'the queued cards are the delivered cards, markup for markup')
  })

// -- every frame between the submit and the delivered row (USER 2026-10-31 14:12:01Z): no
// frame may show the Markdown source of the question or the typed answer as text --
const rawMarkdown = (el: HTMLElement): string[] => {
  const t = el.textContent ?? ''
  return ['**scope**', '**bold**', '`docs/x.md`'].filter(s => t.includes(s))
}

domTest('§7 two-tab batch: no frame from the submit to the delivered row shows raw Markdown',
  async ({ ND, s, mount }) => {
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND, twoTabs(ND))))
    await flush()
    await click(option(el, 'yes'))
    await click([...el.querySelectorAll('.ask-tabbtn')][1])
    const box = el.querySelector('.askcard .ask-free-response-input') as HTMLTextAreaElement | null
    assert.ok(box, 'fixture: the second tab is a free-text question')
    await inAct(async () => {
      const win = box.ownerDocument.defaultView as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, TYPED)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const frames: { at: string; raw: string[] }[] = []
    const win = el.ownerDocument.defaultView as unknown as { MutationObserver: typeof MutationObserver }
    let stage = 'submit'
    const seen = new win.MutationObserver(() => {
      const raw = rawMarkdown(el)
      if (raw.length) frames.push({ at: stage, raw })
    })
    seen.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    stage = 'pending'
    await inAct(async () => {
      s.pending_mail.push(twoTabRow(ND))
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    stage = 'settled'
    await inAct(async () => {
      s.pending_mail.length = 0
      s.messages.push(settledMsg(twoTabRow(ND)) as never)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    seen.disconnect()
    assert.deepEqual(frames, [], 'no frame shows the Markdown source as text')
  })

domTest('§8 two-tab batch, the inbox row of a just-submitted card: the answered card is formatted and equals the resolved ask\'s',
  async ({ ND, mount }) => {
    const ask = twoTabs(ND)
    const el = await mount(<AskCard ask={ask} slug={SL} toast={noop} />)
    await flush()
    await click(option(el, 'yes'))
    await click([...el.querySelectorAll('.ask-tabbtn')][1])
    const box = el.querySelector('.askcard .ask-free-response-input') as HTMLTextAreaElement | null
    assert.ok(box, 'fixture: the second tab is a free-text question')
    await inAct(async () => {
      const win = box.ownerDocument.defaultView as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, TYPED)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(el.querySelector('.askcard .ask-submit'))
    await flush()
    const done = answeredAsk(SL, ask)
    assert.ok(done, 'the submit is in flight')
    // the tree's own resolved row for the same submit (ledger.node_ask on a resolved batch)
    const resolved = { ...ask, status: 'answered', kind: 'question', questions: [
      { header: 'Go', question: Q, options: OPTS, answer: 'yes' },
      { header: 'Scope', question: Q2, answer: TYPED },
    ] } as unknown as AskInfo
    const queuedEl = await mount(<AskCard ask={done} slug={SL} toast={noop} />)
    const resolvedEl = await mount(<AskCard ask={resolved} slug={SL} toast={noop} />)
    await flush()
    const body = (e: HTMLElement) => (e.querySelector('.ask-fold-body, .askcard')?.outerHTML ?? '').replace(/:r[0-9a-z]+:/g, ':id:')
    assert.match(body(queuedEl), /<strong>bold<\/strong>/, 'the first question is Markdown in the queued inbox row')
    assert.match(body(queuedEl), /<strong>scope<\/strong>/, 'the second question is Markdown in the queued inbox row')
    assert.equal(body(queuedEl), body(resolvedEl), 'the queued inbox row is the resolved row, markup for markup')
  })
