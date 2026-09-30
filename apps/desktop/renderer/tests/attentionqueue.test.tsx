// attentionqueue.test.tsx — the "Needs attention" panel against a real server.
//
// attentionfeed.test.tsx pins the membership and resolution RULES as pure
// functions. This file pins that the panel actually obeys them through the
// wire: that the three flavours render as one mixed list, each drawn by its
// home surface's own component (the docket's row and pane, the inbox's row and
// reading pane — user 2026-09-29), that resolving a row goes through the same
// endpoint the Docket and the inbox use, and that a row leaves the list when
// the SERVER stops listing it, with the one urgent-mail retention.
//
// ⚠ ONE OPTIMISTIC REMOVAL, AND ONLY ONE: dismissing a ticket's flag hides
// the row at once (user 2026-09-29: "dismissing attention on a ticket is
// slow") and brings it back if the server refuses (§2.2). Every other
// assertion that a row is gone is made after the server's answer changed.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionqueue

import './harness'
import { compatibilityWorkFixture } from './workcompat.fixture'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { AskInfo, MailEntry, TreePayload, WorkItem } from '../src/types'
import { AttentionQueue } from '../src/attention/AttentionQueue'
import { resetLocalReads } from '../src/mailread'
// a read made in one test is not still "read here" in the next
test.beforeEach(() => resetLocalReads())
import type { PolledStatus } from '../src/canvas/shared'

const SLUG = 'org1'
const NOW = '2026-09-20T12:00:00.000Z'

// ------------------------------------------------------------------ server
interface Server {
  items: WorkItem[]
  pending: MailEntry[]
  delivered: MailEntry[]
  posts: { path: string; body: unknown }[]
}
let server: Server

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'item', rev: 1, kind: 'code', title: 'Item', objective: 'o',
  status: 'in_progress', blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'scout', generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'scout', generation: 0 },
  at: NOW, updated_at: NOW, done_so_far: [], working_on_next: [], docket_at: null,
  last_updater: null, manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [],
  ...o,
} as WorkItem)

const flagged = mkItem({
  slug: 'cutover', title: 'Cut over the index',
  manual_attention: { reason: 'confirm the cutover window', at: '2026-09-20T10:00:00.000Z',
    by: { node: 'scout', generation: 0 }, set_rev: 4 },
  effective_attention: true, attention_sources: ['manual'],
})

const urgent: MailEntry = {
  id: 'm1', from: 'scout', kind: 'message', at: '2026-09-20T11:00:00.000Z',
  body: 'the nightly build has been red for six hours',
  urgent: true, urgent_reason: 'the build is down',
}

const openAsk: AskInfo = {
  id: 'a1', node: 'scout', status: 'open', at: '2026-09-20T09:00:00.000Z',
  kind: 'question', question: 'Ship the cutover tonight?',
  options: [{ label: 'Ship it' }, { label: 'Hold' }],
}

const tree = (o: { ask?: AskInfo; isPublic?: boolean } = {}): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1,
  roots: [{
    id: 'scout', tier: 'opus', state: 'live', generation: 0, seat: 1, grant: 10, free: 4,
    children: [], ...(o.ask ? { ask: o.ask } : {}),
  }],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
  max_top_grant: 1000,
  ...(o.isPublic ? { public: true } : {}),
} as unknown as TreePayload)

function installServer(initial: Partial<Server> = {}) {
  server = { items: [], pending: [], delivered: [], posts: [], ...initial }
  ;(globalThis as unknown as { fetch: unknown }).fetch = compatibilityWorkFixture((url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (init?.method === 'POST') {
      server.posts.push({ path, body: init.body ? JSON.parse(init.body) : null })
    }
    const body =
      /\/work-items(?:-view)?$/.test(path)
        ? { items: server.items, archived: [], backlogged: [],
            counts: { attention: 0, active: server.items.length, archived: 0, backlogged: 0 } }
        : /\/inbox$/.test(path)
          ? { pending: server.pending, delivered: server.delivered, sent: [] }
          : { ok: true }
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  })
}

/** kind:name for each listed entry — a ticket by the docket row's own name
 *  (the slug, as the docket lists it), a mail or question by the inbox row's
 *  own preview line */
const titles = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-attn-row]')].map((r) => {
    const kind = r.getAttribute('data-attn-kind')
    const name = kind === 'ticket'
      ? r.querySelector('.docket-rowname')?.textContent
      : r.querySelector('.mailrow .l2')?.textContent
    return `${kind}:${name ?? ''}`
  })

/** the entry's hook cell (display: contents) — selection state lives here */
const rowFor = (el: HTMLElement, key: string) =>
  el.querySelector(`[data-attn-row="${key}"]`) as HTMLElement | null
/** the home surface's own row inside it — what the user clicks */
const rowEl = (el: HTMLElement, key: string) =>
  rowFor(el, key)?.querySelector('.mailrow') as HTMLElement | null

/** the tree's freshness, which the panel cannot see for itself — question rows
 *  are read out of the `tree` prop rather than a feed it polls. Most cases pass
 *  a CURRENT one so they are about the thing they name; §7.4 and §7.5 are the
 *  cases about this signal itself. */
const FRESH: PolledStatus = {
  loading: false, failed: false, stale: false, unavailable: false,
  at: Date.parse(NOW), error: null,
}
const STALE_TREE: PolledStatus = { ...FRESH, failed: true, stale: true }

// ⚠ `null` MEANS ABSENT, NOT `undefined`. A default parameter fires when the
// argument IS `undefined`, so `panel(tree(), undefined)` quietly supplied FRESH
// and §7.5/§7.6 asserted the unvouched case while testing the vouched one —
// caught because they failed, but they could just as easily have passed for the
// wrong reason. `null` cannot collide with the default.
const panel = (t = tree(), treeStatus: PolledStatus | null = FRESH) =>
  <AttentionQueue slug={SLUG} tree={t} toast={() => {}} onOpenItem={() => {}}
    treeStatus={treeStatus ?? undefined} />

const settle = async () => { await inAct(() => flush(8)) }
const text = (el: HTMLElement) => el.textContent ?? ''

/** Let the panel re-read both feeds.
 *
 *  ⚠ THE TEST CANNOT SKIP THIS, and that is the point. Every "the row is gone"
 *  assertion below is made only after the SERVER's own answer changed and the
 *  panel read it — `usePolled` wakes on the livebus (which `api.req` rings
 *  after every successful mutation, coalesced 120 ms) and otherwise on its
 *  interval. A panel that removed a row optimistically would pass without
 *  this, which is exactly the difference worth keeping. */
const repoll = async () => {
  const { bumpLive } = await import('../src/livebus')
  await inAct(async () => {
    bumpLive()
    await new Promise((r) => setTimeout(r, 220))
    await flush(8)
  })
}

// ------------------------------------------------------------------- §1
test('§1 the three flavours render as one mixed list, newest first', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(tree({ ask: openAsk })), titles)
  await settle()
  assert.deepEqual(titles(v.el), [
    'mail:the nightly build has been red for six hours',
    'ticket:cutover',
    'question:Ship the cutover tonight?',
  ], 'heterogeneous rows in a single list')
  // each row is its home surface's own row, not a lookalike
  const ticket = rowEl(v.el, 'ticket:cutover')!
  assert.ok(ticket.classList.contains('docket-row') && ticket.classList.contains('attention'),
    "the ticket is the docket's DocketRow, in its attention state")
  assert.ok(!!ticket.closest('.docket-modal'), "inside the docket's style scope")
  const mail = rowEl(v.el, 'mail:m1')!
  assert.ok(mail.classList.contains('urgent') && mail.classList.contains('unread'),
    "the mail is the inbox's row: urgent and unread")
  assert.equal(mail.querySelector('.urgentkind')?.textContent, 'urgent')
  const ask = rowEl(v.el, 'question:a1')!
  assert.ok(ask.classList.contains('ask'), "the question is the inbox's ask row")
  assert.equal(ask.querySelector('.askkind')?.textContent, 'question')
  await v.unmount()
})

test('§1.1 with nothing waiting, the list says so rather than looking broken', async () => {
  localStorage.clear()
  installServer()
  const v = await mountView(panel(), titles)
  await settle()
  assert.deepEqual(titles(v.el), [])
  assert.match(v.el.querySelector('.attn-empty')?.textContent ?? '', /Nothing is waiting/)
  await v.unmount()
})

// ------------------------------------------------------------------- §2
test('§2 dismissing a ticket goes through the docket\'s own endpoint, and the row leaves', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()

  await inAct(() => { rowEl(v.el, 'ticket:cutover')!.click() })
  await settle()
  // the body is the docket's own pane: title, status line, and its Dismiss
  const pane = v.el.querySelector('[data-attn-detail="ticket"]') as HTMLElement
  assert.equal(pane.querySelector('.docket-pane-head b')?.textContent, 'Cut over the index')
  assert.ok(!!pane.querySelector('.docket-pane-sub'), "the docket pane's status line")
  const dismiss = [...pane.querySelectorAll('button')]
    .find((b) => /Dismiss/.test(b.textContent ?? '')) as HTMLButtonElement
  assert.ok(dismiss, "the pane carries the docket's own Dismiss")

  await inAct(() => { dismiss.click() })
  // ⚠ NO repoll: the row leaves on the click itself (the optimistic half)
  assert.deepEqual(titles(v.el), ['mail:the nightly build has been red for six hours'],
    'the ticket is gone at once and the unresolved rows are untouched')
  await settle()
  const post = server.posts.find((p) => /dismiss-attention$/.test(p.path))
  assert.ok(post, 'the existing dismiss endpoint, not a second one')
  assert.match(post!.path, /\/work-items\/cutover\/dismiss-attention$/)
  assert.deepEqual(post!.body, { set_rev: 4 },
    'echoing the flag\'s revision, so a stale click cannot clear a newer reason')

  // the server now answers without the flag, and the row stays gone
  server.items = [{ ...flagged, manual_attention: null, attention_sources: [], effective_attention: false }]
  await repoll()
  assert.deepEqual(titles(v.el), ['mail:the nightly build has been red for six hours'])
  await v.unmount()
})

test('§2.2 a refused dismissal brings the row back and says why', async () => {
  localStorage.clear()
  installServer({ items: [flagged] })
  const good = (globalThis as unknown as { fetch: (u: string, i?: unknown) => unknown }).fetch
  // the dismissal is held open, so the optimistic state can be observed, and
  // then refused
  let refuse: (() => void) | null = null
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: unknown) => {
    if (/dismiss-attention$/.test(new URL(String(url), 'http://localhost').pathname)) {
      return new Promise((resolve) => {
        refuse = () => resolve({ ok: false, status: 409, statusText: 'HTTP 409', headers: new Headers(),
          json: () => Promise.resolve({ detail: 'the flag changed' }) })
      })
    }
    return good(url, init)
  }
  const toasts: string[] = []
  const v = await mountView(<AttentionQueue slug={SLUG} tree={tree()} toast={(m) => { toasts.push(...m) }}
    treeStatus={FRESH} />, titles)
  await settle()
  await inAct(() => { rowEl(v.el, 'ticket:cutover')!.click() })
  await settle()
  const dismiss = [...v.el.querySelectorAll('[data-attn-detail="ticket"] button')]
    .find((b) => /Dismiss/.test(b.textContent ?? '')) as HTMLButtonElement
  await inAct(() => { dismiss.click() })
  assert.deepEqual(titles(v.el), [], 'gone while the server has not answered')
  await inAct(async () => { refuse!(); await flush(8) })
  assert.deepEqual(titles(v.el), ['ticket:cutover'], 'refused: the row is back')
  assert.ok(toasts.some((t) => /error/.test(t)), 'and the refusal is reported')
  await v.unmount()
})

test('§2.1 a ticket whose attention is only a question offers no dead Dismiss', async () => {
  localStorage.clear()
  const questionOnly = mkItem({
    slug: 'asked', title: 'Asked about the cutover',
    questions: [{ id: 'a1', node: 'scout', at: NOW } as never],
    effective_attention: true, attention_sources: ['question'],
  })
  installServer({ items: [questionOnly] })
  const v = await mountView(panel(tree({ ask: openAsk })), titles)
  await settle()
  assert.deepEqual(titles(v.el), ['question:Ship the cutover tonight?'],
    'the demand is listed once, as the thing that can actually be answered')
  await v.unmount()
})

// ------------------------------------------------------------------- §3
test('§3 opening an urgent mail reads it, and it stays while it is selected', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()

  await inAct(() => { rowEl(v.el, 'mail:m1')!.click() })
  await settle()
  // the body is the inbox's own reading pane, with its reply box
  const pane = v.el.querySelector('[data-attn-detail="mail"]') as HTMLElement
  assert.ok(!!pane.querySelector('.mailer-head'), "the inbox pane's head")
  assert.equal(pane.querySelector('.urgent-why')?.textContent, 'the build is down')
  assert.ok(!!pane.querySelector('.mail-reply textarea'), 'and its reply box')
  const read = server.posts.find((p) => /\/inbox\/read$/.test(p.path))
  assert.ok(read, 'opening it marks it read through the inbox\'s own endpoint')
  assert.deepEqual(read!.body, { ids: ['m1'] })

  // the server now calls it read: it leaves `pending` entirely
  server.pending = []
  server.delivered = [urgent]
  await repoll()
  assert.deepEqual(titles(v.el), ['mail:the nightly build has been red for six hours', 'ticket:cutover'],
    'a read mail stays on screen while the reader is still in it')
  assert.equal(rowEl(v.el, 'mail:m1')!.classList.contains('unread'), false,
    'drawn as the inbox draws a read mail, so it does not read as still waiting')
  assert.equal(!!v.el.querySelector('[data-attn-detail="mail"] .wait'), false,
    'and the pane drops its unread mark')

  // move to another row and it is released
  await inAct(() => { rowEl(v.el, 'ticket:cutover')!.click() })
  await settle()
  assert.deepEqual(titles(v.el), ['ticket:cutover'],
    'read AND no longer selected — now it is gone')
  await v.unmount()
})

test('§3.1 a mail the server still calls unread is not read twice', async () => {
  localStorage.clear()
  installServer({ items: [], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()
  await inAct(() => { rowEl(v.el, 'mail:m1')!.click() })
  await settle()
  server.pending = []
  await repoll()
  await inAct(() => { rowEl(v.el, 'mail:m1')!.click() })
  await settle()
  assert.equal(server.posts.filter((p) => /\/inbox\/read$/.test(p.path)).length, 1,
    're-selecting a retained row posts nothing')
  await v.unmount()
})

// ------------------------------------------------------------------- §4
test('§4 the list is a real listbox the keyboard can drive', async () => {
  localStorage.clear()
  const second = mkItem({ ...flagged, slug: 'reindex', title: 'Rebuild the index' })
  installServer({ items: [flagged, second], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()
  const list = v.el.querySelector('.attn-mlist') as HTMLElement
  assert.equal(list.getAttribute('role'), 'listbox')
  assert.equal(list.getAttribute('aria-label'), 'Needs attention')
  assert.equal(rowFor(v.el, 'mail:m1')!.getAttribute('role'), 'option')

  const key = (k: string) => inAct(() => {
    list.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
  await key('ArrowDown')
  await settle()
  assert.equal(rowFor(v.el, 'mail:m1')!.getAttribute('aria-selected'), 'true',
    'ArrowDown into an unselected list takes the first row')
  await key('ArrowDown')
  await settle()
  assert.equal(rowFor(v.el, 'ticket:cutover')!.getAttribute('aria-selected'), 'true')
  // the mail was read when it was selected: once deselected it leaves at
  // once, whatever the server's next inbox read says
  assert.equal(!!rowFor(v.el, 'mail:m1'), false, 'a read mail leaves once deselected')
  await key('End')
  await settle()
  assert.equal(rowFor(v.el, 'ticket:reindex')!.getAttribute('aria-selected'), 'true')
  await key('Home')
  await settle()
  assert.equal(rowFor(v.el, 'ticket:cutover')!.getAttribute('aria-selected'), 'true')
  await v.unmount()
})

// ------------------------------------------------------------------- §5
test('§5 a public organization can read the queue and resolve nothing', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(tree({ isPublic: true })), titles)
  await settle()
  assert.deepEqual(titles(v.el),
    ['mail:the nightly build has been red for six hours', 'ticket:cutover'],
    'what is waiting is not a secret from a reader who can already see the docket')

  await inAct(() => { rowEl(v.el, 'ticket:cutover')!.click() })
  await settle()
  // the docket's own pane is drawn as the docket draws it; a Dismiss pressed
  // here still writes nothing, and the row stays
  const dismiss = [...v.el.querySelectorAll('[data-attn-detail="ticket"] button')]
    .find((b) => /Dismiss/.test(b.textContent ?? '')) as HTMLButtonElement | undefined
  if (dismiss) await inAct(() => { dismiss.click() })
  assert.ok(titles(v.el).includes('ticket:cutover'), 'no dismissal')

  await inAct(() => { rowEl(v.el, 'mail:m1')!.click() })
  await settle()
  assert.equal(!!v.el.querySelector('[data-attn-detail="mail"] .mail-reply'), false, 'no reply')
  assert.equal(server.posts.length, 0, 'and nothing here wrote anything at all')
  await v.unmount()
})

// ------------------------------------------------------------------- §6
test('§6 there is no header row: no bell, no title, no count line (user 2026-09-29)', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(tree({ ask: openAsk })), titles)
  await settle()
  assert.equal(titles(v.el).length, 3, 'the list itself is all there')
  assert.equal(!!v.el.querySelector('.attn-head, .attn-counts'), false,
    'the "Needs attention" header row is gone')
  assert.equal(!!v.el.querySelector('h3'), false, "no title (the docket row's own status label may say Needs attention)")
  assert.doesNotMatch(text(v.el), /1 ticket|1 urgent mail|1 question/, 'and no count line')
  await v.unmount()
})

// ------------------------------------------------------------------- §7
//
// WHAT THE PANEL CLAIMS WHEN IT COULD NOT READ. The ticket requires preserving
// "the distinction between current, loading, stale and incomplete state", and
// this is the surface where collapsing them is actively harmful: "nothing is
// waiting" and "nothing could be read" look identical to a reader and mean
// opposite things.
//
// I asserted the wrong behaviour to a peer before measuring it — I said the
// feeds failed closed to an empty list — which is why every case here drives
// the real failure rather than describing one.

/** ⚠ NEVER HAND A DOM NODE TO AN ASSERTION AS `actual` OR `expected`.
 *
 *  MEASURED, under a real mutant: `assert.equal(el.querySelector('.attn-empty'),
 *  null, …)` failing takes ~4.7 SECONDS and dies with
 *  `RangeError: Array buffer allocation failed` — node's reporter tries to
 *  serialise a jsdom element for the diff, and that element's graph reaches its
 *  document, its window and everything in them. The same assertion written with
 *  a BOOLEAN actual fails in 2.3ms with its own message.
 *
 *  That is not a cosmetic difference. A mutation killed by an out-of-memory
 *  crash does not show the assertion discriminates — it shows the mutant drove
 *  the process into an allocation blow-up — and the crash can take later cases
 *  in the file down with it, so a regression suite silently stops reporting
 *  exactly when it has something to say (finding f4). Use `!!node`, a
 *  `textContent`, or an attribute; put the meaning in the message. */
const present = (el: HTMLElement, sel: string) => !!el.querySelector(sel)
const failAll = () => {
  ;(globalThis as unknown as { fetch: unknown }).fetch = compatibilityWorkFixture(() => Promise.resolve({
    ok: false, status: 503, statusText: 'HTTP 503', headers: new Headers(),
    json: () => Promise.resolve({ detail: 'down' }),
  }))
}
/** fail only one of the two feeds; the other keeps answering from `server` */
const failOnly = (which: 'work-items' | 'inbox') => {
  const good = (globalThis as unknown as { fetch: (u: string, i?: unknown) => unknown }).fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = compatibilityWorkFixture((url: string, init?: unknown) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const hit = which === 'work-items' ? /\/work-items(?:-view)?$/.test(path) : /\/inbox$/.test(path)
    if (!hit) return good(url, init)
    return Promise.resolve({
      ok: false, status: 503, statusText: 'HTTP 503', headers: new Headers(),
      json: () => Promise.resolve({ detail: 'down' }),
    })
  })
}

test('§7 a first load that FAILED says unavailable — not loading forever', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  failAll()
  const v = await mountView(panel(), titles)
  await settle()
  assert.deepEqual(titles(v.el), [])
  assert.equal(!!v.el.querySelector('.attn-empty'), false,
    'never the confident sentence: this panel does not know nothing is waiting')
  assert.ok(v.el.querySelector('.attn-unavailable'), 'it says it could not read')
  assert.match(text(v.el), /could not be read/)
  assert.doesNotMatch(text(v.el), /loading/,
    'a known failure is NOT a pending first load — that is the distinction')
  await v.unmount()
})

test('§7.1 success-empty then failure: the confident sentence is withdrawn', async () => {
  localStorage.clear()
  installServer({ items: [], pending: [] })
  const v = await mountView(panel(), titles)
  await settle()
  assert.ok(v.el.querySelector('.attn-empty'), 'both feeds read: the claim is earned')
  assert.match(text(v.el), /Nothing is waiting on you here/)

  failAll()
  await repoll()
  // ⚠ THE CASE THIS WHOLE CARVE-OUT EXISTS FOR. The list is still empty and the
  // panel still has its last good answer — but it can no longer vouch for it,
  // so the reassurance is withdrawn and replaced by what is actually known.
  assert.equal(!!v.el.querySelector('.attn-empty'), false,
    '"Nothing is waiting on you here." must not survive the feeds going dark')
  assert.ok(v.el.querySelector('.attn-stale-empty'))
  assert.match(text(v.el), /could not be refreshed since/)
  await v.unmount()
})

test('§7.2 one feed fails and the other still has rows — shown, and the gap named',
  async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()
  assert.equal(titles(v.el).length, 2)

  failOnly('inbox')
  await repoll()
  // partial coverage is a real state: the ticket rows are still usable and are
  // still shown. Hiding them because a DIFFERENT feed failed would be its own lie.
  assert.ok(titles(v.el).includes('ticket:cutover'),
    'the feed that still reads keeps serving its rows')
  assert.match(text(v.el), /mail could not be refreshed/,
    'and the one that does not is named, so the list is not read as complete')
  await v.unmount()
})

/** hold one feed's FIRST request open for ever; the other answers from `server` */
const hangOnly = (which: 'work-items' | 'inbox') => {
  const good = (globalThis as unknown as { fetch: (u: string, i?: unknown) => unknown }).fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = compatibilityWorkFixture((url: string, init?: unknown) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const hit = which === 'work-items' ? /\/work-items(?:-view)?$/.test(path) : /\/inbox$/.test(path)
    return hit ? new Promise(() => {}) : good(url, init)
  })
}

test('§7.2a usable rows AND a feed still on its first read — the rows show and '
  + 'the pending gap is named', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [] })
  // the inbox never answers at all: not a failure, a first read still in flight
  hangOnly('inbox')
  const v = await mountView(panel(), titles)
  await settle()

  // ⚠ THE HOLE THIS CASE EXISTS FOR (found by multi-window-design reading the
  // source, 2026-09-21). The "loading" branch used to be gated on the list
  // being EMPTY, so with a usable ticket row the header fell straight through
  // to the counts and never said half the queue had not arrived. Pending and
  // failed are different REASONS for the same incompleteness; only what the
  // user is told about them differs.
  assert.deepEqual(titles(v.el), ['ticket:cutover'],
    'the feed that answered keeps serving its rows — a pending sibling must '
    + 'not blank good data')
  assert.match(text(v.el), /mail is still loading/,
    'and the one that has not answered is named above the rows')
  assert.ok(v.el.querySelector('.attn-gaps'),
    "in the gap line that replaced the header's count line")
  assert.equal(!!v.el.querySelector('.attn-empty'), false)
  await v.unmount()
})

test('§7.2b an empty list with only a PENDING feed never reaches the stale '
  + 'sentence, which had no feed to name', async () => {
  localStorage.clear()
  installServer({ items: [], pending: [] })
  hangOnly('inbox')
  const v = await mountView(panel(), titles)
  await settle()
  assert.deepEqual(titles(v.el), [])
  assert.equal(!!v.el.querySelector('.attn-empty'), false, 'no confident sentence')
  assert.ok(v.el.querySelector('.attn-loading'), 'it says what it is still doing')
  assert.match(text(v.el), /Still reading mail/)
  // the old expression produced "…— could not be refreshed" with an EMPTY name
  // here, because it reached the stale branch with nothing stale in it
  assert.doesNotMatch(text(v.el), /could not be refreshed/,
    'a pending read is not a failed refresh, and must not be described as one')
  await v.unmount()
})

test('§7.4 a STALE TREE withdraws the confident sentence — questions ride it',
  async () => {
  localStorage.clear()
  installServer({ items: [], pending: [] })
  // both polled feeds answer cleanly and empty; the tree is the last good copy
  // after a failed refresh, which is a state this panel cannot see for itself
  const v = await mountView(panel(tree(), STALE_TREE), titles)
  await settle()
  assert.deepEqual(titles(v.el), [])
  assert.equal(!!v.el.querySelector('.attn-empty'), false,
    'the list is built from THREE sources and one of them is not current — '
    + 'the reassuring sentence is exactly what must not appear here')
  assert.match(text(v.el), /questions could not be refreshed/)
  await v.unmount()
})

test('§7.5 with no tree freshness reported at all, the panel does not vouch for it',
  async () => {
  localStorage.clear()
  installServer({ items: [], pending: [] })
  // the caller supplies nothing: the panel has no way to know whether the tree
  // it was handed is current, so "not told" must not read as "fine"
  const v = await mountView(panel(tree(), null), titles)
  await settle()
  assert.equal(!!v.el.querySelector('.attn-empty'), false,
    'absent freshness is not a clean bill of health')
  assert.match(text(v.el), /questions are not verified here/,
    'and it says which source it is not vouching for, rather than going quiet')
  await v.unmount()
})

test('§7.6 a question row still shows while the tree is unvouched — the gate '
  + 'withholds the CLAIM, never the rows', async () => {
  localStorage.clear()
  installServer({ items: [], pending: [] })
  const v = await mountView(panel(tree({ ask: openAsk }), null), titles)
  await settle()
  assert.deepEqual(titles(v.el), ['question:Ship the cutover tonight?'],
    'rows from an unvouched source are still the best information available')
  assert.match(text(v.el), /questions are not verified here/)
  await v.unmount()
})

test('§7.3 recovery clears the warning and the confident sentence comes back',
  async () => {
  localStorage.clear()
  installServer({ items: [], pending: [] })
  const v = await mountView(panel(), titles)
  await settle()
  failAll()
  await repoll()
  assert.ok(v.el.querySelector('.attn-stale-empty'))

  installServer({ items: [], pending: [] })   // the server answers again
  await repoll()
  assert.ok(v.el.querySelector('.attn-empty'),
    'once both feeds read again the panel may claim it knows')
  assert.doesNotMatch(text(v.el), /could not be/)
  await v.unmount()
})

// ------------------------------------------------------------------- §8
//
// A QUESTION FROM AN AGENT THE TREE DOES NOT HOLD. The v3 tree is a selected
// read, so such an agent has no `node.ask` — but the header's `tree.asks`
// carries every open request. Before canvas/openasks.ts both this list and
// the user's inbox read `node.ask` alone, and the question was listed nowhere
// (user report 2026-09-29, image-29).

const farAsk: AskInfo = {
  id: 'q88', node: 'far-agent', status: 'open', at: '2026-09-20T08:00:00.000Z',
  kind: 'question', question: 'Is this the right order?',
}
const treeWithFarAsk = (): TreePayload => ({ ...tree(), asks: [farAsk], asks_open: 1 } as TreePayload)

test('§8 an open question from an agent outside the tree is listed and answerable', async () => {
  localStorage.clear()
  installServer({ items: [] })
  const v = await mountView(panel(treeWithFarAsk()), titles)
  await settle()
  // composed into the agent's ONE batch card (FR-14), which the inbox titles
  // by its request count, exactly as it does a held agent's batch
  assert.deepEqual(titles(v.el), ['question:1 request(s) awaiting one submit'],
    "listed from the header's open requests")
  await inAct(() => { rowEl(v.el, 'question:q88')!.click() })
  await settle()
  assert.ok(!!v.el.querySelector('[data-attn-detail="question"] .askcard'),
    "and the body is the inbox's own ask card")
  assert.match(v.el.querySelector('[data-attn-detail="question"] .askcard')?.textContent ?? '',
    /Is this the right order\?/, 'showing the question itself')
  await v.unmount()
})

test("§8.1 the same question appears in the user's inbox", async () => {
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = () => {}
  installServer({ items: [] })
  const { InboxPanel } = await import('../src/App')
  const v = await mountView(<InboxPanel slug={SLUG} tree={treeWithFarAsk()} toast={() => {}}
    close={() => {}} jumpTo={null} />, (el) => el)
  await settle()
  const rows = [...v.el.querySelectorAll('.mailer-list .mailrow.ask')]
  assert.equal(rows.length, 1, 'one open request row')
  assert.match(rows[0]!.textContent ?? '', /request batch/, 'the agent\'s composed card')
  await v.unmount()
})

test('§8.2 an agent the tree holds keeps its ONE batched card, not a second raw row', async () => {
  localStorage.clear()
  installServer({ items: [] })
  // the header also lists the raw row of the batched ask: it must not double up
  const t = { ...tree({ ask: openAsk }), asks: [openAsk] } as TreePayload
  const v = await mountView(panel(t), titles)
  await settle()
  assert.deepEqual(titles(v.el), ['question:Ship the cutover tonight?'])
  await v.unmount()
})

// ------------------------------------------------------------------ point 31
test('point 31: a submitted question leaves the list on the click, before any repoll', async () => {
  localStorage.clear()
  installServer({ items: [flagged] })
  const { submitAsk, resetSubmittedAsks } = await import('../src/asksubmitted')
  const v = await mountView(panel(tree({ ask: openAsk })), titles)
  await settle()
  assert.ok(titles(v.el).includes('question:Ship the cutover tonight?'), 'fixture: the question is listed')
  // answered from any view (desk, inbox, this pane): the server has not
  // answered yet, and no feed is re-read
  let finish: () => void = () => {}
  await inAct(async () => {
    void submitAsk({ slug: SLUG, nid: openAsk.node, askId: openAsk.id, sections: null },
      () => new Promise<void>(r => { finish = r }))
    await flush(4)
  })
  assert.deepEqual(titles(v.el), ['ticket:cutover'], 'gone on the click; the ticket stays')
  finish()
  await v.unmount()
  resetSubmittedAsks()
})

// Superseded 2026-09-30 (docket v3-an-answered-question-vanishes-from-the-
// inbox): the CARD closes on the click (point 31) but the inbox ENTRY stays,
// as answered and no longer waiting. The Attention view above is a to-do
// queue and still lets a resolved request go.
test("point 31: the user's inbox keeps the submitted question's row, answered, on the click", async () => {
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = () => {}
  installServer({ items: [] })
  const { submitAsk, resetSubmittedAsks } = await import('../src/asksubmitted')
  const { InboxPanel } = await import('../src/App')
  const v = await mountView(<InboxPanel slug={SLUG} tree={treeWithFarAsk()} toast={() => {}}
    close={() => {}} jumpTo={null} />, (el) => el)
  await settle()
  const rows = () => [...v.el.querySelectorAll('.mailer-list .mailrow.ask')]
  assert.equal(rows().length, 1, 'fixture: one open request row')
  let finish: () => void = () => {}
  await inAct(async () => {
    void submitAsk({ slug: SLUG, nid: farAsk.node, askId: farAsk.id, sections: null },
      () => new Promise<void>(r => { finish = r }))
    await flush(4)
  })
  assert.equal(rows().length, 1, 'still listed on the click, before the server answers')
  assert.equal(rows()[0]!.classList.contains('unread'), false, 'but no longer as waiting')
  finish()
  await v.unmount()
  resetSubmittedAsks()
})
