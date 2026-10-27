// questionnotificationdesk.visual.tsx: real-renderer scenes for a question's
// desktop notification (USER 2026-10-27 13:25:36Z m007c48d12f28; docket
// 4-5-0-clicking-a-question-s-desktop-notification). The whole App on the
// fixture of tests/questionnotificationdesk.test.tsx, with no engine, provider,
// network or live org. ?scene= picks one: pin, floating, card, switchboard,
// attention, attention-pinned, none (the card: USER 19:00Z m41e0735bee13; the
// switchboard: 19:10Z m1a947c081d09). tools/rig/questionnotificationdesk-visual.mjs drives
// it through window.questionDeskVisual.
// No clipboard in this page: its APIs are replaced below, before anything renders.
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import type { DesktopNotice } from '../src/notifications'
import type { AskInfo, MailEntry, WorkItem } from '../src/types'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { addPin, readPins } from '../src/canvas/pins'
import { modalPinKey, pinModal, readModalPins } from '../src/canvas/modalpin'
import { DESK_KIND, QUEUE_KIND } from '../src/attention/AttentionView'
import { eventFanout, startBus } from './heldevents'
import { compatibilityWorkFixture } from './workcompat.fixture'
import '../src/styles.css'

// ── no clipboard in this page ───────────────────────────────────────────────
const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
const exec = document.execCommand.bind(document)
document.execCommand = ((command: string, ...rest: unknown[]) =>
  /^(copy|cut|paste)$/i.test(command) ? false : exec(command, ...(rest as [boolean, string]))) as typeof document.execCommand

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

type Scene = 'pin' | 'floating' | 'card' | 'switchboard' | 'attention' | 'attention-pinned' | 'none'
const SCENES: Scene[] = ['pin', 'floating', 'card', 'switchboard', 'attention', 'attention-pinned', 'none']
const asked = new URLSearchParams(location.search).get('scene') as Scene
const scene: Scene = SCENES.includes(asked) ? asked : 'none'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } }))
const pathOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input
  : input instanceof URL ? input.href : input.url).replace(/^[a-z]+:\/\/[^/]*/i, '').split(/[?#]/)[0] ?? ''
window.fetch = compatibilityWorkFixture(async (input) => {
  const path = pathOf(input)
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
class Socket { readyState = 1; send(_message: string) {} close() { this.readyState = 3 }
  addEventListener() {} removeEventListener() {} }
Object.defineProperty(window, 'WebSocket', { configurable: true, value: Socket })
const fan = eventFanout()
const identity = { windowId: 'question-desk-visual', kind: 'org', org: ORG, notificationOwner: false }
Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
  windowIdentity: identity, getWindowIdentity: async () => identity,
  requestOrg: async (org: string) => ({ action: 'focused', org }),
  notify: async () => true, syncNotifications: async () => {},
  getPreferences: async () => ({ notifyAllMail: true }), onEvent: fan.onEvent,
} })

localStorage.clear()
setOrgView(ORG, scene === 'attention' ? 'attention' : 'canvas')
setAttentionLayout(ORG, { agent: scene === 'none' ? 'peer' : 'asker' })
if (scene === 'pin') {
  // the peer's pin is added last, so it starts on top and overlaps the asker's
  addPin(ORG, 'asker', { x: 40, y: 50, w: 460, h: 460 })
  addPin(ORG, 'peer', { x: 320, y: 130, w: 460, h: 460 })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const zModal = (kind: string) => readModalPins()[modalPinKey(kind, ORG)]?.z ?? -1
const zPin = (id: string) => readPins(ORG).find(p => p.id === id)?.z ?? -1
const placeOf = (el: Element | null) => !el || el === document.body ? null
  : el.closest('.tempdesk-panel') ? 'floating desk' : el.closest('.pinwin') ? 'desk pin'
  : el.closest('.attn-desk') ? 'Attention agent desk' : el.closest('.eye-panel') ? 'switchboard panel'
  : el.closest('.sq.desk:not(.user)') ? 'canvas card'
  : el.closest('.settings.wide') ? 'inbox'
  : el.closest('.attn-panel-queue') ? 'Attention queue' : 'elsewhere'

Object.assign(window, { questionDeskVisual: {
  scene,
  /** put the asker's desk where this scene needs it */
  async arrange() {
    if (scene === 'floating') {
      const card = document.querySelector<HTMLElement>('.sq[data-copy-agent-name="asker"]')
      const box = card?.getBoundingClientRect()
      card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
        clientX: (box?.x ?? 0) + 20, clientY: (box?.y ?? 0) + 20 }))
      await sleep(200)
      const open = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(b => b.getAttribute('aria-haspopup') === 'menu' && /^Open\b/.test((b.textContent ?? '').trim()))
      open?.click()
    } else if (scene === 'card' || scene === 'switchboard') {
      // a plain click on the card: the camera glides onto it and its desk opens
      // (the eye card's desk is the switchboard, a panel per agent)
      const card = document.querySelector<HTMLElement>(scene === 'card' ? '.sq[data-copy-agent-name="asker"]' : '.sq.user')
      const box = card?.getBoundingClientRect()
      const at = { clientX: (box?.x ?? 0) + (box?.width ?? 0) / 2, clientY: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
      for (const type of ['pointerdown', 'pointerup']) card?.dispatchEvent(new PointerEvent(type, { bubbles: true,
        cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, ...at }))
      await sleep(1800)
    } else if (scene === 'attention') {
      // the queue starts on the ticket, so a moved selection would show
      fan.emit({ type: 'notification-click', data: ticket })
    } else if (scene === 'attention-pinned') {
      // each pinned panel raises itself when pinned: the queue, pinned last, starts on top
      pinModal(DESK_KIND, { x: 40, y: 50, w: 560, h: 560 }, ORG)
      await sleep(400)
      pinModal(QUEUE_KIND, { x: 380, y: 130, w: 520, h: 520 }, ORG)
    }
    await sleep(500)
  },
  /** the user clicks the question's desktop notification */
  click() { fan.emit({ type: 'notification-click', data: notice }) },
  /** a harness outline on whatever has the focus, so the PNG shows it */
  mark() {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return false
    el.style.outline = '4px solid #ff2d55'
    el.style.outlineOffset = '2px'
    return true
  },
  facts() {
    const active = document.activeElement
    const inbox = document.querySelector('.settings.wide')
    return {
      scene,
      inboxOpen: !!inbox,
      inboxShowsQuestion: !!inbox?.querySelector(`[data-question-id="${ask.id}"]`),
      focusedQuestion: active?.getAttribute('data-question-id') === ask.id,
      focusedIn: placeOf(active),
      floatingOpen: !!document.querySelector('.tempdesk-panel'),
      askerPinOnTop: scene === 'pin' ? zPin('asker') > zPin('peer') : null,
      attentionDeskOnTop: scene === 'attention-pinned' ? zModal(DESK_KIND) > zModal(QUEUE_KIND) : null,
      queueSelection: document.querySelector('[data-attn-row][aria-selected="true"]')?.getAttribute('data-attn-row') ?? null,
      questionCards: [...document.querySelectorAll(`[data-question-id="${ask.id}"]`)].map(placeOf),
    }
  },
} })

startBus()
createRoot(document.getElementById('root')!).render(<App />)
