// mailsender.test.tsx — THE SENDER'S MODEL CHIP AND CLICK-TO-DESK, on the two
// surfaces the first pass missed: the mail LIST ROW and the INLINE TRANSCRIPT.
//
// User ruling 2026-09-05, reiterated the same afternoon: an agent's name wears
// its model card and takes you to its desk EVERYWHERE it appears. The landed
// work converted the mailbox's READING PANE and the docket; two places kept
// drawing a bare name — `MailList`'s row (`.mfrom`, raw `party(m)`) and the
// desk transcript's mail card (`<b>{mail.from}</b>`, with no facts wired down
// to it at all).
//
// ⚠ WHAT THIS FILE IS ACTUALLY GUARDING, because "a chip is on screen" is the
// cheap half and not the risky one:
//
//  1. THE ROW IS A CLICK TARGET INSIDE A CLICK TARGET. `.mailrow` has its own
//     onClick — it selects the mail. A sender button that does not stop the
//     bubble navigates AND selects, or deselects the mail you were reading.
//     §5 clicks the name and the row's own text and requires the two to have
//     DIFFERENT effects; a missing stopPropagation makes them the same.
//
//  2. THE NAME MATCHING IS NOT THE EVIDENCE. An outside party may spell itself
//     exactly like one of our agents. §2/§3 give the transcript a sender whose
//     name is ordinary and require no chip and no route unless the tree ON
//     SCREEN vouches for it — and prove the check is live by adding the very
//     same name to the tree and watching both appear.
//
//  3. A CONTEXT WIRED TO NOTHING IS THE FAILURE MODE HERE. `TurnMailCard` sits
//     under a memo'd row in a windowed list, so its facts arrive by context;
//     a provider that is never mounted, or mounted with a resolver that never
//     answers, looks exactly like correct code and renders exactly the bare
//     name we started with. §1 therefore mounts the REAL `DeskChat` against
//     the fake server and drives a real envelope through it — no hand-built
//     provider — so the wiring is what is on trial, not the component.
//
// Anti-vacuity, stated per section: every "renders nothing" assertion is
// paired with a mount that differs in ONE fact and does render it.
//
// ⚠⚠ WHAT THIS FILE DOES **NOT** OBSERVE — read before quoting it as evidence.
//
//  A. THE LIVE MID-TURN ROW IS NOT REACHABLE IN THIS BUILD. §9 and §11.7-11.9
//     hand-build `{kind:'steered'}` live rows. The backend has no such row:
//     `st["live"]` is written only by `supervisor.live_row()`, whose call sites
//     emit tool/text/thought/plan and never 'steered'; the 'steered' WEBSOCKET
//     frame (commit_steer, body[:2000]) goes through `api.stream()`, which only
//     pushes over the socket, and convo.ts's handler for it retires a ghost and
//     nudges a refetch without ever appending a live row. So `LiveSteerRow` is
//     correct code for a branch nothing currently renders. Its DURABLE twin —
//     the steered_log row (`role:'user'`, `steered`, `truncated`) drawn by
//     `Msg` — IS reachable, and §11.1-11.6/§11.10 are about that one.
//  B. (WITHDRAWN 2026-09-05.) This used to record that desk.tsx's own inbox-tab
//     call site was verified by READING only, because it passed no focus
//     handler. It now passes the desk's `onJump`, and §12.5-§12.7 mount the real
//     DeskChat, open the tab and click — with a no-handler control and a
//     missing-node control. The old §12.5 pinned the gap as if it were a rule.
//  C. The pre-existing case "truncated, but the envelope is whole" still shows
//     no cut note (§11.4 pins it as it is; this change did not add one).
//
// Run:  cd frontend && node tests/run.mjs mailsender
//       cd frontend && node mutate_mailsender.mjs        (40/40 killed)

import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { SenderChip } from '../src/App'
import { DeskChat, LineagePanel, Msg } from '../src/canvas/desk'
import { MailList, NodeInboxModal, OrgInboxModal } from '../src/canvas/mail'
import { AgentDirectoryProvider } from '../src/canvas/identity'
import type { AgentDirectory } from '../src/canvas/identity'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import type { ChatMessage, OpResult, OrgInboxEntry, TreeNode, TreePayload } from '../src/types'

// jsdom implements no layout, so `Element.scrollIntoView` does not exist, and
// `jumpTo` calls it from a ref callback where a throw kills the commit rather
// than the assertion (the mailwire.test.tsx idiom).
;(globalThis as unknown as
  { window: { Element: { prototype: Record<string, unknown> } } })
  .window.Element.prototype.scrollIntoView ??= () => {}

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

/** ⚠ RECORDS EVERY ARGUMENT, NOT JUST THE FIRST — and this file is the reason
 *  that matters. `AgentName` invokes `onFocus(id, event)`, because pins.tsx
 *  has to tell a pointer activation from a keyboard one. The real navigator is
 *  `centerOn(id, z = null)`. Every spy here used to push argument ONE and
 *  ignore the rest, so a boundary that handed the callback over whole — and
 *  therefore delivered the CLICK EVENT AS THE ZOOM — recorded exactly the same
 *  thing as a correct one. The suite was green and the deployed UI was broken;
 *  coordinator-astra measured it in a hydrated browser at 392767b, where
 *  clicking a sender in the desk inbox lost the focused desk entirely.
 *
 *  So the contract is asserted on `nav.calls`, and it is EXACTLY [[senderId]]:
 *  one call, one argument, that argument the sender. A second argument is a
 *  failure whatever it contains.
 *
 *  ⚠ AND A SPY IS STILL NOT A NAVIGATOR. Even this only proves what the
 *  boundary CALLS. mailnav.test.tsx drives the real <OrgCanvas> and asks where
 *  the camera actually went; that is the file that reproduced the defect.
 *
 *  ⚠ EVERY ARGUMENT IS REDUCED TO A STRING BEFORE IT IS STORED, and that is
 *  not tidiness. The extra argument this exists to catch is a DOM EVENT, and
 *  `assert.deepEqual` on one walks the whole jsdom object — the same failure
 *  this file's `absent` helper documents (node dies with "Array buffer
 *  allocation failed" and the message never prints). Measured here: the first
 *  cut stored raw arguments and the mutant that leaks the event went red with
 *  NO readable assertion at all. A leaked event now records as `<MouseEvent>`,
 *  so the diff is two short string arrays and the failure says what arrived. */
const describeArg = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v === null) return '<null>'
  if (v === undefined) return '<undefined>'
  if (typeof v === 'object') {
    const n = (v as { constructor?: { name?: string } }).constructor?.name
    return `<${n ?? 'object'}>`
  }
  return `<${typeof v}: ${String(v)}>`
}
function recorder() {
  const calls: string[][] = []
  return { calls, fn: (...args: unknown[]) => { calls.push(args.map(describeArg)) } }
}
const q = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[]
const txt = (el: HTMLElement) => el.textContent ?? ''

/** ⚠ NEVER `assert.equal(node, null)` ON A DOM NODE IN THIS REPO. When it
 *  FAILS, node's diff walks the whole jsdom element, dies with "Array buffer
 *  allocation failed" after ~26 s, and the assertion message never prints —
 *  four mutants read as "wrong check" before this was found (docketname
 *  suite, 2026-09-05). Assert on the COUNT. */
const absent = (el: HTMLElement, sel: string, why: string) =>
  assert.equal(q(el, sel).length, 0, why)

function node(id: string, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'sol', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'sol', ...over,
  } as CanvasNode
}

/** Explicit wire fixture: no producer envelope text is parsed to create it. */
const typedMessage = (from: string, relationship = 'your peer', body = 'a word about the build'): ChatMessage => ({
  role: 'user', text: 'Agent projection fallback', seq: 1, ts: '2026-09-05T10:00:00Z',
  segments: [{ kind: 'mail', rows: [{id: 'typed-fixture', from, relationship, kind: 'message', at: '2026-09-05T10:00:00Z', body,
    ev: {v: 1, variant: 'ordinary.message', actor: {kind: from === '@user' ? 'user' : from.startsWith('@') ? 'external' : 'agent', id: from},
      object: null, engine_authored: false, body},
  }] }],
})

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }> }) => Promise<void>,
): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        await flush()
        return { el: v.el }
      },
    })
  })
}

// ═══════════════════════════════════════════════════════════════════ §1
// THE INLINE TRANSCRIPT, THROUGH THE REAL DESK. Nothing here is hand-built:
// the fake server serves a real envelope, `DeskChat` mounts, and whatever the
// reader would see is what is judged. This is the section that fails if the
// provider is not actually mounted — the "wired to nothing" failure.
// ═══════════════════════════════════════════════════════════════════ §1

let _n = 0
async function desk(t: TestContext, opts: {
  from: string
  /** who is in the tree ON SCREEN besides the desk's own node */
  others?: CanvasNode[]
  /** omit to model a surface with nowhere to jump to */
  onJump?: (id: string) => void
  rel?: string
}): Promise<HTMLElement> {
  useFakeClock()
  const SL = 'org'
  const ND = `ms${++_n}`
  const s = new FakeServer()
  installFetch(s)
  const nd = node(ND, { tier: 'opus' })
  const map = new Map<string, CanvasNode>([[nd.id, nd]])
  for (const o of opts.others ?? []) map.set(o.id, o)
  s.userMsg('Agent projection fallback').segments = typedMessage(opts.from, opts.rel ?? 'your peer').segments
  const v = await mountView(
    <DeskChat node={nd} map={map} op={op} slug={SL} toast={noop} pub={false}
      bare onJump={opts.onJump} />,
    (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos()
    realClock()
  })
  await refreshConvo(SL, ND, { force: true })
  await flush()
  return v.el
}

const head = (el: HTMLElement) => {
  const h = el.querySelector('.event-head') as HTMLElement | null
  assert.ok(h, 'positive control: the transcript rendered a mail CARD at all — '
    + 'without one every assertion below would pass by absence')
  return h!
}

test('§1.1 a mail from an agent of this tree wears its model chip and goes to '
  + 'its desk — through the real DeskChat, not a hand-built provider',
async (t: TestContext) => {
  const nav = recorder()
  const el = await desk(t, {
    from: 'peer-one',
    others: [node('peer-one', { tier: 'sonnet' })],
    onJump: nav.fn,
  })
  const h = head(el)
  const chip = q(h, '.tier')
  assert.equal(chip.length, 1, 'exactly one model chip in the mail header')
  assert.ok(chip[0]!.classList.contains('t-sonnet'),
    `and it is the SENDER's model, not the desk's (the desk is opus): ${chip[0]!.className}`)
  const jump = q(h, 'button.cc-name-jump')
  assert.equal(jump.length, 1, 'the name is one jump button')
  assert.equal(txt(jump[0]!), 'peer-one', 'labelled with the sender, verbatim')
  // ⚠ the tooltip must not claim to know the model AT THE TIME. The envelope
  // records no generation, so the chip is the CURRENT model and says so.
  const tip = jump[0]!.getAttribute('title') ?? ''
  assert.ok(tip.includes('current model'),
    `the tooltip scopes the claim to the current model — got ${JSON.stringify(tip)}`)
  await inAct(() => { jump[0]!.click() })
  assert.deepEqual(nav.calls, [['peer-one']], 'clicking it focuses that agent')
})

test('§1.2 …and the same mail from a name the tree does NOT hold gets neither '
  + 'chip nor route — a name match is not evidence of who it is',
async (t: TestContext) => {
  // ⚠ THE ANTI-VACUITY PAIR. Identical fixture, identical envelope, identical
  // jump handler; the ONE difference is whether `outsider` is in the tree on
  // screen. §1.1 above is the positive half — the same code path DOES draw
  // both when the tree vouches for the name.
  const el = await desk(t, {
    from: 'outsider',
    others: [],                       // an ordinary agent-shaped name, unheld
    onJump: noop,
    rel: 'outside party — addressed to the whole org',
  })
  const h = head(el)
  assert.ok(txt(h).includes('outsider'), 'the name is still shown, verbatim')
  absent(h, '.tier', 'no model chip for a name this tree cannot vouch for')
  absent(h, 'button.cc-name-jump', 'and no route into our tree either')
})

test('§1.3 an @-sentinel is never an agent: @user, @system and an outside '
  + 'peer keep their plain name', async (t: TestContext) => {
  for (const from of ['@user', '@system', '@net:faraway.other-machine.abc']) {
    const el = await desk(t, {
      from,
      // ⚠ ANTI-VACUITY, THE HARD WAY: the sentinel is ALSO put in the tree
      // under its own literal name. If the '@' clause were dropped, `resolve`
      // would now answer and a chip would appear — so this fixture makes the
      // clause the only thing standing between the sentinel and a chip.
      others: [node(from, { tier: 'opus' })],
      onJump: noop,
    })
    const h = head(el)
    absent(h, '.tier', `${from} draws no model chip`)
    absent(h, 'button.cc-name-jump', `${from} draws no jump`)
  }
})

test('§1.4 a desk with nowhere to jump renders a name that does not click — '
  + 'not a button that does nothing', async (t: TestContext) => {
  const el = await desk(t, {
    from: 'peer-one',
    others: [node('peer-one', { tier: 'sonnet' })],
    onJump: undefined,                // the surface offers no navigation
  })
  const h = head(el)
  assert.equal(q(h, '.tier').length, 1,
    'positive control: the chip still renders, so this is not a dead mount')
  absent(h, 'button.cc-name-jump',
    'but there is no button: an inert control is worse than no control')
})

/** a desk showing a mail this very agent sent to ITSELF. `bare` is the
 *  destination test the desk header already uses: a switchboard panel or a
 *  pinned window is NOBODY's focused desk. */
async function selfMailDesk(t: TestContext, bare: boolean): Promise<HTMLElement> {
  const SL = 'org'
  const ND = `ms${++_n}`
  useFakeClock()
  const s = new FakeServer()
  installFetch(s)
  const nd = node(ND, { tier: 'opus' })
  s.userMsg('Agent projection fallback').segments = typedMessage(ND, 'yourself').segments
  const v = await mountView(
    <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL}
      toast={noop} pub={false} bare={bare} onJump={noop} />, (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos(); realClock()
  })
  await refreshConvo(SL, ND, { force: true })
  await flush()
  return v.el
}

test('§1.5 a self-mail on the FOCUSED desk does not offer a trip to the desk '
  + 'you are already on', async (t: TestContext) => {
  const h = head(await selfMailDesk(t, false))
  assert.equal(q(h, '.tier').length, 1,
    'positive control: it is still an identified agent, chip and all')
  absent(h, 'button.cc-name-jump',
    'but the destination IS this surface, so the name is plain text')
})

test('§1.6 …and the SAME self-mail in a switchboard panel DOES navigate — the '
  + 'exemption is keyed on the destination, not on the id matching',
async (t: TestContext) => {
  // ⚠ THIS PAIR IS THE WHOLE POINT OF ITEM 3. The two mounts differ in ONE
  // prop — `bare` — and the envelope, the tree and the handler are identical.
  // A card that decided from `mail.from === nid` cannot tell them apart, so
  // it goes inert in both and this test fails. `bare` is the same test the
  // desk HEADER has used since 2026-08-17 (`atDestination={!bare}`): a panel
  // and a pinned window show this agent's own name and both must still
  // navigate, because the click takes you somewhere you are not.
  const h = head(await selfMailDesk(t, true))
  assert.equal(q(h, '.tier').length, 1, 'positive control: still identified')
  assert.equal(q(h, 'button.cc-name-jump').length, 1,
    'a panel is nobody’s focused desk, so its own self-mail still clicks')
})

// ═══════════════════════════════════════════════════════════════════ §2
// THE CARD ON ITS OWN, against a directory that answers EVERYTHING. §1 proves
// the desk wires one up; this proves the card consults it rather than
// deciding from the id, and that the eligibility test is not the name.
// ═══════════════════════════════════════════════════════════════════ §2

const dirAll: AgentDirectory = {
  resolve: () => ({ tier: 'fable' }),          // answers for ANY id
  onFocus: noop,
}
const msg = (text: string): ChatMessage =>
  ({ role: 'user', text, seq: 1, ts: '2026-09-05T10:00:00Z' })

uiTest('§2.1 the card asks the directory — a resolver that answers puts a chip '
  + 'on an ordinary name', async ({ mount }) => {
  const { el } = await mount(
    <AgentDirectoryProvider value={dirAll}>
      <Msg m={typedMessage('somebody')} slug="org" nid="me" />
    </AgentDirectoryProvider>)
  const h = head(el)
  assert.equal(q(h, '.tier').length, 1,
    'the chip comes from the DIRECTORY, not from anything about the id')
  assert.ok(q(h, '.tier')[0]!.classList.contains('t-fable'),
    'and it is the model the directory named')
})

uiTest('§2.2 …and with NO provider above it the same card is plain text',
  async ({ mount }) => {
    // the honest degradation: a surface that cannot answer "is this one of
    // ours" must not draw a chip or a route for a name it cannot vouch for
    const { el } = await mount(<Msg m={typedMessage('somebody')} slug="org" nid="me" />)
    const h = head(el)
    assert.ok(txt(h).includes('somebody'), 'the name is still there')
    absent(h, '.tier', 'no chip without a directory')
    absent(h, 'button.cc-name-jump', 'and no jump')
  })

uiTest('§2.3 a directory that resolves but offers no focus: chip, no button',
  async ({ mount }) => {
    const { el } = await mount(
      <AgentDirectoryProvider value={{ resolve: () => ({ tier: 'fable' }) }}>
        <Msg m={typedMessage('somebody')} slug="org" nid="me" />
      </AgentDirectoryProvider>)
    const h = head(el)
    assert.equal(q(h, '.tier').length, 1, 'positive control: it did resolve')
    absent(h, 'button.cc-name-jump', 'but nothing claims to navigate')
  })

uiTest('§2.4 a resolved agent whose CURRENT model is unknown gets no chip, and '
  + 'the tooltip says which claim it is declining', async ({ mount }) => {
    const { el } = await mount(
      <AgentDirectoryProvider value={{ resolve: () => ({ tier: null }), onFocus: noop }}>
        <Msg m={typedMessage('somebody')} slug="org" nid="me" />
      </AgentDirectoryProvider>)
    const h = head(el)
    absent(h, '.tier', 'an unknown model is an answer, never back-filled')
    const jump = q(h, 'button.cc-name-jump')
    assert.equal(jump.length, 1,
      'positive control: it IS still a resolved agent, so the route stands')
    assert.ok((jump[0]!.getAttribute('title') ?? '').includes('current model not known'),
      `and the tooltip says so: ${jump[0]!.getAttribute('title')}`)
  })

// ═══════════════════════════════════════════════════════════════════ §3
// THE MAILBOX LIST ROW.
// ═══════════════════════════════════════════════════════════════════ §3

const row = (over: Partial<MailRow> = {}): MailRow => ({
  id: 'r1', from: 'peer-one', kind: 'message',
  body: 'the body of the first mail', at: '2026-09-05T10:00:00Z', ...over,
} as MailRow)

const rowsOf = (el: HTMLElement) => q(el, '.mailrow')
const mfrom = (el: HTMLElement, i = 0) => {
  const r = rowsOf(el)[i]
  assert.ok(r, `positive control: row ${i} rendered at all`)
  const f = r!.querySelector('.mfrom') as HTMLElement | null
  assert.ok(f, 'and it has an identity cell')
  return f!
}

uiTest('§3.1 the LIST ROW carries the model chip and the click-to-desk, not '
  + 'only the reading pane', async ({ mount }) => {
    const nav = recorder()
    const { el } = await mount(
      <MailList delivered={[row()]} tierOf={(id) => (id === 'peer-one' ? 'sonnet' : null)}
        hasAgent={(id) => id === 'peer-one'}
        onFocusAgent={nav.fn} />)
    const f = mfrom(el)
    assert.equal(q(f, '.tier').length, 1, 'the row names the sender with its model')
    assert.ok(q(f, '.tier')[0]!.classList.contains('t-sonnet'), 'the right model')
    const jump = q(f, 'button.cc-name-jump')
    assert.equal(jump.length, 1, 'and the name is a jump')
    await inAct(() => { jump[0]!.click() })
    assert.deepEqual(nav.calls, [['peer-one']], 'which focuses that agent')
  })

uiTest('§3.2 …and the identical row with no facts supplied stays bare — so '
  + '§3.1 is not asserting something the markup gives away free',
  async ({ mount }) => {
    const { el } = await mount(<MailList delivered={[row()]} />)
    const f = mfrom(el)
    assert.ok(txt(f).includes('peer-one'), 'the name is still rendered')
    absent(f, '.tier', 'no tier resolver, no chip')
    absent(f, 'button.cc-name-jump', 'no focus handler, no button')
  })

uiTest('§3.3 an @-sentinel in the row keeps its plain name even with a tier '
  + 'resolver that would answer', async ({ mount }) => {
    const { el } = await mount(
      <MailList delivered={[row({ from: '@system' }), row({ id: 'r2', from: '@user' })]}
        tierOf={() => 'opus'} onFocusAgent={noop} />)
    // rows are newest-first by `at`; both share a timestamp, so judge both
    for (const i of [0, 1]) {
      const f = mfrom(el, i)
      absent(f, '.tier', `row ${i}: a sentinel is not an agent`)
      absent(f, 'button.cc-name-jump', `row ${i}: and has no desk`)
    }
  })

// ═══════════════════════════════════════════════════════════════════ §4
// A CLICK TARGET INSIDE A CLICK TARGET. The row selects the mail; the name
// navigates. One gesture must not do both.
// ═══════════════════════════════════════════════════════════════════ §4

/** the reading pane is empty exactly when nothing is selected */
const selected = (el: HTMLElement) => q(el, '.mailer-none').length === 0

uiTest('§4.1 clicking the sender NAVIGATES without selecting the mail, and '
  + 'clicking the row still selects it', async ({ mount }) => {
    const nav = recorder()
    const { el } = await mount(
      <MailList delivered={[row()]} tierOf={() => 'sonnet'} hasAgent={() => true}
        onFocusAgent={nav.fn} />)
    assert.equal(selected(el), false,
      'the box opens with nothing selected (user spec 2026-08-05)')
    await inAct(() => { q(mfrom(el), 'button.cc-name-jump')[0]!.click() })
    assert.deepEqual(nav.calls, [['peer-one']], 'the name navigated')
    assert.equal(selected(el), false,
      'and the row did NOT also select — the bubble was stopped')
    // ⚠ THE POSITIVE CONTROL FOR THE INSTRUMENT ITSELF. If `selected()` could
    // not see a selection happen, the assertion above would pass however
    // broken the stopPropagation was. Clicking the row's own preview line is
    // the same gesture one element over, and it MUST select.
    await inAct(() => { (rowsOf(el)[0]!.querySelector('.l2') as HTMLElement).click() })
    assert.equal(selected(el), true,
      'positive control: a click on the row body DOES select the mail')
  })

uiTest('§4.2 …and clicking the sender of the mail you are READING does not '
  + 'close it', async ({ mount }) => {
    // the second half of the same bug: `.mailrow`\'s onClick TOGGLES, so an
    // unstopped click on the selected row would deselect and empty the pane
    // out from under the reader.
    const nav = recorder()
    const { el } = await mount(
      <MailList delivered={[row()]} tierOf={() => 'sonnet'} hasAgent={() => true}
        onFocusAgent={nav.fn} />)
    await inAct(() => { (rowsOf(el)[0]!.querySelector('.l2') as HTMLElement).click() })
    assert.equal(selected(el), true, 'positive control: it is open')
    await inAct(() => { q(mfrom(el), 'button.cc-name-jump')[0]!.click() })
    assert.deepEqual(nav.calls, [['peer-one']], 'the name navigated')
    assert.equal(selected(el), true, 'and the mail stayed open')
  })

// ═══════════════════════════════════════════════════════════════════ §5
// THE ORG INBOX — the one mailbox whose counterparty is NOT this org's agent.
// ═══════════════════════════════════════════════════════════════════ §5

const oiIn: OrgInboxEntry = {
  id: 'e-in', dir: 'in', peer: '@net:faraway.other-machine.abcdef',
  body: 'an inbound one', at: '2026-09-05T09:00:00Z',
}
const oiOut: OrgInboxEntry = {
  id: 'e-out', dir: 'out', peer: '@net:faraway.other-machine.abcdef',
  body: 'our answer', at: '2026-09-05T10:00:00Z', by: 'ceo',
  net_id: 'n-out', state: 'sent', state_at: '2026-09-05T10:00:00Z',
}
const inboxBox = (entries: OrgInboxEntry[]): TreePayload['org_inbox'] =>
  ({ entries, unread: 0, holders: ['ceo'], visible: true })

uiTest('§5.1 an org-inbox row names the outside party as plain text — no chip, '
  + 'no route — while the SENT pane still shows who sent it, in full',
  async ({ mount }) => {
    const map = new Map<string, CanvasNode>([['ceo', node('ceo', { tier: 'opus' })]])
    const { el } = await mount(
      <OrgInboxModal inbox={inboxBox([oiIn, oiOut])}
        net={{ slug: 'mine.ncola.abc123', hubs: [] }} map={map} slug="mine"
        toast={noop} close={noop} jumpTo={null} onFocusAgent={noop} />)
    // the inbox folder: the peer is the counterparty
    const f = mfrom(el)
    absent(f, '.tier', 'an outside peer gets no model chip in the row')
    absent(f, 'button.cc-name-jump', 'and no route into our tree')
    // the SENT folder: the row names the recipient ONLY. The reading pane's
    // "@agent as @org → @recipient" is three identities and does not belong
    // in a row — but it must still be there when you OPEN the mail.
    const sent = q(el, '.mail-folders button')
      .find((b) => txt(b).trim().startsWith('sent'))
    assert.ok(sent, 'positive control: there is a sent folder to click')
    await inAct(() => { sent!.click() })
    const sf = mfrom(el)
    assert.ok(txt(sf).includes('faraway'), 'the sent row names the recipient')
    assert.ok(!txt(sf).includes(' as '),
      `and NOT the whole attribution line: ${JSON.stringify(txt(sf))}`)
    await inAct(() => { (rowsOf(el)[0]!.querySelector('.l2') as HTMLElement).click() })
    const pane = el.querySelector('.mailer-head') as HTMLElement | null
    assert.ok(pane, 'positive control: opening the mail rendered a reading pane')
    assert.ok(txt(pane!).includes(' as '),
      `the PANE still carries the full attribution: ${JSON.stringify(txt(pane!))}`)
    // …and the local agent that sent it keeps its chip THERE, which is the
    // control proving this fixture could have produced one in the row
    assert.equal(q(pane!, '.tier').length, 1,
      'the sending agent — ours — is identified in the pane')
  })

uiTest('§5.2 …and a peer that spells itself EXACTLY like one of our live '
  + 'agents still gets nothing — the row obeys the call site, not the name',
  async ({ mount }) => {
    // ⚠ WHAT THIS IS AND IS NOT, corrected after mutating it. Today every
    // org-inbox peer the backend mints is '@'-prefixed (`_extern_peer` →
    // @mcp:, api.py → @org:, net.py → @net:), so the bare-name collision
    // below cannot arrive from the server as things stand — this is DEFENCE
    // IN DEPTH against a frontend that must not rest on an invariant it does
    // not itself enforce.
    //
    // It is NOT the check that holds the row renderer's default in place. A
    // first draft of this comment said it was; mutating `rowSender ?? sender`
    // to `rowSender ?? <the built-in>` left this test GREEN, because the org
    // inbox hands its lists no `tierOf` and no `onFocusAgent`, so the
    // built-in renderer draws nothing here either. §5.3 is that check, at the
    // one place the difference can be made visible.
    const map = new Map<string, CanvasNode>([
      ['luna-reserve', node('luna-reserve', { tier: 'opus' })],
      ['ceo', node('ceo', { tier: 'opus' })],
    ])
    const collide: OrgInboxEntry = { ...oiIn, id: 'e-collide', peer: 'luna-reserve' }
    const { el } = await mount(
      <OrgInboxModal inbox={inboxBox([collide])}
        net={{ slug: 'mine.ncola.abc123', hubs: [] }} map={map} slug="mine"
        toast={noop} close={noop} jumpTo={null} onFocusAgent={noop} />)
    const f = mfrom(el)
    assert.ok(txt(f).includes('luna-reserve'),
      'positive control: the collision is REAL — this row does name it, and '
      + 'the tree above holds a live agent by that exact name')
    absent(f, '.tier', "an outside party does not borrow our agent's model")
    absent(f, 'button.cc-name-jump', 'nor a route into our tree')
  })

uiTest('§5.3 a list that DECLARES its counterparty plain text keeps a plain '
  + 'row even when the same list is also given a tier resolver and a focus '
  + 'handler', async ({ mount }) => {
    // ⚠ THIS IS THE ONE PLACE THE DEFAULT IS VISIBLE. `rowSender` falls back
    // to `sender`, not to the built-in identity renderer, so a call site that
    // said "plain text" once cannot be undone by a row it never thought
    // about. The fixture supplies `tierOf` and `onFocusAgent` DELIBERATELY:
    // they are exactly what a well-meaning future edit would add to the org
    // inbox, and they are what makes the wrong default draw a chip here.
    const nav = recorder()
    const { el } = await mount(
      <MailList delivered={[row()]}
        sender={(id: string) => <b>{id}</b>}
        tierOf={() => 'opus'} onFocusAgent={nav.fn} />)
    const f = mfrom(el)
    assert.ok(txt(f).includes('peer-one'),
      'positive control: the row does name the party')
    absent(f, '.tier', 'the declaration wins: no chip in the row')
    absent(f, 'button.cc-name-jump', 'and no jump')
    // …and the CONTROL that the fixture could have produced one: the same
    // props with the declaration removed do draw both.
    const c = await mount(
      <MailList delivered={[row()]} hasAgent={() => true}
        tierOf={() => 'opus'} onFocusAgent={nav.fn} />)
    assert.equal(q(mfrom(c.el), '.tier').length, 1,
      'control: without the plain-text declaration the very same props DO '
      + 'draw a chip — so the assertions above are not free')
    assert.equal(q(mfrom(c.el), 'button.cc-name-jump').length, 1,
      'control: …and a jump')
  })

// ═══════════════════════════════════════════════════════════════════ §6
// THE USER'S OWN INBOX composes `MailList` with `SenderChip` as its identity
// renderer (App.tsx, both folders — read there, not inferred). That chip
// predates `AgentName` and keeps its own markup by ruling, so it needs its
// own proof that it survives being put inside a row that is itself clickable.
// ═══════════════════════════════════════════════════════════════════ §6

uiTest('§6.1 SenderChip in a LIST ROW: chip, jump, and the row does not select '
  + 'underneath it', async ({ mount }) => {
    const nodes = new Map<string, TreeNode>([
      ['peer-one', { id: 'peer-one', tier: 'sonnet', state: 'live' } as TreeNode],
    ])
    const nav = recorder()
    const { el } = await mount(
      <MailList delivered={[row()]}
        sender={(id: string) => <SenderChip id={id} nodes={nodes}
          onFocusAgent={nav.fn} />} />)
    const f = mfrom(el)
    assert.equal(q(f, '.tier').length, 1, 'the row carries the model chip')
    const jump = q(f, 'button.cc-name-jump')
    assert.equal(jump.length, 1, 'and the name is a jump')
    assert.equal(selected(el), false, 'nothing selected yet')
    await inAct(() => { jump[0]!.click() })
    assert.deepEqual(nav.calls, [['peer-one']], 'the name navigated')
    assert.equal(selected(el), false,
      'and did NOT also select the mail — SenderChip stops the bubble too')
    await inAct(() => { (rowsOf(el)[0]!.querySelector('.l2') as HTMLElement).click() })
    assert.equal(selected(el), true,
      'positive control: the row body still selects, so the check above could fail')
  })

// ═══════════════════════════════════════════════════════════════════ §7
// THE ARCHIVED TRANSCRIPT. `LineagePanel` reads a prior generation's real
// conversation through the same `Msg`, mail cards and all — so it is the one
// remaining place a mail card could have fallen back to a bare name.
// ═══════════════════════════════════════════════════════════════════ §7

function bearerNode(): CanvasNode {
  return {
    ...node('agent-a', { tier: 'opus' }),
    generation: 2,
    lineage: [{
      id: 'agent-a@1', tier: 'opus', generation: 1, state: 'archived',
      bearer_state: 'preserving', at: '2026-09-01T10:00:00.000Z',
    }],
  } as unknown as CanvasNode
}

/** the panel fetches the archived transcript; serve it one mail envelope */
function serveTranscript(from: string) {
  const s = new FakeServer()
  s.userMsg('Agent projection fallback').segments = typedMessage(from, 'your superior').segments
  installFetch(s)
}

uiTest('§7.1 a mail card inside an archived generation carries the same chip '
  + 'and the same route as one in the live desk', async ({ mount }) => {
    serveTranscript('peer-one')
    const nav = recorder()
    const closed: number[] = []
    const { el } = await mount(
      <LineagePanel node={bearerNode()} slug="org"
        op={() => Promise.resolve({} as OpResult)}
        map={new Map<string, CanvasNode>([['peer-one', node('peer-one', { tier: 'sonnet' })]])}
        onFocusAgent={nav.fn}
        close={() => { closed.push(1) }} />)
    const read = q(el, 'button').find((b) => txt(b).trim() === 'read')
    assert.ok(read, 'positive control: the panel offers a transcript to read')
    await inAct(() => { read!.click() })
    await flush()
    const h = el.querySelector('.lin-read .event-head') as HTMLElement | null
    assert.ok(h, 'positive control: the archived transcript rendered a mail CARD')
    assert.equal(q(h!, '.tier').length, 1, 'with the sender\'s model chip')
    const jump = q(h!, 'button.cc-name-jump')
    assert.equal(jump.length, 1, 'and a route to that agent')
    await inAct(() => { jump[0]!.click() })
    // ⚠ A MODAL MUST CLOSE BEFORE IT NAVIGATES, or the camera glides to a desk
    // sitting behind this overlay. Every other modal here does the same.
    assert.deepEqual(nav.calls, [['peer-one']], 'the click focused that agent')
    assert.equal(closed.length, 1, 'and closed the panel first')
  })

uiTest('§7.2 …and the same panel with no tree behind it draws a plain name',
  async ({ mount }) => {
    // the anti-vacuity pair: identical mount but for the two new props, which
    // is exactly what this panel looked like before they existed
    serveTranscript('peer-one')
    const { el } = await mount(
      <LineagePanel node={bearerNode()} slug="org"
        op={() => Promise.resolve({} as OpResult)} close={noop} />)
    const read = q(el, 'button').find((b) => txt(b).trim() === 'read')
    await inAct(() => { read!.click() })
    await flush()
    const h = el.querySelector('.lin-read .event-head') as HTMLElement | null
    assert.ok(h, 'positive control: the card is still rendered')
    assert.ok(txt(h!).includes('peer-one'), 'and still names the sender')
    absent(h!, '.tier', 'but with no tree to ask, there is no chip')
    absent(h!, 'button.cc-name-jump', 'and nowhere to go')
  })

uiTest('§7.3 a sender that matches the BEARER whose transcript this is still '
  + 'navigates — a modal is nobody’s focused desk', async ({ mount }) => {
    // ⚠ THE COLLISION IS REAL, not contrived: a rehired knowledge bearer is a
    // live node in the tree under exactly this id (`agent-a@1`), so reading
    // generation 1's transcript CAN show a mail from `agent-a@1`. The card
    // used to compare the sender against the `nid` it was handed — which here
    // is the bearer — and went inert, stranding the reader in a modal with a
    // name that would not click. The destination is supplied by the surface,
    // and this surface is not anybody's desk.
    serveTranscript('agent-a@1')
    const nav = recorder()
    const closed: number[] = []
    const { el } = await mount(
      <LineagePanel node={bearerNode()} slug="org"
        op={() => Promise.resolve({} as OpResult)}
        map={new Map<string, CanvasNode>([
          ['agent-a@1', node('agent-a@1', { tier: 'sonnet' })]])}
        onFocusAgent={nav.fn}
        close={() => { closed.push(1) }} />)
    const read = q(el, 'button').find((b) => txt(b).trim() === 'read')
    await inAct(() => { read!.click() })
    await flush()
    const h = el.querySelector('.lin-read .event-head') as HTMLElement | null
    assert.ok(h, 'positive control: the archived transcript rendered a mail CARD')
    assert.equal(q(h!, '.tier').length, 1, 'positive control: it is identified')
    const jump = q(h!, 'button.cc-name-jump')
    assert.equal(jump.length, 1,
      'and the name clicks even though it names the bearer being read')
    await inAct(() => { jump[0]!.click() })
    assert.deepEqual(nav.calls, [['agent-a@1']], 'it navigated to that bearer')
    assert.equal(closed.length, 1, 'closing the modal first, as every modal does')
  })

// ═══════════════════════════════════════════════════════════════════ §8
// THE FACTS MUST STAY CURRENT ON A TRANSCRIPT THAT NEVER CHANGES.
//
// This is the section that fails on the shape the first pass shipped: the
// directory read the tree through a ref and memoised its context value on
// `canJump` alone. A ref write notifies nobody, and `Msg` is `memo`'d on its
// message object — so with the SAME transcript rows, a model switch, a
// retirement and a re-hire all failed to reach the screen. The card kept
// yesterday's chip and a link to an agent that had gone, indefinitely.
//
// ⚠ EVERY STEP HERE RE-RENDERS THE SAME MOUNTED ROOT WITH THE SAME MESSAGE
// DATA. Only the tree changes. Mounting a second desk would test a fresh
// component, which is the opposite of the question.
// ═══════════════════════════════════════════════════════════════════ §8

test('§8.1 a tier change, a disappearance and a return all reach a mail card '
  + 'whose transcript never moved', async (t: TestContext) => {
  const SL = 'org'
  const ND = `ms${++_n}`
  useFakeClock()
  const s = new FakeServer()
  installFetch(s)
  const nd = node(ND, { tier: 'opus' })
  s.userMsg('Agent projection fallback').segments = typedMessage('peer-one').segments
  const treeWith = (tier: string | null) => {
    const m = new Map<string, CanvasNode>([[nd.id, nd]])
    if (tier !== null) m.set('peer-one', node('peer-one', { tier }))
    return m
  }
  const deskAt = (map: Map<string, CanvasNode>) => (
    <DeskChat node={nd} map={map} op={op} slug={SL} toast={noop} pub={false}
      bare onJump={noop} />)
  const v = await mountView(deskAt(treeWith('sonnet')), (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos(); realClock()
  })
  await refreshConvo(SL, ND, { force: true })
  await flush()
  const chipClass = () => {
    const c = q(head(v.el), '.tier')
    return c.length ? c[0]!.className : '(none)'
  }
  assert.ok(chipClass().includes('t-sonnet'),
    `positive control: the card starts on the sender's real model — ${chipClass()}`)
  const seqs = s.messages.map((m) => m.seq).join(',')

  // 1. THE MODEL CHANGES. Nothing about the transcript does.
  await v.render(deskAt(treeWith('opus')))
  assert.equal(s.messages.map((m) => m.seq).join(','), seqs,
    'control: the transcript rows are unchanged — nothing was refetched')
  assert.ok(chipClass().includes('t-opus'),
    `the chip followed the switch: ${chipClass()}`)

  // 2. THE SENDER LEAVES THE TREE. Eligibility is withdrawn, not just the chip.
  await v.render(deskAt(treeWith(null)))
  const h2 = head(v.el)
  assert.ok(txt(h2).includes('peer-one'), 'the name is still shown, verbatim')
  absent(h2, '.tier', 'a tree that no longer holds it vouches for nothing')
  absent(h2, 'button.cc-name-jump', 'and the route goes with it')

  // 3. AND IT COMES BACK. The withdrawal above is not a one-way latch.
  await v.render(deskAt(treeWith('fable')))
  assert.ok(chipClass().includes('t-fable'),
    `re-hired at a new model, the card says so: ${chipClass()}`)
  assert.equal(q(head(v.el), 'button.cc-name-jump').length, 1,
    'and the route is restored')
})

test('§8.2 …and the same three steps reach an ARCHIVED transcript in the '
  + 'lineage modal, which builds its directory the same way',
async (t: TestContext) => {
  useFakeClock()
  serveTranscript('peer-one')
  const treeWith = (tier: string | null) =>
    (tier === null ? new Map<string, CanvasNode>()
      : new Map<string, CanvasNode>([['peer-one', node('peer-one', { tier })]]))
  const panel = (map: Map<string, CanvasNode>) => (
    <LineagePanel node={bearerNode()} slug="org"
      op={() => Promise.resolve({} as OpResult)} map={map}
      onFocusAgent={noop} close={noop} />)
  const v = await mountView(panel(treeWith('sonnet')), (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos(); realClock()
  })
  await flush()
  const read = q(v.el, 'button').find((b) => txt(b).trim() === 'read')
  assert.ok(read, 'positive control: there is a transcript to read')
  await inAct(() => { read!.click() })
  await flush()
  const hd = () => {
    const h = v.el.querySelector('.lin-read .event-head') as HTMLElement | null
    assert.ok(h, 'positive control: the archived transcript still shows a card')
    return h!
  }
  const chipClass = () => {
    const c = q(hd(), '.tier')
    return c.length ? c[0]!.className : '(none)'
  }
  assert.ok(chipClass().includes('t-sonnet'), `starts right: ${chipClass()}`)
  await v.render(panel(treeWith('opus')))
  assert.ok(chipClass().includes('t-opus'), `follows a switch: ${chipClass()}`)
  await v.render(panel(treeWith(null)))
  absent(hd(), '.tier', 'and a departure withdraws the chip')
  absent(hd(), 'button.cc-name-jump', 'and the route')
  await v.render(panel(treeWith('fable')))
  assert.ok(chipClass().includes('t-fable'), `and a return restores it: ${chipClass()}`)
})

// ═══════════════════════════════════════════════════════════════════ §9
// MAIL THAT ARRIVES MID-TURN — the LIVE steered row, before the transcript
// catches up. The user's ruling ("inline in the transcript too") covers this
// row: it was a bold name with no chip and no route.
//
// ⚠ THE TWO HALVES ARE EQUALLY LOAD-BEARING. It must identify its sender,
// AND it must still look like a message that is still arriving: a live row
// dressed as the settled card tells the reader the message has landed in the
// transcript when it has not.
// ═══════════════════════════════════════════════════════════════════ §9

async function liveDesk(t: TestContext, opts: {
  from: string; others?: CanvasNode[]; text?: string;
  /** the server DECLARED this copy cut (supervisor caps the frame at 2000) */
  truncated?: boolean;
  typedBody?: string;
  /** what the transcript carries a moment later; defaults to the same text */
  settleText?: string;
}): Promise<{ el: HTMLElement; settle: () => Promise<void> }> {
  const SL = 'org'
  const ND = `ms${++_n}`
  useFakeClock()
  const s = new FakeServer()
  installFetch(s)
  const nd = node(ND, { tier: 'opus' })
  const map = new Map<string, CanvasNode>([[nd.id, nd]])
  for (const o of opts.others ?? []) map.set(o.id, o)
  const text = opts.text ?? 'Agent projection fallback'
  const segments = opts.text === undefined || opts.typedBody !== undefined
    ? typedMessage(opts.from, 'your peer', opts.typedBody).segments : undefined
  s.busy = true
  const lr = s.liveRow('steered', text)
  lr.segments = segments
  if (opts.truncated) lr.truncated = true
  const v = await mountView(
    <DeskChat node={nd} map={map} op={op} slug={SL} toast={noop} pub={false}
      bare onJump={noop} />, (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos(); realClock()
  })
  await refreshConvo(SL, ND, { force: true })
  await flush()
  return {
    el: v.el,
    // what the server does moments later: the live row retires and the same
    // text lands in the durable transcript
    settle: async () => {
      s.live = []
      s.userMsg(opts.settleText ?? text).segments = segments
      await refreshConvo(SL, ND, { force: true })
      await flush()
    },
  }
}

const liveRowOf = (el: HTMLElement) => {
  const r = q(el, '.typed-input.live, .msg.user.live')
  assert.equal(r.length, 1,
    'positive control: exactly one LIVE user row is on screen')
  return r[0]!
}

test('§9.1 a mid-turn mail identifies its sender — and is still a live row, '
  + 'not a settled card', async (t: TestContext) => {
  const { el } = await liveDesk(t, {
    from: 'peer-one', others: [node('peer-one', { tier: 'sonnet' })],
  })
  const r = liveRowOf(el)
  assert.equal(q(r, '.tier').length, 1, 'the sender wears its model chip')
  assert.ok(q(r, '.tier')[0]!.classList.contains('t-sonnet'), 'the right model')
  assert.equal(q(r, 'button.cc-name-jump').length, 1,
    'and its name is a route to its desk')
  assert.ok(txt(r).includes('a word about the build'), 'the body is still there')
  // ⚠ THE OTHER HALF: it has NOT been promoted to the settled card.
  absent(el, '.typed-input:not(.live) .turn-mail',
    'a message still arriving must not be dressed as one that has landed')
  assert.ok(!txt(r).includes('[MAIL'),
    `and the envelope chrome is still hidden: ${JSON.stringify(txt(r).slice(0, 80))}`)
  assert.ok(!txt(r).includes('(orgtree)'), 'including the drive nudge')
})

test('§9.2 …and a mid-turn mail from a name this tree does not hold gets '
  + 'neither chip nor route', async (t: TestContext) => {
  // the anti-vacuity pair for §9.1: same envelope, same row, one fact changed
  const { el } = await liveDesk(t, { from: 'outsider' })
  const r = liveRowOf(el)
  assert.ok(txt(r).includes('outsider'), 'the name is still shown, verbatim')
  absent(r, '.tier', 'no chip for a name this tree cannot vouch for')
  absent(r, 'button.cc-name-jump', 'and no route')
})

test('§9.3 an envelope shape the parser does not recognise still renders its '
  + 'text — a live row must never swallow one', async (t: TestContext) => {
  // `splitTurnMail` refuses an unfamiliar block rather than guessing; the
  // live row inherits that refusal and falls back to the previous rendering.
  const odd = '[MAIL — 1 message(s)]\nFROM-THE-FUTURE peer-one\nbody text here\n[END MAIL]'
  const { el } = await liveDesk(t, {
    from: 'peer-one', others: [node('peer-one', { tier: 'sonnet' })], text: odd,
  })
  const r = liveRowOf(el)
  assert.ok(txt(r).includes('body text here'), 'the body survived')
  assert.ok(txt(r).includes('FROM-THE-FUTURE'),
    `and so did the line the parser could not read: ${JSON.stringify(txt(r))}`)
  absent(r, '.tier', 'nothing is identified from a shape we did not parse')
})

test('§9.4 the handover to the stored transcript loses nothing and duplicates '
  + 'nothing — same sender, same body, once', async (t: TestContext) => {
  const { el, settle } = await liveDesk(t, {
    from: 'peer-one', others: [node('peer-one', { tier: 'sonnet' })],
  })
  const count = (hay: string, needle: string) => hay.split(needle).length - 1
  assert.equal(count(txt(el), 'a word about the build'), 1,
    'positive control: the body is on screen exactly once while live')
  assert.equal(q(el, '.typed-input:not(.live) .turn-mail').length, 0, 'and not yet as a settled card')
  await settle()
  assert.equal(q(el, '.typed-input.live, .msg.user.live').length, 0, 'the live row retired')
  const cards = q(el, '.event-head')
  assert.equal(cards.length, 1, 'and exactly one settled card took its place')
  assert.equal(count(txt(el), 'a word about the build'), 1,
    'the body appears ONCE across the whole desk — no duplicate, no loss')
  assert.equal(q(cards[0]!, '.tier').length, 1,
    'the identity survived the handover: the chip is still there')
  assert.ok(q(cards[0]!, '.tier')[0]!.classList.contains('t-sonnet'),
    'and it is the same model')
  assert.equal(q(cards[0]!, 'button.cc-name-jump').length, 1,
    'and so is the route')
})

// ═══════════════════════════════════════════════════════════════════ §10
// THE PHANTOM JUMP. `SenderChip` used to treat any name that merely did not
// start with '@' as one of ours — so an unknown spelling was drawn as a
// button that focused nothing at all.
// ═══════════════════════════════════════════════════════════════════ §10

uiTest('§10.1 SenderChip offers no route to a name the tree does not hold, '
  + 'and does offer one to a name it does', async ({ mount }) => {
    const nodes = new Map<string, TreeNode>([
      ['peer-one', { id: 'peer-one', tier: 'sonnet', state: 'live' } as TreeNode],
    ])
    const { el } = await mount(
      <div>
        <span className="known">
          <SenderChip id="peer-one" nodes={nodes} onFocusAgent={noop} /></span>
        <span className="unknown">
          <SenderChip id="ghost-agent" nodes={nodes} onFocusAgent={noop} /></span>
      </div>)
    const known = el.querySelector('.known') as HTMLElement
    const unknown = el.querySelector('.unknown') as HTMLElement
    // ⚠ THE POSITIVE CONTROL IS IN THE SAME MOUNT, one fact apart: identical
    // props, identical handler, and the only difference is membership.
    assert.equal(q(known, 'button.cc-name-jump').length, 1,
      'control: an agent the tree holds still gets its route')
    assert.equal(q(known, '.tier').length, 1, 'control: …and its model chip')
    assert.ok(txt(unknown).includes('ghost-agent'),
      'the unknown name is still readable, verbatim')
    absent(unknown, 'button.cc-name-jump',
      'but nothing claims to take you to a desk that does not exist')
  })

uiTest('§10.2 …and its navigation button declares type="button", so it cannot '
  + 'submit a form it is nested in', async ({ mount }) => {
    const nodes = new Map<string, TreeNode>([
      ['peer-one', { id: 'peer-one', tier: 'sonnet', state: 'live' } as TreeNode],
    ])
    const { el } = await mount(
      <SenderChip id="peer-one" nodes={nodes} onFocusAgent={noop} />)
    const b = q(el, 'button.cc-name-jump')
    assert.equal(b.length, 1, 'positive control: there is a button to judge')
    assert.equal(b[0]!.getAttribute('type'), 'button',
      'an untyped button inside a form defaults to submit')
  })

// ═══════════════════════════════════════════════════════════════════ §11
// A COPY THE SERVER CUT.
//
// The supervisor caps a steered message and DECLARES the cap: the live frame
// at `body[:2000]` and the durable steered-log row at `s[:100000]`, each with
// `truncated: true` beside it. Either cap can land before `[END MAIL]`, and
// `splitTurnMail` then refuses the whole envelope — so exactly the messages
// long enough to be worth reading were the ones whose senders went nameless.
//
// ⚠ WHAT IS ON TRIAL IS THE LINE BETWEEN "COMPLETE ENOUGH TO NAME" AND
// "GUESSED". A header that ends inside the copy is evidence; a header the cut
// ran through is not, and neither is a line that merely looks like one. Every
// positive here is paired with the same text one fact away from it.
// ═══════════════════════════════════════════════════════════════════ §11

const HEAD = (from: string, at = '2026-09-05T10:00:00Z') => `FROM ${from} (your peer) - message - ${at}`
const cutMsg = (text: string, truncated = true): ChatMessage => ({role: 'user', text, truncated})
uiTest('truncated legacy mail stays readable without deriving provenance from its header', async ({mount}) => {
  const text = '[MAIL]\nFROM peer-one (your peer)\nwordy '.repeat(10)
  for (const truncated of [true, false]) {
    const {el} = await mount(<AgentDirectoryProvider value={dirAll}><Msg m={cutMsg(text,truncated)} slug="org" nid="me"/></AgentDirectoryProvider>)
    assert.ok(txt(el).includes('FROM peer-one'))
    absent(el,'.event-card','legacy headers never become typed cards')
    absent(el,'.tier','legacy prose never supplies an actor')
    assert.equal(q(el,'.trunc-note').length,truncated?1:0)
  }
})
uiTest('typed provenance survives a truncated transport projection and body header imitations stay prose', async ({mount}) => {
  const message = typedMessage('peer-one','your peer','Unique body with FROM @ghost (your peer) and retained tail')
  message.text='[MAIL'; message.truncated=true
  const {el}=await mount(<AgentDirectoryProvider value={dirAll}><Msg m={message} slug="org" nid="me"/></AgentDirectoryProvider>)
  assert.equal(q(el,'.event-card').length,1)
  assert.equal(q(head(el),'.tier').length,1)
  assert.ok(txt(head(el)).includes('peer-one'))
  assert.ok(txt(el).includes('FROM @ghost'))
  assert.ok(txt(el).includes('retained tail'))
  assert.equal(q(el,'.trunc-note').length,1)
})
test('typed live composition survives handover independently of capped transport text', async t => {
  const {el,settle}=await liveDesk(t,{from:'peer-one',text:'[MAIL',typedBody:'Unique complete content',truncated:true,
    others:[node('peer-one',{tier:'sonnet'})]})
  assert.equal(q(liveRowOf(el),'.tier').length,1)
  assert.ok(txt(el).includes('Unique complete content'))
  assert.equal(q(el,'.trunc-note').length,1)
  await settle()
  assert.equal(q(el,'.typed-input.live, .msg.user.live').length,0)
  assert.equal(q(el,'.event-card').length,1)
  assert.equal(q(head(el),'.tier').length,1)
  assert.equal(q(el,'.trunc-note').length,0)
})

// ═══════════════════════════════════════════════════════════════════ §12
// `MailList`'s OWN phantom jump. Its default identity renderer treated any id
// that merely did not start with '@' as one of ours, so a since-retired agent
// or a name off an archived envelope was drawn as a button focusing nothing.
//
// ⚠ EXISTENCE IS NOT TIER. A real agent whose current model is unknown draws
// no chip and MUST still navigate; keying the jump on tier truthiness would
// pass every "unknown name does not jump" check and silently strand it.
// ═══════════════════════════════════════════════════════════════════ §12

const mailFrom = (from: string, id: string): MailRow =>
  ({ id, from, to: 'me', at: `2026-09-05T09:0${id.slice(-1)}:00.000Z`,
    body: `body ${id}` }) as MailRow

const ROWS: MailRow[] = [
  mailFrom('peer-known', 'm1'),      // in the tree, model known
  mailFrom('peer-notier', 'm2'),     // in the tree, model unknown
  mailFrom('peer-gone', 'm3'),       // not in the tree at all
]
const TREE: Record<string, string | null> = { 'peer-known': 'sonnet', 'peer-notier': null }
const rowNamed = (el: HTMLElement, name: string) =>
  q(el, '.mailer-list .mailrow').find((r) => txt(r).includes(name))!

uiTest('§12.1 the LIST ROW jumps only to agents the tree holds — and unknown '
  + 'model is not unknown agent', async ({ mount }) => {
    const { el } = await mount(
      <MailList delivered={ROWS} onFocusAgent={noop}
        tierOf={(id) => TREE[id]}
        hasAgent={(id) => id in TREE} />)
    const known = rowNamed(el, 'peer-known')
    assert.equal(q(known, 'button.cc-name-jump').length, 1,
      'positive control: an agent the tree holds is a route')
    assert.equal(q(known, '.tier').length, 1, 'and wears its chip')
    const notier = rowNamed(el, 'peer-notier')
    assert.equal(q(notier, 'button.cc-name-jump').length, 1,
      'A REAL AGENT WITH AN UNKNOWN MODEL STILL NAVIGATES')
    absent(notier, '.tier', 'it just has no chip to show')
    const gone = rowNamed(el, 'peer-gone')
    assert.ok(txt(gone).includes('peer-gone'), 'the missing name stays readable')
    absent(gone, 'button.cc-name-jump', 'but claims no desk to go to')
  })

uiTest('§12.2 the READING PANE answers the same way', async ({ mount }) => {
  const { el } = await mount(
    <MailList delivered={ROWS} onFocusAgent={noop}
      tierOf={(id) => TREE[id]}
      hasAgent={(id) => id in TREE} />)
  const open = async (name: string) => {
    await inAct(() => { rowNamed(el, name).click() })
    await flush()
    return el.querySelector('.mailer-read') as HTMLElement
  }
  const pane1 = await open('peer-known')
  assert.equal(q(pane1, 'button.cc-name-jump').length, 1,
    'positive control: the pane routes a known sender')
  const pane2 = await open('peer-gone')
  assert.ok(txt(pane2).includes('peer-gone'), 'the missing name is readable here too')
  absent(pane2, 'button.cc-name-jump', 'and offers no route')
})

uiTest('§12.3 with NO resolver the same list claims no local jump at all',
  async ({ mount }) => {
    // the anti-vacuity pair for §12.1: identical rows, identical handler, one
    // prop removed. A caller that cannot say whether an id is one of ours must
    // not have its silence read as "yes".
    const { el } = await mount(
      <MailList delivered={ROWS} onFocusAgent={noop} tierOf={(id) => TREE[id]} />)
    assert.equal(q(el, '.mailer-list .mailrow').length, 3,
      'positive control: the rows are there to judge')
    assert.equal(q(el, 'button.cc-name-jump').length, 0,
      'no resolver, no claimed route — not even for peer-known')
    assert.equal(q(rowNamed(el, 'peer-known'), '.tier').length, 1,
      'the chip is a separate fact and still shows')
  })

test('§12.4 …and it is WIRED: NodeInboxModal carries the tree down to the row',
  async (t: TestContext) => {
    // ⚠ THE PROP IS THE EASY HALF. `hasAgent` accepted by MailList and passed
    // by nobody draws no jump anywhere and every test above still passes —
    // present, plausible and inert. This mounts the REAL modal, which owns the
    // NodeInboxModal → InboxView → MailList chain, and requires the jump back.
    useFakeClock()
    const had = (globalThis as { fetch?: typeof fetch }).fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ pending: [], sent: [], delivered: ROWS }),
      })) as unknown as typeof fetch
    t.after(() => {
      (globalThis as { fetch?: typeof fetch }).fetch = had; realClock()
    })
    const mountModal = async (hasAgent?: (id: string) => boolean) => {
      const v = await mountView(
        <NodeInboxModal node={node('me')} slug="org" jumpTo={null}
          close={noop} onFocusAgent={noop}
          tierOf={(id) => TREE[id]} hasAgent={hasAgent} />, (host) => host)
      await flush()
      t.after(async () => { try { await v.unmount() } catch { /* gone */ } })
      return v.el
    }
    const wired = await mountModal((id) => id in TREE)
    assert.equal(q(rowNamed(wired, 'peer-known'), 'button.cc-name-jump').length, 1,
      'the modal handed the tree down: a known sender is a route')
    absent(rowNamed(wired, 'peer-gone'), 'button.cc-name-jump',
      'and a name the tree does not hold is not')
    // THE CONTROL: the same mount without the resolver draws no route, so the
    // assertion above cannot be passing on a component that always draws one.
    const bare = await mountModal(undefined)
    assert.equal(q(bare, 'button.cc-name-jump').length, 0,
      'CONTROL BROKEN: a route appeared with no resolver')
  })

// ⚠ §12.5-§12.7 REPLACE A TEST THAT PINNED A MISSING FEATURE. The old §12.5
// asserted "no name in the desk's inbox claims a desk", which was TRUE of the
// build and false as a rule: the tab passed `tierOf`/`hasAgent` and no focus
// handler at all. The user's request named the mail inbox, and the desk already
// holds `onJump` (its header and NavChip use it), so the inbox now passes that
// same callback. These three drive the REAL DeskChat — mount, open the tab,
// click — because the whole failure mode here is a one-line omission at a call
// site that no MailList-level test can see.
//
// The tree ON SCREEN for these: the desk itself, `peer-known` (model known),
// `peer-notier` (a real agent whose model is unknown — it must still navigate)
// and NOT `peer-gone`, which is the missing-node control.
async function deskInbox(t: TestContext, opts: { onJump?: (id: string) => void }) {
  useFakeClock()
  const s = new FakeServer()
  installFetch(s)
  const inner = (globalThis as { fetch: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    url: string, init?: unknown,
  ) => (String(url).includes('/inbox')
    ? Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve({ pending: [], sent: [], delivered: ROWS }),
    })
    : (inner as (u: string, i?: unknown) => Promise<unknown>)(url, init))
  ) as unknown as typeof fetch
  const nd = node(`ms${++_n}`, { tier: 'opus' })
  const map = new Map<string, CanvasNode>([
    [nd.id, nd],
    ['peer-known', node('peer-known', { tier: 'sonnet' })],
    ['peer-notier', node('peer-notier', { tier: null })],
  ])
  const v = await mountView(
    <DeskChat node={nd} map={map} op={op} slug="org" toast={noop} pub={false}
      bare onJump={opts.onJump} />, (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    ;(globalThis as { fetch?: typeof fetch }).fetch = inner
    resetConvos(); realClock()
  })
  await flush()
  const tab = q(v.el, '.cc-tabs button').find((b) => txt(b).trim().startsWith('inbox'))
  assert.ok(tab, 'positive control: the desk has an inbox tab to open')
  await inAct(() => { tab!.click() })
  await flush(); await flush()
  assert.ok(q(v.el, '.mailer-list .mailrow').length >= 3,
    'positive control: the inbox rendered its rows, so anything missing below '
    + 'is about the wiring and not about an empty list')
  return v.el
}
// the desk HEADER draws this agent's own name as a jump, so every count here is
// scoped to `.mailwrap` — otherwise the header would answer for the mailbox.
const boxJumps = (el: HTMLElement) => q(el, '.mailwrap button.cc-name-jump')

test('§12.5 the DESK inbox tab: a sender name is a real route, and clicking it '
  + 'reaches the desk\'s own onJump', async (t: TestContext) => {
  const nav = recorder()
  const el = await deskInbox(t, { onJump: nav.fn })
  const known = rowNamed(el, 'peer-known')
  assert.equal(q(known, '.tier').length, 1,
    '`tierOf` is wired: the sender wears its OWN model, not the desk\'s')
  const jump = q(known, 'button.cc-name-jump')
  assert.equal(jump.length, 1, 'and the name is a route')
  await inAct(() => { jump[0]!.click() })
  assert.deepEqual(nav.calls, [['peer-known']],
    'THE CLICK ARRIVES: the inbox is calling the same onJump the header and '
    + 'NavChip use, with the SENDER\'s id')
  // known-unknown-tier: existence is the route test, tier is only the chip
  const notier = rowNamed(el, 'peer-notier')
  assert.equal(q(notier, 'button.cc-name-jump').length, 1,
    'a real agent whose model is unknown still navigates')
  absent(notier, '.tier', 'it just has no chip to show')
  // MISSING-NODE CONTROL: same list, same handler, one name the tree lacks
  const gone = rowNamed(el, 'peer-gone')
  assert.ok(txt(gone).includes('peer-gone'), 'the missing name stays readable')
  absent(gone, 'button.cc-name-jump',
    'and claims no desk — `hasAgent` still decides, the handler does not')
})

test('§12.6 CONTROL: the same desk with NO onJump draws no route in the inbox',
  async (t: TestContext) => {
    // the anti-vacuity pair for §12.5. One prop differs. A desk that is not a
    // navigation surface (no `onJump` reaches it) must omit the control rather
    // than draw a dead one — and if this ever counts a jump, §12.5 is passing
    // on something that always draws one.
    const el = await deskInbox(t, {})
    assert.equal(q(rowNamed(el, 'peer-known'), '.tier').length, 1,
      'positive control: the chip is a SEPARATE fact and still shows, so the '
      + 'tree is still being handed down and this is not an unwired mount')
    assert.equal(boxJumps(el).length, 0,
      'no handler, no claimed route anywhere in the mailbox')
  })

test('§12.7 the desk inbox: the row BODY still selects, and the name does not',
  async (t: TestContext) => {
    // the row is a click target inside a click target (see the header note).
    // Wiring a handler into the inbox is exactly what could make the sender
    // button select-or-deselect the mail as a side effect.
    const nav = recorder()
    const el = await deskInbox(t, { onJump: nav.fn })
    await inAct(() => { rowNamed(el, 'peer-known').click() })
    await flush()
    const row = rowNamed(el, 'peer-known')
    assert.ok(row.classList.contains('on'), 'the row body SELECTED the mail')
    const pane = el.querySelector('.mailer-read') as HTMLElement | null
    assert.ok(pane, 'positive control: selecting opened the reading pane')
    assert.deepEqual(nav.calls, [], 'and selecting is not navigating')
    // the READING PANE's sender is a route here too (the user asked for both)
    const paneJump = q(pane!, 'button.cc-name-jump')
    assert.equal(paneJump.length, 1, 'the pane names the sender as a route')
    await inAct(() => { paneJump[0]!.click() })
    assert.deepEqual(nav.calls, [['peer-known']], 'and it reaches the same onJump')
    // …and the ROW's name navigates without disturbing the selection
    await inAct(() => { q(rowNamed(el, 'peer-known'), 'button.cc-name-jump')[0]!.click() })
    await flush()
    // TWO CALLS OF ONE ARGUMENT — not one call of two. That distinction is the
    // whole point of recording argument lists instead of a flat id log.
    assert.deepEqual(nav.calls, [['peer-known'], ['peer-known']],
      'the row name routes, with the sender and nothing else')
    assert.ok(rowNamed(el, 'peer-known').classList.contains('on'),
      'and the mail you were reading is STILL selected — the name click does '
      + 'not bubble to the row (a missing stopPropagation would toggle it off)')
  })

uiTest('§11.10 an unreadable block in the MIDDLE refuses the whole envelope',
  async ({ mount }) => {
    // the cut can only ever be at the END. A block the parser cannot read
    // anywhere else is an envelope shape we do not know, and guessing which of
    // its neighbours are real would be the silent-loss failure splitTurnMail
    // already refuses. Same rule here, one step further along.
    const whole = `[MAIL — 3 message(s)]\n${HEAD('peer-one')}\nfirst body\n---\n`
      + `SOME FUTURE SHAPE we do not parse\nwith a body\n---\n`
      + `${HEAD('peer-three', '2026-09-05T10:09:00Z')}\n` + 'wordy '.repeat(20)
    const { el } = await mount(
      <AgentDirectoryProvider value={dirAll}>
        <Msg m={cutMsg(whole)} slug="org" nid="me" />
      </AgentDirectoryProvider>)
    assert.equal(q(el, '.event-head').length, 0,
      'nothing is identified out of an envelope we only half understand')
    assert.ok(txt(el).includes('SOME FUTURE SHAPE'),
      'and every line of it is still on screen')
    assert.ok(txt(el).includes('first body'), 'including the part we could read')
  })
