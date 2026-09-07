// sysnotice.test.tsx — SYSTEM notices render as a short row (user, 2026-08-28).
//
//   "they should also be much narrower in height to deemphasize their
//    presence in the mailbox."
//   "but only system notices should be given this narrower height adjustment."
//
// ⚠ TWO PREDICATES, DELIBERATELY DIFFERENT, AND THIS FILE OWNS THE NARROWER
// ONE. Read-on-arrival applies to EVERY notice whatever its source and is
// enforced server-side (backend/tests/test_notice_read.py). The short row
// applies to SYSTEM notices only — `kind === 'notice'` AND
// `from === '@system'`. An agent's notice keeps full height, and in a node
// mailbox agent-to-agent notices are the ordinary traffic, so this is not a
// hypothetical distinction. §2 is the leg that fails if the two predicates
// are ever collapsed into one test.
//
// ⚠ WHAT jsdom CAN AND CANNOT PROVE HERE. jsdom does no layout, so "much
// narrower" is not measurable as a pixel height — the stylesheet is not even
// applied. What IS checkable, and what actually causes the height, is the
// STRUCTURE: the preview line (`.l2`) is what makes a row two lines tall, so
// the rule drops it and halves the padding. These tests assert the class that
// selects for the padding and the absence of the preview line, which
// mail.tsx does not render for these rows. The pixel result
// is verified by a human on a live mailbox, as with everything visual.
//
// ANTI-VACUITY: every leg that asserts an absence is paired with a fixture
// where the same selector is PRESENT, so a typo'd selector cannot pass by
// matching nothing at all.
//
// Run:  cd frontend && node tests/run.mjs sysnotice

import { mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM } from '../src/canvas/shared'
import type { MailRow } from '../src/canvas/shared'
import { MailList } from '../src/canvas/mail'

// No fake clock: nothing here reads the time — the row's timestamp is a
// slice of the fixture's own ISO string, not a duration. (urgentpip.test.tsx
// does borrow the clock, because `ago()` genuinely depends on it.)
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

const row = (over: Partial<MailRow> = {}): MailRow => ({
  id: 'm1', from: 'alpha', kind: 'message', body: 'the body text',
  at: '2026-08-28T10:00:00Z', ...over,
} as MailRow)

const sysNotice = (id = 's1') =>
  row({ id, from: SYSTEM, kind: 'notice', body: 'a turn failed in a sandbox' })
const agentNotice = (id = 'a1') =>
  row({ id, from: 'alpha', kind: 'notice', body: 'fyi, the build is green' })

uiTest('§1 a system notice gets the short-row class, and loses its preview line',
  async (mount) => {
    const el = await mount(<MailList delivered={[sysNotice()]} />)
    const r = el.querySelector('.mailrow')!
    assert.ok(r.classList.contains('sysnotice'),
      'the row must carry the class the short-row rule selects on')
    // it is still a NOTICE — the quiet dashed edge is not replaced, only
    // added to. Losing that would make a system notice look like plain mail.
    assert.ok(r.classList.contains('notice'),
      'the shorter row is a notice FIRST — it keeps the notice treatment')
    // the preview line is the whole height, and it is not RENDERED for
    // these rows — see mail.tsx. (It was CSS `display:none` first, which is
    // why the assertion below is worded as it is: a hidden node is still in
    // the DOM and this leg failed until the component stopped building it.)
    // ⚠ assert.ok(!node), never assert.equal(node, null): when this leg
    // FAILS, assert.equal formats a diff of a jsdom Element, whose parent
    // chain reaches the whole document — that allocation killed the runner
    // with "Array buffer allocation failed" and hid the real failure behind
    // a 90-second hang. A boolean formats in constant space.
    assert.ok(!r.querySelector('.l2'),
      'the preview line is not rendered — that is where the height went')
    // …but the row is still identifiable and still selectable: the header
    // line stays. "Folded, not hidden" is the property.
    assert.ok(r.querySelector('.l1'), 'the header line stays')
    assert.match(r.querySelector('.l1')!.textContent ?? '', /@system/)
  })

uiTest('§2 an AGENT notice is NOT shortened — the predicates are different',
  async (mount) => {
    const el = await mount(<MailList delivered={[agentNotice()]} />)
    const r = el.querySelector('.mailrow')!
    assert.ok(!r.classList.contains('sysnotice'),
      'only the MACHINE\'s notices shrink; an agent\'s keeps full height')
    // it is still a notice, and it still has its preview line — which is the
    // ANTI-VACUITY pair for §1: the selector does find `.l2` when one is
    // built, so §1's absence means "not built for THIS row", not "this
    // component never builds one"
    assert.ok(r.classList.contains('notice'), 'still a notice')
    assert.ok(r.querySelector('.l2'), 'an agent notice keeps its preview line')
    assert.match(r.querySelector('.l2')!.textContent ?? '', /build is green/)
  })

uiTest('§3 ordinary mail is untouched by either rule', async (mount) => {
  const el = await mount(<MailList delivered={[row()]} />)
  const r = el.querySelector('.mailrow')!
  assert.ok(!r.classList.contains('sysnotice'))
  assert.ok(!r.classList.contains('notice'))
  assert.ok(r.querySelector('.l2'), 'ordinary mail keeps its preview')
})

uiTest('§4 a system MESSAGE is not shortened — the KIND is half the test',
  async (mount) => {
    // The near-miss in the other direction from §2: same sender, different
    // kind. The ledger really does send the user `decision` mail from
    // @system (a Fable limit exhausted, agents dissolved), and that must read
    // as full mail, not as chatter to be skimmed past.
    const el = await mount(<MailList delivered={[
      row({ id: 'd1', from: SYSTEM, kind: 'decision',
        body: 'Weekly Fable usage limit exhausted — agents halted' }),
    ]} />)
    const r = el.querySelector('.mailrow')!
    assert.ok(!r.classList.contains('sysnotice'),
      'a @system DECISION is not a notice and must not be de-emphasised')
    assert.ok(r.querySelector('.l2'), 'it keeps its preview line')
  })

uiTest('§5 mixed list: exactly the system notices shrink, and no others',
  async (mount) => {
    // The whole rule at once, in the shape the user actually sees. A
    // renderer that stamped every row, or every notice, fails here.
    const el = await mount(<MailList delivered={[
      row({ id: 'p1' }),
      agentNotice('a1'),
      sysNotice('s1'),
      row({ id: 'd1', from: SYSTEM, kind: 'decision', body: 'agents halted' }),
      sysNotice('s2'),
    ]} />)
    assert.equal(el.querySelectorAll('.mailrow').length, 5, 'fixture: 5 rows')
    assert.equal(el.querySelectorAll('.mailrow.sysnotice').length, 2,
      'exactly the two system notices shrink')
    assert.equal(el.querySelectorAll('.mailrow.notice').length, 3,
      'three notices in total — the agent one is still a notice')
    // …and the short ones are precisely the two we meant
    const short = [...el.querySelectorAll('.mailrow.sysnotice .l1')]
      .map((x) => x.textContent)
    assert.equal(short.length, 2)
    for (const s of short) assert.match(s ?? '', /@system/)
  })
