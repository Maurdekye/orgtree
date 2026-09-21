// heldbus.test.tsx — the renderer half of "held until somebody is listening".
//
// THE DEFECT UNDER TEST, and it is not hypothetical. Native holds four event
// types a renderer cannot rediscover and releases the hold on evidence of a
// consumer. The evidence it accepts is `ipcRenderer.on('desktop:event')`,
// which the preload sends from inside `onEvent` — so the FIRST `onEvent`
// anywhere in the document ends the holding. In this renderer that is
// `startThemeSync()`, which cares about `preferences` alone, and the four held
// events are then delivered to a document whose consumers for them are React
// effects that have not run. The user-visible result is the exact failure the
// outbox exists to prevent: a notification clicked on a cold start opens a
// window that does nothing.
//
// So the properties below are about KEEPING, not routing. §1 is arrival before
// any consumer, §2 is the no-replay rule that a naive fix gets wrong, §3 is the
// two drain routes not double-delivering, §4 pins the type set against the main
// process's own list, and §5 pins the ordering in main.tsx, which is the one
// thing nothing at runtime can check.
//
// Run:  node apps/desktop/renderer/tests/run.mjs heldbus
import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  HELD_TYPES, heldEventStats, onHeldEvent, resetHeldEvents, startHeldEvents,
} from '../src/events/heldbus'

declare const __SRC_DIR__: string
const src = (p: string) => fs.readFileSync(path.join(__SRC_DIR__, p), 'utf8')

type Nativeish = { type: string; data?: unknown }
type Listener = (event: Nativeish) => void

/** A bridge that behaves the way the real one does: `onEvent` is the ack, and
 *  `takePendingWindowEvents` drains the SAME queue, once. */
function fakeBridge(held: { type: string; data?: unknown }[] = []) {
  const listeners = new Set<Listener>()
  let queue = [...held]
  let acked = 0
  const bridge = {
    onEvent(fn: Listener) {
      listeners.add(fn)
      acked += 1
      // the ack: native drains and sends, synchronously, to whoever is
      // attached AT THAT MOMENT — which is the whole problem being fixed
      const drained = queue
      queue = []
      for (const e of drained) for (const l of [...listeners]) l(e)
      return () => { listeners.delete(fn) }
    },
    async takePendingWindowEvents() {
      const drained = queue
      queue = []
      return drained
    },
    send(event: { type: string; data?: unknown }) {
      for (const l of [...listeners]) l(event)
    },
    acks: () => acked,
    pending: () => queue.length,
  }
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = bridge
  return bridge
}

const clear = () => {
  resetHeldEvents()
  delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
}

// --------------------------------------------- §1 arrival before a consumer

test('§1 an event delivered before ANY consumer exists is kept, not dropped', async () => {
  clear()
  const bridge = fakeBridge([{ type: 'notification-click', data: { id: 'ask:7', org: 'studio' } }])
  startHeldEvents()
  await flush()
  // the ack already discharged it. Nothing in the app has mounted.
  assert.equal(bridge.pending(), 0, 'native considers it delivered')
  assert.equal(heldEventStats().waiting, 1, 'and the renderer is holding it')

  const got: unknown[] = []
  onHeldEvent('notification-click', (e) => got.push(e.data))
  assert.deepEqual(got, [{ id: 'ask:7', org: 'studio' }],
    'the real consumer gets it the moment it registers')
})

test('§1.1 it is handed over SYNCHRONOUSLY, inside the registering call', () => {
  clear()
  fakeBridge([{ type: 'open-org', data: { org: 'studio' } }])
  startHeldEvents()
  let seen = false
  onHeldEvent('open-org', () => { seen = true })
  // ⚠ NOT `await flush()`. A React effect that subscribes must see a cold-open
  // event in the SAME commit, or the view paints once without it — which for
  // `open-org` is a visible flash of the wrong organization.
  assert.equal(seen, true, 'no frame passes between registering and receiving')
})

test('§1.2 arrival order is preserved across several of one type', () => {
  clear()
  fakeBridge([
    { type: 'restore-skipped', data: { orgs: ['a'] } },
    { type: 'restore-skipped', data: { orgs: ['b'] } },
  ])
  startHeldEvents()
  const got: unknown[] = []
  onHeldEvent('restore-skipped', (e) => got.push((e.data as { orgs: string[] }).orgs[0]))
  assert.deepEqual(got, ['a', 'b'])
})

test('§1.3 a LIVE event with no consumer yet is kept too, not only a cold one', async () => {
  clear()
  const bridge = fakeBridge()
  startHeldEvents()
  await flush()   // the opening take settles; see §3.3 for why that matters
  // native sent this because a listener existed — ours. The app's own consumer
  // still has not mounted, and this is the ordinary case during startup.
  bridge.send({ type: 'open-org', data: { org: 'workshop' } })
  assert.equal(heldEventStats().waiting, 1)
  const got: unknown[] = []
  onHeldEvent('open-org', (e) => got.push(e.data))
  assert.deepEqual(got, [{ org: 'workshop' }])
})

test('§1.4 an unheld type is ignored entirely — this is not a second router', () => {
  clear()
  const bridge = fakeBridge()
  startHeldEvents()
  bridge.send({ type: 'preferences', data: { theme: 'dark' } })
  bridge.send({ type: 'window-state', data: {} })
  assert.deepEqual(heldEventStats(), { waiting: 0, dropped: 0, delivered: 0, types: [] },
    'the twenty other event types keep flowing through their own subscriptions')
})

// ------------------------------------------------------ §2 no replay, ever

test('§2 an event handed over once is GONE — a remount does not replay it', () => {
  clear()
  fakeBridge([{ type: 'notification-click', data: { id: 'ask:7', org: 'studio' } }])
  startHeldEvents()
  const first: unknown[] = []
  const off = onHeldEvent('notification-click', (e) => first.push(e.data))
  assert.equal(first.length, 1)
  off()
  // ⚠ THE BUG A NAIVE FIX INTRODUCES. If unsubscribing put the event back,
  // every remount of the consumer would re-open the same notification — one
  // click becoming N reveals, which is worse than the miss and much harder to
  // see, because each one looks like a real click.
  const second: unknown[] = []
  onHeldEvent('notification-click', (e) => second.push(e.data))
  assert.deepEqual(second, [], 'nothing is replayed to the next subscriber')
})

test('§2.1 a live event reaches every registered consumer exactly once', async () => {
  clear()
  const bridge = fakeBridge()
  startHeldEvents()
  await flush()
  const a: unknown[] = []; const b: unknown[] = []
  onHeldEvent('window-identity', (e) => a.push(e.data))
  onHeldEvent('window-identity', (e) => b.push(e.data))
  bridge.send({ type: 'window-identity', data: { windowId: 'w1' } })
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
})

test('§2.2 one consumer throwing does not eat the event for the others', async () => {
  clear()
  const bridge = fakeBridge()
  startHeldEvents()
  await flush()
  const ok: unknown[] = []
  onHeldEvent('open-org', () => { throw new Error('a consumer with a bug') })
  onHeldEvent('open-org', (e) => ok.push(e.data))
  bridge.send({ type: 'open-org', data: { org: 'studio' } })
  assert.deepEqual(ok, [{ org: 'studio' }])
})

// ------------------------------------------------ §3 the two drain routes

test('§3 the ack route and the explicit take cannot deliver the same event twice', async () => {
  clear()
  const bridge = fakeBridge([{ type: 'open-org', data: { org: 'studio' } }])
  startHeldEvents()
  await flush()
  const got: unknown[] = []
  onHeldEvent('open-org', (e) => got.push(e.data))
  // ⚠ BOTH ROUTES RUN, DELIBERATELY. `window-outbox.ts` names the explicit
  // take as the route for a renderer that wants certainty rather than relying
  // on the host's signal, and both drain the same queue idempotently — so
  // whichever arrives first returns the events and the other returns nothing.
  assert.deepEqual(got, [{ org: 'studio' }], 'exactly once, not twice')
  assert.equal(bridge.acks(), 1, 'and exactly one listener was attached')
})

test('§3.1 with no bridge at all it is inert and does not throw', async () => {
  clear()
  const stop = startHeldEvents()
  await flush()
  const got: unknown[] = []
  onHeldEvent('open-org', (e) => got.push(e))
  assert.deepEqual(got, [], 'a browser has no native hold to complete')
  stop()
})

test('§3.2 starting twice attaches one listener — main.tsx and a harness may both call', async () => {
  clear()
  const bridge = fakeBridge()
  startHeldEvents()
  startHeldEvents()
  await flush()
  assert.equal(bridge.acks(), 1)
})

// ------------------------- §3.3 the two routes RACE, and neither is prompt
//
// ⚠ AN EARLIER COMMENT IN heldbus.ts CALLED THE ACK SYNCHRONOUS. It is not:
// `ipcRenderer.send` is asynchronous IPC, so the preload's ack reaches the main
// process on its own turn and what it releases comes back as ordinary sends.
// The take is a promise. So which route drains the outbox is a race, and when
// the TAKE wins it the held events come back a tick later — while the queue is
// already unheld, so a NEWER live event can reach the listener first.
//
// The failure that guards against is an ordering one, and it is the kind that
// reads as working: the consumer gets the new `open-org` and then the older one
// it superseded, and the window ends up on the organization the user left.

/** The take wins the race: it returns the queued event, and a live event is
 *  sent before the take's promise settles. */
function racingBridge(queued: Nativeish[], live: Nativeish[]) {
  const listeners = new Set<Listener>()
  let queue = [...queued]
  let release!: (v: Nativeish[]) => void
  const taken = new Promise<Nativeish[]>((r) => { release = r })
  const bridge = {
    onEvent(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } },
    takePendingWindowEvents() {
      const drained = queue
      queue = []
      // ⚠ the take DRAINED, so native is no longer holding — which is exactly
      // why a live event may now be sent — but the renderer has not been told
      // yet, because a promise settles on a later turn.
      for (const e of live) for (const l of [...listeners]) l(e)
      return taken
    },
    settle: () => { release([...queued]) },
  }
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = bridge
  return bridge
}

test('§3.3 an older queued event is delivered BEFORE a live one that overtook it', async () => {
  clear()
  const b = racingBridge(
    [{ type: 'open-org', data: { org: 'the-one-they-left' } }],
    [{ type: 'open-org', data: { org: 'the-one-they-went-to' } }],
  )
  startHeldEvents()
  const got: string[] = []
  onHeldEvent('open-org', (e) => got.push((e.data as { org: string }).org))
  // the live event has already reached the listener; nothing may be handed
  // over yet, because the take is still outstanding
  assert.deepEqual(got, [], 'the live event waits while a take is in flight')
  b.settle()
  await flush()
  assert.deepEqual(got, ['the-one-they-left', 'the-one-they-went-to'],
    'arrival order, not resolution order — the window ends up where the user went')
})

test('§3.4 a REJECTED take still releases what arrived while it was outstanding', async () => {
  clear()
  const listeners = new Set<Listener>()
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
    onEvent(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } },
    takePendingWindowEvents() {
      // an older host with no such channel, after a live event landed
      for (const l of [...listeners]) l({ type: 'open-org', data: { org: 'studio' } })
      return Promise.reject(new Error('no such channel'))
    },
  }
  startHeldEvents()
  await flush()
  const got: unknown[] = []
  onHeldEvent('open-org', (e) => got.push(e.data))
  assert.deepEqual(got, [{ org: 'studio' }],
    'the ordering guard must not become a way to lose events outright')
})

// ----------------------------------------- §4 the type set, against native

test('§4 the buffered types are exactly the types the main process holds', () => {
  // ⚠ PINNED AGAINST main/index.ts RATHER THAN TRUSTED. A type native holds
  // and this module does not buffer is discharged into the very gap this
  // module exists to close, and nothing else would catch the divergence —
  // both sides compile fine and the loss only shows on a cold start.
  const main = fs.readFileSync(
    path.join(__SRC_DIR__, '..', '..', 'main', 'index.ts'), 'utf8')
  const line = /const HELD_EVENT_TYPES = new Set<DesktopEvent\['type'\]>\(\[([^\]]*)\]\)/.exec(main)
  assert.ok(line, 'main/index.ts still declares HELD_EVENT_TYPES as a literal set')
  const native = [...line[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()
  assert.deepEqual([...HELD_TYPES].sort(), native,
    'the renderer buffers exactly what native holds — no more, no fewer')
})

test('§4.1 every held type has a real consumer in the product', () => {
  // a type nothing consumes would accumulate silently against the bound; this
  // names where each one is actually handled
  const where: Record<string, string> = {
    'open-org': 'App.tsx',
    'restore-skipped': 'App.tsx',
    'notification-click': 'notifications.ts',
    'window-identity': 'shell/identity.ts',
  }
  for (const type of HELD_TYPES) {
    const file = where[type]!
    assert.match(src(file), new RegExp("onHeldEvent\\('" + type + "'"),
      type + ' is consumed through the bus in ' + file)
  }
})

test('§4.2 no held type is ALSO taken directly off the bridge', () => {
  // ⚠ DOUBLE DELIVERY IS THE FAILURE HERE. A consumer that kept its own
  // `bridge.onEvent` alongside the bus would handle every live event twice —
  // two reveals per notification click — while still missing the cold one.
  for (const file of ['App.tsx', 'notifications.ts', 'shell/identity.ts']) {
    const body = src(file)
    for (const type of HELD_TYPES) {
      assert.doesNotMatch(body, new RegExp("event\\.type[^\\n]*'" + type + "'"),
        file + ' must not branch on ' + type + ' inside a raw onEvent handler')
    }
  }
})

// -------------------------------------------- §5 the ordering in main.tsx

test('§5 the bus is started before any other subscription in the document', () => {
  // ⚠ THE ONE PROPERTY NOTHING AT RUNTIME CAN CHECK, and the whole fix rests
  // on it. The preload acks from inside `onEvent`, so the first subscription
  // is what releases native's hold; attaching second is not a weaker version
  // of this protection, it is none of it.
  const entry = src('main.tsx')
  const bus = entry.indexOf('startHeldEvents()')
  assert.ok(bus > 0, 'main.tsx starts the held bus')
  for (const later of ['startThemeSync()', 'startContrastSync()', 'startAgentColorSync()']) {
    const at = entry.indexOf(later + '\n') >= 0 ? entry.indexOf(later + '\n') : entry.indexOf(later)
    assert.ok(at > bus, later + ' subscribes AFTER the held bus, not before')
  }
  // and React itself, which is where every effect-based consumer lives
  assert.ok(entry.indexOf('createRoot') > bus, 'React mounts after the bus exists')
})
