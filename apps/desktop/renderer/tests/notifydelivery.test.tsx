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
  notificationsEnabled: true,
  notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true,
  notifyTerminalFailures: true,
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

// ── THE TWO-WINDOW CASE ──────────────────────────────────────────────────────
// Raised in independent review by notify-review, and ANSWERED BY THE USER on
// 2026-09-12 21:03 when they were shown this exact collision and picked "keep
// it as it is".
//
// The collision: their ruling says a question card suppresses its toast only
// when it is in the window they are actually in — so a card on a second monitor
// should still toast. Their `notifyWhileFocused` setting says nothing should
// interrupt them while they are inside Orgtree at all. With the main window
// focused and the card in an unfocused popout, those two disagree.
//
// The user chose the setting. That is coherent rather than a compromise,
// because THE TWO SUPPRESSIONS ARE DIFFERENT IN KIND and only one of them loses
// anything:
//   · the card-visibility rule DISCARDS — `questionVisible` writes the notice
//     into the seen history in localStorage and no later poll ever raises it
//     again. That was the defect; fixing it is what this branch is for.
//   · `notifyWhileFocused` DEFERS — `notify()` returns before the gate takes
//     the key, so nothing is marked seen, and the next ordinary poll after they
//     leave Orgtree delivers it.
// So the answer costs the user a few seconds, never a request.
//
// Both cases below differ in EXACTLY ONE variable: which window the user is in.
// Same card, same popout, same preferences, Orgtree focused in both. Each then
// watches what happens once the user leaves Orgtree entirely, which is where
// "deferred" and "discarded" stop looking alike.
//
// ⚠ The two cases use DISTINCT identities on purpose. `seen` in notifications.ts
// is module state shared by every test in this process, and `localStorage.clear()`
// does not touch it — reusing an id here made the second case silently skip
// dispatch on the first case's delivery record rather than on its own logic.
function geometry(el: HTMLElement) {
  const rect = { left: 10, top: 10, right: 300, bottom: 200, width: 290, height: 190 }
  el.getBoundingClientRect = () => rect as DOMRect
  el.getClientRects = () => [rect] as unknown as DOMRectList
}
function stateFocus(doc: Document, value: boolean) {
  Object.defineProperty(doc, 'hasFocus', { configurable: true, value: () => value })
}

/** Drives the real renderer hook against the real main-process notifier with the
 *  question card living in a popped-out window. Orgtree holds focus in phase
 *  one either way; `userIsWithTheCard` chooses WHICH window they are in. Then
 *  the user leaves Orgtree and it polls again. A work-attention row rides along
 *  as the control: nothing about it is decided per window, so it must behave
 *  identically in both cases. */
async function twoWindows(userIsWithTheCard: boolean) {
  const tag = userIsWithTheCard ? 'with' : 'away'
  const askId = `q-${tag}`, question = `question:ask-${tag}`, control = `work-attention:work-${tag}`
  const crossAsk = { id: askId, node: 'agent', kind: 'question', status: 'open',
    question: 'Which lane should this run on?' } as AskInfo
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const shown: string[] = []
  let inOrgtree = true
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
    () => inOrgtree)
  let emit: (event: { type: string; data: unknown }) => void = () => {}
  const rows = projection([
    { id: `ask-${tag}`, org: 'orgtree', kind: 'question', source_id: askId,
      title: 'Question from a peer', body: 'Which lane should this run on?' },
    { id: `work-${tag}`, org: 'orgtree', kind: 'work-attention', item: 'some-ticket',
      title: 'Some ticket', body: 'Confirm the edge case.' },
  ])
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
  let whileInside: string[] = []
  try {
    const card = v.el.querySelector<HTMLElement>('.askcard')!
    const home = card.parentElement!          // React owns this node; put it back
    geometry(card)
    // The card lives in the popout in both cases. Only the user moves.
    popout.window.document.body.appendChild(popout.window.document.adoptNode(card))
    geometry(card)
    stateFocus(popout.window.document as unknown as Document, userIsWithTheCard)
    stateFocus(document, !userIsWithTheCard)
    await inAct(async () => { await flush(20) })
    await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
    whileInside = [...shown]

    // …and now they click away to something that is not Orgtree at all.
    inOrgtree = false
    stateFocus(popout.window.document as unknown as Document, false)
    stateFocus(document, false)
    await inAct(async () => { emit({ type: 'notification-poll', data: null }); await flush(20) })
    home.appendChild(document.adoptNode(card))
  } finally {
    await v.unmount(); globalThis.fetch = original
    Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
    realClock()
  }
  return { whileInside, afterLeaving: shown, question, control }
}

test('TWO WINDOWS: a question on the other monitor waits for the user to leave Orgtree, and is never lost', async () => {
  const { whileInside, afterLeaving, question, control } = await twoWindows(false)
  console.log('user in the MAIN window -> inside:', whileInside, 'after leaving:', afterLeaving)
  assert.deepEqual(whileInside, [],
    'the user is inside Orgtree and chose notifyWhileFocused=false, so nothing interrupts them there '
    + '(user ruling 2026-09-12 21:03, shown this exact case)')
  assert.ok(afterLeaving.includes(question),
    'THE POINT: the card was never in front of them, so the request was not consumed — '
    + 'it arrives on the first poll after they leave, with no new event and nothing prompting it')
  assert.ok(afterLeaving.includes(control),
    'and the attention row, which no window decides, behaves the same way')
})

test('TWO WINDOWS: the same question is consumed for good when the user IS in the window showing it', async () => {
  const { whileInside, afterLeaving, question, control } = await twoWindows(true)
  console.log('user in the POPOUT with the card -> inside:', whileInside, 'after leaving:', afterLeaving)
  assert.deepEqual(whileInside, [], 'nothing interrupts them while they are inside Orgtree either way')
  assert.ok(!afterLeaving.includes(question),
    'this card WAS in front of them, so it has reached them: leaving must not raise it later. '
    + 'This is the one suppression that is permanent, and it is permanent on purpose')
  assert.ok(afterLeaving.includes(control),
    'the control still arrives, so the absence above is the question rule and not a dead poll')
})
