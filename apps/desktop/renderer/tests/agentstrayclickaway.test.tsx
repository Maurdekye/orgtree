// The agents tray is portaled on mobile, so click-away must follow the real
// DOM node rather than assume that the list lives under the canvas host.
// Run: cd frontend && node tests/run.mjs agentstrayclickaway

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'

localStorage.setItem('orgtree-mobile', '1')

const noop = () => {}
const asTree = (value: unknown) => value as TreePayload

function tree(): TreePayload {
  const node = {
    id: 'worker', title: 'worker', tier: 'haiku', model_id: 'haiku',
    state: 'live', seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0,
    occupancy: null, context_window: null, charter: null, mail_pending: 0,
    limit_locked: false, last_status: null, prev_status: null,
    inflight_at: null, last_denials: [], turns: [], frozen: null,
    audiences_held: [], bearer_state: null, generation: 0, children: [],
    lineage: [], scope: {
      permission_mode: 'default', add_dirs: [], tools: {},
      org_visibility: 'team',
    },
  }
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0,
    default_tools: null, default_visibility: 'team', default_effort: '',
    credit_requests: [], tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 },
    audiences: [], roots: [node], cost_usd_total: 0,
    audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

type CaptureProto = {
  setPointerCapture?: (id: number) => void
  releasePointerCapture?: (id: number) => void
}

const proto = HTMLElement.prototype as CaptureProto
const oldCapture = {
  set: proto.setPointerCapture,
  release: proto.releasePointerCapture,
}
proto.setPointerCapture = noop
proto.releasePointerCapture = noop

test.after(() => {
  proto.setPointerCapture = oldCapture.set
  proto.releasePointerCapture = oldCapture.release
  localStorage.removeItem('orgtree-mobile')
})

function pointerDown(target: Element): Event {
  const event = new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, clientX: 12, clientY: 16,
  })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  target.dispatchEvent(event)
  return event
}

async function mountCanvas() {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  return mountView(
    <OrgCanvas tree={tree()} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />,
    (host) => host,
  )
}

async function openTray() {
  const toggle = document.querySelector('.tray-toggle') as HTMLElement | null
  assert.ok(toggle, 'the portaled agents trigger rendered')
  await inAct(() => { toggle.click() })
  await flush()
  const tray = document.querySelector('.tray') as HTMLElement | null
  assert.ok(tray, 'the agents tray opened')
  return { toggle, tray }
}

test('inside and trigger gestures stay inside the portaled click-away boundary',
  async () => {
    const view = await mountCanvas()
    try {
      const { toggle, tray } = await openTray()
      const wrap = document.querySelector('.tray-wrap') as HTMLElement | null
      assert.ok(wrap && !view.el.contains(wrap),
        'mobile MaybePortal did not move the tray outside the canvas host')

      const nested = tray.querySelector('.tray-name') as HTMLElement | null
      assert.ok(nested, 'the nested tray-row target rendered')
      await inAct(() => { pointerDown(nested) })
      await flush()
      assert.ok(document.querySelector('.tray'),
        'a nested click inside the portaled tray closed it')

      await inAct(() => { pointerDown(toggle); toggle.click() })
      await flush()
      assert.equal(document.querySelector('.tray'), null,
        'the existing trigger no longer toggles the tray closed')
    } finally {
      await view.unmount()
    }
  })

test('outside controls and canvas drag starts close without being swallowed',
  async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    let outsideClicks = 0
    outside.addEventListener('click', () => { outsideClicks += 1 })
    const view = await mountCanvas()
    try {
      await openTray()
      await inAct(() => { pointerDown(outside); outside.click() })
      await flush()
      assert.equal(document.querySelector('.tray'), null)
      assert.equal(outsideClicks, 1,
        'click-away consumed the outside control action')

      await openTray()
      const viewport = view.el.querySelector('.viewport') as HTMLElement | null
      assert.ok(viewport, 'the canvas viewport rendered')
      let dragStarts = 0
      viewport.addEventListener('pointerdown', () => { dragStarts += 1 })
      await inAct(() => { pointerDown(viewport) })
      await flush()
      assert.equal(document.querySelector('.tray'), null)
      assert.equal(dragStarts, 1,
        'click-away swallowed the canvas pointerdown used to begin pan/drag')
    } finally {
      await view.unmount()
      outside.remove()
    }
  })

test('Escape and close/unmount clean capture listeners without duplicates',
  async () => {
    const originalAdd = document.addEventListener.bind(document)
    const originalRemove = document.removeEventListener.bind(document)
    const active = new Set<EventListenerOrEventListenerObject>()
    document.addEventListener = ((type: string,
      listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'pointerdown' && options === true) active.add(listener)
      originalAdd(type, listener, options)
    }) as typeof document.addEventListener
    document.removeEventListener = ((type: string,
      listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'pointerdown' && options === true) active.delete(listener)
      originalRemove(type, listener, options)
    }) as typeof document.removeEventListener

    let view: Awaited<ReturnType<typeof mountCanvas>> | null = null
    try {
      view = await mountCanvas()
      await openTray()
      assert.equal(active.size, 1, 'opening installed duplicate click-away handlers')

      await inAct(() => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true,
        }))
      })
      await flush()
      assert.equal(document.querySelector('.tray'), null, 'Escape did not close the tray')
      assert.equal(active.size, 0, 'closing left its click-away listener attached')

      await openTray()
      assert.equal(active.size, 1, 'reopening accumulated click-away handlers')
      await view.unmount()
      view = null
      assert.equal(active.size, 0, 'unmount left its click-away listener attached')
    } finally {
      if (view) await view.unmount()
      document.addEventListener = originalAdd as typeof document.addEventListener
      document.removeEventListener = originalRemove as typeof document.removeEventListener
    }
  })
