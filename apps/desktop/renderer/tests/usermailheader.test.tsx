// usermailheader.test.tsx — the Mail tab's "Join mail queue" control lives in
// the desk header, beside the pin / pop-out / modal buttons (docket
// slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20 16:39Z:
// "move this button in the same way. make the text variable: with a value of 1,
// make it say "Join mail queue". with a value of 2, say "Join mail queue
// twice". 3, "Join mail queue 3 times" ... it can be changed after and pressed
// again to update the batch size").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the label: 1 "Join mail queue", 2 "Join mail queue twice", from 3 up
//      "Join mail queue N times"
//   §2 outside the queue: a number input (default 1, 1 to the engine's batch
//      limit of 20) and the button; a click joins at once (user_queue_join with
//      the batch), no dialog
//   §3 inside the queue: the input shows the user's batch; the button is grey
//      until the number differs, and a click sends the same op, which updates
//      the batch in place (the engine keeps the place and a held job)
//   §4 a count that is not a whole number holds nothing; one outside 1..20 is
//      brought into it
//   §5 no control on a retired project; nothing in it says "you"
//   §7 the old dialog's help text is the control's tooltip: jobs arrive as normal
//      mail in the inbox; ack mode says to acknowledge each, round-robin says no
//      acknowledgement is needed (USER 16:43Z: "keep the helptext in the hover
//      tooltips")
//   §6 the inbox's folder strip carries the control on every folder, after the
//      folder buttons (the corner's pin / pop-out / modal buttons sit at the
//      strip's right end): the Mail tab's one header row
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usermailheader

import { withoutMailTransfers } from './mailtransfers.fixture'
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { MailQueueJoin, mailQueueJoinLabel } from '../src/canvas/mailqueuejoin'
import { InboxView } from '../src/canvas/mail'
import { mailListenerState } from '../src/canvas/listeners'
import { CurrentOrg } from '../src/popout'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = () => {}
const node = (extra: Record<string, unknown> = {}) =>
  ({ id: 'jobs', kind: 'project', tier: 'project', state: 'live', children: [], configured_scope: { mail_queue: 'ack' }, ...extra }) as unknown as CanvasNode
const dog = (owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind: 'fair_queue', target: 'jobs', interval_s: 5, state: 'armed',
    at: '2026-10-20T07:00:00.000Z', fired: 0, once: false, spent: false, batch: 1, ...extra } as Watchdog)
const devDog = dog('dev', 'jobs-queue')
const mine = (batch: number) => dog('user', 'u9abc', { name: 'user-queue', batch })

const setInput = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const control = (root: ParentNode) => ({
  group: root.querySelector<HTMLElement>('.queue-join'),
  input: root.querySelector<HTMLInputElement>('.queue-join input[type="number"]'),
  button: root.querySelector<HTMLButtonElement>('.queue-join [data-action="join-queue"]'),
})
function view(dogs: Watchdog[], requests: OpRequest[], toasts: string[][] = [], extra: Record<string, unknown> = {}, ack = true) {
  const op = async (req: OpRequest): Promise<OpResult> => { requests.push(req); return { ok: true } as unknown as OpResult }
  return <MailQueueJoin node={node(extra)} state={mailListenerState('jobs', dogs)} ack={ack} op={op} toast={(m) => { toasts.push(m as string[]) }} />
}

test('§1 the label names the batch: once, twice, N times', () => {
  assert.equal(mailQueueJoinLabel(1), 'Join mail queue')
  assert.equal(mailQueueJoinLabel(2), 'Join mail queue twice')
  assert.equal(mailQueueJoinLabel(3), 'Join mail queue 3 times')
  assert.equal(mailQueueJoinLabel(4), 'Join mail queue 4 times')
  assert.equal(mailQueueJoinLabel(20), 'Join mail queue 20 times')
})

test('§2 outside the queue: the count starts at 1 and a click joins at once with that batch', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mountView(view([devDog], requests, toasts), (el) => el)
  t.after(() => v.unmount())
  const { input, button } = control(v.el)
  assert.ok(input && button, 'a number input and the join button')
  assert.equal(input.type, 'number')
  assert.equal(input.value, '1')
  assert.equal(input.min, '1')
  assert.equal(input.max, '20', 'the engine\'s batch limit')
  assert.equal(button.textContent, 'Join mail queue')
  assert.equal(button.disabled, false)
  await inAct(async () => { setInput(input, '2') })
  assert.equal(control(v.el).button!.textContent, 'Join mail queue twice')
  await inAct(async () => { setInput(input, '3') })
  assert.equal(control(v.el).button!.textContent, 'Join mail queue 3 times')
  await inAct(async () => { control(v.el).button!.click(); await flush(4) })
  assert.ok(!dialog(), 'no dialog opens')
  assert.deepEqual(requests.find((r) => r.op === 'user_queue_join'), { op: 'user_queue_join', node: 'jobs', batch: 3 })
  assert.ok(toasts.some((m) => /joined|queue/i.test(m.join(' '))), 'the user is told')
})

test('§3 inside the queue: the input shows the batch, grey until changed; a click updates it in place', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mountView(view([devDog, mine(2)], requests, toasts), (el) => el)
  t.after(() => v.unmount())
  const { input, button } = control(v.el)
  assert.equal(input!.value, '2', 'the input shows the user\'s batch')
  assert.equal(button!.textContent, 'Join mail queue twice')
  assert.equal(button!.disabled, true, 'nothing to update yet')
  await inAct(async () => { setInput(input!, '4') })
  assert.equal(control(v.el).button!.textContent, 'Join mail queue 4 times')
  assert.equal(control(v.el).button!.disabled, false, 'a different number can be applied')
  await inAct(async () => { control(v.el).button!.click(); await flush(4) })
  assert.deepEqual(requests.filter((r) => r.op.startsWith('user_queue')), [{ op: 'user_queue_join', node: 'jobs', batch: 4 }],
    'the same op updates the batch: no leave, no second join')
  assert.ok(toasts.some((m) => /4/.test(m.join(' '))), 'the user is told the new batch')
  // the tree then reports the new batch: the input follows it and the button is grey again
  await inAct(async () => { await v.render(view([devDog, mine(4)], requests, toasts)); await flush(2) })
  assert.equal(control(v.el).input!.value, '4')
  assert.equal(control(v.el).button!.disabled, true)
})

test('§4 a count that is not a whole number holds nothing; one outside 1..20 is brought into it', async (t) => {
  const requests: OpRequest[] = []
  const v = await mountView(view([devDog], requests), (el) => el)
  t.after(() => v.unmount())
  const { input } = control(v.el)
  for (const bad of ['', '2.5', 'e']) {
    await inAct(async () => { setInput(input!, bad) })
    assert.equal(control(v.el).button!.disabled, true, `"${bad}" cannot be sent`)
  }
  await inAct(async () => { setInput(input!, '0') })
  assert.equal(control(v.el).input!.value, '1')
  await inAct(async () => { setInput(input!, '25') })
  assert.equal(control(v.el).input!.value, '20')
  assert.equal(control(v.el).button!.textContent, 'Join mail queue 20 times')
  assert.ok(!requests.some((r) => r.op === 'user_queue_join'), 'nothing was sent')
})

test('§5 no control on a retired project; nothing in it says "you"', async (t) => {
  const gone = await mountView(view([devDog], [], [], { state: 'archived' }), (el) => el)
  t.after(() => gone.unmount())
  assert.ok(!control(gone.el).group, 'a retired project takes no listener')
  const v = await mountView(view([devDog, mine(3)], []), (el) => el)
  t.after(() => v.unmount())
  const texts = [...v.el.querySelectorAll<HTMLElement>('.queue-join, .queue-join *')].flatMap((el) =>
    [el.textContent ?? '', el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? ''])
  assert.ok(texts.length > 0)
  assert.ok(!texts.some((x) => /\byou\b/i.test(x)), 'neither the control nor its tooltips')
})

test('§6 the inbox folder strip carries the control on every folder, after the folder buttons', async (t) => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = withoutMailTransfers((async (input: string) => {
    const url = new URL(String(input), 'http://fixture.invalid')
    let body: unknown = {}
    if (url.pathname.endsWith('/inbox')) body = { pending: [], delivered: [], sent: [], next_cursor: null }
    else if (url.searchParams.has('tags_only')) body = { tag_choices: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  t.after(() => { globalThis.fetch = oldFetch })
  const tools = <span id="tools" className="mail-folder-tools">join here</span>
  const v = await mountView(<CurrentOrg.Provider value="org">
    <InboxView slug="org" nid="jobs" toast={() => {}} projectMail
      extraFolders={[{ id: 'listeners', render: () => <div id="listeners-body">body</div> }]} folderTools={tools}
      folderAsk={{ folder: 'listeners', seq: 1 }} /></CurrentOrg.Provider>, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(10) })
  const strip = v.el.querySelector<HTMLElement>('.mail-folders')!
  assert.ok(strip, 'the folder strip')
  const there = strip.querySelector('#tools')
  assert.ok(there, 'the tools are in the strip')
  const last = [...strip.querySelectorAll(':scope > button')].at(-1)!
  assert.ok(last.compareDocumentPosition(there!) & 4, 'after the folder buttons')
  assert.ok(!v.el.querySelector('.mailpane #tools'), 'not in the pane')
  for (const name of [/^inbox/, /^sent/]) {
    const folder = [...strip.querySelectorAll<HTMLButtonElement>(':scope > button')].find((b) => name.test(b.textContent ?? ''))!
    await inAct(async () => { folder.click(); await flush(4) })
    assert.ok(v.el.querySelector('.mail-folders #tools'), `still there on ${folder.textContent}: the header row never jumps`)
  }
})

test('§7 the help text of the old dialog is the control\'s tooltip', async (t) => {
  const acked = await mountView(view([devDog], [], [], {}, true), (el) => el)
  t.after(() => acked.unmount())
  const tip = (root: ParentNode) => control(root).button!.getAttribute('title') ?? ''
  assert.match(tip(acked.el), /normal mail in your inbox/i, 'where the jobs arrive')
  assert.match(tip(acked.el), /acknowledge/i, 'ACK mode: each job is acknowledged')
  assert.match(tip(acked.el), /held until|stays held/i, 'a held job stays held, even after leaving')
  assert.ok((control(acked.el).input!.getAttribute('title') ?? '').length > 0, 'the input says what the number is')
  const rr = await mountView(view([devDog], [], [], {}, false), (el) => el)
  t.after(() => rr.unmount())
  assert.match(tip(rr.el), /round-robin/i)
  assert.doesNotMatch(tip(rr.el), /acknowledge each/i, 'a round-robin queue needs no acknowledgement')
})
