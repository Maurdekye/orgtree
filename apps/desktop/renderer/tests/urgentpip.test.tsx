// urgentpip.test.tsx — D-169: urgent mail raises the pulse and the count, and
// reads as urgent in the mailbox.
//
// An agent may tag user-bound mail urgent; the user's inbox then pulses the
// way it does for an unanswered question, until the mail is read. The server
// half (the gate, the pair, the count falling to zero on the read event) is
// backend/tests/test_urgent_mail.py. This file owns the two client-side
// halves: the pip RULE, and the mailbox ROW.
//
// ⚠ WHY THE RULE IS A FUNCTION AND WHAT THAT BUYS THE TEST. The two-tier pip
// (`asks > 0 ? asks : unread`) was written out by hand at FOUR sites — the
// header ask-bell, UserNode's pip, EyeDesk's pip and the compact map eye —
// and they had ALREADY drifted: the bell's tooltip named the unread count
// beside the asks, EyeDesk's said only "your inbox". Threading a third input
// through four copies is how one of them ends up wrong, which is the shape
// that produced the freeze-label bug. `attentionPip` is now the only place
// the rule exists, so §1-§4 test all four surfaces at once by testing it.
// Two of the four no longer compute anything at all — UserNode and EyeDesk
// take the decided pip as a required prop — so for those the guarantee is
// structural rather than tested, which is stronger. §5 renders UserNode to
// prove the prop actually reaches the DOM class that carries the animation.
//
// ⚠ ANTI-VACUITY. §4 pins the ZERO EDGE in the direction that would otherwise
// pass silently: an inbox with ordinary unread mail and nothing urgent must
// show its count WITHOUT the pulsing class. A rule that returned `urgent:
// true` unconditionally would satisfy every "it pulses" assertion in this
// file, and §4 is what refuses it. §7 does the same for the row.
//
// Run:  cd frontend && node tests/run.mjs urgentpip

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { attentionPip } from '../src/canvas/shared'
import type { MailRow, OpFn } from '../src/canvas/shared'
import { MailList } from '../src/canvas/mail'
import { UserNode } from '../src/canvas/cards'

// ===================================================== §1-§4  THE PIP RULE

test('§1 urgent mail joins open asks in the ATTENTION count, and pulses', () => {
  // one urgent mail alone, in an inbox of 5 unread: the pip shows the URGENT
  // count (1), not the unread count (5), and wears the pulsing tier.
  const p = attentionPip({ asks_open: 0, urgent_unread: 1, user_inbox_count: 5 })
  assert.deepEqual({ count: p?.count, urgent: p?.urgent }, { count: 1, urgent: true })
  // asks and urgent mail ADD — they are separate populations (an ask is not a
  // mail), so a user with one of each is being asked for two things.
  const both = attentionPip({ asks_open: 2, urgent_unread: 1, user_inbox_count: 9 })
  assert.deepEqual({ count: both?.count, urgent: both?.urgent },
    { count: 3, urgent: true })
  // asks alone still behave exactly as before this feature existed
  const asks = attentionPip({ asks_open: 2, urgent_unread: 0, user_inbox_count: 9 })
  assert.deepEqual({ count: asks?.count, urgent: asks?.urgent },
    { count: 2, urgent: true })
})

test('§2 the count OVERRIDES the ordinary unread number — it never adds to it', () => {
  // 1 urgent inside 5 unread reads "1", not "6". urgent_unread is a SUBSET of
  // user_inbox_count (both count entries still sitting in user_inbox), so
  // adding them would double-count the same mail.
  assert.equal(attentionPip({ urgent_unread: 1, user_inbox_count: 5 })?.count, 1)
  // the degenerate case the subset relation makes possible: every unread mail
  // is urgent. Still 3, not 6.
  assert.equal(attentionPip({ urgent_unread: 3, user_inbox_count: 3 })?.count, 3)
})

test('§3 nothing waiting → no pip at all', () => {
  assert.equal(attentionPip({ asks_open: 0, urgent_unread: 0, user_inbox_count: 0 }), null)
  // …and absent fields are not a crash and not a phantom pip. The payload
  // omits urgent_unread entirely on an older backend.
  assert.equal(attentionPip({}), null)
  assert.equal(attentionPip({ user_inbox_count: 0 }), null)
})

test('§4 THE ZERO EDGE: ordinary unread falls back to the quiet count', () => {
  // The edge the spec did not settle. Nothing urgent, no ask open, but mail
  // is unread: show the plain count, do NOT pulse.
  const p = attentionPip({ asks_open: 0, urgent_unread: 0, user_inbox_count: 12 })
  assert.deepEqual({ count: p?.count, urgent: p?.urgent }, { count: 12, urgent: false })
  // an older payload with no urgent_unread key must take this branch too,
  // rather than reading `undefined` as something waiting
  const legacy = attentionPip({ asks_open: 0, user_inbox_count: 12 })
  assert.deepEqual({ count: legacy?.count, urgent: legacy?.urgent },
    { count: 12, urgent: false })
  // the three tiers must be DISTINGUISHABLE — a rule that answered
  // `urgent: true` for everything is total and useless
  const tiers = [
    attentionPip({ user_inbox_count: 12 })!.urgent,          // quiet
    attentionPip({ urgent_unread: 1, user_inbox_count: 12 })!.urgent,  // loud
  ]
  assert.deepEqual(tiers, [false, true])
})

test('§5 the tooltip names each thing waiting, without inventing a total', () => {
  const t = (o: Parameters<typeof attentionPip>[0]) => attentionPip(o)?.title
  assert.match(t({ urgent_unread: 1, user_inbox_count: 4 })!, /1 urgent mail/)
  // both populations named, neither summed into a sentence that claims more
  const both = t({ asks_open: 2, urgent_unread: 1, user_inbox_count: 4 })!
  assert.match(both, /2 asks waiting on your answer/)
  assert.match(both, /1 urgent mail/)
  assert.match(both, /4 unread/)
  assert.doesNotMatch(both, /7 unread/, 'the counts must not be added together')
  // the quiet tier says only what is true of it
  assert.equal(t({ user_inbox_count: 4 }), '4 unread')
  // singular/plural is not mangled on the ask leg (pre-existing wording kept)
  assert.match(t({ asks_open: 1 })!, /1 ask waiting/)
})

// ======================================================= §6-§9  THE RENDER

function uiTest(name: string, body: (mount: (el: React.ReactElement)
  => Promise<HTMLElement>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body(async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    })
  })
}

const noop = () => {}
const userNode = (pip: ReturnType<typeof attentionPip>) => (
  <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }}
    pip={pip} seats={{ opus: 5 }} kiosk={undefined} pub={false}
    kioskRemaining={null} pxc={1} zoom={1} onSpawn={noop}
    onMailLink={noop} focused={false} eyeW={124} posX={() => 0}
    map={new Map()} op={(() => Promise.resolve({})) as unknown as OpFn}
    slug="org" toast={noop} />
)

uiTest('§6 the pip prop reaches the DOM, pulsing class and all', async (mount) => {
  // the ATTENTION tier wears `.asks` — the class that carries the askpip
  // animation and is the EXISTING question signal, not a second one built to
  // look like it
  const loud = await mount(userNode(attentionPip({ urgent_unread: 2, user_inbox_count: 6 })))
  const badge = loud.querySelector('.eye-inbox .count')
  assert.equal(badge?.textContent, '2')
  assert.ok(badge?.classList.contains('asks'),
    'urgent mail must drive the same pulsing class an open ask does')

  // …and the quiet tier does NOT, which is the leg that fails if the rule
  // ever returns urgent:true unconditionally
  const quiet = await mount(userNode(attentionPip({ user_inbox_count: 6 })))
  const qb = quiet.querySelector('.eye-inbox .count')
  assert.equal(qb?.textContent, '6')
  assert.ok(!qb?.classList.contains('asks'), 'ordinary unread mail must not pulse')

  // nothing waiting → no badge element at all (not an empty one)
  const none = await mount(userNode(attentionPip({})))
  assert.equal(none.querySelector('.eye-inbox .count'), null)
})

const row = (over: Partial<MailRow> = {}): MailRow => ({
  id: 'm1', from: 'alpha', kind: 'message', body: 'the body',
  at: '2026-08-27T10:00:00Z', ...over,
} as MailRow)

uiTest('§7 an urgent mail reads as urgent in the list', async (mount) => {
  const el = await mount(<MailList delivered={[
    row({ id: 'u', urgent: true, urgent_reason: 'the deploy is wedged' }),
  ]} />)
  const r = el.querySelector('.mailrow')!
  assert.ok(r.classList.contains('urgent'), 'the row wears the urgent class')
  const chip = r.querySelector('.urgentkind')
  assert.equal(chip?.textContent, 'urgent')
  // the reason rides the chip so it is reachable without opening the mail —
  // the whole point of requiring one is that the user can judge the claim
  assert.equal(chip?.getAttribute('title'), 'urgent — the deploy is wedged')
  // ⚠ THE ROW MUST NOT PULSE. The user asked the INBOX to pulse and the row
  // to be pronounced; two pulsing rows would read as an alarm. `.asks` is the
  // pulsing class, and it has no business on a mail row.
  assert.ok(!r.classList.contains('asks'), 'the row must not wear the pulse class')
})

uiTest('§8 …and ordinary mail is untouched by any of it', async (mount) => {
  // ANTI-VACUITY in the other direction: three rows, ONE of them urgent. A
  // renderer that stamped every row would pass §7 and fail here.
  const el = await mount(<MailList delivered={[
    row({ id: 'a' }),
    row({ id: 'b', kind: 'notice' }),
    row({ id: 'c', urgent: true, urgent_reason: 'why' }),
  ]} />)
  const rows = [...el.querySelectorAll('.mailrow')]
  assert.equal(rows.length, 3, 'fixture: three rows rendered')
  assert.equal(el.querySelectorAll('.mailrow.urgent').length, 1,
    'exactly one row is urgent')
  assert.equal(el.querySelectorAll('.urgentkind').length, 1,
    'exactly one urgent chip across three rows')
  // the notice keeps its own quieter treatment rather than being overwritten
  assert.equal(el.querySelectorAll('.mailrow.notice').length, 1)
})

uiTest('§9 opening it shows the reason, in the sender\'s words', async (mount) => {
  const el = await mount(<MailList delivered={[
    row({ id: 'u', urgent: true, urgent_reason: 'prod has been down 20m' }),
  ]} />)
  await flush()
  await inAct(() => { (el.querySelector('.mailrow') as HTMLElement).click() })
  await flush()
  assert.equal(el.querySelector('.urgent-why')?.textContent,
    'prod has been down 20m')
  // the head carries the chip too, so the reading pane says WHY it interrupted
  assert.ok(el.querySelector('.mailer-head .urgentkind'),
    'the reading pane marks it urgent as well as the list')

  // and an ordinary mail's reading pane has neither
  const plain = await mount(<MailList delivered={[row({ id: 'p' })]} />)
  await flush()
  await inAct(() => { (plain.querySelector('.mailrow') as HTMLElement).click() })
  await flush()
  assert.equal(plain.querySelector('.urgent-why'), null)
  assert.equal(plain.querySelector('.mailer-head .urgentkind'), null)
})
