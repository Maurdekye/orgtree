// EPIC Mode off changes nothing; on, the show starts; off again, every piece
// of it goes away.
//
// Drives `startEpicSync` — what main.tsx runs in every window — against a
// native preference bridge, with the window's and document's listener
// registration counted, a counting AudioContext installed, and the document
// searched for anything EPIC Mode draws. Off, the only thing it may hold is
// its one preference subscription (the same kind the theme, contrast and
// Rainbow syncs hold): no listener, no element, no AudioContext, and the App
// taps stay null. On, all of those appear and the taps stage effects with
// sound; switched off again, every listener added is removed, the stage is
// gone, the AudioContext is closed and the taps are null again.

import { flush } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { startEpicSync } from '../src/epic/sync'
import * as taps from '../src/epic/tap'
import { FAREWELL_MS } from '../src/epic/director'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { fakeAudio } from './epicmode-fakes'

const native = window as unknown as { orgtreeDesktop?: unknown; AudioContext?: unknown }

interface Counted {
  added: string[]
  removed: string[]
  live: () => number
  restore: () => void
}

/** count every listener registered on the window, the document and its body,
 *  matching each removal to its registration (target, type, function, phase) */
function countListeners(): Counted {
  const added: string[] = [], removed: string[] = []
  const targets = [window, document, document.body] as EventTarget[]
  const originals = targets.map(tgt => [tgt.addEventListener, tgt.removeEventListener] as const)
  const live: [EventTarget, string, unknown, boolean][] = []
  const phase = (opts: unknown) => !!(typeof opts === 'boolean' ? opts : (opts as { capture?: boolean } | undefined)?.capture)
  for (const tgt of targets) {
    const [add, remove] = [tgt.addEventListener, tgt.removeEventListener]
    tgt.addEventListener = function (this: EventTarget, type: string, fn: unknown, opts?: unknown) {
      added.push(type)
      if (!live.some(([a, b, c, d]) => a === this && b === type && c === fn && d === phase(opts))) live.push([this, type, fn, phase(opts)])
      return add.call(this, type, fn as EventListener, opts as AddEventListenerOptions)
    } as typeof tgt.addEventListener
    tgt.removeEventListener = function (this: EventTarget, type: string, fn: unknown, opts?: unknown) {
      removed.push(type)
      const i = live.findIndex(([a, b, c, d]) => a === this && b === type && c === fn && d === phase(opts))
      if (i >= 0) live.splice(i, 1)
      return remove.call(this, type, fn as EventListener, opts as EventListenerOptions)
    } as typeof tgt.removeEventListener
  }
  return {
    added, removed,
    live: () => live.length,
    restore: () => targets.forEach((tgt, i) => {
      tgt.addEventListener = originals[i]![0]
      tgt.removeEventListener = originals[i]![1]
    }),
  }
}

function installBridge(t: TestContext, initial: Partial<NativePreferences> = {}) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES, ...initial }
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const bridge = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => {
      saved = { ...saved, ...preferencesPatch(patch) }
      for (const fn of [...listeners]) fn({ type: 'preferences', data: saved })
      return saved
    },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
  native.orgtreeDesktop = bridge
  t.after(() => { native.orgtreeDesktop = previous })
  return { bridge, subscriptions: () => listeners.size }
}

const stageCount = () => document.querySelectorAll('canvas.epic-stage, [data-epic]').length

/** the ordinary app's own traffic, as App.tsx would hand it to the taps */
function appTraffic(): void {
  taps.epic?.frame('acme', { type: 'mail', from: 'boss', to: 'alice' })
  taps.epic?.frame('acme', { type: 'node_event', node: 'alice', event: 'frozen' })
  document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }))
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
}

test('EPIC Mode off: one preference subscription and nothing else — no listener, element, audio or tap', async t => {
  assert.equal(typeof startEpicSync, 'function', 'the EPIC sync exists')
  const { subscriptions } = installBridge(t, {})
  const audio = fakeAudio()
  native.AudioContext = audio.Ctor
  t.after(() => { delete native.AudioContext })
  const counted = countListeners()
  t.after(() => counted.restore())
  const stop = startEpicSync()
  t.after(() => stop())
  await flush(10)
  appTraffic()
  await flush(10)
  assert.equal(subscriptions(), 1, 'exactly one native preference subscription')
  assert.equal(counted.added.length, 0, `no window/document listener (saw: ${counted.added.join(', ')})`)
  assert.equal(stageCount(), 0, 'nothing drawn into the document')
  assert.equal(audio.log.created, 0, 'no AudioContext created')
  assert.equal(taps.epic === null, true, 'the App taps stay null')
})

test('EPIC Mode on starts the show; off again removes every piece of it', async t => {
  assert.equal(typeof startEpicSync, 'function', 'the EPIC sync exists')
  const { bridge, subscriptions } = installBridge(t, {})
  const audio = fakeAudio()
  native.AudioContext = audio.Ctor
  t.after(() => { delete native.AudioContext })
  const counted = countListeners()
  t.after(() => counted.restore())
  const stop = startEpicSync()
  t.after(() => stop())
  await flush(10)
  assert.equal(stageCount(), 0)

  await bridge.setPreferences({ epicMode: true })
  await flush(20)
  assert.equal(stageCount(), 1, 'the stage is up')
  assert.equal(audio.log.created, 1, 'one AudioContext')
  assert.equal(taps.epic !== null, true, 'the taps are installed')
  assert.equal(counted.live() > 0, true, 'the user\'s hands are being watched')
  const nodesBefore = audio.log.nodes
  appTraffic()
  await flush(5)
  assert.equal(audio.log.nodes > nodesBefore, true, 'the traffic was staged with sound')

  await bridge.setPreferences({ epicMode: false })
  await flush(5)
  assert.equal(taps.epic === null, true, 'the taps are removed at once')
  assert.equal(counted.live() <= 1, true, `the user's hands are let go at once; only the stage's own resize listener stays for the power-down (live ${counted.live()})`)
  assert.equal(stageCount(), 1, 'the power-down is still playing')
  await new Promise(r => setTimeout(r, FAREWELL_MS + 150))
  await flush(5)
  assert.equal(counted.live(), 0, `every listener added was removed (added ${counted.added.length}, removed ${counted.removed.length})`)
  assert.equal(stageCount(), 0, 'the stage is gone after the power-down')
  assert.equal(audio.log.closed, 1, 'the AudioContext is closed')
  assert.equal(subscriptions(), 1, 'back to the one preference subscription')
  const nodesAfter = audio.log.nodes
  appTraffic()
  await flush(5)
  assert.equal(audio.log.nodes, nodesAfter, 'nothing is staged once it is off')
  assert.equal(stageCount(), 0)
})

test('a window that opens with EPIC Mode already on starts the show without a click', async t => {
  assert.equal(typeof startEpicSync, 'function', 'the EPIC sync exists')
  installBridge(t, { epicMode: true })
  const audio = fakeAudio()
  native.AudioContext = audio.Ctor
  t.after(() => { delete native.AudioContext })
  const stop = startEpicSync()
  await flush(20)
  assert.equal(stageCount(), 1)
  assert.equal(audio.log.created, 1)
  stop()
  await flush(5)
  assert.equal(stageCount(), 0, 'stopping the sync takes the show down at once')
  assert.equal(audio.log.closed, 1)
  assert.equal(taps.epic === null, true)
})
