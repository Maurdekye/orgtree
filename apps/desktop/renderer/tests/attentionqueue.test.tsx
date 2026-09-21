// attentionqueue.test.tsx — the "Needs attention" panel against a real server.
//
// attentionfeed.test.tsx pins the membership and resolution RULES as pure
// functions. This file pins that the panel actually obeys them through the
// wire: that the three flavours render as one mixed list, that resolving a row
// goes through the same endpoint the Docket and the inbox use, and — the part
// a pure test cannot reach — that a row leaves the list only when the SERVER
// stops listing it, with the one urgent-mail retention the ticket asks for.
//
// ⚠ NO OPTIMISTIC REMOVAL ANYWHERE. Every assertion below that a row is gone
// is made after the server's own answer changed. A panel that hid a row on
// click would pass a weaker version of these tests and then leave the user
// looking at a list that disagreed with the docket.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionqueue

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { AskInfo, MailEntry, TreePayload, WorkItem } from '../src/types'
import { AttentionQueue } from '../src/attention/AttentionQueue'

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
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (init?.method === 'POST') {
      server.posts.push({ path, body: init.body ? JSON.parse(init.body) : null })
    }
    const body =
      /\/work-items$/.test(path)
        ? { items: server.items, archived: [], backlogged: [],
            counts: { attention: 0, active: server.items.length, archived: 0, backlogged: 0 } }
        : /\/inbox$/.test(path)
          ? { pending: server.pending, delivered: server.delivered, sent: [] }
          : { ok: true }
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  }
}

const titles = (el: HTMLElement) =>
  [...el.querySelectorAll('.attn-row')].map((r) =>
    `${r.getAttribute('data-attn-kind')}:${r.querySelector('.attn-row-title')?.textContent ?? ''}`)

const rowFor = (el: HTMLElement, key: string) =>
  el.querySelector(`[data-attn-row="${key}"]`) as HTMLElement | null

const panel = (t = tree()) =>
  <AttentionQueue slug={SLUG} tree={t} toast={() => {}} onOpenItem={() => {}} />

const settle = async () => { await inAct(() => flush(8)) }

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
    'mail:the build is down',
    'ticket:Cut over the index',
    'question:Ship the cutover tonight?',
  ], 'heterogeneous rows in a single list')
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

  await inAct(() => { rowFor(v.el, 'ticket:cutover')!.click() })
  await settle()
  const dismiss = [...v.el.querySelectorAll('button')]
    .find((b) => b.textContent === 'Dismiss attention') as HTMLButtonElement
  assert.ok(dismiss, 'the row carries the control that resolves its own type')

  await inAct(() => { dismiss.click() })
  await settle()
  const post = server.posts.find((p) => /dismiss-attention$/.test(p.path))
  assert.ok(post, 'the existing dismiss endpoint, not a second one')
  assert.match(post!.path, /\/work-items\/cutover\/dismiss-attention$/)
  assert.deepEqual(post!.body, { set_rev: 4 },
    'echoing the flag\'s revision, so a stale click cannot clear a newer reason')

  // the server now answers without the flag — that is what removes the row
  server.items = [{ ...flagged, manual_attention: null, attention_sources: [], effective_attention: false }]
  await repoll()
  assert.deepEqual(titles(v.el), ['mail:the build is down'],
    'the ticket is gone and the unresolved rows are untouched')
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

  await inAct(() => { rowFor(v.el, 'mail:m1')!.click() })
  await settle()
  const read = server.posts.find((p) => /\/inbox\/read$/.test(p.path))
  assert.ok(read, 'opening it marks it read through the inbox\'s own endpoint')
  assert.deepEqual(read!.body, { ids: ['m1'] })

  // the server now calls it read: it leaves `pending` entirely
  server.pending = []
  server.delivered = [urgent]
  await repoll()
  assert.deepEqual(titles(v.el), ['mail:the build is down', 'ticket:Cut over the index'],
    'a read mail stays on screen while the reader is still in it')
  assert.ok(rowFor(v.el, 'mail:m1')!.className.includes('attn-resolved'),
    'marked as resolved, so it does not read as still waiting')
  assert.match(v.el.querySelector('.attn-read-mark')?.textContent ?? '', /read/)

  // move to another row and it is released
  await inAct(() => { rowFor(v.el, 'ticket:cutover')!.click() })
  await settle()
  assert.deepEqual(titles(v.el), ['ticket:Cut over the index'],
    'read AND no longer selected — now it is gone')
  await v.unmount()
})

test('§3.1 a mail the server still calls unread is not read twice', async () => {
  localStorage.clear()
  installServer({ items: [], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()
  await inAct(() => { rowFor(v.el, 'mail:m1')!.click() })
  await settle()
  server.pending = []
  await repoll()
  await inAct(() => { rowFor(v.el, 'mail:m1')!.click() })
  await settle()
  assert.equal(server.posts.filter((p) => /\/inbox\/read$/.test(p.path)).length, 1,
    're-selecting a retained row posts nothing')
  await v.unmount()
})

// ------------------------------------------------------------------- §4
test('§4 the list is a real listbox the keyboard can drive', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(), titles)
  await settle()
  const list = v.el.querySelector('.attn-list') as HTMLElement
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
  await key('Home')
  await settle()
  assert.equal(rowFor(v.el, 'mail:m1')!.getAttribute('aria-selected'), 'true')
  await v.unmount()
})

// ------------------------------------------------------------------- §5
test('§5 a public organization can read the queue and resolve nothing', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(tree({ isPublic: true })), titles)
  await settle()
  assert.deepEqual(titles(v.el),
    ['mail:the build is down', 'ticket:Cut over the index'],
    'what is waiting is not a secret from a reader who can already see the docket')

  await inAct(() => { rowFor(v.el, 'ticket:cutover')!.click() })
  await settle()
  const labels = () => [...v.el.querySelectorAll('button')].map((b) => b.textContent)
  assert.equal(labels().includes('Dismiss attention'), false, 'no dismissal')

  await inAct(() => { rowFor(v.el, 'mail:m1')!.click() })
  await settle()
  assert.equal(labels().includes('Mark read'), false, 'no read mark')
  assert.equal(server.posts.length, 0, 'and opening a row wrote nothing at all')
  await v.unmount()
})

// ------------------------------------------------------------------- §6
test('§6 the counts describe the mixed list, by flavour', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  const v = await mountView(panel(tree({ ask: openAsk })),
    (el) => el.querySelector('.attn-counts')?.textContent ?? '')
  await settle()
  assert.equal(v.last(), '1 ticket · 1 urgent mail · 1 question')
  await v.unmount()
})

// ------------------------------------------------------------------- §7
//
// WHAT THE PANEL SAYS WHEN IT COULD NOT READ. The ticket requires preserving
// "the distinction between current, loading, stale and incomplete state", so
// what this panel claims when a feed fails is part of the spec and not an
// afterthought. Measured here rather than reasoned about, because I asserted
// the wrong answer to a peer before checking: I said the feeds fail closed to
// an empty list. They do not — `usePolled` catches and keeps the PREVIOUS
// value, so the two failure shapes are different from each other and neither
// is an empty list.

test('§7 a feed that has never succeeded says loading — not "nothing is waiting"',
  async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  // every request fails, so `usePolled` never has a value to keep
  ;(globalThis as unknown as { fetch: unknown }).fetch = () => Promise.resolve({
    ok: false, status: 500, statusText: 'HTTP 500', headers: new Headers(),
    json: () => Promise.resolve({ detail: 'boom' }),
  })
  const v = await mountView(panel(), titles)
  await settle()
  assert.deepEqual(titles(v.el), [])
  assert.equal(v.el.querySelector('.attn-empty'), null,
    'the empty state is NOT shown: this panel does not know that nothing is waiting')
  assert.match(v.el.querySelector('.attn-counts')?.textContent ?? '', /loading/,
    'it says it has not read yet, which is the true statement')
  await v.unmount()
})

test('§7.1 a feed that fails AFTER succeeding keeps showing the last answer, '
  + 'and does not mark it stale — a known gap', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [] })
  const v = await mountView(panel(), titles)
  await settle()
  assert.deepEqual(titles(v.el), ['ticket:Cut over the index'])

  // the server stops answering
  ;(globalThis as unknown as { fetch: unknown }).fetch = () => Promise.resolve({
    ok: false, status: 503, statusText: 'HTTP 503', headers: new Headers(),
    json: () => Promise.resolve({ detail: 'down' }),
  })
  await repoll()

  // ⚠ THIS IS THE GAP, PINNED SO IT IS VISIBLE RATHER THAN DISCOVERED. The row
  // is still shown, with nothing saying the panel can no longer read. That is
  // `usePolled`'s behaviour across every panel in this app — it is the shared
  // hook's contract, not something this feature chose — but the ticket asks
  // this view to distinguish current from stale, and it currently cannot,
  // because `usePolled` exposes no failure to distinguish on. Closing it needs
  // a change to canvas/shared.ts, which this feature does not own.
  //
  // The DANGEROUS shape is the empty one: a queue that last read successfully
  // as empty, then goes unreadable, shows "Nothing is waiting on you here."
  // with full confidence. That reads as "nothing needs you" when the truth is
  // "nothing could be read" — raised with the coordinator rather than papered
  // over with a marking this panel has no signal to drive.
  assert.deepEqual(titles(v.el), ['ticket:Cut over the index'],
    'the last good answer is retained')
  assert.equal(v.el.querySelector('.attn-stale'), null,
    'and nothing marks it stale — the signal to do so does not exist here yet')
  await v.unmount()
})
