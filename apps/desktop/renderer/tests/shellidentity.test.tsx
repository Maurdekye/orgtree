// shellidentity.test.tsx — which window this is, and what that window is
// allowed to do about notifications.
//
// v2 had one main window, so nothing ever had to ask either question. v3 has
// several at once, and two properties fall straight out of that:
//
//   1. The identity must be there at the FIRST render. A shell that awaited
//      `getWindowIdentity()` would paint the wrong view for a frame — a
//      Homepage flashing a canvas, or a canvas flashing the org list.
//   2. The app-wide notification duties belong to EXACTLY ONE window. The
//      cross-organization projection read, the native cleanup reconciliation
//      and the taskbar aggregate are global; running them in N windows means N
//      renderers racing one reconciliation. Handling a notification CLICK is
//      not part of that and must keep working everywhere.
//
// Run:  node apps/desktop/renderer/tests/run.mjs shellidentity
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { identityOrg, identityView, ownsNotifications, readIdentity, sameIdentity, useWindowIdentity } from '../src/shell/identity'
import { nativeWindows, startupMode, windowIdentity } from '../src/desktop'
import type { OrgWindowIdentity } from '../src/desktop'
import { EMPTY_ISH, installBridge, removeBridge } from './shellbridge'
// ⚠ the held bus, started exactly as main.tsx starts it. `window-identity`
// and `notification-click` are held types, so their consumers subscribe
// through the bus now and a single-slot `onEvent` fake would keep only one
// of the document's two subscribers — see heldevents.ts.
import { eventFanout, startBus } from './heldevents'
import { pendingAttention, publishPending, resetPending, startPendingMirror } from '../src/pending-attention'
import { useNativeNotifications } from '../src/notifications'
import type { DesktopNotice } from '../src/notifications'

const ORG: OrgWindowIdentity = { windowId: 'w1', kind: 'org', org: 'studio' }

// ------------------------------------------------------- §1 reading it

test('an identity is accepted only when it is actually one', () => {
  assert.deepEqual(readIdentity(ORG), ORG)
  assert.deepEqual(readIdentity({ windowId: 'w2', kind: 'homepage' }),
    { windowId: 'w2', kind: 'homepage' })
  assert.equal(readIdentity(null), null)
  assert.equal(readIdentity({ kind: 'org', org: 'a' }), null, 'no window id')
  assert.equal(readIdentity({ windowId: 'w', kind: 'canvas' }), null, 'not one of the three kinds')
  assert.equal(readIdentity({ windowId: 'w', kind: 'org' }), null,
    'an org window without an org is not an identity — binding is what makes it one')
  assert.deepEqual(readIdentity({ windowId: 'w', kind: 'homepage', org: 'leaked' }),
    { windowId: 'w', kind: 'homepage' }, 'an org on a non-org window is dropped, not carried')
})

test('the view and the bound org are read from the identity, never guessed', () => {
  assert.equal(identityView(ORG), 'org')
  assert.equal(identityOrg(ORG), 'studio')
  assert.equal(identityView({ windowId: 'w', kind: 'create' }), 'create')
  assert.equal(identityOrg({ windowId: 'w', kind: 'create' }), null)
  assert.equal(identityView(null), null, 'no identity means render the pre-v3 app')
})

test('only an explicit false demotes a window from the notification duties', () => {
  assert.equal(ownsNotifications(null), true, 'the single-window world — the one window always did this')
  assert.equal(ownsNotifications(ORG), true, 'a shell that has not implemented ownership yet still alerts')
  assert.equal(ownsNotifications({ ...ORG, notificationOwner: true }), true)
  assert.equal(ownsNotifications({ ...ORG, notificationOwner: false }), false)
})

test('identities compare by value, so a repeated event re-renders nothing', () => {
  assert.equal(sameIdentity(ORG, { ...ORG }), true)
  assert.equal(sameIdentity(ORG, { ...ORG, org: 'other' }), false)
  assert.equal(sameIdentity(ORG, { ...ORG, notificationOwner: true }), true,
    'absent already MEANS owner, so spelling it out changes nothing')
  assert.equal(sameIdentity(ORG, { ...ORG, notificationOwner: false }), false,
    'losing the duty is a real change — and comparing truthiness would miss it')
  assert.equal(sameIdentity(null, null), true)
  assert.equal(sameIdentity(null, ORG), false)
})

test('the v3 shell is gated on requestOrg, not on the mere presence of a bridge', () => {
  assert.equal(nativeWindows(undefined), false)
  assert.equal(nativeWindows({ ...EMPTY_ISH } as never), false,
    "today's shipped preload exposes a bridge and knows nothing about windows")
  assert.equal(nativeWindows({ ...EMPTY_ISH, requestOrg: async () => ({ action: 'pending', org: 'a' }) } as never), true)
})

test('the startup default lives in one place and an older shell reads as restore', () => {
  assert.equal(startupMode(null), 'restore')
  assert.equal(startupMode({} as never), 'restore')
  assert.equal(startupMode({ startupMode: 'homepage' } as never), 'homepage')
  assert.equal(startupMode({ startupMode: 'restore' } as never), 'restore')
})

// ------------------------------------------- §2 present at the first render

test('the identity is on screen at the FIRST render — no frame of the wrong view', async () => {
  const bridge = installBridge({
    windowIdentity: ORG,
    getWindowIdentity: async () => ORG,
  })
  try {
    assert.deepEqual(windowIdentity(), ORG, 'synchronously readable before React runs')
    function View() {
      const id = useWindowIdentity()
      return <span className="view">{identityView(id) ?? 'none'}</span>
    }
    const v = await mountView(<View />, (el) => el.querySelector('.view')!.textContent)
    // frames[0] IS the first paint; a promise-only identity would read 'none'
    assert.equal(v.frames[0], 'org', 'the first painted frame already knows which window this is')
    await v.unmount()
  } finally { removeBridge(bridge) }
})

test('binding and ownership transfer both arrive as window-identity and are adopted', async () => {
  const fan = eventFanout()
  const fire = fan.emit
  const home: OrgWindowIdentity = { windowId: 'w9', kind: 'homepage' }
  const bridge = installBridge({
    windowIdentity: home,
    getWindowIdentity: async () => home,
    onEvent: fan.onEvent,
  })
  const stopBus = startBus()
  try {
    function View() {
      const id = useWindowIdentity()
      return <span className="view">{`${identityView(id)}:${identityOrg(id) ?? '-'}:${ownsNotifications(id)}`}</span>
    }
    const v = await mountView(<View />, (el) => el.querySelector('.view')!.textContent)
    await inAct(async () => { await flush() })
    assert.equal(v.last(), 'homepage:-:true')
    // the Homepage binds itself: SAME window id, new kind and org
    await inAct(async () => {
      fire({ type: 'window-identity', data: { windowId: 'w9', kind: 'org', org: 'studio' } })
      await flush()
    })
    assert.equal(v.last(), 'org:studio:true', 'a bound window keeps its id and changes only kind/org')
    // …and the notification duty is handed away and later handed back
    await inAct(async () => {
      fire({ type: 'window-identity', data: { windowId: 'w9', kind: 'org', org: 'studio', notificationOwner: false } })
      await flush()
    })
    assert.equal(v.last(), 'org:studio:false')
    await inAct(async () => {
      fire({ type: 'window-identity', data: { windowId: 'w9', kind: 'org', org: 'studio', notificationOwner: true } })
      await flush()
    })
    assert.equal(v.last(), 'org:studio:true', 'transfer is what starts the new owner polling')
    // a malformed payload does not blank the view
    await inAct(async () => { fire({ type: 'window-identity', data: { kind: 'org' } }); await flush() })
    assert.equal(v.last(), 'org:studio:true', 'an unparseable message is not evidence of anything')
    await v.unmount()
  } finally { stopBus(); removeBridge(bridge) }
})

// --------------------------------------------- §3 one window does the work

const NOTICES: DesktopNotice[] = [
  { id: 'n1', org: 'other-org', source_id: 'ask-1', title: 'Question', body: 'Choose',
    kind: 'question', agent: 'writer' } as DesktopNotice,
]

/** Mount the notification hook with a given ownership and report what it did
 *  to the world. */
async function notifyProbe(owner: boolean) {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const reads: string[] = [], delivered: DesktopNotice[] = [], synced: unknown[] = []
  const taskbar: unknown[] = [], opened: DesktopNotice[] = []
  const fan = eventFanout()
  const fire = fan.emit
  const bridge = installBridge({
    notify: async (n: DesktopNotice) => { delivered.push(n); return true },
    syncNotifications: async (active: unknown) => { synced.push(active) },
    setPendingAttention: async (ids: unknown) => { taskbar.push(ids) },
    onEvent: fan.onEvent,
  })
  // started before the component mounts, as main.tsx does
  const stopBus = startBus()
  globalThis.fetch = async (url: unknown) => {
    reads.push(String(url))
    return { ok: true, headers: new Headers(),
      json: async () => ({ notices: NOTICES, total: NOTICES.length, truncated: false }) } as Response
  }
  function View({ own }: { own: boolean }) {
    useNativeNotifications((n) => opened.push(n), own)
    return <div>w</div>
  }
  const view = await mountView(<View own={owner} />, (el) => el)
  return {
    reads, delivered, synced, taskbar, opened, view,
    fireEvent: (e: { type: string; data: unknown }) => fire(e),
    async stop() {
      await view.unmount(); globalThis.fetch = original; stopBus(); removeBridge(bridge); realClock()
    },
  }
}

test('the OWNER reads the cross-org projection, syncs it and writes the taskbar', async () => {
  const p = await notifyProbe(true)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(p.reads, ['/api/desktop/notifications'])
    assert.equal(p.delivered.length, 1, 'the owner dispatches')
    assert.equal(p.synced.length, 1, 'the owner reconciles the native inventory')
    assert.equal(p.taskbar.length, 1, 'the owner writes the taskbar aggregate')
  } finally { await p.stop() }
})

test('a NON-OWNER reads nothing, syncs nothing, writes no taskbar — and still reveals its click', async () => {
  const p = await notifyProbe(false)
  try {
    await inAct(async () => { await flush(8) })
    await advance(20_000)
    assert.deepEqual(p.reads, [], 'no cross-organization poll — this is the racing read the owner prevents')
    assert.deepEqual(p.delivered, [], 'no duplicate operating-system alerts')
    assert.deepEqual(p.synced, [], 'no competing cleanup reconciliation')
    assert.deepEqual(p.taskbar, [], 'no competing taskbar write')
    // the per-window half is untouched: the click still resolves and reveals
    await inAct(async () => {
      p.fireEvent({ type: 'notification-click', data: NOTICES[0] }); await flush(10)
    })
    assert.equal(p.opened.length, 1, 'every window handles the click aimed at it, owner or not')
    assert.equal(p.opened[0]!.org, 'other-org')
    assert.ok(p.reads.length > 0, 'the click re-reads to revalidate — that read is per-click, not a poll')
  } finally { await p.stop() }
})

test('a native poll tick does not make a non-owner start reading', async () => {
  const p = await notifyProbe(false)
  try {
    await inAct(async () => { p.fireEvent({ type: 'notification-poll', data: null }); await flush(8) })
    await advance(10_000)
    assert.deepEqual(p.reads, [],
      'the tick is addressed to the owner; a window that is told anyway still declines')
  } finally { await p.stop() }
})

test('a pass still in flight when the duty MOVES finishes without writing anything', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const synced: unknown[] = [], taskbar: unknown[] = [], delivered: unknown[] = []
  let release: ((r: Response) => void) | null = null
  const bridge = installBridge({
    notify: async (n: unknown) => { delivered.push(n); return true },
    syncNotifications: async (a: unknown) => { synced.push(a) },
    setPendingAttention: async (ids: unknown) => { taskbar.push(ids) },
    onEvent: () => () => {},
  })
  globalThis.fetch = (() => new Promise<Response>((resolve) => { release = resolve })) as unknown as typeof fetch
  function View({ own }: { own: boolean }) {
    useNativeNotifications(() => {}, own)
    return <div>w</div>
  }
  const view = await mountView(<View own={true} />, (el) => el)
  try {
    await inAct(async () => { await flush(4) })
    assert.ok(release, 'the owner has a read in flight')
    // the duty moves to another window WHILE that read is outstanding
    await inAct(async () => { await view.render(<View own={false} />); await flush(4) })
    // …and only now does the old read come back
    await inAct(async () => {
      release!({ ok: true, headers: new Headers(),
        json: async () => ({ notices: [{ id: 'n1', org: 'other', kind: 'question',
          source_id: 'a1', title: 'Q', body: 'b', agent: 'w' }], total: 1, truncated: false }),
      } as Response)
      await flush(10)
    })
    assert.deepEqual(taskbar, [], 'a stale owner does not write the taskbar aggregate')
    assert.deepEqual(synced, [], 'nor reconcile the native alert inventory')
    assert.deepEqual(delivered, [], 'nor dispatch an alert the new owner is about to dispatch')
    await advance(20_000)
    assert.deepEqual(taskbar, [], 'and it does not resume polling either')
  } finally {
    await view.unmount(); globalThis.fetch = original; removeBridge(bridge); realClock()
  }
})

// ------------------------------------------------- §4 the aggregate mirror

test('the owner mirrors the aggregate and a follower adopts it without polling', async () => {
  localStorage.clear(); resetPending()
  const stopOwner = startPendingMirror(true)
  publishPending({ mail: 2, docket: 1, ids: ['["a","1"]', '["b","2"]'],
    items: [{ org: 'a', id: '1' }, { org: 'b', id: '2' }] })
  const stored = localStorage.getItem('orgtree-pending-attention-v1')
  assert.ok(stored, 'the owner writes what it publishes')
  stopOwner()

  // a second window: nothing of its own, only what the owner left
  resetPending()
  assert.deepEqual(pendingAttention(), { mail: 0, docket: 0, ids: [], items: [] })
  const stopFollower = startPendingMirror(false)
  assert.equal(pendingAttention().mail, 2, 'the follower seeds from the last write')
  assert.equal(pendingAttention().docket, 1)

  localStorage.setItem('orgtree-pending-attention-v1',
    JSON.stringify({ mail: 0, docket: 0, ids: [], items: [] }))
  window.dispatchEvent(new (window as unknown as { StorageEvent: typeof StorageEvent }).StorageEvent('storage', { key: 'orgtree-pending-attention-v1' }))
  assert.deepEqual(pendingAttention(), { mail: 0, docket: 0, ids: [], items: [] },
    'clearing in the owner clears the dot everywhere')

  localStorage.setItem('orgtree-pending-attention-v1', '{ not json')
  window.dispatchEvent(new (window as unknown as { StorageEvent: typeof StorageEvent }).StorageEvent('storage', { key: 'orgtree-pending-attention-v1' }))
  assert.deepEqual(pendingAttention(), { mail: 0, docket: 0, ids: [], items: [] },
    'a corrupt mirror is empty, never a thrown listener')
  stopFollower()
  resetPending()
})
