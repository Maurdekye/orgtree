// frontend/tests/harness.ts — the rig every suite in this folder mounts on.
//
// ⚠ IMPORT ORDER IS LOAD-BEARING. Every test file must import this module
// FIRST, before any `../src/*`. `api.ts` reads `location.pathname` at module
// scope and `desk.tsx` reads `localStorage` during render, so the DOM has to
// exist before their module bodies run. esbuild emits module bodies in import
// order, so "first import wins" is enough — but only if it really is first.
//
// What it provides:
//   • a jsdom window/document/localStorage installed on globalThis
//   • FakeServer — one node's conversation as the SERVER sees it, with the
//     drain/echo handover the real one performs, and a `getChat` projection
//   • a fetch stub routed at the real `api.ts` URLs, with programmable latency,
//     out-of-order delivery and failure injection
//   • deterministic time (node:test's mock timers) plus `flush`/`advance`
//   • mountConvoView() — a real React subscriber, i.e. the actual code path a
//     desk uses, so subscription-gated liveness is exercised rather than faked

import { JSDOM } from 'jsdom'
import { mock } from 'node:test'
import type { ChatMessage, ChatPayload, LiveRowPayload, PendingMail } from '../src/types'

// --------------------------------------------------------------------- DOM
// ⚠ pretendToBeVisual stays OFF: it starts jsdom's own 60 Hz rAF loop on the
// REAL clock, which holds the node event loop open forever — a suite that
// passes and then hangs for its whole timeout. rAF is supplied below instead.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})
const g = globalThis as unknown as Record<string, unknown>
const put = (name: string, value: unknown) => {
  // node 24 defines `navigator`/`location` as accessor properties on the
  // global object, so a plain assignment throws — redefine instead
  Object.defineProperty(g, name, { value, configurable: true, writable: true })
}
put('window', dom.window)
put('document', dom.window.document)
put('navigator', dom.window.navigator)
put('location', dom.window.location)
g.localStorage = dom.window.localStorage
g.HTMLElement = dom.window.HTMLElement
g.Node = dom.window.Node
g.Event = dom.window.Event
g.UIEvent = dom.window.UIEvent
g.MouseEvent = dom.window.MouseEvent
g.KeyboardEvent = dom.window.KeyboardEvent
g.WheelEvent = dom.window.WheelEvent
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16)
g.cancelAnimationFrame = (id: number) => clearTimeout(id)
g.IS_REACT_ACT_ENVIRONMENT = true

// jsdom ships no ResizeObserver, and the sticky-bottom scroll depends on one
// (a switchboard tab toggle re-widths its sibling panels with no React render
// at all — see the ⚠ block in desk.tsx). jsdom does no layout, so a size
// CHANGE is something a test states via `fireResize`; everything else about
// this fake tracks the spec, because the gaps are where a green test starts
// meaning nothing:
//   • `observe()` delivers an INITIAL callback with the element's current
//     size. Real ROs do; production therefore re-pins once on every scroller
//     attach (first mount, and every return to the chat tab), and a fake that
//     skipped it would leave that path modelled by nothing.
//   • `disconnect()` deactivates rather than forgets, so `observe()` after a
//     `disconnect()` works — as it does in a browser. A fake that made
//     re-observation permanently dead would fail a perfectly valid refactor
//     (reuse one observer instead of building a fresh one per attach) for a
//     reason that exists only in the harness.
// Delivery is synchronous here where a real RO batches into the render steps,
// and `fireResize` is manual, so THIS RIG CANNOT MODEL A RESIZE LOOP AT ALL —
// constraint 4 is asserted by reading CSS, never tested here. (An earlier
// version of this comment claimed the loop was unreachable because the
// callback "only writes scrollTop and component-local state". That is wrong:
// `.msgs` is observed content-box and has a laid-out scrollbar gutter, so
// toggling `.jumpbottom` (then an in-flow child) could change scrollHeight,
// hence the gutter, hence the observed width. `.pinuser` is now an absolute
// overlay and cannot contribute that feedback. The real reason a loop is
// implausible is that `.msgs`'s box is flex-determined in all three of its
// homes: `.eye-chat`, `.desk-inner`, `html.mobile .mobsheet-body`.)
// The callback also takes no `entries` argument: code reading
// `entries[0].contentRect` is unmodelled, and would throw here rather than
// pass silently.
type ROCallback = () => void
interface ROEntry { cb: ROCallback; targets: Set<Element>; live: boolean }
const observers: ROEntry[] = []
class FakeResizeObserver {
  private entry: ROEntry
  constructor(cb: ROCallback) {
    this.entry = { cb, targets: new Set(), live: true }
    observers.push(this.entry)
  }
  observe(el: Element) {
    this.entry.live = true
    // re-register: `disconnect()` prunes, so the array cannot grow across a
    // suite, and re-observing after a disconnect still works (as in a browser)
    if (!observers.includes(this.entry)) observers.push(this.entry)
    this.entry.targets.add(el)
    // the spec's initial delivery: asynchronous, at the end of the frame
    queueMicrotask(() => { if (this.entry.live && this.entry.targets.has(el)) this.entry.cb() })
  }
  unobserve(el: Element) { this.entry.targets.delete(el) }
  disconnect() {
    this.entry.targets.clear()
    this.entry.live = false
    const i = observers.indexOf(this.entry)
    if (i >= 0) observers.splice(i, 1)
  }
}
g.ResizeObserver = FakeResizeObserver
/** how many live observers are watching `el` — 0 means nothing would notice
 *  the element changing size, which is the failure this rig exists to catch */
export const resizeWatchers = (el: Element) =>
  observers.filter((o) => o.live && o.targets.has(el)).length
/** deliver a resize to every observer watching `el` */
export const fireResize = (el: Element) => {
  for (const o of [...observers]) if (o.live && o.targets.has(el)) o.cb()
}

process.on('beforeExit', () => { try { dom.window.close() } catch { /* already gone */ } })

export const REPS = Number(process.env.ORGTREE_TEST_REPS || '1') || 1

// -------------------------------------------------------------- the server
/** One node's conversation as the server holds it. Deliberately models the
 *  three carriers a message passes through, in order — the client ghost is not
 *  the server's business, but `pending_mail` → transcript IS, and the handover
 *  between them is where D-51/D-52/D-55 all lived. */
export class FakeServer {
  busy = false
  responding = false
  queued = 0
  last_error: string | null = null
  occupancy: number | null = 1000
  /** …and whether anything MEASURED that number: a compacted agent reports
   *  its post-compaction fill immediately, and until its next turn that fill
   *  is estimated from the summary (backend `occupancy_estimated`) */
  occupancy_estimated: boolean | undefined = undefined
  messages: ChatMessage[] = []
  live: LiveRowPayload[] = []
  pending_mail: PendingMail[] = []
  /** the org's docket, as `GET /work-items` serves it. The desk polls this for
   *  the agent's own docket tab, so a test that leaves it empty gets the empty
   *  panel — which is the honest default, not a stub that hides the tab. */
  workItems: unknown[] = []
  workArchived: unknown[] = []
  workBacklogged: unknown[] = []
  /** every chat request the client has made, newest last */
  requests: { last: number | null; at: number }[] = []
  /** truncation tier the real `node_chat` applies to a pending body */
  bodyCap = 2000
  /** next response fails with this status until cleared */
  fail: number | null = null
  /** ms of latency for the NEXT response only (null = use `latency`) */
  onceLatency: number | null = null
  /** the backend process answering — every real response carries it as
   *  `X-Orgtree-Instance`, and a CHANGE means orgtree was restarted under
   *  this page (see `noteInstance` in api.ts). Change it to model a redeploy. */
  instance = 'inst-0'
  latency = 0
  private seq = 0

  // -- world steps ---------------------------------------------------------
  /** the user posts mail: it lands in the mailbox, undelivered */
  postMail(body: string, id = `m${this.pending_mail.length + 1}`): PendingMail {
    const m: PendingMail = { id, from: '@user', body, at: new Date(Date.now()).toISOString() }
    this.pending_mail.push(m)
    return m
  }

  /** the turn drains the mailbox and the CLI echoes it into the transcript.
   *  `gap` splits the two halves so a test can sit inside the D-55 window. */
  drain(): PendingMail[] {
    const taken = this.pending_mail.splice(0)
    taken.forEach((m) => { m.delivering = true; m.via = 'turn' })
    this._drained = taken
    this.busy = true
    return taken
  }

  private _drained: PendingMail[] = []

  /** the transcript catches up with whatever `drain` took */
  echo(): void {
    this._drained.forEach((m) => this.userMsg(m.body))
    this._drained = []
  }

  /** while the turn is starting, the drained mail is projected back into
   *  `pending_mail` — the real `delivering_mail` + `node_chat` evidence test */
  private projectedPending(): PendingMail[] {
    return [...this._drained.map((m) => ({ ...m, delivering: true })), ...this.pending_mail]
  }

  userMsg(text: string): ChatMessage {
    const m: ChatMessage = { role: 'user', text, seq: this.seq++, ts: new Date(Date.now()).toISOString() }
    this.messages.push(m)
    return m
  }

  /** the server's draft epoch — an opaque token that changes whenever a turn's
   *  streamed text becomes durable (supervisor.draft_epoch). `boot` is the
   *  per-process half; changing it models a backend restart. */
  boot = 'boot0'
  epoch = 0
  draftEpoch(): string { return `${this.boot}:${this.epoch}` }

  /** what `_text_became_durable` does: the reply is now a durable row AND the
   *  epoch advances. Use this instead of `assistantMsg` wherever the point is
   *  that a STREAMED draft has been superseded. */
  textDurable(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    const m = this.assistantMsg(text, extra)
    this.epoch += 1
    return m
  }

  assistantMsg(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    const m: ChatMessage = {
      role: 'assistant', text, seq: this.seq++,
      ts: new Date(Date.now()).toISOString(), ...extra,
    }
    this.messages.push(m)
    return m
  }

  liveRow(kind: string, text: string, id?: string): LiveRowPayload {
    const r: LiveRowPayload = { kind, text, ...(id ? { id } : {}) }
    this.live.push(r)
    return r
  }

  /** the server's own sweep: a live row retires when the transcript carries it */
  sweepLive(): void {
    this.live = this.live.filter((r) => !this.messages.some((m) =>
      m.role === 'assistant' && (m.text || '') === (r.text || '')))
  }

  endTurn(): void {
    this.busy = false
    this.responding = false
    this.live = []
    this._drained = []
  }

  // -- the projection the client actually sees ------------------------------
  chat(last: number | null): ChatPayload {
    const n = last ?? 120
    const cap = this.bodyCap
    return {
      busy: this.busy,
      queued: this.queued,
      responding: this.responding,
      last_error: this.last_error,
      occupancy: this.occupancy,
      occupancy_estimated: this.occupancy_estimated,
      messages: this.messages.slice(-n).map((m) => ({ ...m })),
      live: this.live.map((r) => ({ ...r })),
      draft_epoch: this.draftEpoch(),
      mail_pending: this.pending_mail.length,
      pending_mail: this.projectedPending().map((m) => ({ ...m, body: (m.body || '').slice(0, cap) })),
    }
  }
}

// ---------------------------------------------------------------- transport
export interface Transport {
  server: FakeServer
  /** responses currently held back, oldest first */
  held: (() => void)[]
  /** hold every response until `release()` is called */
  holdAll: boolean
  release(n?: number): void
  releaseLast(): void
  requests: number
}

export function installFetch(server: FakeServer): Transport {
  const t: Transport = {
    server,
    held: [],
    holdAll: false,
    requests: 0,
    release(n = Infinity) {
      const take = t.held.splice(0, n === Infinity ? t.held.length : n)
      take.forEach((f) => f())
    },
    releaseLast() {
      const f = t.held.pop()
      if (f) f()
    },
  }
  g.fetch = (url: string, _init?: unknown): Promise<unknown> => {
    const u = new URL(String(url), 'http://localhost')
    t.requests++
    const last = u.searchParams.get('last')
    if (/\/chat$/.test(u.pathname)) {
      server.requests.push({ last: last ? Number(last) : null, at: Date.now() })
    }
    const status = server.fail
    const lat = server.onceLatency ?? server.latency
    server.onceLatency = null
    // a two-folder scratch tree, so a panel whose identity changes has
    // something to change TO (see render §6.10 — a vacuous pass there would
    // hide exactly the defect it is looking for)
    const sub = u.searchParams.get('path')
    const body = /\/chat$/.test(u.pathname)
      ? server.chat(last ? Number(last) : null)
      : /\/scratch$/.test(u.pathname)
        ? {
          path: sub ?? '',
          entries: sub
            ? [{ name: 'inner.txt', dir: false, size: 7 }]
            : [{ name: 'sub', dir: true, size: 0 },
              { name: 'notes.txt', dir: false, size: 12 }],
        }
        : /\/history$/.test(u.pathname) ? { items: [] }
          : /\/work-items$/.test(u.pathname)
            ? {
              items: server.workItems,
              // the two groups are served only when their flag is set, the
              // same contract the real endpoint keeps
              ...(u.searchParams.get('archived') ? { archived: server.workArchived } : {}),
              ...(u.searchParams.get('backlogged') ? { backlogged: server.workBacklogged } : {}),
              counts: { attention: 0, active: server.workItems.length,
                        archived: server.workArchived.length,
                        backlogged: server.workBacklogged.length },
              now: new Date(Date.now()).toISOString(),
            }
            : { ok: true }
    return new Promise((resolve, reject) => {
      // every real response carries the answering process's id; the stub does
      // too, or the restart detector in `req` would be exercised by nothing
      const headers = new Headers({ 'X-Orgtree-Instance': server.instance })
      const deliver = () => {
        if (status != null) {
          resolve({
            ok: false, status, statusText: `HTTP ${status}`, headers,
            json: () => Promise.resolve({ detail: `boom ${status}` }),
          })
          return
        }
        resolve({ ok: true, status: 200, headers,
                  json: () => Promise.resolve(body) })
      }
      const go = () => { if (lat > 0) setTimeout(deliver, lat); else deliver() }
      if (t.holdAll) t.held.push(go)
      else go()
      void reject
    })
  }
  return t
}

// -------------------------------------------------------------------- time
export function useFakeClock(): void {
  // reset first: a test that fails before its own `realClock()` would
  // otherwise poison every test after it with "MockTimers is already enabled"
  mock.timers.reset()
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
}

export function realClock(): void {
  mock.timers.reset()
}

/** drain the microtask + macrotask queues so pending `.then`s settle. The
 *  timers are mocked; `setImmediate` deliberately is not, which is what makes
 *  this possible at all. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

/** Move the fake clock and let everything it triggered settle.
 *
 *  Wrapped in `act` because the things a tick sets off — a heartbeat fetch
 *  landing, the thinking clock — patch the store from outside React's own
 *  event handling. Without it React warns on every one and, worse, the render
 *  a test then asserts on may not have happened yet. */
export async function advance(ms: number, step = 250): Promise<void> {
  const { act } = await import('react')
  let left = ms
  while (left > 0) {
    const d = Math.min(step, left)
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      mock.timers.tick(d)
      await flush(3)
    })
    left -= d
  }
  await act(async () => { await flush(3) })
}

/** run store mutations (ingest*, addPending, …) where React can see them */
export async function inAct(fn: () => void | Promise<void>): Promise<void> {
  const { act } = await import('react')
  await act(async () => { await fn() })
}

// ------------------------------------------------------------- React views
import { createElement, StrictMode } from 'react'
import type { ReactNode } from 'react'

export interface MountedView<T> {
  /** every snapshot this view has rendered, oldest first */
  frames: T[]
  last(): T
  /** re-render the same root with new props, inside `act` */
  render(next: ReactNode): Promise<T>
  /** advance a mocked clock and flush the resulting React work */
  tick(ms: number, tick: (ms: number) => void): Promise<void>
  unmount(): Promise<void>
  el: HTMLElement
}

/** Mount a component in a fresh container and record what it renders.
 *  `select` turns each render into the value the test compares. */
export async function mountView<T>(
  node: ReactNode, select: (el: HTMLElement) => T,
): Promise<MountedView<T>> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const frames: T[] = []
  await act(async () => { root.render(node) })
  frames.push(select(host))
  return {
    frames,
    el: host,
    last: () => select(host),
    // Re-render the SAME root with new props — for anything whose behaviour
    // depends on a value changing under a mounted component (a replacement
    // cache receipt, a superseded expiry). Mounting a second view would test
    // a fresh component instead, which is the opposite of the question.
    render: async (next: ReactNode) => {
      await act(async () => { root.render(next) })
      frames.push(select(host))
      return select(host)
    },
    // Advance mocked timers with the resulting React work flushed inside
    // `act`, so a subscriber that fires on a tick has actually repainted by
    // the time the assertion runs.
    tick: async (ms: number, tick: (ms: number) => void) => {
      await act(async () => { tick(ms); await Promise.resolve() })
    },
    unmount: async () => {
      await act(async () => { root.unmount() })
      host.remove()
    },
  }
}

export { createElement, StrictMode }
