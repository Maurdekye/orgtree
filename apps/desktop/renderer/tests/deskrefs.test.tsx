// deskrefs.test.tsx — canonical references written in the DESK CHAT's prose.
//
// The desk is where most prose in this app is actually read, and it was the
// last surface where a reference stayed dead text. What is judged here is the
// REAL DeskChat against a fake server: the transcript comes back over the
// wire, the component mounts, and whatever a reader would see is what these
// checks read. A hand-built body would pass with the wiring deleted.
//
// WHAT EACH SECTION IS FOR
//
//   §1  the agent's own reply — the ordinary case
//   §1b the text a turn is still STREAMING (a different call site)
//   §2  CONTROL: no route wired ⇒ "not opened from this panel", never a chip
//   §3  a mail card INSIDE the transcript (the envelope's body)
//   §4  ARITY. The route is called with exactly one argument.
//   §5  CONTROL: an agent this tree does not hold is `unavailable`
//   §6  a mail token reaches the router in the ROUTER's vocabulary
//   §7  CONTROL: slash-command output is left alone, deliberately
//   §8  the user's own undelivered bubble carries chips too
//   §8b …and the optimistic ghost, which is a SECOND call site
//   §9  identity stability — the claim the perf comment makes, measured
//   §10 the MAILBOX panels forward a world at all (they did not, once)
//
// ⚠ §4 IS A REGRESSION CHECK, not a nicety. `onJump` is `centerOn(id, z)` and
// `focusView` reads `z ?? fit`, so ANY non-null second argument defeats the
// default and the camera is computed from it. A DOM event handed to a
// one-argument-looking route type-checks and then poisons the zoom — Astra
// found exactly that on the mail surface on 2026-09-05. This suite pins the
// desk's four routes to a one-argument call so the same handoff cannot be
// reintroduced here quietly.
//
// STATED LIMITS, so nobody quotes this suite as more than it is:
//
//   • AN @agent TOKEN NAMING THE DESK'S OWN AGENT STAYS CLICKABLE. RefWorld
//     decides by KIND, not per id, so it cannot express "everyone but me" —
//     which differs from AgentName's `atDestination` rule two lines up the
//     same file. It is a camera move to where you already are, not a wrong
//     destination, and §9's world is not the place to fix it. Said out loud
//     rather than left for a reviewer to find.
//   • SLASH-COMMAND OUTPUT IS EXCLUDED ON PURPOSE (§7): it is quoted machine
//     text, the same reason refmd skips CODE and PRE. If someone decides it
//     should linkify, §7 is the check that must change with it.
//   • The live mid-turn steer row takes the same `refs` prop, but the desk's
//     own suite has no reachable path that writes a `steered` live row (see
//     mailsender's header, same finding), so it is NOT covered here. Absence
//     of a check, stated, beats a fabricated one that proves nothing.
//
// Run:  cd frontend && node tests/run.mjs deskrefs
//       cd frontend && node mutate_deskrefs.mjs

import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { useState } from 'react'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { addPending, refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { InboxView, NodeInboxModal } from '../src/canvas/mail'
import { useRefRoutes } from '../src/canvas/reflinks'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

;(globalThis as unknown as
  { window: { Element: { prototype: Record<string, unknown> } } })
  .window.Element.prototype.scrollIntoView ??= () => {}

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const q = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[]

/** ⚠ NEVER `assert.equal(node, null)` ON A DOM NODE IN THIS REPO — node's diff
 *  walks the whole jsdom tree and dies before printing. Assert the COUNT. */
const absent = (el: HTMLElement, sel: string, why: string) =>
  assert.equal(q(el, sel).length, 0, why)

const SL = 'org'

function node(id: string, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'opus', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'opus', ...over,
  } as CanvasNode
}

/** the envelope the backend really writes, so §3 reads a REAL mail card */
const envelope = (from: string, body: string) =>
  `[MAIL — 1 message(s)]\nFROM ${from} (your peer) · message · 2026-09-05T10:00:00Z\n`
  + `${body}\n[END MAIL]\n\n(orgtree) You have new mail above.`

/** every argument every route was called with, so a check can ask about
 *  ARITY and not only about "was it called" */
interface Calls {
  item: unknown[][]
  agent: unknown[][]
  doc: unknown[][]
  mail: unknown[][]
}

let _n = 0

/** the real desk, on a real fetch, with whichever routes the case wires.
 *
 *  ⚠ ROUTES ARE OMITTED, NOT STUBBED, when a case does not want them — that
 *  is the whole of §2. A stub would make `handles` claim the panel can open
 *  something it cannot, which is the exact confusion the outcome table exists
 *  to prevent. */
async function desk(t: TestContext, opts: {
  /** durable assistant text (the agent's own reply) */
  say?: string
  /** text the turn is still streaming — a DIFFERENT call site from `say` */
  live?: string
  /** a durable USER row carrying a mail envelope */
  mail?: { from: string; body: string }
  /** an undelivered outgoing bubble */
  queued?: string
  /** slash-command output, as `node_chat` returns it */
  cmdOut?: string
  others?: CanvasNode[]
  routes?: { item?: boolean; agent?: boolean; doc?: boolean; mailbox?: boolean }
}): Promise<{ el: HTMLElement; calls: Calls; nid: string }> {
  useFakeClock()
  const ND = `dr${++_n}`
  const s = new FakeServer()
  installFetch(s)
  const nd = node(ND)
  const map = new Map<string, CanvasNode>([[nd.id, nd]])
  for (const o of opts.others ?? []) map.set(o.id, o)
  if (opts.say) s.assistantMsg(opts.say)
  if (opts.live) s.liveRow('text', opts.live)
  if (opts.mail) s.userMsg(envelope(opts.mail.from, opts.mail.body))
  if (opts.cmdOut) {
    s.messages.push({ role: 'system', text: '', cmd_out: opts.cmdOut,
      seq: 900, ts: new Date(Date.now()).toISOString() } as never)
  }
  if (opts.queued) s.postMail(opts.queued)
  const calls: Calls = { item: [], agent: [], doc: [], mail: [] }
  const on = opts.routes ?? { item: true, agent: true, doc: true, mailbox: true }
  const v = await mountView(
    <DeskChat node={nd} map={map} op={op} slug={SL} toast={noop} pub={false} bare
      onWorkLink={on.item ? (...a: unknown[]) => { calls.item.push(a) } : undefined}
      onJump={on.agent ? (...a: unknown[]) => { calls.agent.push(a) } : undefined}
      onOpenDoc={on.doc ? (...a: unknown[]) => { calls.doc.push(a) } : undefined}
      onMailLink={on.mailbox ? (...a: unknown[]) => { calls.mail.push(a) } : undefined}
    />,
    (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos()
    realClock()
  })
  await refreshConvo(SL, ND, { force: true })
  await flush()
  return { el: v.el, calls, nid: ND }
}

/** the chip for one token, with the positive control that the transcript
 *  rendered the prose AT ALL — without it every assertion below passes by
 *  absence, which is this repo's most-repeated way to be wrong */
function chip(el: HTMLElement, token: string): HTMLElement {
  // ⚠ EVERY BODY CLASS THE DESK USES, because the live row wears `.md` alone
  // and an over-narrow control fails as "nothing rendered" on a surface that
  // rendered perfectly well. Each section adds its OWN sharper control on top.
  assert.ok(q(el, '.md, .msgtext, .turn-mail-body, .pendbody').length > 0,
    'positive control: the desk rendered a prose body at all')
  const found = q(el, '[data-ref-token]').filter((c) => c.getAttribute('data-ref-token') === token)
  assert.equal(found.length, 1,
    `exactly one chip for ${token} (found ${found.length}); `
    + `chips present: ${q(el, '[data-ref-token]').map((c) => c.getAttribute('data-ref-token')).join(', ') || 'none'}`)
  return found[0]
}

// ═══════════════════════════════════════════════════════════════════ §1
test('§1 a reference the agent wrote in its own reply is a live chip, '
  + 'and clicking it opens the item', async (t: TestContext) => {
  const { el, calls } = await desk(t, {
    say: 'picked this up from @item:org/slug-identity earlier today',
  })
  const c = chip(el, '@item:org/slug-identity')
  assert.equal(c.tagName, 'BUTTON', 'a ready reference is a real control')
  assert.equal(c.getAttribute('data-ref-outcome'), 'ready')
  assert.equal(c.textContent, 'slug-identity',
    'the label is the id — this surface holds no item titles to improve on it')
  await inAct(async () => { c.click() })
  assert.deepEqual(calls.item, [[{ slug: 'slug-identity' }]],
    'the docket route was called once, with the item the token named')
})

// ⚠ AND THE LIVE ROW IS ITS OWN CALL SITE. The text a turn is still streaming
// is drawn by different code from the settled row it becomes, so "the reply
// works" says nothing about the twenty seconds before it settles — which is
// most of the time anyone spends watching a desk.
test('§1b the text a turn is still streaming carries chips too',
async (t: TestContext) => {
  const { el, calls } = await desk(t, { live: 'starting on @item:org/sort-selector now' })
  assert.ok(q(el, '.msg.assistant.live').length > 0,
    'positive control: a LIVE row rendered, not a settled one')
  await inAct(async () => { chip(el, '@item:org/sort-selector').click() })
  assert.deepEqual(calls.item, [[{ slug: 'sort-selector' }]])
})

// ═══════════════════════════════════════════════════════════════════ §2
test('§2 CONTROL — with no docket route the same prose says so in words, '
  + 'and draws no control at all', async (t: TestContext) => {
  const { el } = await desk(t, {
    say: 'picked this up from @item:org/slug-identity earlier today',
    routes: { agent: true, doc: true, mailbox: true },   // item deliberately absent
  })
  const c = chip(el, '@item:org/slug-identity')
  assert.equal(c.tagName, 'SPAN', 'nothing to click when nothing can open it')
  assert.equal(c.getAttribute('data-ref-outcome'), 'elsewhere')
  assert.match(c.textContent ?? '', /not from here/)
  assert.match(c.textContent ?? '', /@item:org\/slug-identity/,
    'the token itself is shown, because whoever fixes it needs to see it')
  assert.match(c.getAttribute('title') ?? '', /not opened from this panel/,
    'a statement about the PANEL, never about whether the item exists')
})

// ═══════════════════════════════════════════════════════════════════ §3
test('§3 a reference inside a mail card in the transcript works too',
async (t: TestContext) => {
  const { el, calls } = await desk(t, {
    mail: { from: 'peer-one', body: 'see @item:org/sort-selector when you get a moment' },
  })
  assert.ok(q(el, '.turn-mail-head').length > 0,
    'positive control: the envelope really rendered as a mail CARD')
  const c = chip(el, '@item:org/sort-selector')
  assert.ok(c.closest('.turn-mail-body'),
    'the chip is in the CARD BODY, not in some tail the parser left behind')
  await inAct(async () => { c.click() })
  assert.deepEqual(calls.item, [[{ slug: 'sort-selector' }]])
})

// ═══════════════════════════════════════════════════════════════════ §4
// ⚠ THE REGRESSION. See this file's header: a second argument reaching
// `centerOn` is not a style problem, it is a poisoned camera.
test('§4 every route is called with EXACTLY ONE argument — an event handed '
  + 'to centerOn would be read as the zoom', async (t: TestContext) => {
  const { el, calls } = await desk(t, {
    others: [node('peer-one')],
    say: 'ask @agent:org/peer-one, or read @doc:org/d7',
  })
  await inAct(async () => { chip(el, '@agent:org/peer-one').click() })
  await inAct(async () => { chip(el, '@doc:org/d7').click() })
  assert.deepEqual(calls.agent, [['peer-one']],
    'the agent route got the id and NOTHING else')
  assert.deepEqual(calls.doc, [['d7']],
    'the document route got the id and NOTHING else')
  // said as arity too, because deepEqual on the args array is the same
  // assertion only for as long as nobody "helpfully" appends an event
  assert.equal(calls.agent[0].length, 1)
  assert.equal(calls.doc[0].length, 1)
})

// ═══════════════════════════════════════════════════════════════════ §5
test('§5 CONTROL — an agent this tree does not hold is unavailable, '
  + 'not a chip that goes nowhere', async (t: TestContext) => {
  const { el, calls } = await desk(t, {
    others: [node('peer-one')],
    say: 'ask @agent:org/peer-one — not @agent:org/nobody-here',
  })
  const real = chip(el, '@agent:org/peer-one')
  const ghost = chip(el, '@agent:org/nobody-here')
  assert.equal(real.tagName, 'BUTTON', 'the one that exists still navigates')
  assert.equal(ghost.tagName, 'SPAN')
  assert.equal(ghost.getAttribute('data-ref-outcome'), 'absent')
  assert.match(ghost.getAttribute('title') ?? '', /no agent named nobody-here in this org/)
  await inAct(async () => { ghost.click() })
  assert.deepEqual(calls.agent, [], 'and clicking it routes nowhere at all')
})

// ═══════════════════════════════════════════════════════════════════ §6
test('§6 a mail reference reaches the router in the ROUTER\'s vocabulary, '
  + 'not the token\'s', async (t: TestContext) => {
  const { el, calls } = await desk(t, {
    others: [node('peer-one')],
    say: 'that was settled in @mail:org/node/peer-one/abc123',
  })
  await inAct(async () => { chip(el, '@mail:org/node/peer-one/abc123').click() })
  assert.deepEqual(calls.mail, [[{ id: 'abc123', to: 'peer-one' }]],
    'translated by mailRefTarget — the desk writes no second copy of that map')
})

// ═══════════════════════════════════════════════════════════════════ §7
test('§7 CONTROL — slash-command output is left exactly as written',
async (t: TestContext) => {
  const { el } = await desk(t, {
    say: 'and @item:org/slug-identity is the one',
    cmdOut: 'usage report for @item:org/slug-identity',
  })
  assert.equal(q(el, '.cmdout').length, 1,
    'positive control: the command output really rendered')
  assert.equal(q(el, '.cmdout [data-ref-token]').length, 0,
    'quoted machine output is not prose — same rule as a code fence')
  // …and the check is not passing because NOTHING linkified anywhere
  assert.equal(q(el, '.msgtext [data-ref-token]').length, 1,
    'control for the control: the ordinary reply beside it DID linkify')
})

// ═══════════════════════════════════════════════════════════════════ §8
test('§8 the reader\'s own undelivered message carries chips too',
async (t: TestContext) => {
  const { el, calls } = await desk(t, { queued: 'look at @item:org/sort-selector' })
  assert.ok(q(el, '.pendbody').length > 0,
    'positive control: the pending bubble rendered')
  await inAct(async () => { chip(el, '@item:org/sort-selector').click() })
  assert.deepEqual(calls.item, [[{ slug: 'sort-selector' }]])
})

// ⚠ THE BUBBLE HAS TWO CALL SITES, and a mutation run is what proved it: the
// DURABLE pending row above and the optimistic GHOST here are drawn by
// different code, so a check on one leaves the other free to rot. §8 was green
// with the ghost's wiring deleted until this section existed.
test('§8b …and so does the optimistic ghost, which is a second call site',
async (t: TestContext) => {
  const { el, calls, nid } = await desk(t, { say: 'nothing to see here' })
  await inAct(async () => { addPending(SL, nid, 'and @item:org/sort-selector too') })
  assert.ok(q(el, '.pendghost').length > 0,
    'positive control: the ghost bubble rendered at all')
  await inAct(async () => { chip(el, '@item:org/sort-selector').click() })
  assert.deepEqual(calls.item, [[{ slug: 'sort-selector' }]])
})

// ═══════════════════════════════════════════════════════════════════ §9
// THE PERF CLAIM, MEASURED. The desk latches its refs value because `Msg` is
// memoized and the composer's state lives in the same component: an identity
// that changed every render would re-`md()` every row of the transcript on
// every keystroke. A comment asserting that is worth nothing; this is the
// check that fails if the latch is removed.
test('§9 the refs value keeps its identity while the answers are unchanged, '
  + 'and loses it when they change', async (t: TestContext) => {
  useFakeClock()
  const seen: unknown[] = []
  let bump: (() => void) | null = null
  let setAgents: ((m: ReadonlyMap<string, unknown>) => void) | null = null
  // ⚠ ONE ROUTES OBJECT, HOISTED. The desk latches its own (see `deskRoutes`);
  // a fresh literal here would test React's memo, not the desk's contract.
  const routes = { onOpenItem: () => {} }
  function Probe() {
    const [, setTick] = useState(0)
    const [agents, setA] = useState<ReadonlyMap<string, unknown>>(new Map([['a', 1]]))
    bump = () => setTick((n) => n + 1)
    setAgents = setA
    seen.push(useRefRoutes('org', agents, routes))
    return null
  }
  const v = await mountView(<Probe />, (host) => host)
  t.after(async () => { try { await v.unmount() } catch { /* gone */ } ; realClock() })
  await inAct(async () => { bump!() })
  assert.equal(seen.length >= 2, true, 'positive control: it rendered twice')
  assert.equal(seen[0], seen[seen.length - 1],
    'an unrelated render must not hand the transcript a new refs object')
  await inAct(async () => { setAgents!(new Map([['a', 1], ['b', 2]])) })
  assert.notEqual(seen[seen.length - 1], seen[0],
    'control: a real change to who exists DOES produce a new world')
})

// ═══════════════════════════════════════════════════════════════════ §10
// THE MAILBOX PANELS. `MailList` has taken a `refs` prop since the mail-body
// work, but for a while nothing above it forwarded one — the classic present,
// plausible and inert prop: every check of the prop itself passed, and no
// mailbox on screen rendered a single reference. These mount the REAL
// InboxView and the REAL NodeInboxModal and require a chip in the reading
// pane, with a control that the same mount WITHOUT a world renders none.

const INBOX_REF = {
  delivered: [{
    id: 'm1', from: 'peer-one', to: 'me', at: '2026-09-05T09:00:00.000Z',
    kind: 'message', body: 'settled in @item:org/sort-selector', read: true,
  }],
  pending: [], sent: [],
}

function stubInbox() {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const body = String(url).includes('/inbox') ? INBOX_REF : {}
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  }) as unknown as typeof fetch
  return () => { (globalThis as { fetch?: typeof fetch }).fetch = had }
}

const inboxWorld = {
  org: 'org',
  agents: new Map([['peer-one', 'peer-one']]),
  handles: new Set(['item', 'agent', 'doc', 'mail']),
} as unknown as NonNullable<Parameters<typeof InboxView>[0]['refs']>['world']

/** ⚠ THE READING PANE IS WHERE A BODY IS, so a mail must be SELECTED before
 *  there is any prose to carry a reference. Without this the check reports
 *  "no chip" for a reason that has nothing to do with the wiring. */
async function openFirstMail(el: HTMLElement) {
  await flush(); await advance(200, 16); await flush()
  const row = el.querySelector('.mailer-list .mailrow') as HTMLElement | null
  assert.ok(row, 'positive control: the fake inbox produced a mail row at all')
  await inAct(async () => { row!.click() })
  await flush()
}

test('§10 a reference in a mail body is live in the node inbox panel',
async (t: TestContext) => {
  useFakeClock()
  const restore = stubInbox()
  const opened: unknown[][] = []
  const v = await mountView(
    <InboxView slug="org" nid="me" tier={null}
      refs={{ world: inboxWorld, onOpen: (...a: unknown[]) => { opened.push(a) } }} />,
    (host) => host)
  t.after(async () => { try { await v.unmount() } catch { /* gone */ } ; restore(); realClock() })
  await openFirstMail(v.el)
  const c = chip(v.el, '@item:org/sort-selector')
  assert.equal(c.tagName, 'BUTTON')
  await inAct(async () => { c.click() })
  assert.equal(opened.length, 1, 'the chip in a mail body is a real control')
  assert.equal((opened[0][0] as { ref: { id: string } }).ref.id, 'sort-selector')
})

test('§10b CONTROL — the same panel with no world renders the token as text',
async (t: TestContext) => {
  useFakeClock()
  const restore = stubInbox()
  const v = await mountView(<InboxView slug="org" nid="me" tier={null} />, (host) => host)
  t.after(async () => { try { await v.unmount() } catch { /* gone */ } ; restore(); realClock() })
  await openFirstMail(v.el)
  assert.equal(q(v.el, '[data-ref-token]').length, 0,
    'no world ⇒ no chip; the panel judges nothing on its own')
  assert.match(v.el.querySelector('.mailer-read')?.textContent ?? '',
    /@item:org\/sort-selector/, 'and the token is still on screen, as written')
})

test('§10c the node inbox MODAL closes on its way to what a reference names',
async (t: TestContext) => {
  useFakeClock()
  const restore = stubInbox()
  const opened: unknown[][] = []
  let closed = 0
  const v = await mountView(
    <NodeInboxModal node={node('me')} slug="org" jumpTo={null}
      close={() => { closed += 1 }}
      refs={{ world: inboxWorld, onOpen: (...a: unknown[]) => { opened.push(a) } }} />,
    (host) => host)
  t.after(async () => { try { await v.unmount() } catch { /* gone */ } ; restore(); realClock() })
  await openFirstMail(v.el)
  await inAct(async () => { chip(v.el, '@item:org/sort-selector').click() })
  assert.equal(opened.length, 1, 'the route still ran')
  assert.equal(opened[0].length, 1, 'and with exactly one argument')
  assert.equal(closed, 1,
    'everything a token can open lives UNDER this overlay — following one '
    + 'without closing looks like a click that did nothing')
})
