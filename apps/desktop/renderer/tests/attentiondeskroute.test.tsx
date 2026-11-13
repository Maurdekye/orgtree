// attentiondeskroute.test.tsx — WHERE AN AGENT LINK OPENS ITS AGENT when the Attention desk is in a window of its own.
//
// User 2026-11-12 16:57:30Z m6ac4fe1109a2: "if the attention desk is popped out, and the main window with the canvas
// is closed, clicking an agent link should open it in the attention desk the same way it does when attention view is
// open". Closing the main window with a panel popped out HIDES it (the renderer lives on for its panels), so the one
// focus path (`centerOn`, which every agent link ends in) went on moving the canvas camera in a window nobody can see.
//
//   §1  control: with the Attention view presented, a focus selects the agent in the Attention desk (2026-09-29 rule)
//   §2  canvas view, desk popped out, main window hidden: the focus selects the agent in the Attention desk, brings
//       that desk's window forward, and leaves the hidden camera alone
//   §3  a minimized main window is as unreachable as a hidden one: same as §2
//   §4  no regression: canvas view, desk popped out, main window SHOWN: the canvas takes the jump, as before
//   §5  no regression: main window hidden but the desk NOT popped out: the canvas path is unchanged
//   §6  another organization's popped-out Attention desk is not this organization's
//   §7  the main-window report: unknown is "shown"; hide, minimize, restore and show are followed; unmount resets
//
// The fixture is App's composition (attentionfocus.test.tsx): the real OrgCanvas with the real AttentionView in its
// slot. The popped-out desk is the registry record a real pop-out makes (`registerWindow`, as presentfocus.test.tsx
// §1-§4), and the main window's state arrives as the native side sends it: `window-state` events on the bridge.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs attentiondeskroute

import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas, resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { AttentionView } from '../src/attention/AttentionView'
import { forgetAttentionMode, setAttentionLayout, setOrgView, useAttentionLayout, useOrgView } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import { registerWindow } from '../src/windowlife'
import type { WindowSurface } from '../src/windowlife'
import { mainWindowShown, watchMainWindow } from '../src/mainwindow'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const slug = 'attention-route'
const noop = () => {}
const op = () => Promise.resolve({})
const node = (id: string) => ({
  id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', generation: 0,
  seat: 1, grant: 0, free: 0, children: [], lineage: [], turns: [], occupancy: null,
  context_window: null, charter: null, mail_pending: 0, last_status: null,
  audiences_held: [], scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
})
const tree = {
  slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000, default_top_grant: 50,
  compact_at: 0, tiers: { haiku: 1, opus: 4 }, roots: [node('alpha'), node('beta')],
  audiences: [], credit_requests: [], audience_requests: [], asks: [], asks_open: 0,
  audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0,
} as unknown as TreePayload

// ------------------------------------------------------------------ the native side, as the renderer sees it
type Listener = (event: { type: string; data?: unknown }) => void
const listeners = new Set<Listener>()
let initial: { visible: boolean; minimized: boolean } = { visible: true, minimized: false }
const bridge = {
  getWindowControlsState: async () => ({ ...initial, maximized: false, restoreWindows: true }),
  getPreferences: async () => ({}),
  onEvent: (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}
const windowState = async (visible: boolean, minimized = false) => {
  await inAct(() => { for (const fn of [...listeners]) fn({ type: 'window-state', data: { visible, minimized, maximized: false, restoreWindows: true } }) })
}

// ------------------------------------------------------------------ the window
let focusAgent: ((id: string) => void) | undefined
function WindowFixture() {
  const mode = useOrgView(slug)
  const layout = useAttentionLayout(slug)
  return <CurrentOrg.Provider value={slug}>
    <output data-attention-agent={layout.agent ?? ''} />
    <OrgCanvas tree={tree} slug={slug} op={op} toast={noop} mailEvt={null}
      canvasContent={mode === 'attention' ? 'hidden' : 'shown'}
      renderOrgSlot={ctx => {
        focusAgent = ctx.onFocusAgent
        return <AttentionView slug={slug} tree={tree} op={op} toast={noop}
          map={ctx.map} posOf={ctx.posOf} onFocusAgent={ctx.onFocusAgent} deskExtras={ctx.deskExtras} />
      }} />
  </CurrentOrg.Provider>
}

/** the record a popped-out Attention desk registers; `reveal` is the native "bring this window forward" */
function poppedOutDesk(org: string, revealed: string[]): WindowSurface {
  return { id: 'attention-desk:' + org, kind: 'attention-desk', org, editable: true, redock: noop,
    window: { focus() {}, closed: false } as unknown as Window, reveal: () => { revealed.push(org) } } as WindowSurface
}

async function mounted(t: { after(fn: () => void | Promise<void>): void }) {
  localStorage.clear(); forgetAttentionMode(); resetCanvasSessionForTests(); resetConvos()
  listeners.clear(); initial = { visible: true, minimized: false }
  ;(window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop = bridge
  useFakeClock(); installFetch(new FakeServer())
  const proto = window.HTMLElement.prototype
  const rect = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    return this.classList.contains('viewport')
      ? { x: 0, y: 0, left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, toJSON() {} } as DOMRect
      : rect.call(this)
  }
  const offs: (() => void)[] = []
  const view = await mountView(<WindowFixture />, h => h)
  t.after(async () => {
    for (const off of offs.splice(0)) off()
    await view.unmount(); proto.getBoundingClientRect = rect
    delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
    realClock(); resetConvos(); localStorage.clear(); forgetAttentionMode()
  })
  await advance(2500)
  await inAct(() => setAttentionLayout(slug, { agent: 'alpha' }))
  await inAct(() => flush(4))
  const selected = () => view.el.querySelector('[data-attention-agent]')!.getAttribute('data-attention-agent')
  const camera = () => (view.el.querySelector('.space') as HTMLElement).style.transform
  const focus = async (id: string) => { await inAct(() => focusAgent!(id)); await advance(1800) }
  assert.equal(selected(), 'alpha', 'control: the Attention desk starts on alpha')
  assert.equal(typeof focusAgent, 'function', 'the one focus path is handed to the slot')
  return { view, offs, selected, camera, focus }
}

test('§1 control: with the Attention view presented, a focus selects the agent in the Attention desk', async (t) => {
  const w = await mounted(t)
  await inAct(() => setOrgView(slug, 'attention'))
  await inAct(() => flush(4))
  const camera = w.camera()
  await w.focus('beta')
  assert.equal(w.selected(), 'beta')
  assert.equal(w.camera(), camera, 'the hidden camera does not move')
})

test('§2 desk popped out and the main window hidden: the agent opens in the popped-out Attention desk', async (t) => {
  const w = await mounted(t)
  const revealed: string[] = []
  w.offs.push(registerWindow(poppedOutDesk(slug, revealed)))
  await windowState(false)
  assert.equal(mainWindowShown(), false, 'control: the native side said the main window is hidden')
  const camera = w.camera()
  await w.focus('beta')
  assert.equal(w.selected(), 'beta', 'the Attention desk takes the agent')
  assert.deepEqual(revealed, [slug], 'and its window is brought forward, once')
  assert.equal(w.camera(), camera, 'the camera of the window nobody can see is left alone')
})

test('§3 a minimized main window counts as not on screen', async (t) => {
  const w = await mounted(t)
  const revealed: string[] = []
  w.offs.push(registerWindow(poppedOutDesk(slug, revealed)))
  await windowState(true, true)
  await w.focus('beta')
  assert.equal(w.selected(), 'beta')
  assert.deepEqual(revealed, [slug])
})

test('§4 no regression: with the main window shown, the canvas takes the jump', async (t) => {
  const w = await mounted(t)
  const revealed: string[] = []
  w.offs.push(registerWindow(poppedOutDesk(slug, revealed)))
  const camera = w.camera()
  await w.focus('beta')
  assert.equal(w.selected(), 'alpha', 'the popped-out desk keeps its agent')
  assert.deepEqual(revealed, [])
  assert.notEqual(w.camera(), camera, 'the camera went to the agent, as before')
  // and after a hide and a show it is the same again
  await windowState(false); await windowState(true)
  await w.focus('alpha')
  assert.equal(w.selected(), 'alpha')
  assert.deepEqual(revealed, [], 'shown again: nothing is routed to the desk')
})

test('§5 no regression: main window hidden but no popped-out Attention desk: the canvas path is unchanged', async (t) => {
  const w = await mounted(t)
  await windowState(false)
  const camera = w.camera()
  await w.focus('beta')
  assert.equal(w.selected(), 'alpha', 'there is no Attention desk on screen to take it')
  assert.notEqual(w.camera(), camera)
})

test('§6 another organization\'s popped-out Attention desk is not this organization\'s', async (t) => {
  const w = await mounted(t)
  const revealed: string[] = []
  w.offs.push(registerWindow(poppedOutDesk('some-other-org', revealed)))
  await windowState(false)
  await w.focus('beta')
  assert.equal(w.selected(), 'alpha')
  assert.deepEqual(revealed, [])
})

test('§7 the main-window report: unknown is shown; hide, minimize, restore and show are followed', async (t) => {
  listeners.clear(); initial = { visible: false, minimized: false }
  assert.equal(mainWindowShown(), true, 'before anything reports, the window counts as shown')
  delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
  const none = watchMainWindow(); none()
  assert.equal(mainWindowShown(), true, 'no bridge: shown')

  ;(window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop = bridge
  t.after(() => { delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop })
  const off = watchMainWindow()
  await flush()
  assert.equal(mainWindowShown(), false, 'the state read at start: hidden')
  const say = (visible: boolean, minimized = false) => { for (const fn of [...listeners]) fn({ type: 'window-state', data: { visible, minimized } }) }
  say(true); assert.equal(mainWindowShown(), true)
  say(true, true); assert.equal(mainWindowShown(), false, 'minimized')
  say(true, false); assert.equal(mainWindowShown(), true, 'restored')
  say(false); assert.equal(mainWindowShown(), false)
  for (const fn of [...listeners]) fn({ type: 'preferences', data: { visible: true } })
  assert.equal(mainWindowShown(), false, 'another event\'s data is not a window report')
  for (const fn of [...listeners]) fn({ type: 'window-state', data: {} })
  assert.equal(mainWindowShown(), false, 'a report without the fact changes nothing')
  off()
  assert.equal(mainWindowShown(), true, 'nobody listening: back to shown')
  assert.equal(listeners.size, 0)
})
