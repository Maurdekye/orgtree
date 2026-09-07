// syspile.test.tsx — consecutive SYSTEM notices fold into one row, and open
// as a list (user, 2026-08-28):
//
//   "if there are multiple consecutive system notices in a row, collapse them
//    all into a single mail entry, and then display them in a list in the full
//    mail view to the right, kind of like how notices are already collapsed
//    and collated into the next turn for an agent"
//
// D-173 extended, not replaced. sysnotice.test.tsx owns the SHORT ROW; this
// file owns the FOLD. They share one predicate — `shared.isSystemNotice` —
// and §4/§5 here are the legs that fail if anyone widens it.
//
// ⚠ THE SAFETY PROPERTY, AND WHY MOST OF THIS FILE IS ABOUT NOT FOLDING.
// A row that says "3 notices" is a claim about what is inside it. `@system`
// also sends the user `kind: "decision"` mail — a Fable limit exhausted,
// agents halted, subtrees dissolved — and sweeping one of those into a pile
// would hide real mail behind a label that says it is chatter. That is
// strictly worse than the wrong-height failure D-173 was careful about: a
// wrong height is cosmetic, a wrong fold BURIES. So §3, §4, §5 and §6 are
// all "this did NOT fold", and §1/§2 are the happy path.
//
// ANTI-VACUITY: every leg that counts rows also asserts what the rows SAY,
// so a selector that matches nothing cannot pass by returning zero.
//
// Run:  cd frontend && node tests/run.mjs syspile

import { mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { isSystemNotice, pileNotices, SYSTEM } from '../src/canvas/shared'
import type { MailRow } from '../src/canvas/shared'
import { MailList } from '../src/canvas/mail'

function uiTest(name: string, body: (mount: (el: React.ReactElement)
  => Promise<HTMLElement>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
    })
    await body(async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    })
  })
}

// ⚠ DISTINCT `at` PER ROW, DESCENDING. MailList sorts by send time, so a
// fixture with one shared timestamp would be ordering by sort stability and
// these tests would be asserting on an implementation detail of Array.sort.
// Minute N = the Nth row from the top.
const at = (n: number) => `2026-08-28T1${9 - n}:00:00Z`
const row = (n: number, over: Partial<MailRow> = {}): MailRow => ({
  id: 'm' + n, from: 'alpha', kind: 'message', body: 'ordinary mail ' + n,
  at: at(n), ...over,
} as MailRow)
const sys = (n: number, body = 'system notice ' + n): MailRow =>
  row(n, { id: 's' + n, from: SYSTEM, kind: 'notice', body })
const decision = (n: number): MailRow =>
  row(n, { id: 'd' + n, from: SYSTEM, kind: 'decision',
    body: 'Weekly Fable usage limit exhausted — agents halted' })
const agentNotice = (n: number): MailRow =>
  row(n, { id: 'a' + n, from: 'beta', kind: 'notice', body: 'build is green' })

const rowsOf = (el: HTMLElement) => [...el.querySelectorAll('.mailrow')]
const chip = (r: Element) => r.querySelector('.noticekind')?.textContent ?? ''

// ─────────────────────────────────────────── the pure rule, on its own
// pileNotices is a plain function over rows, so the RULE is testable without
// a DOM. The mount tests below prove the component actually uses it.

test('§0 pileNotices: adjacency and nothing else', () => {
  const runs = (rs: MailRow[]) => pileNotices(rs).map((g) => g.length)
  assert.deepEqual(runs([sys(1), sys(2), sys(3)]), [3],
    'three in a row are one entry')
  assert.deepEqual(runs([sys(1), row(2), sys(3)]), [1, 1, 1],
    'ordinary mail between them breaks the run')
  assert.deepEqual(runs([sys(1), sys(2), row(3), sys(4), sys(5), sys(6)]),
    [2, 1, 3], 'two runs, and the mail between them stands alone')
  assert.deepEqual(runs([row(1), row(2)]), [1, 1],
    'ordinary mail never folds into anything')
  assert.deepEqual(runs([]), [], 'nothing folds to nothing')
  // NO TIME BOUND — the two below are a year apart and still one entry
  const far = [
    { ...sys(1), at: '2027-01-01T00:00:00Z' },
    { ...sys(2), at: '2026-01-01T00:00:00Z' },
  ]
  assert.deepEqual(runs(far), [2],
    'consecutive means adjacent, not recent — a gap does not break a run')
  // and the fold preserves order and membership: nothing is dropped
  const rs = [sys(1), sys(2), row(3)]
  assert.deepEqual(pileNotices(rs).flat().map((m) => m.id), ['s1', 's2', 'm3'])
})

test('§0b pileNotices: a READ ordinary mail breaks a run just the same', () => {
  // the open question the coordinator raised: does read state matter? It does
  // not — the rule is position. A read mail is still a mail between them.
  const read = { ...row(2) }             // no `_wait` == delivered/read
  assert.deepEqual(pileNotices([sys(1), read, sys(3)]).map((g) => g.length),
    [1, 1, 1])
})

test('§0c isSystemNotice is the ONE predicate, and it is narrow', () => {
  assert.ok(isSystemNotice(sys(1)))
  assert.ok(!isSystemNotice(decision(1)), '@system DECISION is not a notice')
  assert.ok(!isSystemNotice(agentNotice(1)), "an AGENT's notice is not the machine's")
  assert.ok(!isSystemNotice(row(1)), 'ordinary mail is neither')
  assert.ok(!isSystemNotice({ ...sys(1), _ask: { status: 'open' } } as MailRow),
    'an ask riding the inbox is never swept up')
})

// ─────────────────────────────────────────── the rendering
uiTest('§1 three consecutive system notices are ONE row that says so',
  async (mount) => {
    const el = await mount(<MailList
      delivered={[sys(1, 'alpha stopped: its turn failed'),
        sys(2, 'beta is stuck'), sys(3, 'storage migrated')]} />)
    const rs = rowsOf(el)
    assert.equal(rs.length, 1, 'three notices, one row')
    const r = rs[0]!
    assert.ok(r.classList.contains('notepile'), 'it is marked as a folded run')
    // …and it is still the D-173 short system row underneath — this reads as
    // more of the same, not as a new kind of thing
    assert.ok(r.classList.contains('sysnotice'), 'still the one-line system row')
    assert.ok(r.classList.contains('notice'), 'still a notice')
    assert.ok(!r.querySelector('.l2'), 'still no preview line — still one line')
    // THE COUNT. This is the sentence the user approves.
    assert.equal(chip(r), '3 notices')
    assert.match(r.querySelector('.l1')!.textContent ?? '', /@system/)
  })

uiTest('§2 opening it lists EVERY notice it folded, oldest first',
  async (mount) => {
    const el = await mount(<MailList
      delivered={[sys(1, 'newest thing'), sys(2, 'middle thing'),
        sys(3, 'oldest thing')]} />)
    const r = rowsOf(el)[0]!
    ;(r as HTMLElement).click()
    await new Promise((res) => setTimeout(res, 0))
    const list = el.querySelector('.mailer-body.notepile')
    assert.ok(list, 'the reading pane renders the list, not one body')
    const items = [...list!.querySelectorAll('.notepile-row')]
    assert.equal(items.length, 3, 'one line per folded notice — none elided')
    const texts = items.map((x) => x.textContent ?? '')
    // ⚠ CHRONOLOGICAL, like the [ORG NOTICES] block an agent gets. The list
    // on the left is newest-first; this is a different axis and reads forward.
    assert.match(texts[0]!, /oldest thing/)
    assert.match(texts[1]!, /middle thing/)
    assert.match(texts[2]!, /newest thing/)
    // each line carries its own time — the fold must not flatten three
    // moments into the head's single timestamp
    for (const it of items) {
      assert.match(it.querySelector('.notepile-at')?.textContent ?? '',
        /\d\d-\d\d \d\d:\d\d/)
    }
    // and the head says how many, so the pane is self-describing
    assert.match(el.querySelector('.mailer-head')?.textContent ?? '',
      /3 notices/)
  })

uiTest('§3 a @system DECISION breaks the run and is NEVER folded in',
  async (mount) => {
    // THE LEG THAT MATTERS. Same sender, different kind. If this ever folds,
    // "agents halted" is hiding inside a row labelled as chatter.
    const el = await mount(<MailList
      delivered={[sys(1), decision(2), sys(3)]} />)
    const rs = rowsOf(el)
    assert.equal(rs.length, 3, 'a decision between them is a wall, not a member')
    assert.equal(chip(rs[0]!), 'notice', 'the run above it is a run of one')
    assert.equal(chip(rs[2]!), 'notice', 'and so is the run below')
    // the decision is full mail: its own row, its own preview, no fold class
    const d = rs[1]!
    assert.ok(!d.classList.contains('notepile'))
    assert.ok(!d.classList.contains('sysnotice'))
    assert.match(d.querySelector('.l2')?.textContent ?? '', /agents halted/,
      'and its text is on screen without a click')
  })

uiTest('§4 an AGENT notice does not join a system run', async (mount) => {
    // the near-miss on the SENDER half of the predicate
    const el = await mount(<MailList
      delivered={[sys(1), agentNotice(2), sys(3)]} />)
    const rs = rowsOf(el)
    assert.equal(rs.length, 3, 'the agent notice is not a member')
    assert.ok(!rs[1]!.classList.contains('notepile'))
    assert.ok(rs[1]!.querySelector('.l2'), 'and it keeps its full height')
  })

uiTest('§5 a lone system notice is EXACTLY what it was before', async (mount) => {
    // the anti-regression pair for §1: nothing about a single notice changes
    const el = await mount(<MailList delivered={[sys(1), row(2), sys(3)]} />)
    const rs = rowsOf(el)
    assert.equal(rs.length, 3)
    for (const i of [0, 2]) {
      assert.ok(!rs[i]!.classList.contains('notepile'), 'no fold class')
      assert.equal(chip(rs[i]!), 'notice', 'the chip still reads exactly "notice"')
    }
    // …and it still opens as one body, not as a one-item list
    ;(rs[0] as HTMLElement).click()
    await new Promise((res) => setTimeout(res, 0))
    assert.ok(!el.querySelector('.mailer-body.notepile'),
      'a run of one opens the ordinary way')
    assert.match(el.querySelector('.mailer-body')?.textContent ?? '',
      /system notice 1/)
  })

uiTest('§6 a notice still AWAITING delivery is not folded away',
  async (mount) => {
    // a waiting row carries an unread mark and (in a node mailbox) a retract
    // button — actions. Burying an action inside a summary is the failure.
    const el = await mount(<MailList
      pending={[sys(1)]} delivered={[sys(2), sys(3)]} />)
    const rs = rowsOf(el)
    assert.equal(rs.length, 2, 'the pending one stands alone; the two read fold')
    assert.ok(rs[0]!.classList.contains('unread'), 'and it keeps its unread mark')
    assert.equal(chip(rs[0]!), 'notice')
    assert.equal(chip(rs[1]!), '2 notices')
  })

uiTest('§6b …and not folded INTO a run either — both ends are guarded',
  async (mount) => {
    // ⚠ THIS LEG EXISTS BECAUSE A MUTATION SURVIVED §6 (tests/syspile_mutate.py
    // M5). Two clauses keep a waiting row out of a run and they guard opposite
    // ends: `foldable` stops a waiting row JOINING one, `!run[0]!._wait` stops
    // a run FORMING on top of one. §6 only ever exercised the second — the
    // pending row was newest, so it was always the head. Here it is in the
    // MIDDLE, which is reachable whenever an undelivered mail is older than a
    // delivered one, and it is the only shape that tests the first clause.
    const el = await mount(<MailList
      pending={[sys(2)]} delivered={[sys(1), sys(3)]} />)
    const rs = rowsOf(el)
    assert.equal(rs.length, 3, 'a waiting row is a wall on both sides of itself')
    assert.ok(rs[1]!.classList.contains('unread'), 'fixture: the middle one waits')
    for (const r of rs) assert.equal(chip(r), 'notice', 'nothing folded at all')
  })

uiTest('§7 the fold is DISPLAY only — the list still holds every entry',
  async (mount) => {
    // filtering reaches the folded members, which it could not do if the
    // fold had replaced them with one synthetic row
    const el = await mount(<MailList delivered={[
      sys(1, 'aardvark migrated'), sys(2, 'beta is stuck'),
      sys(3, 'gamma is stuck'), sys(4, 'delta is stuck'),
      row(5), row(6),
    ]} />)
    assert.equal(rowsOf(el).length, 3, 'four notices fold to one, plus two mails')
    const filter = el.querySelector('.mail-filter') as HTMLInputElement
    assert.ok(filter, 'fixture: enough rows for the filter to appear')
    // harness note: React's onChange listens for `input` and reads the value
    // through its own tracker, so a plain `filter.value = …` is ignored — the
    // NATIVE setter has to run. `HTMLInputElement` is not a global here
    // (harness.ts installs jsdom's document, not its whole window onto
    // globalThis), so the prototype comes off the element itself.
    const set = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(filter), 'value')!.set!
    set.call(filter, 'aardvark')
    filter.dispatchEvent(
      new filter.ownerDocument.defaultView!.Event('input', { bubbles: true }))
    await new Promise((res) => setTimeout(res, 0))
    const rs = rowsOf(el)
    assert.equal(rs.length, 1, 'the folded member is still a findable entry')
    assert.equal(chip(rs[0]!), 'notice', 'and on its own it is a run of one')
  })
