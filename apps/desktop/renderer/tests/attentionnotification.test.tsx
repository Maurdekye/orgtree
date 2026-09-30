import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import type { DesktopNotice } from '../src/notifications'
import type { AskInfo, MailEntry, WorkItem } from '../src/types'
import { forgetAttentionMode, setOrgView } from '../src/attention/mode'
import { resetConvos } from '../src/convo'
import { resetLocalReads } from '../src/mailread'
// a read made in one test is not still "read here" in the next
test.beforeEach(() => resetLocalReads())
import { pinModal, unpinModal } from '../src/canvas/modalpin'
import { QUEUE_KIND } from '../src/attention/AttentionView'
import { eventFanout, startBus } from './heldevents'
import { compatibilityWorkFixture } from './workcompat.fixture'

const ORG = 'notice-fixture'
const AT = '2026-09-30T11:00:00Z'
const question: AskInfo = { id: 'shared:source', node: 'agent', status: 'open', at: AT,
  kind: 'question', question: 'Choose the notification target?', options: [{ label: 'Continue' }] }
const urgent: MailEntry = { id: 'shared:source', from: 'agent', kind: 'message', at: AT,
  body: 'Urgent notification body', urgent: true, urgent_reason: 'Review this mail' }
const ordinary: MailEntry = { ...urgent, id: 'ordinary', body: 'Ordinary mail body', urgent: false }
const item = (slug: string, flagged = false): WorkItem => ({
  slug, title: slug, rev: 1, kind: 'code', objective: 'Notification routing fixture',
  status: 'in_progress', owner: { node: 'agent', generation: 0 }, owner_current: true,
  owner_state: 'live', reviewer: null, participants: [], created_by: { node: 'agent', generation: 0 },
  at: AT, updated_at: AT, done_so_far: [], working_on_next: [], questions: [],
  manual_attention: flagged ? { reason: 'Please review', at: AT,
    by: { node: 'agent', generation: 0 }, set_rev: 1 } : null,
  effective_attention: flagged, attention_sources: flagged ? ['manual'] : [],
  archived: false, archived_at: null, blocked_reason: null, last_updater: null,
  acceptance: [], dependencies: [], evidence: [], dismissals: [], history: [],
  delivery: null, accepted: null, docket_at: null, superseded_by: null,
})
const notices: DesktopNotice[] = [
  { id: 'ticket-notice', org: ORG, kind: 'work-attention', item: 'flagged', title: 'Flag', body: 'Review' },
  // Same raw ID in two kinds must still select the exact notification target.
  { id: 'question-notice', org: ORG, kind: 'question', source_id: question.id,
    title: 'Question', body: 'Choose' },
  { id: 'mail:' + urgent.id, org: ORG, kind: 'urgent-mail', title: 'Urgent', body: 'Read' },
  { id: 'ordinary-notice', org: ORG, kind: 'routine', source_id: ordinary.id, title: 'Mail', body: 'Read' },
  { id: 'unlisted-ticket-notice', org: ORG, kind: 'work-attention', item: 'unflagged', title: 'Ticket', body: 'Read' },
]

async function setup(t: TestContext, mode: 'attention' | 'canvas' = 'attention') {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    custom: globals.CustomEvent, fragment: globals.DocumentFragment }
  const oldBridge = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  const oldScroll = window.HTMLElement.prototype.scrollIntoView
  const scrolled: string[] = [], read: string[] = []
  let pending = [urgent, ordinary]
  window.HTMLElement.prototype.scrollIntoView = function () {
    const key = this.closest('[data-attn-row]')?.getAttribute('data-attn-row')
    if (key) scrolled.push(key)
  }
  class Socket { readyState = 1; close() { this.readyState = 3 } }
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
  const node = { id: 'agent', tier: 'opus', state: 'live', generation: 0, children: [],
    parent: null, seat: 1, grant: 10, free: 5, ask: question,
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } }
  const tree = { slug: ORG, name: ORG, roots: [node], asks: [question], asks_open: 1,
    epoch: 1, rev: 1, dirs: [], tiers: { opus: 1 }, max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, credit_requests: [], audience_requests: [],
    audiences: [], watchdogs: [], work_items_summary: { attention: 1, active: 2 },
    audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 2, user_inbox_urgent_count: 1, org_inbox: null, net: null }
  globals.fetch = compatibilityWorkFixture(async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path === '/api/desktop/notifications') {
      const active = notices.filter(n => n.kind !== 'urgent-mail' || pending.some(m => m.id === urgent.id))
      return json({ notices: active, total: active.length, truncated: false })
    }
    if (path.endsWith('/foreground-tree')) return json({ kind: 'compatibility' }, 409)
    if (path === '/api/orgs') return json([{ slug: ORG, name: ORG, live: 1, seats: 1 }])
    if (path === `/api/orgs/${ORG}`) return json(tree)
    if (path === '/api/providers') return json({ providers: [] })
    if (/\/work-items(?:-view)?$/.test(path)) return json({ items: [item('flagged', true), item('unflagged')],
      archived: [], backlogged: [], counts: { attention: 1, active: 2, archived: 0, backlogged: 0 } })
    if (path.endsWith('/inbox/read')) {
      const ids = JSON.parse(String(init?.body)).ids as string[]
      read.push(...ids)
      pending = pending.filter(m => !ids.includes(m.id))
      return json({ ok: true })
    }
    if (path.endsWith('/inbox')) return json({ pending, delivered: [urgent, ordinary].filter(m => !pending.includes(m)), sent: [] })
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [], busy: false,
      windowed: true, has_older: false, before: null, draft_epoch: 'fixture:0' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/detail')) return json(node)
    return json({})
  })
  localStorage.clear(); forgetAttentionMode(); resetConvos()
  setOrgView(ORG, mode)
  window.history.replaceState(null, '', `/o/${ORG}`)
  const stopBus = startBus()
  let view: Awaited<ReturnType<typeof mountView>> | null = null
  t.after(async () => {
    unpinModal(QUEUE_KIND, ORG)
    await view?.unmount(); stopBus(); resetConvos(); localStorage.clear(); forgetAttentionMode()
    window.history.replaceState(null, '', '/')
    Object.assign(globals, { fetch: saved.fetch, WebSocket: saved.socket, history: saved.history,
      CustomEvent: saved.custom, DocumentFragment: saved.fragment })
    if (oldBridge) Object.defineProperty(window, 'orgtreeDesktop', oldBridge)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
    window.HTMLElement.prototype.scrollIntoView = oldScroll
  })
  view = await mountView(<App />, el => el)
  await inAct(() => flush(40))
  const click = (notice: DesktopNotice) => inAct(async () => {
    fan.emit({ type: 'notification-click', data: notice }); await flush(40)
  })
  return { el: view.el, click, scrolled, read }
}

for (const [notice, key, kind] of [
  [notices[0]!, 'ticket:flagged', 'ticket'],
  [notices[1]!, 'question:' + question.id, 'question'],
  [notices[2]!, 'mail:' + urgent.id, 'mail'],
] as const) {
  test(`native ${kind} notification selects its Attention entry, focuses and scrolls without a modal`, async (t) => {
    const { el, click, scrolled, read } = await setup(t)
    assert.equal(el.querySelector('[data-attention-active]')?.getAttribute('data-attention-active'), 'yes')
    assert.equal(el.querySelectorAll('[data-attn-row]').length, 3, 'real queue sources loaded')
    const pane = el.querySelector<HTMLElement>('.attn-mread')!
    pane.scrollTop = 350
    await click(notice)
    const selected = el.querySelector('[data-attn-row][aria-selected="true"]')
    assert.equal(selected?.getAttribute('data-attn-row'), key)
    assert.equal(el.querySelector('[data-attn-detail]')?.getAttribute('data-attn-detail'), kind)
    assert.equal(document.activeElement?.classList.contains('attn-mlist'), true)
    assert.equal(scrolled.at(-1), key)
    assert.equal(pane.scrollTop, 0)
    assert.equal(!!el.querySelector('.settings.wide'), false, 'no inbox/docket modal')
    if (kind === 'question') {
      await click(notice)
      assert.equal(scrolled.filter(key => key === 'question:' + question.id).length, 2,
        'repeat click reveals the same entry again')
    }
    if (kind === 'mail') {
      assert.ok(read.includes(urgent.id), 'selecting urgent mail retains the existing mark-read path')
      assert.equal(el.querySelector('[data-attn-row][aria-selected="true"]')?.getAttribute('data-attn-row'),
        'mail:' + urgent.id, 'mail remains selected after its read acknowledgment removes it from pending')
    }
  })
}

for (const [target, panel] of [[3, 'inbox'], [4, 'docket']] as const) {
  test(`Attention keeps the existing ${panel} modal for an unlisted notification target`, async (t) => {
    const { el, click } = await setup(t)
    await click(notices[target]!)
    assert.equal(!!el.querySelector('.settings.wide'), true)
    assert.equal(!!el.querySelector('.settings.wide.docket-modal'), panel === 'docket')
    assert.equal(!!el.querySelector('[data-attn-row][aria-selected="true"]'), false)
  })
}

test('Canvas fallback remains active while a pinned Attention queue is still mounted', async (t) => {
  const { el, click } = await setup(t)
  await inAct(async () => {
    pinModal(QUEUE_KIND, { x: 10, y: 10, w: 500, h: 400 }, ORG)
    setOrgView(ORG, 'canvas'); await flush(20)
  })
  assert.equal(el.querySelectorAll('[data-attn-row]').length, 3, 'the pinned queue still owns a handler')
  assert.equal(el.querySelector('[data-attention-active]')?.getAttribute('data-attention-active'), 'no')
  await click(notices[0]!)
  assert.equal(!!el.querySelector('.settings.wide.docket-modal'), true)
  assert.equal(!!el.querySelector('[data-attn-row][aria-selected="true"]'), false)
})

for (const [target, panel] of [[0, 'docket'], [1, 'inbox'], [2, 'inbox']] as const) {
  test(`Canvas keeps the existing ${panel} modal for ${notices[target]!.kind}`, async (t) => {
    const { el, click } = await setup(t, 'canvas')
    await click(notices[target]!)
    assert.equal(!!el.querySelector('.settings.wide'), true)
    assert.equal(!!el.querySelector('.settings.wide.docket-modal'), panel === 'docket')
    assert.equal(!!el.querySelector('[data-attn-row][aria-selected="true"]'), false)
  })
}
