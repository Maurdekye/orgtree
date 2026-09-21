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
// WHAT THE PANEL CLAIMS WHEN IT COULD NOT READ. The ticket requires preserving
// "the distinction between current, loading, stale and incomplete state", and
// this is the surface where collapsing them is actively harmful: "nothing is
// waiting" and "nothing could be read" look identical to a reader and mean
// opposite things.
//
// I asserted the wrong behaviour to a peer before measuring it — I said the
// feeds failed closed to an empty list — which is why every case here drives
// the real failure rather than describing one.

const text = (el: HTMLElement) => el.textContent ?? ''
const failAll = () => {
  ;(globalThis as unknown as { fetch: unknown }).fetch = () => Promise.resolve({
    ok: false, status: 503, statusText: 'HTTP 503', headers: new Headers(),
    json: () => Promise.resolve({ detail: 'down' }),
  })
}
/** fail only one of the two feeds; the other keeps answering from `server` */
const failOnly = (which: 'work-items' | 'inbox') => {
  const good = (globalThis as unknown as { fetch: (u: string, i?: unknown) => unknown }).fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: unknown) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const hit = which === 'work-items' ? /\/work-items$/.test(path) : /\/inbox$/.test(path)
    if (!hit) return good(url, init)
    return Promise.resolve({
      ok: false, status: 503, statusText: 'HTTP 503', headers: new Headers(),
      json: () => Promise.resolve({ detail: 'down' }),
    })
  }
}

test('§7 a first load that FAILED says unavailable — not loading forever', async () => {
  localStorage.clear()
  installServer({ items: [flagged], pending: [urgent] })
  failAll()
  const v = await mountView(panel(), titles)
  await settle()
  assert.deepEqual(titles(v.el), [])
  assert.equal(v.el.querySelector('.attn-empty'), null,
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
  assert.equal(v.el.querySelector('.attn-empty'), null,
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
  assert.ok(titles(v.el).includes('ticket:Cut over the index'),
    'the feed that still reads keeps serving its rows')
  assert.match(text(v.el), /mail could not be refreshed/,
    'and the one that does not is named, so the list is not read as complete')
  await v.unmount()
})

/** hold one feed's FIRST request open for ever; the other answers from `server` */
const hangOnly = (which: 'work-items' | 'inbox') => {
  const good = (globalThis as unknown as { fetch: (u: string, i?: unknown) => unknown }).fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: unknown) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const hit = which === 'work-items' ? /\/work-items$/.test(path) : /\/inbox$/.test(path)
    return hit ? new Promise(() => {}) : good(url, init)
  }
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
  assert.deepEqual(titles(v.el), ['ticket:Cut over the index'],
    'the feed that answered keeps serving its rows — a pending sibling must '
    + 'not blank good data')
  assert.match(text(v.el), /mail is still loading/,
    'and the one that has not answered is named alongside the counts')
  assert.ok(v.el.querySelector('.attn-incomplete'),
    'the header marks itself incomplete, not merely un-stale')
  assert.equal(v.el.querySelector('.attn-empty'), null)
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
  assert.equal(v.el.querySelector('.attn-empty'), null, 'no confident sentence')
  assert.ok(v.el.querySelector('.attn-loading'), 'it says what it is still doing')
  assert.match(text(v.el), /Still reading mail/)
  // the old expression produced "…— could not be refreshed" with an EMPTY name
  // here, because it reached the stale branch with nothing stale in it
  assert.doesNotMatch(text(v.el), /could not be refreshed/,
    'a pending read is not a failed refresh, and must not be described as one')
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
