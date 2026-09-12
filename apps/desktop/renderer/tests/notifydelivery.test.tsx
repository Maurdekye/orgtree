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
