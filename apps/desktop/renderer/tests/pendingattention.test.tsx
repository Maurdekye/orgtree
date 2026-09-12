// pendingattention.test.tsx — the two standing indicators (user ruling
// 2026-09-12): the Windows taskbar pulse and the bright dot on the matching
// in-app toolbar icon, while any attached question, attention ticket or
// urgent mail is still waiting.
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useNativeNotifications } from '../src/notifications'
import type { DesktopNotice } from '../src/notifications'
import { publishPending, resetPending, summarizePending } from '../src/pending-attention'
import { AskBell } from '../src/App'
import { DocketToolbarButton } from '../src/canvas/docket'

const question: DesktopNotice = { id: 'q-1', org: 'orgtree', kind: 'question', source_id: 'qa',
  title: 'Question from state-audit', body: 'Which providers?' }
const urgent: DesktopNotice = { id: 'm-1', org: 'resonite', kind: 'urgent-mail', source_id: 'm1',
  title: 'Message from coordinator', body: 'Now please' }
const attention: DesktopNotice = { id: 'w-1', org: 'unity', kind: 'work-attention', item: 'a-ticket',
  title: 'A ticket', body: 'Confirm the edge case' }
const noise: DesktopNotice[] = [
  { id: 'd-1', org: 'orgtree', kind: 'document', source_id: 'd1', title: 'A document', body: 'Presented' },
  { id: 'r-1', org: 'orgtree', kind: 'routine', source_id: 'r1', title: 'Message', body: 'text' },
  { id: 'f-1', org: 'orgtree', kind: 'agent-frozen', agent: 'someone', generation: 0, title: 'Frozen', body: 'Open it' },
]

test('the aggregate counts only what is waiting on the user, across organizations', () => {
  const all = summarizePending([question, urgent, attention, ...noise])
  assert.equal(all.mail, 2, 'a question and urgent mail both claim the inbox bell')
  assert.equal(all.docket, 1, 'a flagged ticket claims the docket button')
  assert.equal(all.ids.length, 3, 'documents, routine mail and frozen agents are not requests')
  assert.deepEqual(summarizePending(noise), { mail: 0, docket: 0, ids: [] })
  assert.deepEqual(all.ids, [...all.ids].sort(), 'identities are ordered, so an unchanged set compares equal')
})

test('an unchanged aggregate is not an event, and a changed one is', () => {
  resetPending()
  try {
    assert.equal(publishPending(summarizePending([question, attention])), true, 'first report')
    assert.equal(publishPending(summarizePending([attention, question])), false, 'order cannot fake a change')
    assert.equal(publishPending(summarizePending([question])), true, 'one resolving is a change')
    assert.equal(publishPending(summarizePending([])), true, 'emptying is a change')
    assert.equal(publishPending(summarizePending([])), false, 'and staying empty is not')
  } finally { resetPending() }
})

async function poll(rows: DesktopNotice[], prefs: Record<string, boolean>) {
  localStorage.clear(); resetPending(); useFakeClock()
  const original = globalThis.fetch
  const sent: string[][] = []
  let emit: (event: { type: string; data: unknown }) => void = () => {}
  let current = rows
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getPreferences: async () => prefs,
    notify: async () => true,
    syncNotifications: async () => {},
    setPendingAttention: async (ids: string[]) => { sent.push(ids) },
    onEvent: (fn: typeof emit) => { emit = fn; return () => { emit = () => {} } },
  } })
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(), json: async () => ({
    notices: current, total: current.length, truncated: false,
    active: current.map(({ org, id }) => ({ org, id })),
  }) }) as unknown as Response
  function View() { useNativeNotifications(() => {}); return <div>owner</div> }
  const v = await mountView(<View />, el => el)
  const tick = async () => { await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) }) }
  await inAct(async () => { await flush(20) })
  return {
    sent, tick,
    set: (next: DesktopNotice[]) => { current = next },
    async done() {
      await v.unmount(); globalThis.fetch = original
      Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
      resetPending(); realClock()
    },
  }
}

const ALL_ON = { notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true,
  notifyAllMail: false, notifyDocuments: false, notifyFrozen: false, notifyWhileFocused: false }

test('the poll reports what is waiting once, repeats nothing, and clears only when nothing remains', async () => {
  const p = await poll([question, urgent, attention, ...noise], ALL_ON)
  try {
    assert.equal(p.sent.length, 1, 'the first pass reports')
    assert.equal(p.sent[0]!.length, 3)
    await p.tick(); await p.tick(); await p.tick()
    assert.equal(p.sent.length, 1, 'polling the same items again reports nothing, so no pulse restarts')
    p.set([urgent, attention, ...noise]); await p.tick()
    assert.equal(p.sent.length, 2, 'one request resolving is reported')
    assert.equal(p.sent[1]!.length, 2, 'and the other two are still waiting')
    p.set([...noise]); await p.tick()
    assert.deepEqual(p.sent.at(-1), [], 'the indicators clear only once none remain')
  } finally { await p.done() }
})

test('muting a notification category does not pretend the work stopped waiting', async () => {
  const p = await poll([question, urgent, attention, ...noise],
    { ...ALL_ON, notifyQuestions: false, notifyDocketAttention: false })
  try {
    assert.equal(p.sent[0]!.length, 3,
      'the dot and the pulse report what is waiting; preferences decide only what interrupts through the OS')
  } finally { await p.done() }
})

test('the dot appears on the toolbar icon that corresponds to the waiting request', async () => {
  resetPending()
  const tree = { asks_open: 0, urgent_unread: 0, user_inbox_count: 0 }
  const bell = await mountView(<AskBell tree={tree} onOpen={() => {}} />, el => el)
  const docket = await mountView(<DocketToolbarButton summary={{ attention: 0, active: 0 }} />, el => el)
  try {
    assert.equal(bell.el.querySelector('.ask-bell .attn-dot'), null, 'nothing waiting, no dot')
    assert.equal(docket.el.querySelector('.docket-bell .attn-dot'), null)

    await inAct(async () => { publishPending(summarizePending([attention])) })
    assert.equal(bell.el.querySelector('.ask-bell .attn-dot'), null, 'a ticket is not mail')
    assert.ok(docket.el.querySelector('.docket-bell .attn-dot'), 'a flagged ticket dots the docket button')

    await inAct(async () => { publishPending(summarizePending([attention, question])) })
    assert.ok(bell.el.querySelector('.ask-bell .attn-dot'), 'a question dots the inbox bell')
    assert.ok(docket.el.querySelector('.docket-bell .attn-dot'), 'without disturbing the docket dot')

    await inAct(async () => { publishPending(summarizePending([question])) })
    assert.ok(bell.el.querySelector('.ask-bell .attn-dot'))
    assert.equal(docket.el.querySelector('.docket-bell .attn-dot'), null,
      'the ticket resolving clears its dot and only its dot')

    await inAct(async () => { publishPending(summarizePending([urgent])) })
    assert.ok(bell.el.querySelector('.ask-bell .attn-dot'), 'urgent mail keeps the inbox dot standing')

    await inAct(async () => { publishPending(summarizePending([])) })
    assert.equal(bell.el.querySelector('.ask-bell .attn-dot'), null, 'both clear when none remain')
    assert.equal(docket.el.querySelector('.docket-bell .attn-dot'), null)
  } finally { await bell.unmount(); await docket.unmount(); resetPending() }
})

test('the dot is not the only way to learn it is there', async () => {
  // The mark is aria-hidden, so whatever it claims has to be claimed in words
  // as well, or the indicator exists for sighted users only.
  resetPending()
  const tree = { asks_open: 0, urgent_unread: 0, user_inbox_count: 0 }
  const bell = await mountView(<AskBell tree={tree} onOpen={() => {}} />, el => el)
  const docket = await mountView(<DocketToolbarButton summary={{ attention: 0, active: 0 }} />, el => el)
  const title = (v: typeof bell, sel: string) => v.el.querySelector<HTMLElement>(sel)!.title
  try {
    assert.equal(title(bell, 'button.ask-bell'), 'your inbox')
    assert.equal(title(docket, 'button.docket-bell'), 'work docket')

    await inAct(async () => { publishPending(summarizePending([question, urgent, attention])) })
    assert.match(title(bell, 'button.ask-bell'), /2 request\(s\) still waiting on you/)
    assert.match(title(docket, 'button.docket-bell'), /1 ticket\(s\) still waiting on you/)

    await inAct(async () => { publishPending(summarizePending([])) })
    assert.equal(title(bell, 'button.ask-bell'), 'your inbox', 'and it stops saying so when nothing remains')
    assert.equal(title(docket, 'button.docket-bell'), 'work docket')
  } finally { await bell.unmount(); await docket.unmount(); resetPending() }
})

test('the dot survives a desktop with no native attention bridge at all', async () => {
  resetPending()
  const docket = await mountView(<DocketToolbarButton summary={{ attention: 3, active: 9 }} />, el => el)
  try {
    const button = docket.el.querySelector('button.docket-bell') as HTMLButtonElement
    assert.ok(button.classList.contains('glow'), 'the open org\'s own attention still glows on its own')
    assert.equal(docket.el.querySelector('.attn-dot'), null,
      'and the cross-organization dot stays silent until something reports it')
  } finally { await docket.unmount() }
})
