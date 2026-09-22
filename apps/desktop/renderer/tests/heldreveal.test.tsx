// heldreveal.test.tsx — the REVEAL ACTION, from a held event to the exact
// surface the user is supposed to be looking at.
//
// ⚠ WHY THIS EXISTS SEPARATELY FROM THE COMPOSITION FIXTURE. That fixture
// runs the production main handlers, the production preload and the shipping
// `useNativeNotifications` in real Electron — but the callback the hook is
// given there is the fixture's, so what it proves is HOOK RECEIPT: the event
// reached the real consumer and survived its whole validation path. It does
// not prove the REVEAL: that the real App then shows the targeted item in the
// right place. multi-window-design asked for that to be checked against what
// the App displays rather than inferred, and this is that check.
//
// The two halves and the seam between them, stated plainly so nobody reads
// either for more than it shows:
//
//   Electron fixture   native host + production preload → events/heldbus.ts
//                      → useNativeNotifications         (receipt)
//   here (jsdom)       events/heldbus.ts → useNativeNotifications → App's own
//                      callback → the exact pane        (action)
//
// The seam is not a copy: the SAME `heldbus` module and the SAME hook are in
// both, which is what lets the two halves be joined at all.
//
// ⚠ AND THE ORDER IS THE DEFECT'S OWN ORDER. The event is delivered BEFORE
// App mounts — which is the whole case. A test that clicked a notification at
// a live App would pass with the bus removed entirely.
//
// Run:  node apps/desktop/renderer/tests/run.mjs heldreveal
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import { heldEventStats } from '../src/events/heldbus'
import type { NativeNotice } from '../src/desktop'
import { DEFAULT_NOTIFICATIONS } from '../../../../packages/contracts/notifications'
import { eventFanout, startBus } from './heldevents'

const response = (data: unknown) => ({ ok: true, headers: new Headers(), json: async () => data } as Response)
const native = (value?: unknown) =>
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
const settle = () => inAct(async () => { await flush(40) })

const NOTICE: NativeNotice = {
  id: 'other-document', source_id: 'exact', org: 'other', kind: 'document',
  title: 'Exact document', body: 'New plan',
} as NativeNotice
const DOC = {
  id: 'exact', node: 'agent', title: 'Exact document', at: '2026-09-12',
  node_state: 'live', evicted: false,
}
const ROOT = {
  id: 'agent', title: 'agent', tier: 'haiku', model_id: 'haiku', generation: 2,
  state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
}

function server() {
  return async (url: unknown) => {
    const path = String(url).split('?')[0]
    if (path === '/api/desktop/notifications') {
      return response({ notices: [NOTICE], total: 1, truncated: false,
        active: [{ org: NOTICE.org, id: NOTICE.id }] })
    }
    if (path === '/api/orgs') return response([{ slug: 'other', name: 'Other', live: 1, seats: 1 }])
    if (path === '/api/orgs/other') {
      return response({ slug: 'other', name: 'Other', roots: [ROOT], max_top_grant: 1000,
        default_top_grant: 50, compact_at: 0, tiers: { haiku: 1 }, audience_requests: [],
        credit_requests: [], cost_usd_total: 0,
        audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
        epoch: 1, rev: 1, work_items_summary: { attention: 0, active: 0 }, asks: [],
        asks_open: 0, watchdogs: [], dirs: [] })
    }
    if (path === '/api/providers') return response({ providers: [] })
    if (path === '/api/orgs/other/documents/exact') {
      return response({ ...DOC, body: 'Notification selected this precise document.' })
    }
    if (path === '/api/orgs/other/documents') {
      return response({ documents: [DOC], total: 1, offset: 0,
        located: String(url).includes('locate=exact') ? 'exact' : '', next_offset: null })
    }
    if (/inbox|mailbox|\/mail/.test(path!)) {
      return response({ pending: [], delivered: [], history: [], messages: [], items: [], unread: 0 })
    }
    if (/\/(work|items|asks|watchdogs|events|audiences)$/.test(path!)) return response([])
    return response({})
  }
}

test('a click delivered before App exists still reveals the exact document', async () => {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const oldFetch = globalThis.fetch
  const g = globalThis as unknown as Record<string, unknown>
  g.history ??= window.history; g.location ??= window.location
  window.history.replaceState(null, '', '/')

  const fan = eventFanout()
  native({
    getPreferences: async () => ({ ...DEFAULT_NOTIFICATIONS, notifyDocuments: true }),
    notify: async () => false,
    syncNotifications: async () => {},
    onEvent: fan.onEvent,
  })
  // ⚠ THE BUS FIRST, AS main.tsx STARTS IT, and then the event — before any
  // component exists. This is the cold-start order the whole mechanism is for:
  // native released its hold to whatever was listening, and what was listening
  // was the bus and nothing else.
  const stopBus = startBus()
  globalThis.fetch = server() as typeof globalThis.fetch

  fan.emit({ type: 'notification-click', data: NOTICE })
  assert.equal(heldEventStats().waiting, 1,
    'nothing consumes it yet, and it is KEPT rather than dropped')

  const v = await mountView(<App />, (el) => el)
  try {
    await settle()
    // ⚠ THE ASSERTIONS ARE ABOUT WHAT THE USER SEES, not about a callback
    // having fired. The organization, the surface and the document body.
    assert.equal(window.location.pathname, '/o/other',
      'the window went to the organization the notification named')
    const pane = v.el.querySelector('.gallery-modal .mailer-read')
    assert.match(pane?.textContent ?? '', /Notification selected this precise document/,
      'and the exact document is open in the Presentations pane')
    assert.equal(v.el.querySelectorAll('.gallery-modal').length, 1,
      'exactly one gallery — a reveal opens the surface, it does not stack them')
    assert.equal(heldEventStats().waiting, 0, 'and nothing is still being held')
  } finally {
    stopBus(); await v.unmount(); native(); globalThis.fetch = oldFetch
    forgetModalPins(); forgetModalOpenCache(); window.history.replaceState(null, '', '/')
  }
})

test('and with the bus removed from the path, the same reveal never happens', async () => {
  // ⚠ THE CONTROL. Without it the test above says only "a notification click
  // reveals a document", which was true before any of this existed. Here the
  // event is delivered at exactly the same moment with NO bus started, which
  // is what the product did until events/heldbus.ts: the click reaches a
  // document whose consumers are React effects that have not run, and goes
  // nowhere.
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const oldFetch = globalThis.fetch
  window.history.replaceState(null, '', '/')

  const fan = eventFanout()
  native({
    getPreferences: async () => ({ ...DEFAULT_NOTIFICATIONS, notifyDocuments: true }),
    notify: async () => false,
    syncNotifications: async () => {},
    onEvent: fan.onEvent,
  })
  globalThis.fetch = server() as typeof globalThis.fetch

  // no startBus(): the event is announced to a document with no listener at all
  fan.emit({ type: 'notification-click', data: NOTICE })

  const v = await mountView(<App />, (el) => el)
  try {
    await settle()
    assert.equal(v.el.querySelectorAll('.gallery-modal').length, 0,
      'no surface was revealed — the click was delivered to nobody, which is '
      + 'exactly the user-visible defect: a notification that opens a window '
      + 'and then does nothing')
  } finally {
    await v.unmount(); native(); globalThis.fetch = oldFetch
    forgetModalPins(); forgetModalOpenCache(); window.history.replaceState(null, '', '/')
  }
})
