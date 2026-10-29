// askfold.test.tsx — request cards fold away.
//
// USER 2026-10-29 08:14:03Z mece9d7b275c2: "add collapsible request cards"
// (docket collapsible-request-cards-questions-on-the-user-s). Every request
// card the user answers (a question, a mixed batch with credit and scope tabs,
// a credit request) and the resolved card a request leaves behind has a fold
// control in its header. Folded, the card keeps one line: who asks, the linked
// ticket and the first line of the question (or the names of its tabs). The
// fold is one state per request, shared by every surface that draws the card
// and kept across a reload. An amended folded card stays folded and says it
// changed. Folding never answers, skips or withdraws anything.
//
// Run: node tests/run.mjs askfold

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AskCard, InboxAskCard } from '../src/canvas/asks'
import { resetSubmittedAsks } from '../src/asksubmitted'
import type { RefRoutes, RefWorld, ResolvedRef } from '../src/canvas/reflinks'
import type { AskInfo, AskQuestion, TreePayload } from '../src/types'
import { elicitationFixture } from './elicitation-fixture'
import { flush, inAct, mountView, StrictMode } from './harness'

const ORG = 'orgtree'
const world: RefWorld = {
  org: ORG,
  agents: new Map([['alice', 'alice'], ['bob', 'bob']]),
  items: new Map([['ship-it', 'ship-it']]),
  docs: new Map(),
}
const routes = () => {
  const opened: ResolvedRef[] = []
  const refs: RefRoutes = { world, onOpen: (r) => { opened.push(r) } }
  return { refs, opened }
}

const SHIP: AskQuestion = { question: '# Release plan\n\nShip **today** or wait for @bob?', header: 'Ship',
  options: [{ label: 'Today' }, { label: 'Wait', description: 'until @bob is back' }], work_item: 'ship-it' }
const NOTES: AskQuestion = { question: 'Anything else?', header: 'Notes' }
const SCOPE: AskQuestion = { question: 'Which folders?', header: 'Scope', options: [{ label: 'Repo' }, { label: 'Docs' }] }
const TIMELINE: AskQuestion = { question: 'When?', header: 'Timeline', options: [{ label: 'Now' }, { label: 'Later' }] }

// every test folds its own requests, so no fold carries from one test to another
let serial = 0
const fresh = () => `q-fold-${++serial}`

/** an open request as the Rust engine sends it: kind batch, its question tabs
 *  mirrored in `questions`, and the tickets those tabs name */
const open = (id: string, qs: AskQuestion[], rev = 1, extra: Partial<AskInfo> = {}): AskInfo => {
  const items = [...new Set(qs.flatMap((q) => (q.work_item ? [q.work_item] : [])))]
  return {
    id, node: 'alice', at: '2026-10-29T08:00:00Z', status: 'open', kind: 'batch', rev, revs: { ask: rev },
    questions: qs, tabs: qs.map((q) => ({ kind: 'question' as const, ...q })),
    question: qs[0]?.question, header: qs[0]?.header,
    ...(items.length ? { work_items: items } : {}), ...extra,
  }
}
const withCredits = (id: string): AskInfo => open(id, [SCOPE, TIMELINE], 1, {
  old: 2, new: 4, reason: 'two more reports',
  tabs: [{ kind: 'question', ...SCOPE }, { kind: 'question', ...TIMELINE },
    { kind: 'credits', id, old: 2, new: 4, reason: 'two more reports' }],
})
const legacyQuestion = (id: string): AskInfo => ({ id, node: 'alice', at: '2026-10-29T08:00:00Z',
  status: 'open', kind: 'question', rev: 1, question: SHIP.question, header: SHIP.header,
  options: SHIP.options, questions: [SHIP] })
const legacyCredit = (id: string): AskInfo => ({ id, node: 'alice', at: '2026-10-29T08:00:00Z',
  status: 'open', kind: 'credit', old: 2, new: 4, reason: 'two more reports' })
const resolved = (id: string, status: string, qs: AskQuestion[] = [SHIP]): AskInfo => ({
  id, node: 'alice', at: '2026-10-29T08:00:00Z', resolved_at: '2026-10-29T08:05:00Z', status,
  kind: 'question', rev: 1, questions: qs, question: qs[0]?.question, header: qs[0]?.header,
  options: qs[0]?.options, work_items: ['ship-it'] })

const tree = { roots: [], max_top_grant: 1000 } as unknown as TreePayload
const card = (ask: AskInfo, refs?: RefRoutes) =>
  <StrictMode><AskCard ask={ask} slug={ORG} toast={() => {}} refs={refs} /></StrictMode>

// every request the cards make, and the ones that send something (an answer, a
// dismissal, a credit decision): reads such as a reference lookup are not sends
const requests: { method: string; url: string; body: unknown }[] = []
const sends = () => requests.filter((r) => r.method !== 'GET')
const listed = () => JSON.stringify(requests.map((r) => `${r.method} ${r.url}`))
const realFetch = globalThis.fetch
test.beforeEach(() => {
  requests.length = 0
  globalThis.fetch = (async (url, init) => {
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
})
test.afterEach(() => { globalThis.fetch = realFetch; resetSubmittedAsks() })

/** mount for one test: unmounted at its end unless the test already did */
const mount = async (t: { after: (f: () => void | Promise<void>) => void }, node: Parameters<typeof mountView>[0]) => {
  const view = await mountView(node, (e) => e)
  let gone = false
  const unmount = async () => { if (!gone) { gone = true; await view.unmount() } }
  t.after(unmount)
  return { el: view.el, render: view.render, unmount }
}

/** the fold control of the first card under `el` */
const foldOf = (el: Element) => el.querySelector('button.ask-fold') as HTMLButtonElement | null
/** the region the fold control says it controls */
const bodyOf = (el: Element) => {
  const id = foldOf(el)?.getAttribute('aria-controls')
  return id ? el.ownerDocument.getElementById(id) : null
}
const folded = (el: Element) => foldOf(el)?.getAttribute('aria-expanded') === 'false'
const lineOf = (el: Element) => el.querySelector('.ask-fold-line') as HTMLElement | null
const toggle = async (el: Element) => {
  const b = foldOf(el)
  assert.ok(b, 'the card has a fold control')
  await inAct(() => { b!.click() })
}
/** what a reload does to this window's copy: the store re-reads storage */
const reload = () => inAct(() => {
  const e = new Event('storage')
  Object.defineProperty(e, 'key', { value: null })
  window.dispatchEvent(e)
})
const submitKey = (target: Element) => inAct(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
})

test('§1 every open request card starts expanded, with a real disclosure button', async (t) => {
  const forms: [string, AskInfo][] = [
    ['a question', open(fresh(), [SHIP])],
    ['a multi-question batch', open(fresh(), [SCOPE, TIMELINE])],
    ['a batch with a credits tab', withCredits(fresh())],
    ['a legacy question card', legacyQuestion(fresh())],
    ['a legacy credit request', legacyCredit(fresh())],
  ]
  for (const [what, ask] of forms) {
    const { el } = await mount(t, card(ask, routes().refs))
    const fold = foldOf(el)
    assert.ok(fold, `${what}: a fold control`)
    assert.equal(fold!.tagName, 'BUTTON', `${what}: a native button, reachable by keyboard`)
    assert.equal(fold!.type, 'button', `${what}: that submits nothing`)
    assert.ok(fold!.closest('.ask-tab'), `${what}: in the card's header`)
    assert.equal(fold!.getAttribute('aria-expanded'), 'true', `${what}: expanded by default`)
    const body = bodyOf(el)
    assert.ok(body, `${what}: aria-controls names the card's body`)
    assert.equal(body!.hidden, false, `${what}: the body shows`)
    assert.ok(body!.querySelector('.ask-submit'), `${what}: the answer controls are in the body`)
    assert.ok(el.querySelector('.ask-tab .chip-x'), `${what}: the ✕ shows while expanded`)
  }
})

test('§2 folding hides the answer controls and keeps one line: who asks, the ticket and the first line', async (t) => {
  const { el } = await mount(t, card(open(fresh(), [SHIP]), routes().refs))
  await toggle(el)
  assert.equal(folded(el), true, 'aria-expanded=false')
  const body = bodyOf(el)
  assert.ok(body, 'the body is still the controlled region')
  assert.equal(body!.hidden, true, 'and it is hidden')
  assert.ok(body!.querySelector('.ask-rows') && body!.querySelector('.ask-submit'),
    'the options and the submit are inside the hidden body')
  assert.equal(el.querySelector('.chip-x'), null, 'no ✕: a folded card cannot dismiss')
  assert.ok(el.querySelector('.ask-tab [data-copy-agent-name="alice"]'), 'who asks')
  const line = lineOf(el)
  assert.ok(line, 'the folded line')
  assert.ok(line!.closest('.ask-tab'), 'in the header')
  const ticket = line!.querySelector('.ref-item')
  assert.ok(ticket, 'the linked ticket is a mention chip')
  assert.match(ticket!.textContent ?? '', /ship-it/)
  const text = line!.querySelector('.ask-fold-text') as HTMLElement | null
  assert.ok(text, 'the first line of the question')
  assert.equal(text!.textContent?.trim(), 'Release plan', 'its Markdown heading mark is not shown')
  await toggle(el)
  assert.equal(folded(el), false, 'the fold control expands it again')
  assert.equal(bodyOf(el)!.hidden, false)
  assert.equal(lineOf(el), null, 'the folded line leaves with the fold')
  assert.ok(el.querySelector('.chip-x'), 'the ✕ is back')
})

test('§2b the folded line renders inline formatting rather than its marks', async (t) => {
  const bold: AskQuestion = { question: '**Ship** it before `v2`?\nMore detail below.', header: 'Go' }
  const { el } = await mount(t, card(open(fresh(), [bold]), routes().refs))
  await toggle(el)
  const text = el.querySelector('.ask-fold-line .ask-fold-text') as HTMLElement | null
  assert.ok(text, 'the folded line')
  assert.ok(text!.querySelector('strong'), 'bold renders')
  assert.ok(text!.querySelector('code'), 'code renders')
  assert.equal(text!.textContent?.includes('**'), false, 'no Markdown marks')
  assert.equal(text!.textContent?.includes('More detail'), false, 'only the first line')
})

test('§3 a card with several tabs names its tabs when folded', async (t) => {
  for (const [ask, want] of [
    [open(fresh(), [SCOPE, TIMELINE]), 'Scope · Timeline'],
    [withCredits(fresh()), 'Scope · Timeline · credits'],
  ] as const) {
    const { el } = await mount(t, card(ask, routes().refs))
    await toggle(el)
    assert.equal(el.querySelector('.ask-fold-line .ask-fold-text')?.textContent?.trim(), want)
  }
})

test('§4 the whole header row folds and unfolds; its ticket chip opens the ticket instead', async (t) => {
  const { refs, opened } = routes()
  const { el } = await mount(t, card(open(fresh(), [SHIP]), refs))
  const who = el.querySelector('.ask-tab [data-copy-agent-name="alice"]') as HTMLElement
  await inAct(() => { who.click() })
  assert.equal(folded(el), true, 'a click on the header row folds the card')
  const ticket = el.querySelector('.ask-fold-line .ref-item') as HTMLElement
  await inAct(() => { ticket.click() })
  assert.deepEqual(opened.map((r) => r.token), ['@item:orgtree/ship-it'], 'the chip opened its ticket')
  assert.equal(folded(el), true, 'and did not unfold the card')
  await inAct(() => { (el.querySelector('.ask-tab-label') as HTMLElement).click() })
  assert.equal(folded(el), false, 'a click elsewhere on the row unfolds it')
})

test('§5 folding never answers: drafts survive, ctrl+enter does nothing while folded, nothing is sent', async (t) => {
  const ask = open(fresh(), [SHIP])
  const { el } = await mount(t, card(ask, routes().refs))
  const today = [...el.querySelectorAll('.ask-row')].find((r) => r.textContent?.trim() === 'Today') as HTMLElement
  await inAct(() => { today.click() })
  assert.equal(today.classList.contains('on'), true, 'an answer is drafted')
  await toggle(el)
  await submitKey(foldOf(el)!)
  await submitKey(el.querySelector('.askcard')!)
  await flush()
  assert.deepEqual(sends(), [], `folding and ctrl+enter on a folded card send nothing: ${listed()}`)
  assert.ok(el.querySelector('.askcard'), 'the card is still open')
  await toggle(el)
  const again = [...el.querySelectorAll('.ask-row')].find((r) => r.textContent?.trim() === 'Today') as HTMLElement
  assert.equal(again.classList.contains('on'), true, 'the draft survived the fold')
  await submitKey(el.querySelector('.askcard')!)
  await flush()
  assert.equal(sends().length, 1, `expanded, ctrl+enter submits as it always did: ${listed()}`)
  assert.deepEqual(sends()[0]!.body, { revs: { ask: 1 }, answers: ['Today'] })
})

test('§6 one state per request: every surface follows, a reload keeps it, others are untouched', async (t) => {
  const id = fresh()
  const ask = open(id, [SHIP])
  const both = await mount(t, <>
    {card(ask, routes().refs)}
    <InboxAskCard ask={ask} slug={ORG} tree={tree} toast={() => {}} refs={routes().refs} />
    {card(open(fresh(), [NOTES]), routes().refs)}
  </>)
  const [desk, inbox, other] = [...both.el.querySelectorAll('.askcard')] as HTMLElement[]
  await toggle(desk!)
  assert.equal(folded(desk!), true)
  assert.equal(folded(inbox!), true, 'the inbox copy of the same request folds with it')
  assert.equal(folded(other!), false, 'another request does not')
  await both.unmount()
  await reload()
  const after = await mount(t, card(ask, routes().refs))
  assert.equal(folded(after.el), true, 'after a reload the request is still folded')
  await after.unmount()
  localStorage.clear()
  await reload()
  const cleared = await mount(t, card(ask, routes().refs))
  assert.equal(folded(cleared.el), false, "the fold lived in this origin's storage: cleared, the card is expanded")
})

test('§7 an amended folded card stays folded and says it changed; a revision stamp alone is no change', async (t) => {
  const id = fresh()
  const view = await mount(t, card(open(id, [SHIP]), routes().refs))
  await toggle(view.el)
  await view.render(card(open(id, [SHIP], 2), routes().refs))
  assert.equal(folded(view.el), true)
  assert.equal(view.el.querySelector('.ask-fold-changed'), null, 'a new revision with the same questions is no change')
  await view.render(card(open(id, [SHIP, NOTES], 3), routes().refs))
  assert.equal(folded(view.el), true, 'amended (a tab added), it stays folded')
  const mark = view.el.querySelector('.ask-tab .ask-fold-changed')
  assert.ok(mark, 'and its header says it changed')
  assert.equal(view.el.querySelector('.ask-fold-line .ask-fold-text')?.textContent?.trim(), 'Ship · Notes',
    'the line names the tabs it has now')
  await toggle(view.el)
  assert.equal(view.el.querySelector('.ask-fold-changed'), null, 'unfolding clears the mark')
  await toggle(view.el)
  assert.equal(view.el.querySelector('.ask-fold-changed'), null, 'folding again records the amended card')
})

test('§8 resolved cards fold too, and a folded request stays folded as its withdrawn card', async (t) => {
  const answered = await mount(t, card(resolved(fresh(), 'answered'), routes().refs))
  const fold = foldOf(answered.el)
  assert.ok(fold, 'an answered card has a fold control')
  assert.equal(fold!.getAttribute('aria-expanded'), 'true', 'expanded by default')
  assert.ok(fold!.closest('.ask-head'), 'in its header')
  await toggle(answered.el)
  assert.equal(bodyOf(answered.el)!.hidden, true, 'folded, its record is hidden')
  assert.ok(answered.el.querySelector('.ask-head .ask-null-tag'), 'its outcome stays in the header')
  await inAct(() => { (answered.el.querySelector('.ask-head [data-copy-agent-name]') as HTMLElement).click() })
  assert.equal(folded(answered.el), false, 'its header row unfolds it')

  const id = fresh()
  const view = await mount(t, card(open(id, [SHIP]), routes().refs))
  await toggle(view.el)
  await view.render(card(resolved(id, 'withdrawn'), routes().refs))
  assert.ok(view.el.querySelector('.askcard.nulled'), 'the request was withdrawn')
  assert.equal(folded(view.el), true, 'it stays folded as its withdrawn card')
  assert.equal(view.el.querySelector('.ask-null-tag')?.textContent, 'withdrawn', 'the outcome shows')
  assert.equal(view.el.querySelector('.ask-fold-changed'), null, 'resolving is not a change to its questions')
})

test('§9 CONTROL: an expanded card answers exactly as before', async (t) => {
  const { el } = await mount(t, card(open(fresh(), [SCOPE, TIMELINE]), routes().refs))
  const pick = (label: string) => inAct(() => {
    ([...el.querySelectorAll('.ask-row')].find((r) => r.textContent?.trim() === label) as HTMLElement).click()
  })
  await pick('Repo')
  await pick('Later')
  await inAct(() => { (el.querySelector('.ask-submit') as HTMLButtonElement).click() })
  await flush()
  t.diagnostic(`requests: ${listed()}`)
  assert.equal(sends().length, 1, `one answer is sent: ${listed()}`)
  assert.equal(sends()[0]!.method, 'POST')
  assert.equal(sends()[0]!.url, '/api/orgs/orgtree/nodes/alice/batch')
  assert.deepEqual(sends()[0]!.body, { revs: { ask: 1 }, answers: ['Repo', 'Later'] })
})

test('§10 CONTROL: an MCP permission card keeps its frame and buttons (it expires in five minutes)', async (t) => {
  const { el } = await mount(t, <AskCard ask={elicitationFixture()} slug={ORG} toast={() => {}} />)
  const form = el.querySelector('form[data-elicitation-id]')
  assert.ok(form, 'the permission card')
  assert.equal(foldOf(el), null, 'no fold control: an expiring permission request stays in sight')
  assert.deepEqual([...form!.querySelectorAll('button')].map((b) => b.textContent), ['Accept', 'Decline', 'Cancel'])
})

// ── the fold's look, from the stylesheet ────────────────────────────────────
declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const rule = (selector: string): Map<string, string> => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const at = css.search(new RegExp('(^|[}\\n])\\s*' + escaped + '\\s*\\{'))
  assert.ok(at >= 0, `styles.css has a rule for exactly "${selector}"`)
  const open = css.indexOf('{', at)
  const body = css.slice(open + 1, css.indexOf('}', open))
  return new Map(body.split(';').map((d) => d.split(':').map((s) => s.trim())).filter((d) => d[0])
    .map(([k, ...v]) => [k!, v.join(':')]))
}

test('§11 the stylesheet hides a folded body even though the body is display: contents', () => {
  assert.equal(rule('.ask-fold-body').get('display'), 'contents',
    "the body keeps the card's layout: its children stay the card's flex items")
  assert.equal(rule('.ask-fold-body[hidden]').get('display'), 'none',
    'an author display rule beats the hidden attribute, so the folded body needs its own')
})

test('§12 the fold control is drawn small in every panel, as the docket fold is', () => {
  // the inbox, docket and Attention panels are `.settings` panels, whose
  // `button` rule (14px, 7px 15px padding) would otherwise reach the control
  const fold = rule('.askcard button.ask-fold')
  for (const [k, v] of [['padding', '0'], ['border', '0'], ['background', 'none'], ['min-height', '0']]) {
    assert.equal(fold.get(k!), v, `the fold control resets ${k}`)
  }
  assert.ok(rule('.askcard button.ask-fold.folded').get('transform'), 'the folded caret turns')
})
