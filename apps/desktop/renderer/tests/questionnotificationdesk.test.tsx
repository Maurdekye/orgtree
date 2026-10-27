// A question's desktop notification goes to the asker's open desk, not the
// inbox (USER 2026-10-27 13:25:36Z m007c48d12f28): "also if the asking agent's
// desk of a question is pinned anywhre, open either as a floating panel, a desk
// pin, or open in the attention agent desk, then dont open the question in the
// inbox when clicking a desktop notification for it". Open in more than one of
// those, the placement holding the live desk wins (@coordinator-opus: "pick the
// most recently used one"). USER 19:00Z m41e0735bee13: "a desk on a zoomed
// canvas card should count"; 19:10Z m1a947c081d09: the switchboard's panels
// count too. Open in none, the click is unchanged.
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import type { DesktopNotice } from '../src/notifications'
import type { AskInfo, MailEntry, WorkItem } from '../src/types'
import { forgetAttentionMode, setAttentionLayout, setOrgView } from '../src/attention/mode'
import { resetConvos } from '../src/convo'
import { resetLocalReads } from '../src/mailread'
import { forgetModalOpenCache, forgetModalPins, modalPinKey, pinModal, readModalPins, unpinModal } from '../src/canvas/modalpin'
import { addPin, forgetPins, readPins, removePin } from '../src/canvas/pins'
import { deskIdentity } from '../src/canvas/deskhosts'
import { registerWindow } from '../src/windowlife'
import { DESK_KIND, QUEUE_KIND } from '../src/attention/AttentionView'
import { eventFanout, startBus } from './heldevents'
import { compatibilityWorkFixture } from './workcompat.fixture'

test.beforeEach(() => resetLocalReads())

const ORG = 'question-desk-org'
const AT = '2026-10-27T13:30:00Z'
const ask: AskInfo = { id: 'ask-q1', node: 'asker', status: 'open', at: AT, kind: 'question',
  question: 'Which deployment lane should we use?', options: [{ label: 'Lane A' }, { label: 'Lane B' }] }
const notice: DesktopNotice = { id: `ask:${ask.id}`, org: ORG, kind: 'question', source_id: ask.id,
  agent: 'asker', generation: 0, title: 'asker asks', body: ask.question ?? '' }
const ticket: DesktopNotice = { id: 'ticket-notice', org: ORG, kind: 'work-attention', item: 'flagged',
  title: 'Flag', body: 'Review' }
const item = (slug: string, flagged = false): WorkItem => ({
  slug, title: slug, rev: 1, kind: 'code', objective: 'Fixture item',
  status: 'in_progress', owner: { node: 'asker', generation: 0 }, owner_current: true,
  owner_state: 'live', reviewer: null, participants: [], created_by: { node: 'asker', generation: 0 },
  at: AT, updated_at: AT, done_so_far: [], working_on_next: [], questions: [],
  manual_attention: flagged ? { reason: 'Please review', at: AT, by: { node: 'asker', generation: 0 }, set_rev: 1 } : null,
  effective_attention: flagged, attention_sources: flagged ? ['manual'] : [],
  archived: false, archived_at: null, blocked_reason: null, last_updater: null,
  acceptance: [], dependencies: [], evidence: [], dismissals: [], history: [],
  delivery: null, accepted: null, docket_at: null, superseded_by: null, parent: null,
})

async function setup(t: TestContext, mode: 'canvas' | 'attention' = 'canvas', deskAgent?: string) {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    custom: globals.CustomEvent, fragment: globals.DocumentFragment }
  const oldBridge = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  const oldScroll = window.HTMLElement.prototype.scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = function () {}
  class Socket { readyState = 1; send(_message: string) {} close() { this.readyState = 3 } }
  Object.assign(globals, { WebSocket: Socket, history: window.history,
    CustomEvent: window.CustomEvent, DocumentFragment: window.DocumentFragment })
  const fan = eventFanout()
  const identity = { windowId: 'notification-window', kind: 'org', org: ORG, notificationOwner: false }
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    windowIdentity: identity, getWindowIdentity: async () => identity,
    requestOrg: async (org: string) => ({ action: 'focused', org }),
    notify: async () => true, syncNotifications: async () => {},
    getPreferences: async () => ({ notifyAllMail: true }), onEvent: fan.onEvent,
  } })
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }))
  const agent = (id: string, withAsk: boolean) => ({ id, tier: 'opus', state: 'live', generation: 0, children: [],
    parent: null, seat: 1, grant: 10, free: 5, ask: withAsk ? ask : null,
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
  const asker = agent('asker', true), peer = agent('peer', false)
  const tree = { slug: ORG, name: ORG, roots: [asker, peer], asks: [ask], asks_open: 1,
    epoch: 1, rev: 1, dirs: [], tiers: { opus: 2 }, max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, credit_requests: [], audience_requests: [],
    audiences: [], watchdogs: [], work_items_summary: { attention: 1, active: 2 },
    audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_urgent_count: 0, org_inbox: null, net: null }
  const pending: MailEntry[] = []
  globals.fetch = compatibilityWorkFixture(async (input) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path === '/api/app/records') return json({ detail: 'legacy notification fixture' }, 501)
    if (path === '/api/desktop/notifications') return json({ notices: [notice, ticket], total: 2, truncated: false })
    if (path.endsWith('/foreground-tree')) return json({ kind: 'compatibility' }, 409)
    if (path === '/api/orgs') return json([{ slug: ORG, name: ORG, live: 2, seats: 2 }])
    if (path === `/api/orgs/${ORG}`) return json(tree)
    if (path === '/api/providers') return json({ providers: [] })
    if (/\/work-items(?:-view)?$/.test(path)) return json({ items: [item('flagged', true), item('work-1')],
      archived: [], backlogged: [], counts: { attention: 1, active: 2, archived: 0, backlogged: 0 } })
    if (path.endsWith('/inbox/read')) return json({ ok: true })
    if (path.endsWith('/inbox')) return json({ pending, delivered: [], sent: [] })
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [], busy: false,
      windowed: true, has_older: false, before: null, draft_epoch: 'fixture:0' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/nodes/asker/detail')) return json(asker)
    if (path.endsWith('/nodes/peer/detail')) return json(peer)
    return json({})
  })
  localStorage.clear()
  forgetPins(); forgetModalPins(); forgetModalOpenCache(); forgetAttentionMode(); resetConvos()
  setOrgView(ORG, mode)
  if (deskAgent) setAttentionLayout(ORG, { agent: deskAgent })
  window.history.replaceState(null, '', `/o/${ORG}`)
  const stopBus = startBus()
  let view: Awaited<ReturnType<typeof mountView>> | null = null
  t.after(async () => {
    unpinModal(QUEUE_KIND, ORG); unpinModal(DESK_KIND, ORG); unpinModal('docket', ORG)
    removePin(ORG, 'asker'); removePin(ORG, 'peer')
    await view?.unmount()
    stopBus(); resetConvos(); localStorage.clear()
    forgetPins(); forgetModalPins(); forgetModalOpenCache(); forgetAttentionMode()
    window.history.replaceState(null, '', '/')
    Object.assign(globals, { fetch: saved.fetch, WebSocket: saved.socket, history: saved.history,
      CustomEvent: saved.custom, DocumentFragment: saved.fragment })
    if (oldBridge) Object.defineProperty(window, 'orgtreeDesktop', oldBridge)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
    window.HTMLElement.prototype.scrollIntoView = oldScroll
  })
  view = await mountView(<App />, el => el)
  await inAct(() => flush(40))
  const click = (target: DesktopNotice = notice) => inAct(async () => {
    fan.emit({ type: 'notification-click', data: target }); await flush(40)
  })
  return { el: view.el, click }
}

const inbox = (el: HTMLElement) => el.querySelector('.settings.wide')
// jsdom has no layout: the canvas reads its viewport's size and takes pointer
// capture, so both are stated here (as tests/focusstick.test.tsx does)
function stubCanvas(): () => void {
  const proto = window.HTMLElement.prototype
  const rect = proto.getBoundingClientRect
  const capture = { set: proto.setPointerCapture, release: proto.releasePointerCapture, has: proto.hasPointerCapture }
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList?.contains('viewport')
      ? { x: 0, y: 0, left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, toJSON() {} } as DOMRect
      : rect.call(this)
  }
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.hasPointerCapture = () => false
  return () => {
    proto.getBoundingClientRect = rect
    proto.setPointerCapture = capture.set; proto.releasePointerCapture = capture.release; proto.hasPointerCapture = capture.has
  }
}
const pointer = (type: string) => new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
  pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 200, clientY: 200 })
// real time: the camera's glides run on animation frames
const waitFor = (ms: number) => inAct(async () => { await new Promise(r => setTimeout(r, ms)); await flush(10) })
const card = (scope: ParentNode, within: string) =>
  scope.querySelector<HTMLElement>(`${within} [data-question-id="${ask.id}"]`)
const selectedRow = (el: HTMLElement) => el.querySelector('[data-attn-row][aria-selected="true"]')?.getAttribute('data-attn-row')

test('desk pin: the click raises the pinned desk, focuses its question and opens no inbox', async (t) => {
  const { el, click } = await setup(t)
  await inAct(async () => {
    addPin(ORG, 'asker', { x: 20, y: 20, w: 360, h: 280 })
    addPin(ORG, 'peer', { x: 80, y: 80, w: 360, h: 280 })
    await flush(20)
  })
  const z = (id: string) => readPins(ORG).find(p => p.id === id)?.z ?? -1
  assert.ok(z('asker') < z('peer'), 'fixture: the asker pin starts behind the peer pin')
  assert.ok(card(el, '.pinwin'), 'fixture: the question card is on the pinned desk')
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.ok(z('asker') > z('peer'), 'the asker pin came to the front')
  assert.equal(document.activeElement, card(el, '.pinwin'), 'the question card on the pinned desk has focus')
})

test('floating desk: the click focuses the question in the open floating desk and opens no inbox', async (t) => {
  const { el, click } = await setup(t)
  const asker = el.querySelector<HTMLElement>('.sq[data-copy-agent-name="asker"]')
  assert.ok(asker, 'fixture: the asker card is on the canvas')
  await inAct(async () => {
    asker.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
    await flush(10)
  })
  const open = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(b => b.getAttribute('aria-haspopup') === 'menu' && /^Open\b/.test((b.textContent ?? '').trim()))
  assert.ok(open, 'fixture: the agent menu offers Open (the floating desk)')
  await inAct(async () => { open.click(); await flush(20) })
  const panel = document.querySelector<HTMLElement>('.tempdesk-panel')
  assert.ok(panel && card(panel, ''), 'fixture: the floating desk is open with the question card')
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.ok(document.querySelector('.tempdesk-panel'), 'the floating desk stays open')
  assert.equal(document.activeElement, card(document, '.tempdesk-panel'), 'the question card in the floating desk has focus')
})

test('zoomed canvas card: the click focuses the question on that card and opens no inbox', async (t) => {
  t.after(stubCanvas())
  const { el, click } = await setup(t)
  await waitFor(2500)   // the canvas's opening drift
  const asker = el.querySelector<HTMLElement>('.sq[data-copy-agent-name="asker"]')
  assert.ok(asker, 'fixture: the asker card is on the canvas')
  await inAct(async () => { asker.dispatchEvent(pointer('pointerdown')); await flush() })
  await inAct(async () => { asker.dispatchEvent(pointer('pointerup')); await flush() })
  await waitFor(1600)   // the glide to the card, and the desk it opens
  assert.ok(card(el, '.sq.desk:not(.user)'), 'fixture: the zoomed asker card shows its desk with the question')
  ;(document.activeElement as HTMLElement | null)?.blur()
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.equal(document.activeElement, card(el, '.sq.desk:not(.user)'), 'the question card on the zoomed card has focus')
})

test('switchboard: the click focuses the question in the asker panel and opens no inbox', async (t) => {
  t.after(stubCanvas())
  const { el, click } = await setup(t)
  await waitFor(2500)   // the canvas's opening drift
  const eye = el.querySelector<HTMLElement>('.sq.user')
  assert.ok(eye, 'fixture: the eye card is on the canvas')
  await inAct(async () => { eye.dispatchEvent(pointer('pointerdown')); await flush() })
  await inAct(async () => { eye.dispatchEvent(pointer('pointerup')); await flush() })
  await waitFor(1600)   // the glide into the switchboard and its panels
  assert.ok(card(el, '.eye-panel'), 'fixture: the switchboard shows the asker panel with the question')
  ;(document.activeElement as HTMLElement | null)?.blur()
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.equal(document.activeElement, card(el, '.eye-panel'), 'the question card in the asker panel has focus')
})

test('popped-out desk: the click brings the desk window forward and opens no inbox', async (t) => {
  const { el, click } = await setup(t)
  let revealed = 0
  t.after(registerWindow({ id: 'asker-desk-window', kind: `desk:${deskIdentity(ORG, { id: 'asker', generation: 0 })}`,
    org: ORG, editable: true, window, redock: () => {}, reveal: () => { revealed++ } }))
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.equal(revealed, 1, 'the popped-out desk window was brought forward')
})

test('Attention agent desk: in the Attention view and pinned on the canvas, the click focuses the desk, not the queue or inbox', async (t) => {
  const { el, click } = await setup(t, 'attention', 'asker')
  assert.ok(card(el, '.attn-desk'), 'fixture: the Attention agent desk shows the asker and its question')
  await click(ticket)
  assert.equal(selectedRow(el), 'ticket:flagged', 'fixture: the queue starts on the ticket entry')
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.equal(selectedRow(el), 'ticket:flagged', 'the queue keeps its selection')
  assert.equal(document.activeElement, card(el, '.attn-desk'), 'the question card on the Attention agent desk has focus')

  // pinned on the canvas, behind the pinned Needs attention panel: each frame
  // raises itself when it is pinned, so the panel pinned last is on top
  ;(document.activeElement as HTMLElement | null)?.blur()
  await inAct(async () => { setOrgView(ORG, 'canvas'); await flush(20) })
  await inAct(async () => { pinModal(DESK_KIND, { x: 30, y: 30, w: 480, h: 360 }, ORG); await flush(20) })
  await inAct(async () => { pinModal(QUEUE_KIND, { x: 60, y: 60, w: 420, h: 380 }, ORG); await flush(20) })
  const z = (kind: string) => readModalPins()[modalPinKey(kind, ORG)]?.z ?? -1
  assert.ok(card(el, '.attn-desk'), 'fixture: the pinned Attention agent desk shows the question card')
  assert.ok(z(DESK_KIND) < z(QUEUE_KIND), `fixture: the pinned Attention agent desk starts behind the pinned queue (${z(DESK_KIND)} < ${z(QUEUE_KIND)})`)
  await click()
  assert.equal(inbox(el), null, 'no inbox on the canvas either')
  assert.ok(z(DESK_KIND) > z(QUEUE_KIND), 'the pinned Attention agent desk came to the front')
  assert.equal(document.activeElement, card(el, '.attn-desk'), 'its question card has focus')
})

test('open in two placements: the one holding the live desk wins, and Move desk here changes it', async (t) => {
  const { el, click } = await setup(t, 'canvas', 'asker')
  await inAct(async () => {
    addPin(ORG, 'asker', { x: 20, y: 20, w: 360, h: 280 })
    await flush(20)
    pinModal(DESK_KIND, { x: 420, y: 40, w: 480, h: 360 }, ORG)
    await flush(25)
  })
  // the panel pinned last took the live desk; the pin shows the placeholder
  assert.ok(card(el, '.attn-desk'), 'fixture: the pinned Attention agent desk holds the live desk')
  assert.equal(card(el, '.pinwin'), null, 'fixture: the desk pin shows the placeholder')
  await click()
  assert.equal(inbox(el), null, 'no inbox')
  assert.equal(document.activeElement, card(el, '.attn-desk'), 'the Attention agent desk, which holds the live desk, has the focus')

  const move = [...el.querySelectorAll<HTMLButtonElement>('.pinwin button')].find(b => b.textContent === 'Move desk here')
  assert.ok(move, 'fixture: the desk pin offers Move desk here')
  await inAct(async () => { move.click(); await flush(20) })
  assert.ok(card(el, '.pinwin'), 'fixture: the desk pin now holds the live desk')
  ;(document.activeElement as HTMLElement | null)?.blur()
  await click()
  assert.equal(inbox(el), null, 'still no inbox')
  assert.equal(document.activeElement, card(el, '.pinwin'), 'the desk pin, used last, has the focus')
})

test('not open in any placement: the click is unchanged (inbox on the canvas, queue entry in the Attention view)', async (t) => {
  const { el, click } = await setup(t, 'canvas', 'peer')
  await click()
  assert.ok(inbox(el), 'the inbox opens on the canvas')

  await inAct(async () => { setOrgView(ORG, 'attention'); await flush(25) })
  assert.equal(card(el, '.attn-desk'), null, 'fixture: the Attention agent desk shows another agent')
  await click()
  assert.equal(selectedRow(el), `question:${ask.id}`, 'the Attention view selects the question entry')
})
