// ctxtargetstorm.test.tsx — A DESK MENU MUST NOT MULTIPLY THE COST OF EVERY
// RENDER (bug 4.5.5, 2026-11-05: a desktop window froze after a right-click in
// the desk of an agent running a long series of tool calls, streamer mode on).
//
// THE MECHANISM, read from the source at 8a634fb (canvas/desk.tsx, "THE
// RIGHT-CLICKED EVENT STAYS LIT"): while a transcript menu is open, an effect
// with no dependency list runs after EVERY desk render and
//   1. re-searches the whole transcript (`querySelectorAll('[data-reply-event]')`)
//      for the event's element whenever the element it was first raised on has
//      been replaced — and it never remembers the element it found, so after
//      one re-key it searches on every render for the rest of the menu's life;
//   2. calls `classList.add('ctx-target')` on the found row every render, even
//      when the class is already there. A DOM `class` write queues a mutation
//      record even when the value is unchanged, and the row's class list holds
//      a streamer zone token (`msg`), so the streamer boundary treats every one
//      of those writes as a relevant change and rescans.
// A live desk renders on every tool-call update, so both costs ride on every
// update for as long as the menu is up.
//
// The bounds below are the contract: per render, O(1) work and NO DOM write
// when the marked event is where it already was.
//
// Run:  node apps/desktop/renderer/tests/run.mjs ctxtargetstorm

import test from 'node:test'
import assert from 'node:assert/strict'
import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { loadOlder, refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage } from '../src/types'
import { installStreamerBoundary, streamerScanStats } from '../src/streamer-boundary'

const W = window as unknown as Window & typeof globalThis
const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

interface Mounted {
  el: HTMLElement
  server: FakeServer
  poll: () => Promise<void>
  unmount: () => Promise<void>
}

async function desk(messages: ChatMessage[], cursorPages = false): Promise<Mounted> {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = messages
  server.cursorPages = cursorPages
  installFetch(server)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} bare />, el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  return {
    el: view.el, server,
    poll: async () => { await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) }) },
    unmount: async () => { await view.unmount(); resetConvos() },
  }
}

/** a long transcript: the user's ask, then many finished tool-call rounds */
function transcript(n: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' }]
  for (let i = 1; i <= n; i++) out.push({ role: 'assistant', text: `step ${i} done`, seq: i, event_id: `reply-${i}` })
  return out
}

const menuEl = () => document.querySelector('.ctxmenu')
const rowOf = (m: Mounted, id: string) =>
  m.el.querySelector(`[data-transcript-row][data-reply-event="${id}"]`) as HTMLElement

async function rightClick(el: Element): Promise<void> {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  assert.ok(menuEl(), 'no menu opened — nothing after this would mean anything')
}

/** counts whole-transcript searches for a reply event's element */
function countSearches(): { count: () => number; restore: () => void } {
  const proto = W.Element.prototype as unknown as { querySelectorAll(s: string): NodeListOf<Element> }
  const orig = proto.querySelectorAll
  let n = 0
  proto.querySelectorAll = function (this: Element, s: string) {
    if (s === '[data-reply-event]') n++
    return orig.call(this, s)
  }
  return { count: () => n, restore: () => { proto.querySelectorAll = orig } }
}

/** counts `class` writes on rows that carry the menu mark */
function countMarkWrites(root: Element): { count: () => Promise<number>; stop: () => void } {
  let n = 0
  const tally = (rs: MutationRecord[]) => {
    for (const r of rs) if ((r.target as Element).classList?.contains('ctx-target')
      || (r.oldValue ?? '').split(/\s+/).includes('ctx-target')) n++
  }
  const mo = new W.MutationObserver(tally)
  mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
  return { count: async () => { await flush(2); tally(mo.takeRecords()); return n }, stop: () => mo.disconnect() }
}

/** a composer keystroke: re-renders the desk and touches nothing in the transcript */
async function type(m: Mounted, text: string): Promise<void> {
  const ta = m.el.querySelector('textarea') as HTMLTextAreaElement
  assert.ok(ta, 'fixture: the desk has a composer')
  const set = Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')!.set!
  await inAct(() => { set.call(ta, text); ta.dispatchEvent(new W.Event('input', { bubbles: true })) })
  await flush(2)
}

// The desk shows a window of the newest CHAT_WINDOW (8) rows: a marked row
// pushed out of it is gone, and so is its menu. Stay inside it.
const UPDATES = 5

test('§1 THE BUG: after a re-key, live updates under an open menu re-search the transcript every render',
  async () => {
    const msgs = transcript(40)
    msgs.push({ role: 'assistant', text: 'streaming', seq: 41, event_id: 'live-1',
      assistant_id: 'as-1', assistant_revision: 1, assistant_state: 'partial',
      assistant_pending: true, assistant_scope: 'turn' })
    const m = await desk(msgs)
    const searches = countSearches()
    try {
      const before = rowOf(m, 'live-1')
      await rightClick(before)
      // the row the menu was raised on is replaced by its durable projection
      m.server.messages[41] = { role: 'assistant', text: 'streaming', seq: 41,
        event_id: 'live-1', native_event_id: 'nat-1' }
      await m.poll()
      assert.notEqual(rowOf(m, 'live-1'), before, 'fixture: the row really was replaced')
      assert.ok(rowOf(m, 'live-1').classList.contains('ctx-target'), 'the mark followed its event')
      const afterRekey = searches.count()
      // …then the agent keeps working: one tool-call round per update
      for (let i = 0; i < UPDATES; i++) {
        m.server.assistantMsg(`tool call ${i}`, { event_id: `tool-${i}` })
        await m.poll()
      }
      assert.ok(menuEl(), 'fixture: the menu is still up for the whole run')
      assert.ok(rowOf(m, 'live-1').classList.contains('ctx-target'), 'and its event is still marked')
      const extra = searches.count() - afterRekey
      assert.ok(extra <= 1,
        `${UPDATES} updates that never touched the marked row cost ${extra} whole-transcript searches (want ≤ 1)`)
    } finally { searches.restore(); await m.unmount() }
  })

test('§2 THE BUG: a render under an open menu rewrites the mark (and the streamer rescans for it)',
  async () => {
    const win = W as unknown as { CSS?: unknown; Highlight?: unknown }
    const hadCSS = Object.getOwnPropertyDescriptor(win, 'CSS')
    const hadHighlight = Object.getOwnPropertyDescriptor(win, 'Highlight')
    Object.defineProperty(win, 'CSS', { value: { highlights: new Map() }, configurable: true, writable: true })
    Object.defineProperty(win, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true, writable: true })
    const m = await desk(transcript(40))
    const boundary = installStreamerBoundary(document)
    const writes = countMarkWrites(m.el)
    try {
      boundary.update(true, { cover: true })
      await rightClick(rowOf(m, 'reply-38'))
      assert.ok(rowOf(m, 'reply-38').classList.contains('ctx-target'), 'fixture: the event is marked')
      await flush(4)
      const marksBefore = await writes.count()
      const scansBefore = streamerScanStats().scans.filter(s => s.trigger === 'mutation').length
      for (let i = 0; i < UPDATES; i++) await type(m, 'x'.repeat(i + 1))
      assert.ok(menuEl(), 'fixture: typing in the composer leaves the menu up')
      assert.ok(rowOf(m, 'reply-38').classList.contains('ctx-target'), 'the mark is still there')
      const marks = (await writes.count()) - marksBefore
      const scans = streamerScanStats().scans.filter(s => s.trigger === 'mutation').length - scansBefore
      assert.equal(marks, 0, `${UPDATES} renders rewrote an unchanged mark ${marks} times`)
      assert.ok(scans <= 1, `${UPDATES} composer keystrokes cost ${scans} streamer rescans (want ≤ 1)`)
    } finally {
      writes.stop(); boundary.update(false); boundary.dispose(); await m.unmount()
      if (hadCSS) Object.defineProperty(win, 'CSS', hadCSS); else delete win.CSS
      if (hadHighlight) Object.defineProperty(win, 'Highlight', hadHighlight); else delete win.Highlight
    }
  })

test('§3 the desk the user saw: earlier messages failing and retrying, menu open, live updates',
  async () => {
    // USER 2026-11-05 23:07Z: the freeze "seems to happen on agent desks that
    // couldn't load earlier messages". The store retries the failed page every
    // 5 s while the desk is shown (convo.ts retryHistory); each retry patches
    // the store twice. Those renders must not remount the marked row, and the
    // menu's mark must stay O(1) through them.
    useFakeClock()
    const g = globalThis as unknown as { fetch: (u: string, i?: unknown) => Promise<unknown> }
    let inner: typeof g.fetch | null = null
    let m: Mounted | null = null
    const searches = countSearches()
    try {
      m = await desk(transcript(60), true)
      const server = m.server
      // every older page fails; the live tail keeps working
      inner = g.fetch
      const pass = inner
      let pages = 0
      g.fetch = (u: string, i?: unknown) => {
        if (!/[?&]before=/.test(String(u))) return pass(u, i)
        pages++
        server.fail = 500
        try { return pass(u, i) } finally { server.fail = null }
      }
      await inAct(() => { loadOlder('org', 'writer', 8) })
      await advance(200)
      assert.ok(pages >= 1, 'fixture: an older page was requested')
      assert.match(m.el.textContent ?? '', /load earlier messages, retrying/,
        'fixture: the desk shows the retrying state')
      const last = rowOf(m, 'reply-60')
      assert.ok(last, 'fixture: the newest row is on screen')
      await rightClick(last)
      const writes = countMarkWrites(m.el)
      const searchesBefore = searches.count(), pagesBefore = pages
      for (let i = 0; i < 4; i++) {
        server.assistantMsg(`tool call ${i}`, { event_id: `tool-${i}` })
        await advance(5000)
      }
      assert.ok(pages - pagesBefore >= 2, `fixture: the failed page was retried (${pages - pagesBefore})`)
      assert.match(m.el.textContent ?? '', /load earlier messages, retrying/, 'fixture: still retrying')
      assert.ok(menuEl(), 'fixture: the menu is still up')
      assert.equal(rowOf(m, 'reply-60'), last, 'a history retry remounted the marked row')
      assert.ok(last.classList.contains('ctx-target'), 'the event is still marked')
      const marks = await writes.count()
      writes.stop()
      assert.equal(marks, 0, `retries and updates rewrote an unchanged mark ${marks} times`)
      const extra = searches.count() - searchesBefore
      assert.ok(extra <= 1, `retries and updates cost ${extra} whole-transcript searches (want ≤ 1)`)
    } finally {
      searches.restore()
      if (inner) g.fetch = inner
      if (m) await m.unmount()
      realClock()
    }
  })
