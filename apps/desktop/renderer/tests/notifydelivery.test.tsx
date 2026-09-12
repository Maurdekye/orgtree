// Reproduction probe for the 2.1.0 attention/question delivery defect.
// Wires the REAL renderer hook to the REAL main-process notifier, with the
// projection shape and stored preferences taken from the user's live install.
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useNativeNotifications } from '../src/notifications'
import { bumpLive } from '../src/livebus'
import type { DesktopNotice } from '../src/notifications'
import { NativeNotifications } from '../../main/notifications'
import { JSDOM } from 'jsdom'
import { AskCard } from '../src/canvas/asks'
import { questionVisible } from '../src/notification-visibility'
import type { AskInfo } from '../src/types'

// exactly what is on the user's disk right now
const LIVE_PREFS = {
  notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true,
  notifyAllMail: false, notifyDocuments: false, notifyFrozen: false, notifyWhileFocused: false,
}

function projection(extra: DesktopNotice[] = []) {
  const documents: DesktopNotice[] = Array.from({ length: 46 }, (_, i) => ({
    id: `doc-${i}`, org: 'orgtree', kind: 'document', source_id: `d${i}`,
    title: `Document ${i}`, body: 'Presented by someone', agent: 'someone',
  }))
  const routine: DesktopNotice = { id: 'mail-1', org: 'orgtree', kind: 'routine', source_id: 'm1',
    title: 'Message from peer', body: 'text' }
  const rows = [...extra, routine, ...documents]
  return rows
}

async function run(extra: DesktopNotice[], focused = false) {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const shown: string[] = []
  const native = new NativeNotifications(
    (data: DesktopNotice) => {
      const listeners: Record<string, (() => void)[]> = {}
      return {
        on(event: string, fn: () => void) { (listeners[event] ??= []).push(fn) },
        show() { shown.push(`${data.kind}:${data.id}`); for (const fn of listeners.show ?? []) fn() },
        close() {},
      }
    },
    () => {},
    () => focused)
  let emit: (event: { type: string; data: unknown }) => void = () => {}
  let rows = projection(extra)
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getPreferences: async () => ({ ...LIVE_PREFS }),
    notify: (n: unknown) => native.notify(n, LIVE_PREFS),
    syncNotifications: async (active: unknown) => native.sync(active),
    onEvent: (fn: typeof emit) => { emit = fn; return () => { emit = () => {} } },
  } })
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(), json: async () => ({
    notices: rows, total: rows.length, truncated: false,
    active: rows.map(({ org, id }) => ({ org, id })),
  }) }) as unknown as Response
  function View() { useNativeNotifications(() => {}); return <div>owner</div> }
  const v = await mountView(<View />, el => el)
  try {
    await inAct(async () => { await flush(20) })
    await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
  } finally {
    await v.unmount(); globalThis.fetch = original
    Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
    realClock()
  }
  return shown
}

// The real app has been polling for hours before the event happens.
async function runArriving(extra: DesktopNotice[], focused = false) {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const shown: string[] = []
  const native = new NativeNotifications(
    (data: DesktopNotice) => {
      const listeners: Record<string, (() => void)[]> = {}
      return {
        on(event: string, fn: () => void) { (listeners[event] ??= []).push(fn) },
        show() { shown.push(`${data.kind}:${data.id}`); for (const fn of listeners.show ?? []) fn() },
        close() {},
      }
    },
    () => {},
    () => focused)
  let emit: (event: { type: string; data: unknown }) => void = () => {}
  let rows = projection()                        // nothing to alert about yet
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getPreferences: async () => ({ ...LIVE_PREFS }),
    notify: (n: unknown) => native.notify(n, LIVE_PREFS),
    syncNotifications: async (active: unknown) => native.sync(active),
    onEvent: (fn: typeof emit) => { emit = fn; return () => { emit = () => {} } },
  } })
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(), json: async () => ({
    notices: rows, total: rows.length, truncated: false,
    active: rows.map(({ org, id }) => ({ org, id })),
  }) }) as unknown as Response
  function View() { useNativeNotifications(() => {}); return <div>owner</div> }
  const v = await mountView(<View />, el => el)
  try {
    // several quiet polls first, exactly as the running app does every 5 s
    await inAct(async () => { await flush(20) })
    for (let i = 0; i < 3; i++) {
      await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
    }
    assert.deepEqual(shown, [], 'nothing is alerted while the projection is quiet')
    rows = projection(extra)                      // the event happens
    await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
  } finally {
    await v.unmount(); globalThis.fetch = original
    Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
    realClock()
  }
  return shown
}

test('REPRO: a question that ARRIVES while the app is running reaches the OS', async () => {
  const shown = await runArriving([{ id: 'ask-new', org: 'orgtree', kind: 'question', source_id: 'qe5fc0dfa',
    title: 'Question from state-audit', body: 'Which providers get API-key accounts?' }])
  console.log('arriving question ->', shown)
  assert.deepEqual(shown, ['question:ask-new'])
})

test('REPRO: an attention flag RAISED while the app is running reaches the OS', async () => {
  const shown = await runArriving([{ id: 'work-new', org: 'orgtree', kind: 'work-attention', item: 'some-ticket',
    title: 'Some ticket', body: 'Confirm the edge case I chose.', agent: 'owner' }])
  console.log('arriving attention ->', shown)
  assert.deepEqual(shown, ['work-attention:work-new'])
})

// The user's install is a busy org: the websocket 'changed' handler and every
// non-GET call bumpLive(), coalesced to 120 ms, so mutations land during the
// notification read and the IPC sync more or less continuously.
test('REPRO: continuous mutation traffic must not starve dispatch', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const shown: string[] = []
  let reads = 0, syncs = 0, notifies = 0
  const native = new NativeNotifications(
    (data: DesktopNotice) => {
      const listeners: Record<string, (() => void)[]> = {}
      return {
        on(event: string, fn: () => void) { (listeners[event] ??= []).push(fn) },
        show() { shown.push(`${data.kind}:${data.id}`); for (const fn of listeners.show ?? []) fn() },
        close() {},
      }
    },
    () => {},
    () => false)
  let emit: (event: { type: string; data: unknown }) => void = () => {}
  const rows = projection([
    { id: 'ask-busy', org: 'orgtree', kind: 'question', source_id: 'qe5fc0dfa',
      title: 'Question from state-audit', body: 'Which providers get API-key accounts?' },
    { id: 'work-busy', org: 'orgtree', kind: 'work-attention', item: 'redesign-api-key-inference-accounts',
      title: 'Redesign API-key inference accounts', body: 'An attached question needs your answer.' },
  ])
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getPreferences: async () => ({ ...LIVE_PREFS }),
    notify: (n: unknown) => { notifies++; return native.notify(n, LIVE_PREFS) },
    syncNotifications: async (active: unknown) => { syncs++; native.sync(active) },
    onEvent: (fn: typeof emit) => { emit = fn; return () => { emit = () => {} } },
  } })
  // a loaded engine answering the 47-row projection, not an instant stub
  globalThis.fetch = async () => {
    reads++
    await new Promise(resolve => setTimeout(resolve, 300))
    return { ok: true, headers: new Headers(), json: async () => ({
      notices: rows, total: rows.length, truncated: false,
      active: rows.map(({ org, id }) => ({ org, id })),
    }) } as unknown as Response
  }
  function View() { useNativeNotifications(() => {}); return <div>owner</div> }
  const v = await mountView(<View />, el => el)
  try {
    // ten seconds of ordinary org activity: a live bump every 200 ms
    for (let i = 0; i < 50; i++) { bumpLive(); await advance(200) }
  } finally {
    await v.unmount(); globalThis.fetch = original
    Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
    realClock()
  }
  console.log(`busy-org probe: reads=${reads} syncs=${syncs} notifies=${notifies} delivered ->`, shown)
  assert.deepEqual(shown.sort(), ['question:ask-busy', 'work-attention:work-busy'],
    'a busy organization must still deliver its attention and question alerts')
})

test('REPRO: a question row in the live projection reaches the OS', async () => {
  const shown = await run([{ id: 'ask-cold', org: 'orgtree', kind: 'question', source_id: 'qcold',
    title: 'Question from state-audit', body: 'Which providers get API-key accounts?' }])
  console.log('question probe delivered ->', shown)
  assert.deepEqual(shown, ['question:ask-cold'])
})

test('REPRO: a work-attention row in the live projection reaches the OS', async () => {
  const shown = await run([{ id: 'work-cold', org: 'orgtree', kind: 'work-attention', item: 'cold-ticket',
    title: 'Some ticket', body: 'Confirm the edge case I chose.', agent: 'owner' }])
  console.log('attention probe delivered ->', shown)
  assert.deepEqual(shown, ['work-attention:work-cold'])
})

// ── THE CROSS-WINDOW CASE ────────────────────────────────────────────────────
// Raised in independent review by notify-review, and it is a fair question:
// the renderer now refuses to let an UNFOCUSED card suppress its own question,
// but the main process still applies `notifyWhileFocused`, so with the main
// window focused and the card sitting on a second monitor nothing toasts.
//
// That is not the defect this branch fixes, and the difference is the whole
// point. The visibility bug DISCARDED the alert: it wrote the notice into
// `seen` in localStorage and no later poll would ever raise it again. The
// focus preference DEFERS it — `notify()` returns before `gate.take`, so
// nothing is marked seen, and the moment the user leaves Orgtree the next
// ordinary poll delivers it. One loses the request; the other holds it until
// the user is somewhere it can be seen, which is what they asked the
// preference for.
//
// Whether the question focus rule should ALSO override an explicitly chosen
// `notifyWhileFocused` is a product decision the ticket does not settle, and
// it is with the user. This test pins what the code does today either way, so
// a change to that answer has to come with a deliberate edit here.
const crossAsk = { id: 'q-cross', node: 'agent', kind: 'question', status: 'open',
  question: 'Which lane should this run on?' } as AskInfo
function geometry(el: HTMLElement) {
  const rect = { left: 10, top: 10, right: 300, bottom: 200, width: 290, height: 190 }
  el.getBoundingClientRect = () => rect as DOMRect
  el.getClientRects = () => [rect] as unknown as DOMRectList
}
function stateFocus(doc: Document, value: boolean) {
  Object.defineProperty(doc, 'hasFocus', { configurable: true, value: () => value })
}

test('CROSS-WINDOW: a card on a second monitor never silences its question, and the focus preference defers the alert rather than losing it', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const shown: string[] = []
  let appFocused = true                      // the user is in the MAIN window
  const native = new NativeNotifications(
    (data: DesktopNotice) => {
      const listeners: Record<string, (() => void)[]> = {}
      return {
        on(event: string, fn: () => void) { (listeners[event] ??= []).push(fn) },
        show() { shown.push(`${data.kind}:${data.id}`); for (const fn of listeners.show ?? []) fn() },
        close() {},
      }
    },
    () => {},
    () => appFocused)
  let emit: (event: { type: string; data: unknown }) => void = () => {}
  const rows = projection([{ id: 'ask-cross', org: 'orgtree', kind: 'question', source_id: 'q-cross',
    title: 'Question from a peer', body: 'Which lane should this run on?' }])
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getPreferences: async () => ({ ...LIVE_PREFS }),
    notify: (n: unknown) => native.notify(n, LIVE_PREFS),
    syncNotifications: async (active: unknown) => native.sync(active),
    onEvent: (fn: typeof emit) => { emit = fn; return () => { emit = () => {} } },
  } })
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(), json: async () => ({
    notices: rows, total: rows.length, truncated: false,
    active: rows.map(({ org, id }) => ({ org, id })),
  }) }) as unknown as Response
  function View() {
    useNativeNotifications(() => {})
    return <AskCard ask={crossAsk} slug="orgtree" toast={() => {}} />
  }
  const v = await mountView(<View />, el => el)
  const popout = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
  try {
    const card = v.el.querySelector<HTMLElement>('.askcard')!
    const home = card.parentElement!     // React owns this node; put it back before unmount
    geometry(card)
    stateFocus(document, true)
    // the card is moved to the popout on the second monitor, which is open and
    // uncovered but is NOT the window the user is typing in
    popout.window.document.body.appendChild(popout.window.document.adoptNode(card))
    geometry(card)
    stateFocus(popout.window.document as unknown as Document, false)
    assert.equal(questionVisible('orgtree', 'q-cross'), false,
      'a card in a window the user is not in has reached nobody, so it must not suppress anything')

    await inAct(async () => { await flush(20) })
    await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
    assert.deepEqual(shown, [],
      'the user is inside Orgtree and chose notifyWhileFocused=false, so nothing interrupts them there')

    // THE POINT: the request was not consumed. Leaving Orgtree delivers it on
    // the very next ordinary poll — no restart, no new event, nothing lost.
    appFocused = false
    await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
    assert.deepEqual(shown, ['question:ask-cross'],
      'the focus preference defers the alert; the visibility bug this branch fixes DISCARDED it')
    home.appendChild(document.adoptNode(card))
  } finally {
    await v.unmount(); globalThis.fetch = original
    Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
    realClock()
  }
})
