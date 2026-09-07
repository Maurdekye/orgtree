// mailjump.test.tsx — a reference to a MESSAGE, followed.
//
// Astra rejected the first design outright ("do not silently open a mailbox")
// and the rejection is the spec: reuse the addressed inbox fetch, select the
// exact message once it has loaded, and give an EXPLICIT unavailable outcome
// when it is not there — disclosing nothing about it.
//
// THE THREE FAILURES THIS EXISTS TO CATCH ARE ALL SILENT ONES. Not a crash,
// not a wrong mail: a panel that opens looking perfectly ordinary while the
// thing you clicked for is not on screen and nothing says why.
//
//   1. THE MESSAGE IS NOT HERE and the pane shows "select a mail to read it".
//      Indistinguishable from having misclicked.
//   2. THE SECOND LINK DOES NOTHING. The box is already mounted, so the
//      selection — initialised once at mount — never moves again. The first
//      reference of a session works and every one after it appears dead.
//   3. THE MESSAGE IS IN THE OTHER FOLDER. A node's Sent list was not even
//      given the jump, so a reference to something an agent SENT could never
//      be found, with the mail one unmarked click away.
//
// ⚠ AND ONE THING THAT MUST NOT LEAK. A message may be missing because this
// viewer is not allowed to see it. An explanation that quotes the sender or
// the subject is not a refusal — it is the disclosure, wearing an apology. §4
// asserts the absence of content, which is a check that can only be written
// by naming what must not appear.
//
// Run: cd frontend && node tests/run.mjs mailjump

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { InboxView, MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'

// ⚠ jsdom IMPLEMENTS NO LAYOUT, so `Element.scrollIntoView` does not exist
// there and the product's jump handler throws on the first render. Stubbed
// here rather than guarded in the source: the call is correct in a browser,
// and adding `?.` to product code to satisfy a test environment hides a real
// missing-method bug behind a shrug. The stub records nothing — these checks
// are about which message is SELECTED, not about scrolling, which no DOM test
// can observe anyway.
{
  // reached through a real element rather than a global: the harness installs
  // jsdom's document, not its constructors
  const win = document.createElement('div').ownerDocument.defaultView as
    unknown as { Element: { prototype: Record<string, unknown> } }
  const proto = win.Element.prototype
  if (typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = function scrollIntoView() { /* no layout in jsdom */ }
  }
}

function uiTest(name: string, body: (mount: (el: React.ReactElement)
  => Promise<{ el: HTMLElement; render: (n: React.ReactElement)
    => Promise<unknown> }>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
    })
    await body(async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return { el: v.el, render: v.render }
    })
  })
}

// distinct timestamps: MailList sorts by send time, so one shared `at` would
// be asserting on the stability of Array.sort instead of on the feature
const row = (n: number, over: Partial<MailRow> = {}): MailRow => ({
  id: 'm' + n, from: 'alpha', kind: 'message',
  body: 'the body of message ' + n,
  at: `2026-09-05T1${9 - n}:00:00Z`, ...over,
} as MailRow)

const THREE = [row(1), row(2), row(3)]
const pane = (el: HTMLElement) =>
  el.querySelector('.mailer-read')?.textContent ?? ''

uiTest('§1 a jump selects the exact message, not merely the newest',
  async (mount) => {
    // the target is deliberately NOT the newest row: a panel that simply
    // opened the top of the list would pass a check aimed at row 1.
    const { el } = await mount(<MailList delivered={THREE} jumpTo="m3" />)
    await flush()
    assert.match(pane(el), /the body of message 3/)
    assert.doesNotMatch(pane(el), /the body of message 1/)
  })

uiTest('§2 a SECOND jump moves the selection — the latch is per-jump, not '
  + 'once-ever', async (mount) => {
    // the box is already open. This is the ordinary case, not the edge one:
    // two references in the same paragraph, clicked one after the other.
    const { el, render } = await mount(
      <MailList delivered={THREE} jumpTo="m3" />)
    await flush()
    assert.match(pane(el), /message 3/)

    await render(<MailList delivered={THREE} jumpTo="m1" />)
    await flush()
    assert.match(pane(el), /message 1/, 'the second reference moved the pane')
    assert.doesNotMatch(pane(el), /message 3/)
  })

uiTest('§3 a jump to a message that is NOT in this folder says so, instead of '
  + 'falling through to "select a mail"', async (mount) => {
    const { el } = await mount(<MailList delivered={THREE} jumpTo="m9" />)
    await flush()
    const said = el.querySelector('.mailer-nojump')
    assert.ok(said, 'the panel states that the linked message is not here')
    assert.doesNotMatch(pane(el), /select a mail to read it/,
      'the generic invitation is the silent failure this replaces')
  })

uiTest('§4 CONTROL — that statement discloses nothing about the message',
  async (mount) => {
    // the reason it is missing may be that this viewer may not see it.
    const secret = row(9, { from: 'confidential-sender',
      body: 'the contents nobody may read' })
    const { el } = await mount(
      // the row exists in the WORLD but not in this folder's data
      <MailList delivered={THREE} jumpTo={secret.id!} />)
    await flush()
    const said = el.querySelector('.mailer-nojump')!.textContent ?? ''
    for (const leak of ['confidential-sender', 'nobody may read', 'm9']) {
      assert.ok(!said.includes(leak), `the notice leaked ${leak}`)
    }
    // ⚠ and it is not vacuous: it does actually say something
    assert.ok(said.trim().length > 20, 'the notice is empty, not discreet')
  })

uiTest('§5 CONTROL — a jump that IS found produces no such statement',
  async (mount) => {
    // §3 and §4 both assert on an element being present. If that element were
    // present unconditionally they would pass while the feature did nothing.
    //
    // ⚠ THIS ESTABLISHES LESS THAN IT LOOKS LIKE, and the limit is worth
    // knowing before leaning on it: the notice lives inside `{!cur && …}`, so
    // once a message is SELECTED it cannot render whatever `outsideWindow`
    // says. This check therefore pins the FOUND path only — it does not
    // constrain that flag, and a mutant forcing `outsideWindow = true` walks
    // straight past it. §6, §7d and §15c are the ones that catch that.
    const { el } = await mount(<MailList delivered={THREE} jumpTo="m2" />)
    await flush()
    assert.equal(el.querySelector('.mailer-nojump'), null)
    assert.match(pane(el), /message 2/)
  })

uiTest('§6 CONTROL — the search filter does not turn a found message into a '
  + 'missing one', async (mount) => {
    // the "is it here" question is asked over ALL rows, not the filtered
    // ones. Asked over the visible set, typing in the search box would make
    // the panel announce that a message it is holding does not exist.
    //
    // ⚠ SIX ROWS, NOT THREE: the filter box only renders above four, so a
    // three-row fixture would make this check pass by never filtering at all.
    const six = [1, 2, 3, 4, 5, 6].map((n) => row(n))
    const { el } = await mount(<MailList delivered={six} jumpTo="m6" />)
    await flush()
    assert.match(pane(el), /message 6/)
    const box = el.querySelector('input.mail-filter') as HTMLInputElement
    assert.ok(box, 'the search box renders above four rows')

    // React tracks the input's value on the node, so assigning `.value`
    // directly is swallowed as "no change" — the native setter is what makes
    // the synthetic onChange fire.
    const win = box.ownerDocument.defaultView as unknown as {
      HTMLInputElement: { prototype: object }; Event: typeof Event
    }
    const set = Object.getOwnPropertyDescriptor(
      win.HTMLInputElement.prototype, 'value')!.set!
    await inAct(() => {
      set.call(box, 'message 1')
      box.dispatchEvent(new win.Event('input', { bubbles: true }))
    })
    await flush()
    assert.equal(box.value, 'message 1', 'the filter really took the text')
    assert.ok(el.querySelectorAll('.mailrow').length < six.length,
      'and it really filtered — otherwise this control is inert')
    // ⚠ THE COUNT, NOT THE NODE. `assert.equal(node, null)` makes node's diff
    // walk the whole jsdom tree when it FAILS: measured here at 33 s and an
    // "Array buffer allocation failed" instead of a message, which also took
    // the mutation harness's process down with it and left a mutant in the
    // source. The rule is already written in mailsender's header; this file
    // had one left.
    assert.equal(el.querySelectorAll('.mailer-nojump').length, 0,
      'filtering the list must not be reported as a missing message')
  })

uiTest('§7 an outgoing folder honours a jump too', async (mount) => {
  // the node box passes `jumpTo` to Sent as well now; before, a reference to
  // something an agent had SENT could not be found in any folder.
  const sent = [row(1, { to: 'beta' }), row(2, { to: 'gamma' })]
  const { el } = await mount(
    <MailList delivered={sent} outgoing jumpTo="m2" />)
  await flush()
  assert.match(pane(el), /message 2/)
  assert.equal(el.querySelector('.mailer-nojump'), null)
})

// ───────────────────────── §7 a window is not the world
//
// ⚠ ASTRA, 2026-09-05: every box route returns a slice, and this pane said
// "that message is not in this folder" for anything outside it — a claim about
// the MESSAGE made from what the panel happened to be holding. A retained
// message at position 51 is still there.
//
// Three outcomes, and they must stay three: still asking, found outside the
// window, and really absent. Collapsing the first into the third is the
// original defect; collapsing the second into the third is worse.

const older = (id: string): MailRow => ({
  id, from: 'peer-one', to: 'me', at: '2026-08-01T09:00:00.000Z',
  kind: 'message', body: 'the older message', read: true,
} as MailRow)

const listWith = (rows: MailRow[], extra: Record<string, unknown> = {}) => (
  <MailList delivered={rows} jumpTo="outside-1" jumpSeq={1} {...extra} />
)

uiTest('§7 a reference outside the window is looked up, not called missing',
async (mount) => {
  let asked = 0
  const { el } = await mount(listWith([older('in-window-1')], {
    lookup: (id: string) => { asked += 1; return Promise.resolve(older(id)) },
  }))
  await flush()
  assert.equal(asked, 1, 'the exact question was never asked')
  const pane = el.querySelector('.mailer-read')
  assert.ok(pane, 'no reading pane')
  assert.equal(el.querySelectorAll('.mailer-nojump').length, 0,
    'a retained message was reported as gone')
  assert.match(pane!.textContent ?? '', /the older message/,
    'the message it found is not on screen')
})

uiTest('§7b while the question is in flight it says so, and claims nothing',
async (mount) => {
  let settle: ((m: MailRow | null) => void) | null = null
  const { el } = await mount(listWith([older('in-window-1')], {
    lookup: () => new Promise<MailRow | null>((res) => { settle = res }),
  }))
  await flush()
  const note = el.querySelector('.mailer-nojump')
  assert.ok(note, 'nothing at all was said while the lookup was in flight')
  assert.match(note!.textContent ?? '', /Looking for that message/)
  assert.doesNotMatch(note!.textContent ?? '', /not in this folder/,
    'it claimed the message was gone while still asking')
  await inAct(async () => { settle!(null) })
  await flush()
  assert.match(el.querySelector('.mailer-nojump')?.textContent ?? '',
    /not in this folder/, 'and once the answer is no, it says no')
})

uiTest('§7c CONTROL — with no lookup wired the notice is unchanged',
async (mount) => {
  // a surface that cannot ask must not pretend to have asked: the wording is
  // the same one it has always shown
  const { el } = await mount(listWith([older('in-window-1')]))
  await flush()
  assert.match(el.querySelector('.mailer-nojump')?.textContent ?? '',
    /not in this folder/)
})

uiTest('§7d CONTROL — a message that IS in the window is never looked up',
async (mount) => {
  let asked = 0
  const { el } = await mount(
    <MailList delivered={[older('outside-1')]} jumpTo="outside-1" jumpSeq={1}
      lookup={(id: string) => { asked += 1; return Promise.resolve(older(id)) }} />)
  await flush()
  assert.equal(asked, 0, 'the panel asked for a message it was already holding')
  assert.equal(el.querySelectorAll('.mailer-nojump').length, 0)
})

uiTest('§7e an answer belongs to the request that asked for it',
async (mount) => {
  // ⚠ TWO JUMPS, TWO ANSWERS. Without keying the answer to the request, the
  // FIRST lookup's row renders as the second request's message while the
  // second is still in flight — the reader clicks one reference and is shown
  // a different message, which is the wrong-target failure again.
  const settle: ((m: MailRow | null) => void)[] = []
  const lookup = () => new Promise<MailRow | null>((res) => { settle.push(res) })
  const { el, render } = await mount(
    <MailList delivered={[older('in-window-1')]} jumpTo="outside-1" jumpSeq={1}
      lookup={lookup} />)
  await flush()
  await inAct(async () => { settle[0]!(older('outside-1')) })
  await flush()
  assert.match(el.querySelector('.mailer-read')?.textContent ?? '',
    /the older message/, 'positive control: the first answer rendered')
  // a second, different reference — its answer has NOT arrived yet
  await render(
    <MailList delivered={[older('in-window-1')]} jumpTo="outside-2" jumpSeq={2}
      lookup={lookup} />)
  await flush()
  const note = el.querySelector('.mailer-nojump')
  assert.ok(note, 'the stale answer was rendered as the new request')
  assert.match(note!.textContent ?? '', /Looking for that message/)
})

uiTest('§7f a lookup that answers with the wrong message is not believed',
async (mount) => {
  // ⚠ THE ANSWER IS AN EXTERNAL INPUT. `lookup` belongs to the caller, and
  // this pane cannot see how it resolves an id — so a row that is not the
  // message asked for is refused rather than rendered as it. Without this the
  // pane shows one message under another message's reference, which is the
  // wrong-target failure the whole reference format exists to prevent.
  const { el } = await mount(
    <MailList delivered={[older('in-window-1')]} jumpTo="outside-1" jumpSeq={1}
      lookup={() => Promise.resolve({ ...older('a-different-message'),
        body: 'somebody else’s mail' } as MailRow)} />)
  await flush()
  assert.doesNotMatch(el.querySelector('.mailer-read')?.textContent ?? '',
    /somebody else/, 'a message that was not asked for was rendered as the answer')
  assert.match(el.querySelector('.mailer-nojump')?.textContent ?? '',
    /not in this folder/, 'and the honest outcome is the refusal')
})

// ───────────────────────── §8 a failed question is not a negative answer
//
// ⚠ EXECUTED BY ASTRA AGAINST THE PREVIOUS TIP: a rejected lookup promise and
// a successful lookup returning null rendered the SAME "not in this folder /
// retracted" sentence. One of those is a fact about the message; the other is
// a fact about the network, and stating the first from the second tells a
// reader their mail was retracted because a fetch failed.

uiTest('§8 a lookup that FAILS says so, and offers a deliberate retry',
async (mount) => {
  let calls = 0
  const { el } = await mount(
    <MailList delivered={[older('in-window-1')]} jumpTo="outside-1" jumpSeq={1}
      lookup={() => { calls += 1; return Promise.reject(new Error('network failed')) }} />)
  await flush()
  const note = el.querySelector('.mailer-nojump')
  assert.ok(note, 'nothing was said at all')
  assert.match(note!.textContent ?? '', /Could not check/,
    'a failed question was reported as a confirmed absence')
  assert.doesNotMatch(note!.textContent ?? '', /retracted/,
    'it stated a fact about the MESSAGE on the strength of a network error')
  assert.equal(calls, 1, 'and nothing retried on its own — an error path that '
    + 'polls is a storm')
  // the retry is a control the reader presses
  const again = note!.querySelector('button')
  assert.ok(again, 'no way to try again')
  await inAct(() => { (again as HTMLButtonElement).click() })
  await flush()
  assert.equal(calls, 2, 'the retry did not ask again')
})

uiTest('§8b CONTROL — a lookup that ANSWERS "no" still says the message is not '
  + 'here', async (mount) => {
  const { el } = await mount(
    <MailList delivered={[older('in-window-1')]} jumpTo="outside-1" jumpSeq={1}
      lookup={() => Promise.resolve(null)} />)
  await flush()
  const note = el.querySelector('.mailer-nojump')
  assert.match(note!.textContent ?? '', /not in this folder/,
    'a searched box that does not hold it is a real negative answer')
  assert.doesNotMatch(note!.textContent ?? '', /Could not check/)
  assert.equal(note!.querySelectorAll('button').length, 0,
    'there is nothing to retry: the question was answered')
})

// ─────────────────────── §9 the answer opens the folder that holds it
uiTest('§9 a found message tells its owner, so the right folder can open',
async (mount) => {
  const found: string[] = []
  const { el } = await mount(
    <MailList delivered={[older('in-window-1')]} outgoing jumpTo="outside-1"
      jumpSeq={1} lookup={(id: string) => Promise.resolve(older(id))}
      onFound={(m: MailRow) => { found.push(String(m.id)) }} />)
  await flush()
  assert.deepEqual(found, ['outside-1'],
    'the list that found it never told the panel that owns the folders')
  assert.ok(el, 'mounted')
})

uiTest('§9b CONTROL — nothing is announced when nothing was found',
async (mount) => {
  const found: string[] = []
  await mount(
    <MailList delivered={[older('in-window-1')]} jumpTo="outside-1" jumpSeq={1}
      lookup={() => Promise.resolve(null)}
      onFound={(m: MailRow) => { found.push(String(m.id)) }} />)
  await flush()
  assert.deepEqual(found, [], 'a folder was opened for a message nobody found')
})

// ─────────────────── §11 the REAL InboxView, folders and repeat requests
//
// ⚠ WHY AT THIS LEVEL. §7-§9 drive `MailList`, which does not own the folders.
// Astra's counterexample lives one layer up: the panel's folder effect READ
// `jumpSeq` but did not depend on it, so a repeat request never re-ran it —
// every latch below comparing the new key is irrelevant when the effect that
// would act on it is never woken. A component test of the latch cannot see
// that; this mounts the panel and clicks.

const NODE_BOX = {
  pending: [],
  delivered: [{
    id: 'received-1', from: 'alpha', to: 'me', at: '2026-09-05T09:00:00.000Z',
    kind: 'message', body: 'RECEIVED CONTROL', read: true,
  }],
  sent: [{
    id: 'sent-1', from: 'me', to: 'beta', at: '2026-09-05T09:30:00.000Z',
    kind: 'message', body: 'SENT CONTROL', read: true,
  }],
}

/** the older, retained message — deliberately NOT in the window above */
const OUTSIDE = {
  id: 'older-received', from: 'alpha', to: 'me',
  at: '2026-08-01T09:00:00.000Z', kind: 'message', body: 'OLDER RECEIVED',
  read: true,
}

function stubBox(onLookup?: () => void) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const u = String(url)
    let body: unknown = {}
    if (u.includes('/mail/node/')) {
      onLookup?.()
      body = { found: true, mail: OUTSIDE }
    // ⚠ A FRESH OBJECT PER POLL, as the real fetch returns. Handing back the
    // SAME object made `usePolled` bail out of its own setState, so the panel
    // effect never re-ran and every "under a repoll" claim below was free.
    } else if (u.includes('/inbox')) body = { ...NODE_BOX }
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  }) as unknown as typeof fetch
  return () => { (globalThis as { fetch?: typeof fetch }).fetch = had }
}

const folderNow = (el: HTMLElement) =>
  [...el.querySelectorAll('.mail-folders button.on')].map((b) => b.textContent)

async function settle(el: HTMLElement) {
  await flush(); await advance(200, 16); await flush()
  return el
}

uiTest('§11 a repeat request re-runs the folder decision after the reader has '
  + 'moved', async (mount) => {
  useFakeClock()
  const restore = stubBox()
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    assert.deepEqual(folderNow(el), ['inbox'],
      'positive control: the first request opened the folder holding it')
    // the reader chooses Sent by hand
    const sent = [...el.querySelectorAll('.mail-folders button')]
      .find((b) => b.textContent === 'sent') as HTMLButtonElement
    await inAct(() => { sent.click() })
    await flush()
    assert.deepEqual(folderNow(el), ['sent'], 'positive control: they moved')
    // …and clicks the SAME reference again: a new request
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={2} />)
    await settle(el)
    assert.deepEqual(folderNow(el), ['inbox'],
      'the second request never re-ran the folder decision — the effect reads '
      + 'jumpSeq but did not depend on it')
    assert.match(el.querySelector('.mailer-read')?.textContent ?? '',
      /RECEIVED CONTROL/)
  } finally { restore(); realClock() }
})

uiTest('§11b CONTROL — an unrelated repoll does not move the reader',
async (mount) => {
  useFakeClock()
  const restore = stubBox()
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    const sent = [...el.querySelectorAll('.mail-folders button')]
      .find((b) => b.textContent === 'sent') as HTMLButtonElement
    await inAct(() => { sent.click() })
    await flush()
    // the SAME request re-delivered, plus the poll ticking underneath
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await advance(6000, 16)
    await flush()
    assert.deepEqual(folderNow(el), ['sent'],
      'an unchanged request dragged the reader out of the folder they chose')
  } finally { restore(); realClock() }
})

uiTest('§11c a reference to retained mail outside the window opens the folder '
  + 'that HOLDS it, as received mail', async (mount) => {
  let looked = 0
  useFakeClock()
  const restore = stubBox(() => { looked += 1 })
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    const sent = [...el.querySelectorAll('.mail-folders button')]
      .find((b) => b.textContent === 'sent') as HTMLButtonElement
    await inAct(() => { sent.click() })
    await flush()
    // now follow a reference to a RETAINED message that is in neither list
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="older-received" jumpSeq={2} />)
    await settle(el)
    assert.ok(looked > 0, 'positive control: the exact question was asked')
    // ⚠ A NODE-BOX REFERENCE NAMES THAT NODE'S RECEIVED MAIL. Left on Sent it
    // renders an incoming message in an outgoing row's dress ("to beta"),
    // which is the wrong-target failure wearing the right id.
    assert.deepEqual(folderNow(el), ['inbox'],
      'the answer was rendered in the Sent folder')
    const pane = el.querySelector('.mailer-read')?.textContent ?? ''
    assert.match(pane, /OLDER RECEIVED/, 'the message it found is not on screen')
    assert.doesNotMatch(pane, /to\s*beta/,
      'an incoming message was dressed as one of the reader’s own sends')
  } finally { restore(); realClock() }
})

// ───────────── §12 the folder owner's failed question is the owner's to report
//
// ⚠ EXECUTED BY ASTRA AGAINST 222088a. Read from Sent, follow a reference to a
// message in neither loaded list, and let the panel's question REJECT. The
// panel caught it and said nothing, on the belief that "the list below reports
// the failure" — but the Sent list is deliberately given no `lookup`, so it
// reported the one thing a list can know without asking: not in this folder.
// A network error was rendered as a fact about the message, in the one folder
// where nothing could correct it.
//
// AND THE SAME HOLE IS OPEN WHILE THE QUESTION IS STILL IN FLIGHT: an
// unanswered question read as a confirmed absence.

/** a box stub whose one-message lookup is controlled by the caller */
function stubAsk(answer: () => Promise<unknown>) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const u = String(url)
    if (u.includes('/mail/node/')) return answer()
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(u.includes('/inbox') ? { ...NODE_BOX } : {}),
    })
  }) as unknown as typeof fetch
  return () => { (globalThis as { fetch?: typeof fetch }).fetch = had }
}

const toSent = async (el: HTMLElement) => {
  const b = [...el.querySelectorAll('.mail-folders button')]
    .find((x) => x.textContent === 'sent') as HTMLButtonElement
  await inAct(() => { b.click() })
  await flush()
}

uiTest('§12 a rejected question, followed from Sent, is reported as a failed '
  + 'question — with a retry', async (mount) => {
  let asks = 0
  useFakeClock()
  const restore = stubAsk(() => {
    asks += 1; return Promise.reject(new Error('network failed'))
  })
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await toSent(el)
    assert.deepEqual(folderNow(el), ['sent'], 'positive control: they moved')
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="missing-one" jumpSeq={2} />)
    await settle(el)
    assert.ok(asks > 0, 'positive control: the question was actually asked')
    const note = el.querySelector('.mailer-nojump')
    assert.ok(note, 'nothing was said at all')
    assert.match(note!.textContent ?? '', /Could not check/,
      'a rejected question was reported as a confirmed absence, in a folder '
      + 'that never asked anything')
    assert.doesNotMatch(note!.textContent ?? '', /retracted/,
      'it stated a fact about the MESSAGE on the strength of a network error')
    const again = note!.querySelector('button')
    assert.ok(again, 'no way to try again')
    const before = asks
    await inAct(() => { (again as HTMLButtonElement).click() })
    await settle(el)
    assert.ok(asks > before, 'the retry did not ask again')
  } finally { restore(); realClock() }
})

uiTest('§12b an unanswered question, followed from Sent, claims nothing yet',
async (mount) => {
  useFakeClock()
  // never settles: the question is in flight for the whole check
  const restore = stubAsk(() => new Promise(() => {}))
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await toSent(el)
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="missing-one" jumpSeq={2} />)
    await settle(el)
    const note = el.querySelector('.mailer-nojump')?.textContent ?? ''
    assert.match(note, /Looking for that message/,
      'a question still in flight was rendered as a confirmed absence')
    assert.doesNotMatch(note, /not in this folder/)
  } finally { restore(); realClock() }
})

uiTest('§12c CONTROL — a question ANSWERED "no" from Sent still says the '
  + 'message is not here', async (mount) => {
  useFakeClock()
  const restore = stubAsk(() => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({ found: false, mail: null }),
  }))
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await toSent(el)
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="missing-one" jumpSeq={2} />)
    await settle(el)
    const note = el.querySelector('.mailer-nojump')
    assert.match(note?.textContent ?? '', /not in this folder/,
      'a real negative answer must still be stated as one')
    assert.equal(note!.querySelectorAll('button').length, 0,
      'there is nothing to retry: the question was answered')
  } finally { restore(); realClock() }
})

// ───────────── §13 an empty window is not an answer about a message
//
// ⚠ EXECUTED BY ASTRA AGAINST 222088a. `if (!all.length) return "no mail yet"`
// sits ABOVE every jump outcome, so a folder whose window happens to be empty
// answered an explicit reference with a remark about the folder — and would
// have hidden a found message, an in-flight question and a real absence alike.

uiTest('§13 an explicit jump into an empty window renders its OUTCOME, not '
  + '"no mail yet"', async (mount) => {
  const { el } = await mount(
    <MailList delivered={[]} jumpTo="outside-1" jumpSeq={1}
      lookup={() => Promise.resolve(
        { ...older('outside-1'), body: 'FOUND OUTSIDE' })} />)
  await flush()
  assert.match(pane(el), /FOUND OUTSIDE/,
    'the message the reader asked for was found and then hidden behind a '
    + 'remark about the folder')
})

uiTest('§13b an explicit jump into an empty window reports a real absence',
async (mount) => {
  const { el } = await mount(
    <MailList delivered={[]} jumpTo="outside-1" jumpSeq={1}
      lookup={() => Promise.resolve(null)} />)
  await flush()
  assert.match(el.querySelector('.mailer-nojump')?.textContent ?? '',
    /not in this folder/, 'an answered question said nothing')
})

uiTest('§13c CONTROL — an empty folder with NO jump still says "no mail yet"',
async (mount) => {
  const { el } = await mount(<MailList delivered={[]} />)
  await flush()
  assert.match(el.textContent ?? '', /no mail yet/,
    'the ordinary empty folder lost its own sentence')
  assert.equal(el.querySelectorAll('.mailer-nojump').length, 0,
    'an empty folder nobody linked into announced a missing message')
})

// ───────────── §14 a repoll underneath must not abandon the question
//
// ⚠ RAISED BY ASTRA AS A READ-ONLY CONCERN, reproduced here. The panel's
// folder effect depends on `box`, and the poll replaces `box` every few
// seconds with a fresh object. The re-run cleans up the previous run (killing
// the in-flight answer) and then returns early on its own latch — so a
// question outlived by one poll tick is silently dropped and the reader is
// left in the wrong folder with no outcome at all.

uiTest('§14 an answer that arrives after a repoll still opens the folder',
async (mount) => {
  let settleAsk: ((v: unknown) => void) | null = null
  const answer = {
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({ found: true, mail: OUTSIDE }),
  }
  useFakeClock()
  // ⚠ ONLY THE PANEL'S QUESTION IS HELD OPEN. The inbox list asks the same id
  // again once the folder opens (two requests per click, today); deferring
  // that one too would leave the check stuck on the second question and
  // stop it saying anything about the repoll race it exists for.
  const restore = stubAsk(() => (settleAsk
    ? Promise.resolve(answer)
    : new Promise((res) => { settleAsk = res })))
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await toSent(el)
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="older-received" jumpSeq={2} />)
    await settle(el)
    assert.ok(settleAsk, 'positive control: the question is in flight')
    // the poll ticks underneath — a new `box` object, same data
    await advance(6000, 16); await flush()
    // …and only now does the answer come back
    await inAct(() => { settleAsk!(answer) })
    await settle(el)
    assert.deepEqual(folderNow(el), ['inbox'],
      'a poll tick underneath the question threw the answer away')
    assert.match(pane(el), /OLDER RECEIVED/,
      'the message it found never reached the screen')
  } finally { restore(); realClock() }
})

// ───────────── §15 a superseded question may not answer over its successor
//
// ⚠ EXECUTED BY ASTRA AGAINST 85054be. A request supersedes the previous one
// whatever it turns out to need — including a target already in a loaded list,
// which needs no question of its own. The claim on the in-flight answer was
// staked AFTER the branches that handle those targets, so the older question
// stayed live and moved the reader off the newer one when it came back.
//
// ⚠ AND THE PAIRED CONTROL BELOW IS THE POINT: the invalidation must be per
// REQUEST, not per effect run. A repoll re-runs the same effect with the same
// request, and killing the answer there is §14 all over again.

/** every lookup deferred, each recorded so a check can answer them ALL. One
 *  click makes two (panel then list): answering only the last hides this. */
function stubDeferred() {
  const open: (() => void)[] = []
  const restore = stubAsk(() => new Promise((res) => {
    open.push(() => res({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve({ found: true, mail: OUTSIDE }),
    }))
  }))
  return { open, restore }
}

uiTest('§15 an older question, answered late, does not move the reader off a '
  + 'newer target that was already loaded', async (mount) => {
  useFakeClock()
  const { open, restore } = stubDeferred()
  try {
    // a reference to a message in NEITHER list: the panel asks, and waits
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="older-received" jumpSeq={1} />)
    await settle(el)
    assert.ok(open.length, 'positive control: the older question is in flight')
    // …then a NEW reference to a message the Sent list is already holding.
    // It needs no question, so nothing below stakes a fresh claim.
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="sent-1" jumpSeq={2} />)
    await settle(el)
    assert.deepEqual(folderNow(el), ['sent'],
      'positive control: the newer reference opened the folder holding it')
    // ⚠ ALL of them, not merely the last: the panel's and the list's
    const late = open.splice(0)
    await inAct(() => { late.forEach((f) => f()) })
    await settle(el)
    assert.deepEqual(folderNow(el), ['sent'],
      'the superseded question answered over the top of a newer request')
    assert.match(pane(el), /SENT CONTROL/,
      'the reader was left looking for a message they had stopped asking for')
  } finally { restore(); realClock() }
})

uiTest('§15b CONTROL — the same request re-delivered under a repoll is not '
  + 'superseded by itself', async (mount) => {
  useFakeClock()
  const { open, restore } = stubDeferred()
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await toSent(el)
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="older-received" jumpSeq={2} />)
    await settle(el)
    assert.ok(open.length, 'positive control: the question is in flight')
    // the SAME request re-delivered, and the poll ticking underneath it
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="older-received" jumpSeq={2} />)
    await advance(6000, 16); await settle(el)
    const late = open.splice(0)
    await inAct(() => { late.forEach((f) => f()) })
    await settle(el)
    assert.deepEqual(folderNow(el), ['inbox'],
      'an invalidation that fires per effect run, not per request, throws away '
      + 'the answer to a question nothing superseded')
  } finally { restore(); realClock() }
})

uiTest('§15c an outcome belongs to the request that produced it, and does not '
  + 'outlive it', async (mount) => {
  useFakeClock()
  const restore = stubAsk(() => Promise.reject(new Error('network failed')))
  try {
    const { el, render } = await mount(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={1} />)
    await settle(el)
    await toSent(el)
    // a reference in neither list, whose question FAILS while they read Sent
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="missing-one" jumpSeq={2} />)
    await settle(el)
    assert.match(el.querySelector('.mailer-nojump')?.textContent ?? '',
      /Could not check/, 'positive control: the failure was reported')
    // …then a reference the inbox is already holding. It needs no question,
    // so nothing new is asked and nothing new answers.
    await render(
      <InboxView slug="org" nid="me" tier={null} jumpTo="received-1" jumpSeq={3} />)
    await settle(el)
    assert.deepEqual(folderNow(el), ['inbox'], 'positive control: it opened')
    // the reader goes back to Sent by hand, where that message is not
    const back = [...el.querySelectorAll('.mail-folders button')]
      .find((b) => b.textContent === 'sent') as HTMLButtonElement
    await inAct(() => { back.click() })
    await settle(el)
    const note = el.querySelector('.mailer-nojump')?.textContent ?? ''
    assert.doesNotMatch(note, /Could not check/,
      'the previous request’s failure was still on screen, attached to a '
      + 'message that is sitting in the inbox')
    assert.match(note, /not in this folder/,
      'and the honest answer for this folder was not given')
  } finally { restore(); realClock() }
})
