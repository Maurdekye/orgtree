// The user mailbox panel as chats (4.7.0). One test per ruling of USER
// 2026-11-22 m200806e4af28 / m1454e651500e / m321dab754e52 and 2026-11-23
// m79c022311f95 / me0241bccf7b4, driven on the mounted panel against a fake
// engine. dmmodel.test.tsx holds the pure rules; this file shows the panel
// obeys them and calls exactly the engine routes the classic mailbox calls.
//
// Run:  node apps/desktop/renderer/tests/run.mjs dmpanel

import './harness'
import { fireResize, flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AskBell, UserMailbox } from '../src/App'
import { CurrentOrg } from '../src/popout'
import {
  CLASSIC_MAILBOX_KEY, OPEN_CHAT_ON_REPLY_KEY, onChatRequest, replySentOnObject, setClassicMailbox,
  setOpenChatOnReply,
} from '../src/mailboxpref'
import { resetLocalReads } from '../src/mailread'
import { resetComposerDrafts } from '../src/composerdrafts'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { syncFastModes } from '../src/canvas/fastmode'
import { OPEN_SETTINGS_AT_EVENT } from '../src/canvas/settingskit'
import { withoutMailTransfers } from './mailtransfers.fixture'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}
const USER = '@user'

const node = (id: string, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id, title: id, tier: 'opus', model_id: 'opus', state: 'live', seat: 1, grant: 0, free: 0, ui_order: 0,
  cost_usd: 0, occupancy: null, context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [], turns: [], frozen: null,
  audiences_held: [], bearer_state: null, generation: 0, children, lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' }, ...extra,
})

/** lead and solo are top-level; worker and helper report to lead */
const tree = (extra: Record<string, unknown> = {}, lead: Record<string, unknown> = {}) => ({
  slug: 'mine', name: 'Mine', tiers: { opus: { name: 'Opus' } },
  roots: [node('lead', [node('worker'), node('helper')], lead), node('solo')],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full', ...extra,
}) as unknown as TreePayload

const mail = (id: string, from: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ id, from, at, kind: 'message', body: `body of ${id}`, ...extra })
const sent = (id: string, to: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ id, from: USER, to, at, kind: 'message', body: `body of ${id}`, ...extra })
const grant = (grantee: string) => ({ grantee, grantor: USER, granted_at: '2026-11-01T00:00:00Z', reason: '' })

interface Call { method: string; path: string; body: Record<string, unknown> | null }
interface World {
  pending?: unknown[]; delivered?: unknown[]; sent?: unknown[]
  audiences?: unknown[]; requests?: unknown[]
  /** a mail the by-id lookup knows, outside the loaded window */
  byId?: Record<string, unknown>
  /** the engine refuses every message */
  refuse?: boolean
  /** older history, a page per entry: the first read says there is more, and
   *  `before=<n>` returns page n (1-based) */
  older?: { delivered?: unknown[]; sent?: unknown[] }[]
}

function engine(world: World) {
  const calls: Call[] = []
  /** every history page asked for: `<folder>:<before>` */
  const pages: string[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetcher = withoutMailTransfers((async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    if (method !== 'GET') calls.push({ method, path, body })
    if (/\/audiences$/.test(path)) {
      if (method === 'POST') {
        const b = body as { action: string; node: string }
        if (b.action === 'revoke') world.audiences = (world.audiences ?? []).filter(g => (g as { grantee: string }).grantee !== b.node)
        if (b.action === 'grant') world.audiences = [...(world.audiences ?? []), grant(b.node)]
        if (b.action === 'grant' || b.action === 'deny') world.requests = (world.requests ?? []).filter(r => (r as { from: string }).from !== b.node)
        return json({ ok: true })
      }
      return json({ audiences: world.audiences ?? [], requests: world.requests ?? [] })
    }
    if (/\/inbox\/read$/.test(path)) {
      const ids = (body as { ids: string[] }).ids
      const read = (world.pending ?? []).filter(m => ids.includes((m as { id: string }).id))
      world.pending = (world.pending ?? []).filter(m => !ids.includes((m as { id: string }).id))
      world.delivered = [...(world.delivered ?? []), ...read]
      return json({ read: read.length })
    }
    const byId = path.match(/\/mail\/user\/([^?]+)/)
    if (byId) {
      const found = world.byId?.[decodeURIComponent(byId[1]!)] ?? null
      return json({ found: !!found, mail: found })
    }
    if (/\/nodes\/[^/]+\/message$/.test(path)) return world.refuse ? json({ error: 'the agent is not taking mail' }, 500)
      : json({ accepted: true, id: 'm-new', ref: '@mail:m-new' })
    // a desk's own chat read (the desk box mounted beside the chats' box)
    if (/\/nodes\/[^/]+\/chat(\?|$)/.test(path)) return json({ messages: [], live: [], pending_mail: [], busy: false, responding: false,
      windowed: true, has_older: false, before: null, draft_epoch: 'synthetic:0' })
    if (/\/nodes\/[^/]+\/batch$/.test(path)) return json({ resolved: 'ok' })
    if (/\/nodes\/[^/]+\/scope$/.test(path)) return json({ ok: true })
    if (/\/inbox(\?|$)/.test(path)) {
      const q = new URL(path, 'http://x').searchParams
      const older = world.older ?? []
      const ids = q.get('ids')
      if (ids) {
        // the reader re-reads the rows it holds: every one of them, as it stands
        const want = JSON.parse(ids) as string[]
        const all = [...(world.delivered ?? []), ...older.flatMap(p => p.delivered ?? [])] as { id: string }[]
        const mine = [...(world.sent ?? []), ...older.flatMap(p => p.sent ?? [])] as { id: string }[]
        return json({ pending: [], delivered: all.filter(m => want.includes(m.id)), sent: mine.filter(m => want.includes(m.id)), refreshed_ids: want })
      }
      const before = q.get('before')
      if (before) {
        pages.push(`${q.get('folder')}:${before}`)
        const page = older[Number(before) - 1] ?? {}
        return json({ pending: [], delivered: page.delivered ?? [], sent: page.sent ?? [],
          next_cursor: Number(before) < older.length ? String(Number(before) + 1) : null })
      }
      return json({ pending: world.pending ?? [], delivered: world.delivered ?? [], sent: world.sent ?? [], next_cursor: older.length ? '1' : null })
    }
    return json({})
  }) as typeof fetch)
  return { calls, pages, fetcher }
}

async function setup(t: TestContext, world: World, opts: {
  tree?: TreePayload; jumpTo?: string | null; active?: boolean; openChat?: { peer: string; seq: number } | null
} = {}) {
  const oldFetch = globalThis.fetch
  const server = engine(world)
  globalThis.fetch = server.fetcher
  const oldFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')
  Object.defineProperty(document, 'hasFocus', { value: () => opts.active !== false, configurable: true })
  const oldConfirm = window.confirm
  const confirms: string[] = []
  window.confirm = (text?: string) => { confirms.push(String(text)); return true }
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  window.localStorage.removeItem(OPEN_CHAT_ON_REPLY_KEY)
  window.sessionStorage.clear()
  resetLocalReads()
  resetComposerDrafts()
  const state = { closed: 0, focused: [] as string[], toasts: [] as string[], opened: [] as unknown[] }
  const panel = (o = opts) => (
    <CurrentOrg.Provider value="mine">
      <UserMailbox slug="mine" tree={o.tree ?? opts.tree ?? tree()} toast={(lines) => { state.toasts.push(...lines) }}
        close={() => { state.closed++ }} jumpTo={o.jumpTo ?? null} jumpSeq={o.jumpTo ? 1 : null}
        openChat={o.openChat ?? null} onFocusAgent={(id) => { state.focused.push(id) }}
        onOpenMail={(ref) => { state.opened.push(ref) }} />
    </CurrentOrg.Provider>
  )
  let view = await mountView(panel(), el => el)
  /** close the panel and open it again, as closing and reopening the inbox does */
  const remount = async () => {
    await view.unmount()
    view = await mountView(panel(), el => el)
    await inAct(async () => { await flush(12) })
  }
  t.after(async () => {
    await view.unmount()
    globalThis.fetch = oldFetch
    window.confirm = oldConfirm
    if (oldFocus) Object.defineProperty(document, 'hasFocus', oldFocus)
    else delete (document as unknown as Record<string, unknown>).hasFocus
    window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
    window.localStorage.removeItem(OPEN_CHAT_ON_REPLY_KEY)
  })
  await inAct(async () => { await flush(12) })
  const all = <T extends Element>(sel: string) => [...document.querySelectorAll<T>(sel)]
  const click = async (el: Element | null | undefined, what = 'the control') => {
    assert.ok(el, `${what} is on screen`)
    await inAct(async () => { (el as HTMLElement).click(); await flush(8) })
  }
  const rows = () => all<HTMLElement>('.dm-row')
  const row = (peer: string) => rows().find(r => r.dataset.dmChat === peer)
  const openChat = async (peer: string) => { await click(row(peer), `the chat row of ${peer}`) }
  const type = async (text: string) => {
    const ta = document.querySelector('.dm-compose textarea') as HTMLTextAreaElement
    assert.ok(ta, 'the message box is on screen')
    await inAct(async () => {
      Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, text)
      ta.dispatchEvent(new W.Event('input', { bubbles: true }))
      await flush(2)
    })
  }
  const send = async () => { await click(document.querySelector('.dm-compose .mail-reply-send'), 'the send button') }
  const draft = () => (document.querySelector('.dm-compose textarea') as HTMLTextAreaElement | null)?.value ?? null
  return { get view() { return view }, state, server, confirms, all, click, rows, row, openChat, type, send, draft, remount,
    rerender: (o: typeof opts) => view.render(panel({ ...opts, ...o })) }
}

const posts = (calls: Call[], re: RegExp) => calls.filter(c => c.method === 'POST' && re.test(c.path))

test('the panel is a list of chats: every top-level agent and every audience holder, newest first, each with its unread count', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    pending: [mail('m2', 'worker', '2026-11-20T12:00:00Z'), mail('m3', 'worker', '2026-11-20T12:05:00Z')],
    delivered: [mail('m1', 'lead', '2026-11-20T10:00:00Z')],
    sent: [sent('s1', 'solo', '2026-11-20T11:00:00Z')],
  }, { active: false })
  assert.equal(document.querySelector('.settings.dm-panel') !== null, true, 'the chats panel is mounted')
  assert.equal(document.querySelector('.mail-folders') === null, true, 'and it has no folders: it is not the classic mailbox')
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['worker', 'solo', 'lead'],
    'newest message first; helper holds no audience and has no chat')
  assert.equal(s.row('worker')!.querySelector('.dm-badge:not(.dm-badge-asks)')?.textContent, '2', 'two unread from worker')
  assert.equal(s.row('lead')!.querySelector('.dm-badge') === null, true, 'nothing unread from lead')
  assert.match(s.row('solo')!.querySelector('.dm-row-prev')?.textContent ?? '', /^You:\s+body of s1$/, 'the user\'s own last message is marked as theirs')
  assert.equal(s.server.calls.length, 0, 'opening the panel changes nothing on the engine')
})

test('a chat is that agent\'s mail as bubbles, oldest first, the user\'s own on the other side', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('x1', 'lead', '2026-11-20T10:01:00Z')],
    sent: [sent('s2', 'worker', '2026-11-20T11:00:00Z')],
    pending: [mail('m3', 'worker', '2026-11-20T12:00:00Z')],
  }, { active: false })
  // it opens on the chat holding the oldest unread mail, as the classic mailbox opens on that mail
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker')
  const bubbles = s.all<HTMLElement>('.dm-msg')
  assert.deepEqual(bubbles.map(b => b.dataset.dmEntry), ['m1', 's2', 'm3'])
  assert.deepEqual(bubbles.map(b => b.classList.contains('out')), [false, true, false])
  assert.match(bubbles[0]!.textContent ?? '', /body of m1/)
  assert.equal(document.querySelector('.dm-newmark')?.textContent, '1 new message', 'the unread mail is under a "new" line')
  assert.equal(s.all('.dm-day').length, 1, 'one day line for one day')
})

test('seeing a chat reads it: one read request for its unread mail, and only while the window has the user', async (t) => {
  const world: World = {
    audiences: [grant('worker')],
    pending: [mail('m2', 'worker', '2026-11-20T12:00:00Z'), mail('m3', 'worker', '2026-11-20T12:05:00Z'),
      mail('l1', 'lead', '2026-11-20T13:00:00Z')],
  }
  const away = await setup(t, world, { active: false })
  assert.equal(posts(away.server.calls, /\/inbox\/read$/).length, 0, 'a window the user is not at reads nothing')
  await away.view.unmount()

  const s = await setup(t, world)
  const reads = posts(s.server.calls, /\/inbox\/read$/)
  assert.equal(reads.length, 1, 'the open chat\'s unread mail goes in one request')
  assert.deepEqual(reads[0]!.body, { ids: ['m2', 'm3'] }, 'worker\'s mail only: lead\'s chat was not opened')
  assert.equal(s.row('worker')!.querySelector('.dm-badge') === null, true, 'its count is gone on the spot')
  assert.equal(s.row('lead')!.querySelector('.dm-badge')?.textContent, '1')
})

test('closing an audience chat revokes exactly that grant, at once, with no confirmation', async (t) => {
  const s = await setup(t, { audiences: [grant('worker'), grant('helper')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] })
  await s.openChat('worker')
  const close = document.querySelector<HTMLButtonElement>('.dm-head .dm-close')!
  assert.equal(close.disabled, false)
  assert.match(close.title, /revoke worker's audience/i)
  await s.click(close)
  const revokes = posts(s.server.calls, /\/audiences$/)
  assert.equal(revokes.length, 1)
  assert.deepEqual(revokes[0]!.body, { action: 'revoke', node: 'worker' })
  assert.deepEqual(s.confirms, [], 'nothing asked "are you sure"')
  assert.equal(s.row('worker'), undefined, 'the chat left the list')
  assert.equal(s.row('helper') !== undefined, true, 'the other grant is untouched')
  assert.equal(document.querySelector('.dm-head') === null, true, 'and no chat is open any more')
})

test('a top-level chat cannot be closed, and the control says why', async (t) => {
  const s = await setup(t, { delivered: [mail('m1', 'lead', '2026-11-20T10:00:00Z')] })
  await s.openChat('lead')
  const close = document.querySelector<HTMLButtonElement>('.dm-head .dm-close')!
  assert.equal(close.disabled, true)
  assert.match(close.title, /top-level/i)
  assert.match(close.title, /can't be closed/i)
  assert.equal(s.row('lead')!.querySelector('.dm-row-close') === null, true, 'its row offers no close either')
  await inAct(async () => { close.click(); await flush(4) })
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0)
})

test('a top-level agent that also holds a grant: closing revokes the grant, the chat stays, and the tooltip says so', async (t) => {
  const s = await setup(t, { audiences: [grant('solo')], delivered: [mail('m1', 'solo', '2026-11-20T10:00:00Z')] })
  await s.openChat('solo')
  const close = document.querySelector<HTMLButtonElement>('.dm-head .dm-close')!
  assert.equal(close.disabled, false)
  assert.match(close.title, /revoke solo's audience grant/i)
  assert.match(close.title, /the chat stays/i)
  await s.click(close)
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'solo' }])
  assert.equal(s.row('solo') !== undefined, true, 'the chat is still listed')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'solo', 'and still open')
  assert.equal(document.querySelector<HTMLButtonElement>('.dm-head .dm-close')!.disabled, true, 'with nothing left to revoke')
})

test('New chat is the agents list itself; picking an agent without an audience grants one and opens its chat', async (t) => {
  const s = await setup(t, { audiences: [] })
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  const picker = document.querySelector('.dm-newchat')
  assert.ok(picker, 'the picker opened')
  assert.equal(picker!.parentElement?.classList.contains('dm-list'), true, 'over the chat list, in its column')
  assert.equal(picker!.classList.contains('tray-panel'), true, 'in the canvas agents list\'s own panel box')
  assert.equal(picker!.querySelector(':scope > .tray') !== null, true, 'it is the shared agents list')
  assert.equal(picker!.querySelector('input.tray-filter') !== null, true, 'with its filter box')
  assert.equal(document.querySelector('input[aria-label="Only active agents"]') !== null, true, 'and its active-only switch')
  assert.deepEqual(s.all<HTMLElement>('.dm-newchat .tray-row').map(r => r.dataset.dmPick), ['lead', 'worker', 'helper', 'solo'],
    'every agent of this org, by hierarchy')
  await s.click(s.all<HTMLElement>('.dm-newchat .tray-row').find(r => r.dataset.dmPick === 'helper'), 'helper\'s row')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'grant', node: 'helper' }])
  assert.equal(document.querySelector('.dm-newchat') === null, true, 'the picker closed')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'helper', 'and helper\'s chat is open')
})

test('New chat on an agent that can already write to the user opens its chat and grants nothing', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')] })
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  await s.click(s.all<HTMLElement>('.dm-newchat .tray-row').find(r => r.dataset.dmPick === 'lead'), 'lead\'s row')
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  await s.click(s.all<HTMLElement>('.dm-newchat .tray-row').find(r => r.dataset.dmPick === 'worker'), 'worker\'s row')
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0)
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker')
})

test('a notice keeps its fill and has a thick, widely dashed border in the chat background\'s colour, and no label; a request has its label, and files are chips', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [
      mail('n1', 'worker', '2026-11-20T10:00:00Z', { notice: true }),
      mail('r1', 'worker', '2026-11-20T10:10:00Z', { kind: 'request' }),
      mail('f1', 'worker', '2026-11-20T10:20:00Z', { attachments: [{ name: 'report.pdf', path: 'outbox/report.pdf', bytes: 2048 }] }),
      mail('p1', 'worker', '2026-11-20T10:30:00Z'),
    ],
  })
  await s.openChat('worker')
  const bubble = (id: string) => s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === id)!.querySelector<HTMLElement>('.dm-bubble')!
  assert.equal(bubble('n1').classList.contains('notice'), true)
  // USER 2026-11-23 mae2b1aa37a9b: "dont display the 'NOTICE' badge"
  assert.equal(bubble('n1').querySelector('.dm-kind') === null, true, 'a notice wears no label')
  assert.match(bubble('n1').querySelector('.dm-sr')?.textContent ?? '', /notice/, 'a screen reader is still told it is one')
  assert.equal(bubble('p1').classList.contains('notice'), false, 'an ordinary message is not dashed')
  assert.equal(bubble('r1').querySelector('.dm-kind')?.textContent, 'Request')
  assert.equal(bubble('p1').querySelector('.dm-kind') === null, true, 'an ordinary message wears no label')
  const chip = bubble('f1').querySelector<HTMLAnchorElement>('.attach-row a.attach-chip')
  assert.match(chip?.textContent ?? '', /report\.pdf/)
  assert.match(chip?.getAttribute('href') ?? '', /\/api\/orgs\/mine\/nodes\/worker\/file\?path=outbox%2Freport\.pdf$/,
    'the file is the sender\'s, read through the route the classic mailbox uses')
  // the rule that draws it (USER 2026-11-23 mae2b1aa37a9b, m7012356beca4): the
  // fill is the bubble's own; the border is a layer in the chat background's
  // colour, cut to a dashed outline 4px wide on the edge (2px inside) with
  // 7px dashes and 7px gaps
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  const rule = /\.dm-bubble\.notice::before \{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(rule, /background: var\(--bg\);/, 'the border is the chat background\'s colour')
  assert.match(rule, /mask: url\("data:image\/svg\+xml,[^"]*stroke-width='4' stroke-dasharray='7 7'/, 'thick, with wide gaps')
  assert.equal(/\.dm-bubble\.notice \{[^}]*(background|border:)/.test(css), false, 'the notice sets no fill and no border of its own')
  assert.equal(/currentColor/.test(rule), false, 'not in the text colour any more')
})

// ---- prototype feedback (USER 2026-11-23 mae2b1aa37a9b) ----

const request = (from: string, at = '2026-11-20T09:00:00Z', reason = 'to report the nightly check to you directly') =>
  ({ from, target: USER, currently_at: USER, reason, at })

test('an audience request is a new chat, marked and first in the list, and there is no request strip', async (t) => {
  const s = await setup(t, {
    requests: [request('helper')],
    delivered: [mail('m1', 'lead', '2026-11-20T10:00:00Z')],
  }, { active: false })
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['helper', 'lead', 'solo'], 'the request is the first chat')
  assert.equal(s.row('helper')!.classList.contains('request'), true, 'and it is marked')
  assert.match(s.row('helper')!.querySelector('.dm-row-prev')?.textContent ?? '', /^Audience request ·\s+to report the nightly check/)
  assert.equal(s.row('helper')!.querySelector('.dm-badge-request') !== null, true)
  assert.equal(s.row('lead')!.classList.contains('request'), false)
  assert.equal(document.querySelector('.dm-requests') === null, true, 'the strip above the chats is gone')
  await s.openChat('helper')
  const card = document.querySelector<HTMLElement>('.dm-audreq')
  assert.equal(card?.dataset.dmRequest, 'helper', 'the chat shows the request')
  assert.match(card?.textContent ?? '', /helper asks for an audience with you:.*to report the nightly check to you directly/)
  assert.deepEqual([...card!.querySelectorAll('button')].map(b => b.textContent), ['Approve', 'Deny'])
  assert.equal(s.server.calls.length, 0, 'looking at a request answers nothing')
})

test('Approve in the chat grants the audience with the existing action, and the chat stays as an audience chat', async (t) => {
  const s = await setup(t, { requests: [request('helper')] }, { active: false })
  await s.openChat('helper')
  await s.click([...document.querySelectorAll('.dm-audreq button')].find(b => b.textContent === 'Approve'), 'Approve')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'grant', node: 'helper' }])
  assert.equal(document.querySelector('.dm-audreq') === null, true, 'the request is answered')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'helper', 'its chat stays open')
  assert.equal(s.row('helper')!.classList.contains('request'), false)
  assert.match(document.querySelector('.dm-head .dm-who-l1')?.textContent ?? '', /audience/, 'now holding the audience')
})

test('writing to a chat that is a request approves it: the grant, then the message', async (t) => {
  const s = await setup(t, { requests: [request('helper')] }, { active: false })
  await s.openChat('helper')
  await s.type('Go ahead, report here.')
  await s.send()
  const changed = s.server.calls.filter(c => c.method === 'POST' && /\/(audiences|nodes\/helper\/message)$/.test(c.path))
  assert.deepEqual(changed.map(c => c.path.replace(/^.*\/orgs\/mine/, '')), ['/audiences', '/nodes/helper/message'], 'the grant first, then the message')
  assert.deepEqual(changed[0]!.body, { action: 'grant', node: 'helper' })
  assert.equal(changed[1]!.body!.text, 'Go ahead, report here.')
  assert.equal(changed[1]!.body!.surface, 'dm', 'it is still a new message typed in the chats')
  assert.equal(document.querySelector('.dm-audreq') === null, true)
})

test('Deny in the chat, or closing the request\'s chat, denies the request with the existing action and asks nothing', async (t) => {
  const s = await setup(t, { requests: [request('helper'), request('worker', '2026-11-20T08:00:00Z')] }, { active: false })
  await s.openChat('helper')
  await s.click([...document.querySelectorAll('.dm-audreq button')].find(b => b.textContent === 'Deny'), 'Deny')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'deny', node: 'helper', target: USER }])
  assert.equal(s.row('helper') === undefined, true, 'the chat leaves the list')
  const close = s.row('worker')!.querySelector<HTMLButtonElement>('.dm-row-close')
  assert.match(close?.getAttribute('title') ?? '', /Deny worker's audience request and close this chat\./)
  await s.click(close, 'the close control of the other request')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body)[1], { action: 'deny', node: 'worker', target: USER })
  assert.equal(s.row('worker') === undefined, true)
  assert.equal(s.confirms.length, 0, 'no confirmation')
})

test('the top-level chip has the audience badge\'s box, in its own colour', async (t) => {
  const s = await setup(t, { audiences: [grant('solo')] }, { active: false })
  await s.openChat('solo')
  const chips = [...document.querySelectorAll<HTMLElement>('.dm-head .dm-who-l1 .badge')]
  const top = chips.find(c => c.textContent === 'top-level'), aud = chips.find(c => /audience/.test(c.textContent ?? ''))
  assert.equal(top !== undefined && aud !== undefined, true, 'both chips are in the header')
  assert.equal(top!.classList.contains('aud-badge'), true, 'the same box class as the audience badge')
  assert.equal(aud!.classList.contains('aud-badge'), true, 'POSITIVE CONTROL: the audience badge has it')
  assert.equal(top!.classList.contains('aud-user'), false, 'but not the audience colour')
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  assert.match(css, /\.badge\.dm-standing \{ border-color: /, 'and a visible border, as the audience badge has')
})

test('the message box has the agent\'s fast mode and effort, saved through the desk\'s own route', async (t) => {
  syncFastModes([{ tiers: [{ tier: 'opus', fast_mode: true }] }] as unknown as Parameters<typeof syncFastModes>[0])
  t.after(() => syncFastModes([]))
  const s = await setup(t, { audiences: [grant('worker')] }, { active: false })
  await s.openChat('worker')
  const controls = document.querySelector('.dm-compose .cc-composer .cc-controls')
  assert.equal(controls !== null, true, 'the controls sit in the message box')
  const fast = controls!.querySelector<HTMLButtonElement>('button.cc-fast')
  assert.equal(fast?.getAttribute('aria-label'), 'Fast mode')
  await s.click(fast, 'the fast mode button')
  assert.deepEqual(posts(s.server.calls, /\/nodes\/worker\/scope$/).map(c => c.body), [{ fast_mode: true }])
  const effort = controls!.querySelector<HTMLButtonElement>('button.cc-eff')
  assert.match(effort?.getAttribute('title') ?? '', /^Thinking effort: /)
  await s.click(effort, 'the effort button')
  const track = controls!.querySelector<HTMLElement>('.eff-pop [role="slider"]')
  assert.equal(track !== null, true, 'it opens the effort track')
  await inAct(async () => {
    track!.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flush(8)
  })
  const saved = posts(s.server.calls, /\/nodes\/worker\/scope$/).map(c => c.body)
  assert.equal(saved.length, 2, 'the level is saved')
  assert.equal(typeof saved[1]!.effort, 'string')
  assert.equal(posts(s.server.calls, /\/message$/).length, 0, 'and nothing is sent')
})

test('Orgtree\'s own chat and a project\'s chat have no agent controls in the message box', async (t) => {
  const s = await setup(t, { delivered: [mail('sys1', '@system', '2026-11-20T10:00:00Z')] }, { active: false })
  await s.openChat('@system')
  assert.equal(document.querySelector('.dm-compose .cc-controls :is(.cc-fast, .cc-eff)') === null, true)
  assert.equal(document.querySelector('.dm-head .dm-gear') === null, true, 'and no gear: it is no agent')
})

test('the chat header: the name is the agent link, and the gear asks for that agent\'s settings', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')] }, { active: false })
  await s.openChat('worker')
  const link = document.querySelector<HTMLElement>('.dm-head .dm-who-name .ref-chip.ref-agent')
  assert.equal(link?.tagName, 'BUTTON', 'the link every reference to an agent is')
  assert.equal(link?.getAttribute('data-copy-agent-name'), 'worker')
  await s.click(link, 'the agent link')
  assert.deepEqual(s.state.focused, ['worker'], 'it goes to the agent')
  const asks: unknown[] = []
  const hear = (e: Event) => { asks.push((e as CustomEvent).detail) }
  window.addEventListener(OPEN_SETTINGS_AT_EVENT, hear)
  t.after(() => window.removeEventListener(OPEN_SETTINGS_AT_EVENT, hear))
  const gear = document.querySelector<HTMLButtonElement>('.dm-head .dm-gear')
  assert.equal(gear?.getAttribute('aria-label'), "Open worker's settings")
  await s.click(gear, 'the gear')
  assert.deepEqual(asks, [{ scope: 'agent', org: 'mine', agentId: 'worker', over: true }],
    'the existing settings request, for this agent, to open over the chat')
})

test('a message typed in the panel says it came from there; a reply does not, and names what it answers', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] })
  await s.openChat('worker')
  await s.type('a new thought')
  await s.send()
  const first = posts(s.server.calls, /\/nodes\/worker\/message$/)
  assert.equal(first.length, 1)
  assert.equal(first[0]!.body!.text, 'a new thought')
  assert.equal(first[0]!.body!.surface, 'dm', 'not a reply: the agent is told it came from the chats')
  assert.equal('target' in first[0]!.body! || 'targets' in first[0]!.body!, false)

  await s.click(s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'm1')!.querySelector('.dm-actions button[title="Reply"]'), 'the bubble\'s Reply')
  assert.match(document.querySelector('.dm-replybar')?.textContent ?? '', /body of m1/, 'the box says what the next send answers')
  await s.type('answering that')
  await s.send()
  const both = posts(s.server.calls, /\/nodes\/worker\/message$/)
  assert.equal(both.length, 2)
  assert.deepEqual(both[1]!.body!.target, { kind: 'mail', org: 'mine', box: 'user', id: 'm1' })
  assert.equal('surface' in both[1]!.body!, false, 'a reply carries no panel mark')
  assert.equal(document.querySelector('.dm-replybar') === null, true, 'the reply target is spent')
})

test('a notice typed in the panel carries no panel mark', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')] })
  await s.openChat('worker')
  await s.click(document.querySelector('.dm-compose .cc-notice-toggle'), 'the notice toggle')
  await s.type('for your information')
  await s.send()
  const sentNow = posts(s.server.calls, /\/nodes\/worker\/message$/)
  assert.equal(sentNow.length, 1)
  assert.equal(sentNow[0]!.body!.notice, true)
  assert.equal('surface' in sentNow[0]!.body!, false)
})

test('a request is one bubble per tab under one submit, and is answered through the ordinary route', async (t) => {
  const ask = { id: 'a1', node: 'lead', kind: 'batch', status: 'open', at: '2026-11-20T10:00:00Z', revs: { ask: 3 },
    tabs: [
      { kind: 'question', header: 'Channel', question: 'Which channel?', options: ['Beta', 'Stable'] },
      { kind: 'question', question: 'Anything else?' },
    ] }
  const s = await setup(t, {}, { tree: tree({ asks: [ask] }, { ask }) })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'lead', 'it opens on the chat that waits')
  assert.equal(s.row('lead')!.querySelector('.dm-badge-asks')?.textContent, '?')
  const tabs = s.all<HTMLElement>('.dm-ask .ask-message')
  assert.equal(tabs.length, 2, 'one bubble per tab')
  assert.equal(document.querySelector('.dm-ask .ask-tabstrip') === null, true, 'and no tab strip')
  assert.deepEqual(tabs.map(x => x.querySelector('.ask-message-kind')?.textContent), ['Question', 'Question'])
  assert.match(tabs[0]!.textContent ?? '', /Which channel\?/)
  assert.equal(tabs[1]!.querySelector('textarea.ask-free-response-input') !== null, true, 'a question without options has its free response')
  assert.equal(s.all('.dm-ask .ask-submit').length, 1, 'one submit for the whole request')
  const submit = document.querySelector<HTMLButtonElement>('.dm-ask .ask-submit')!
  assert.equal(submit.disabled, true, 'nothing is decided yet')

  await s.click([...tabs[0]!.querySelectorAll<HTMLElement>('.ask-row')].find(r => /Beta/.test(r.textContent ?? '')), 'the option Beta')
  const free = document.querySelector<HTMLTextAreaElement>('.dm-ask textarea.ask-free-response-input')!
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')?.set?.call(free, 'ship it')
    free.dispatchEvent(new W.Event('input', { bubbles: true }))
    await flush(2)
  })
  assert.equal(document.querySelector<HTMLButtonElement>('.dm-ask .ask-submit')!.disabled, false)
  await s.click(document.querySelector('.dm-ask .ask-submit'), 'submit')
  const batch = posts(s.server.calls, /\/nodes\/lead\/batch$/)
  assert.equal(batch.length, 1)
  assert.deepEqual(batch[0]!.body, { revs: { ask: 3 }, answers: ['Beta', 'ship it'] })
})

test('a reference to one mail opens the chat that holds it, also from outside the loaded window', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('l1', 'lead', '2026-11-20T11:00:00Z')],
    byId: { old9: mail('old9', 'solo', '2026-10-01T09:00:00Z') },
  }, { jumpTo: 'm1' })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker')
  assert.equal(s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'm1')!.classList.contains('flash'), true)
  await inAct(async () => { await s.rerender({ jumpTo: 'old9' }); await flush(12) })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'solo', 'the looked-up mail\'s sender')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['old9'], 'and the mail itself is in its timeline')
})

test('the title-bar checkbox brings back the classic mailbox and its mail icon, and returns', async (t) => {
  const s = await setup(t, { delivered: [mail('m1', 'lead', '2026-11-20T10:00:00Z')] })
  const bell = await mountView(<AskBell tree={{ slug: 'mine', user_inbox_count: 0 }} onOpen={() => {}} />, el => el)
  t.after(() => bell.unmount())
  const box = () => document.querySelector<HTMLInputElement>('.modalpin-bar input[aria-label="Classic mailbox"]')!
  assert.equal(box().checked, false)
  assert.equal(document.querySelector('.settings h3')?.textContent?.trim(), 'Your inbox', 'the panel keeps its name')
  assert.equal(document.querySelector('.settings h3 [data-testid="ChatBubbleOutlineOutlinedIcon"]') !== null, true)
  assert.equal(bell.el.querySelector('[data-testid="ChatBubbleOutlineOutlinedIcon"]') !== null, true, 'the panel\'s icon is a chat bubble')
  assert.equal(bell.el.querySelector('[data-testid="MailOutlinedIcon"]') === null, true)

  await s.click(box(), 'the classic checkbox')
  assert.equal(window.localStorage.getItem(CLASSIC_MAILBOX_KEY), '1', 'saved for every org and window')
  assert.equal(document.querySelector('.settings.dm-panel') === null, true)
  assert.equal(document.querySelector('.settings h3')?.textContent?.trim(), 'Your inbox', 'today\'s panel')
  assert.equal(document.querySelector('.settings h3 [data-testid="MailOutlinedIcon"]') !== null, true, 'under its mail icon')
  assert.equal(document.querySelector('.mail-folders') !== null, true, 'with its folders')
  assert.equal(document.querySelector('.mailrow') !== null, true, 'and its mail list')
  assert.equal(bell.el.querySelector('[data-testid="MailOutlinedIcon"]') !== null, true, 'the mail icon is back')
  assert.equal(bell.el.querySelector('[data-testid="ChatBubbleOutlineOutlinedIcon"]') === null, true)
  assert.equal(box().checked, true, 'the classic panel carries the same switch, ticked')

  await s.click(box(), 'the classic checkbox')
  assert.equal(window.localStorage.getItem(CLASSIC_MAILBOX_KEY), '0')
  assert.equal(document.querySelector('.settings.dm-panel') !== null, true, 'and back to the chats')
})

test('one panel per org: it asks this org\'s engine routes only, and lists this org\'s agents only', async (t) => {
  const seen: string[] = []
  const s = await setup(t, { audiences: [grant('worker'), grant('stranger')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] })
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => { seen.push(String(url)); return inner(url, init) }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
  await s.openChat('worker')
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  assert.deepEqual(seen.filter(u => u.includes('/api/orgs/') && !u.startsWith('/api/orgs/mine/')), [])
  assert.deepEqual(s.all<HTMLElement>('.dm-newchat .tray-row').map(r => r.dataset.dmPick), ['lead', 'worker', 'helper', 'solo'])
})

test('a reply sent on a presentation or a ticket asks for that agent\'s chat, unless the setting or the classic mailbox says otherwise', async (t) => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  window.localStorage.removeItem(OPEN_CHAT_ON_REPLY_KEY)
  const asked: [string, string][] = []
  const off = onChatRequest((org, peer) => { asked.push([org, peer]) })
  t.after(() => { off(); window.localStorage.removeItem(CLASSIC_MAILBOX_KEY); window.localStorage.removeItem(OPEN_CHAT_ON_REPLY_KEY) })
  replySentOnObject('mine', 'helper')
  assert.deepEqual(asked, [['mine', 'helper']], 'on by default')
  setOpenChatOnReply(false)
  replySentOnObject('mine', 'helper')
  assert.equal(asked.length, 1, 'off: nothing opens')
  setOpenChatOnReply(true); setClassicMailbox(true)
  replySentOnObject('mine', 'helper')
  assert.equal(asked.length, 1, 'the classic mailbox has no chat to open')
  setClassicMailbox(false)

  // …and the panel opens the chat it is asked for, though that agent held no audience when asked
  const s = await setup(t, { sent: [sent('s9', 'helper', '2026-11-20T12:00:00Z')] }, { openChat: { peer: 'helper', seq: 1 } })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'helper')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['s9'], 'with the reply as its latest message')
})

test('in a narrow panel the chat list is the overlay the other two-pane panels use, and picking a chat closes it', async (t) => {
  // jsdom lays nothing out: the reading surface's width is stated, as in the gallery's own narrow tests
  const original = W.HTMLElement.prototype.getBoundingClientRect
  W.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('mailer')) return { ...original.call(this), width: 700 } as DOMRect
    return original.call(this)
  }
  t.after(() => { W.HTMLElement.prototype.getBoundingClientRect = original })
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('m2', 'lead', '2026-11-20T11:00:00Z')],
  })
  const box = document.querySelector('.mailer.dm') as HTMLElement
  await inAct(() => fireResize(box))
  assert.equal(box.classList.contains('narrow-list'), true, 'the list is collapsed behind its control')
  const toggle = () => box.querySelector('.mailer-listtoggle')
  assert.equal(toggle()?.getAttribute('aria-label'), 'Show the chat list')

  await s.click(toggle(), 'the list control')
  assert.equal(box.classList.contains('narrow-list-open'), true)
  await s.openChat('worker')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker', 'the chat opens')
  assert.equal(box.classList.contains('narrow-list-open'), false, 'and the list gives way to it')

  // closing a chat from the list leaves the list up: nothing new was asked for
  await s.click(toggle(), 'the list control')
  await s.click(s.row('worker')!.querySelector('.dm-row-close'), 'the row\'s close')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'worker' }])
  assert.equal(box.classList.contains('narrow-list-open'), true, 'the list stays open')

  // New chat sweeps out over the list, inside the overlay; the agent picked there closes it
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  assert.equal(document.querySelector('.dm-list > .dm-newchat') !== null, true)
  assert.equal(box.classList.contains('narrow-list-open'), true, 'the list overlay stays up: the sweep is in it')
  await s.click(s.all<HTMLElement>('.dm-newchat .tray-row').find(r => r.dataset.dmPick === 'solo'), 'solo\'s row')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'solo')
  assert.equal(box.classList.contains('narrow-list-open'), false, 'and gives way to the chat that was picked')
})

test('a chat row\'s preview reads as plain words, without the mail\'s markdown marks', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z', {
      body: '## Status\n\nThe **beta** list has `3` bounces, see [the report](https://example.invalid/r) for some_file_name.' })],
  })
  assert.equal(s.row('worker')!.querySelector('.dm-row-text')?.textContent,
    'Status The beta list has 3 bounces, see the report for some_file_name.')
})

// ---- a project's chat is one thread (USER 2026-11-23 mb52269db6058) ----

const projectNode = (id: string, children: unknown[]) => node(id, children, { kind: 'project', tier: null })
/** crew is a top-level project holding the user's audience; member and mate work under it */
const crewTree = () => tree({ roots: [node('lead'), projectNode('crew', [node('member'), node('mate')])] })
const crewWorld = (): World => ({
  audiences: [grant('crew')],
  sent: [
    sent('j1', 'crew', '2026-11-20T10:00:00Z', { queue: { held_by: 'member', ack: true } }),
    sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1', ack: true } } }),
    sent('j2', 'crew', '2026-11-20T11:00:00Z'),
    sent('g1a', 'member', '2026-11-20T12:00:00Z', { megaphone: { name: 'crew', send: 'g1', to: 2 } }),
    sent('g1b', 'mate', '2026-11-20T12:00:00Z', { megaphone: { name: 'crew', send: 'g1', to: 2 } }),
  ],
  delivered: [mail('a1', 'member', '2026-11-20T10:30:00Z', { reply_to: { id: 'c1', kind: 'mail', from: USER } })],
})
const entry = (key: string) => [...document.querySelectorAll<HTMLElement>('.dm-msg')].find(m => m.dataset.dmEntry === key)

test('a project\'s chat is one thread: the message says who holds it, the member\'s answer names the member, the megaphone send is recorded once', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['j1', 'a1', 'j2', 'megaphone:g1'],
    'no bubble for the queue\'s copy; one for the megaphone send')
  assert.match(entry('j1')!.querySelector('.dm-job')?.textContent ?? '', /^held by /)
  assert.equal(entry('j1')!.querySelector('.dm-job b')?.textContent, 'member')
  assert.equal(entry('j1')!.querySelector('.dm-job')?.classList.contains('dm-job-held'), true)
  assert.equal(entry('j2')!.querySelector('.dm-job')?.textContent, 'waiting in the queue')
  assert.equal(entry('a1')!.dataset.dmVia, 'member')
  assert.equal(entry('a1')!.querySelector('.dm-via b')?.textContent, 'member', 'the answer is under the agent\'s name')
  assert.equal(entry('megaphone:g1')!.querySelector('.dm-kind-megaphone')?.textContent?.trim(), 'Megaphone · 2 agents')
  assert.match(entry('megaphone:g1')!.querySelector('.dm-kind-megaphone')?.getAttribute('title') ?? '', /member, mate/)
  assert.equal(entry('megaphone:g1')!.querySelector('.dm-job') === null, true)
  // USER 2026-11-23 m212aefce0372: "megaphone messages have a different colored background, a brighter
  // teal-eggshell color": their own fill, mixed from one teal into each theme's page colour
  assert.equal(entry('megaphone:g1')!.querySelector('.dm-bubble')?.classList.contains('megaphone'), true)
  assert.equal(entry('j1')!.querySelector('.dm-bubble')?.classList.contains('megaphone'), false, 'an ordinary message keeps its fill')
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  assert.match(css, /--dm-mega: color-mix\(in srgb, #3fd0b6 \d+%, var\(--bg\)\);/)
  assert.match(css, /\.dm-msg \.dm-bubble\.megaphone \{ background: var\(--dm-mega\);/)
  // each member's chat has its own copy of the megaphone send, and not the queue's copy of j1
  await s.openChat('member')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['g1a'])
  assert.equal(entry('g1a')!.querySelector('.dm-kind-megaphone')?.textContent?.trim(), 'Megaphone · crew')
  assert.equal(entry('g1a')!.querySelector('.dm-bubble')?.classList.contains('megaphone'), true, 'the copy in a member chat has the same fill')
})

test('in a project\'s chat, Reply on a member\'s bubble writes to that member', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  await s.click(entry('a1')!.querySelector('.dm-actions button[aria-label="Reply"]'), 'Reply on the member\'s answer')
  assert.equal(document.querySelector('.dm-compose textarea')?.getAttribute('placeholder'), 'reply to member…')
  await s.type('Thanks, go on.')
  await s.send()
  const posted = posts(s.server.calls, /\/message$/)
  assert.deepEqual(posted.map(c => c.path.replace(/^.*\/orgs\/mine/, '')), ['/nodes/member/message'], 'to the member, not to the project\'s queue')
  assert.deepEqual(posted[0]!.body!.target, { kind: 'mail', org: 'mine', box: 'user', id: 'a1' })
  assert.equal('surface' in posted[0]!.body!, false, 'a reply carries no panel mark')
})

test('in a project\'s chat, Reply on the user\'s own message is a follow-up: to the project, naming that message', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  const follow = entry('j1')!.querySelector<HTMLButtonElement>('.dm-actions button[aria-label="Follow up on this message"]')
  await s.click(follow, 'Follow up on the user\'s own message')
  assert.equal(document.querySelector('.dm-compose textarea')?.getAttribute('placeholder'), 'follow up on your message to crew…')
  await s.type('One more thing.')
  await s.send()
  const posted = posts(s.server.calls, /\/message$/)
  assert.deepEqual(posted.map(c => c.path.replace(/^.*\/orgs\/mine/, '')), ['/nodes/crew/message'],
    'to the project: the engine hands a follow-up to the job\'s holder')
  assert.deepEqual(posted[0]!.body!.target, { kind: 'mail', org: 'mine', box: 'user', id: 'j1' })
  assert.equal(posts(s.server.calls, /\/inbox\/read$/).length, 0, 'the user\'s own message is not "read"')
  // the megaphone record and a plain agent chat offer no follow-up
  assert.equal(entry('megaphone:g1')!.querySelector('.dm-actions button[aria-label="Follow up on this message"]') === null, true)
})

test('in a project\'s chat, one reply cannot answer a member and follow up on the user\'s own message at once', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  await s.click(entry('a1')!.querySelector('.dm-actions button[aria-label="Reply"]'), 'Reply')
  await s.click(entry('j1')!.querySelector('.dm-actions button[aria-label="Follow up on this message"]'), 'Follow up')
  await s.type('Both?')
  await s.send()
  assert.equal(posts(s.server.calls, /\/message$/).length, 0, 'nothing is sent')
  assert.match(document.querySelector('.dm-compose [role="alert"]')?.textContent ?? '', /reply to one agent at a time, or follow up on your own message/)
})

test('a reference to the queue\u2019s copy of a message opens the project\u2019s chat at the message itself', async (t) => {
  // the quote on a member's answer names the member's COPY of the job, which is no bubble
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false, jumpTo: 'c1' })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'crew')
  assert.equal(entry('j1')?.classList.contains('flash'), true, 'the message the copy was made from is shown')
  assert.deepEqual(s.state.toasts, [], 'and nothing says the mail is gone')
})

// ---- audiences that come through a project (USER 2026-11-23 m0ca89ba635fd) ----

const inheritsFrom = (p: string) => ({ audiences_inherited: [{ grantor: USER, project: p }] })
/** desk is a project under lead with the user's audience; clerk reaches the user only through it, runner also holds its own grant */
const deskTree = () => tree({ roots: [
  node('lead', [projectNode('desk', [node('clerk', [], inheritsFrom('desk')), node('runner', [], inheritsFrom('desk'))])]),
] })
const deskWorld = (): World => ({
  audiences: [grant('desk'), grant('runner')],
  delivered: [mail('k1', 'clerk', '2026-11-20T10:00:00Z')],
})
const hover = async (el: Element | null | undefined, on: boolean) => {
  assert.ok(el, 'the control is on screen')
  await inAct(async () => { el!.dispatchEvent(new W.MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true })); await flush(2) })
}
const losing = () => [...document.querySelectorAll<HTMLElement>('.dm-row.losing')].map(r => r.dataset.dmChat)
/** the app's own confirmation (canvas/modals.tsx ConfirmModal), never the system's dialog */
const asked = () => document.querySelector<HTMLElement>('.confirm-box[role="dialog"]')
const answer = (label: string) => [...(asked()?.querySelectorAll('button') ?? [])].find(b => b.textContent === label)

test('an audience through a project reads "via" the project link; with its own grant too, "(and via …)"', async (t) => {
  const s = await setup(t, deskWorld(), { tree: deskTree(), active: false })
  await s.openChat('clerk')
  const l1 = () => document.querySelector<HTMLElement>('.dm-head .dm-who-l1')!
  assert.match(l1().querySelector('.badge.aud-user')?.textContent ?? '', /audience/, 'the audience badge')
  assert.match(l1().querySelector('.dm-via-projects')?.textContent ?? '', /^via\s*desk$/)
  const link = l1().querySelector<HTMLElement>('.dm-via-projects .ref-chip')
  assert.equal(link?.getAttribute('data-copy-agent-name'), 'desk', 'the project is the project link')
  assert.equal(link?.querySelector('.project-mark') !== null, true, 'with the project\'s own mark')
  await s.click(link, 'the project link')
  assert.deepEqual(s.state.focused, ['desk'])
  await s.openChat('runner')
  assert.match(l1().querySelector('.dm-via-projects')?.textContent ?? '', /^\(and via\s*desk\)$/, 'its own grant comes first')
})

test('hovering a project\'s close marks every agent that would lose the audience; closing asks first, once', async (t) => {
  const s = await setup(t, deskWorld(), { tree: deskTree(), active: false })
  const close = s.row('desk')!.querySelector<HTMLButtonElement>('.dm-row-close')
  await hover(close, true)
  assert.deepEqual(losing().sort(), ['clerk', 'desk'], 'the project and clerk; runner keeps its own grant')
  await hover(close, false)
  assert.deepEqual(losing(), [], 'the mark goes with the pointer')
  await s.click(close, 'the project\'s close')
  assert.equal(s.confirms.length, 0, 'not the system\'s dialog')
  assert.equal(asked()?.querySelector('h3')?.textContent, "Revoke project desk's audience with you?", 'the app\'s own confirmation: the one close that asks')
  assert.match(asked()?.querySelector('.confirm-body')?.textContent ?? '', /^1 agent reaches you only through it and loses its audience too: clerk\.$/)
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0, 'nothing is revoked before the answer')
  await s.click(answer('Revoke'), 'Revoke')
  assert.equal(asked(), null)
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'desk' }])
})

test('declining the confirmation revokes nothing', async (t) => {
  const s = await setup(t, deskWorld(), { tree: deskTree(), active: false })
  await s.click(s.row('desk')!.querySelector('.dm-row-close'), 'the project\'s close')
  await s.click(answer('cancel'), 'cancel')
  assert.equal(asked(), null, 'the question is gone')
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0)
  assert.equal(s.row('desk') !== undefined, true, 'the chat is still there')
})

test('a project whose close takes the audience from nobody else asks nothing', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.click(s.row('crew')!.querySelector('.dm-row-close'), 'the close of crew')
  assert.equal(asked(), null, 'its members are top-level and keep their direct line')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'crew' }])
})

test('the close of an agent that reaches the user only through a project is that project\'s close', async (t) => {
  const s = await setup(t, deskWorld(), { tree: deskTree(), active: false })
  await s.openChat('clerk')
  const close = document.querySelector<HTMLButtonElement>('.dm-head .dm-close')
  assert.equal(close?.disabled, false)
  assert.match(close?.getAttribute('title') ?? '', /clerk reaches you only through project desk/)
  await hover(close, true)
  assert.deepEqual(losing().sort(), ['clerk', 'desk'], 'the same mark as on the project\'s own close')
  await s.click(close, 'the close in clerk\'s chat')
  assert.equal(asked()?.querySelector('h3')?.textContent, "Revoke project desk's audience with you?", 'and the same question')
  await s.click(answer('Revoke'), 'Revoke')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'desk' }], 'the PROJECT\'s grant, not clerk\'s')
})

test('with a grant of its own and a project\'s audience: the first close revokes its own grant without asking, the second the project\'s', async (t) => {
  const s = await setup(t, deskWorld(), { tree: deskTree(), active: false })
  await s.openChat('runner')
  const close = () => document.querySelector<HTMLButtonElement>('.dm-head .dm-close')
  await hover(close(), true)
  assert.deepEqual(losing(), [], 'the first close affects nobody else')
  await s.click(close(), 'the first close')
  assert.equal(asked(), null, 'nothing is asked')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'revoke', node: 'runner' }])
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'runner', 'its chat stays: it still reaches the user through the project')
  assert.match(document.querySelector('.dm-head .dm-via-projects')?.textContent ?? '', /^via\s*desk$/, 'now through the project only')
  await s.click(close(), 'the second close')
  assert.match(asked()?.querySelector('.confirm-body')?.textContent ?? '', /^2 agents reach you only through it and lose their audience too: clerk, runner\.$/,
    'the project\'s close asks: clerk and runner lose the audience')
  await s.click(answer('Revoke'), 'Revoke')
  assert.equal(s.confirms.length, 0, 'the system\'s dialog was never used')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body)[1], { action: 'revoke', node: 'desk' })
})

// ---- the row's own menu, and the system's chip (USER 2026-11-23 mf47548121ae5) ----

const rowMenu = async (row: HTMLElement | undefined) => {
  assert.ok(row, 'the row is on screen')
  await inAct(async () => { row!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); await flush(6) })
  // the newest top-level menu: each row owns its menu
  const menu = [...document.querySelectorAll('.ctxmenu')].filter(m => !m.parentElement?.closest('.ctxmenu')).pop()
  return menu ? [...menu.children].flatMap(c => c.matches('[role="separator"]') ? [] : [(c.querySelector('[role="menuitem"]') ?? c).textContent?.trim() ?? '']) : null
}

test('a chat row\'s menu has "Agent…" for an agent and "Project…" for a project, and neither for the system\'s chat', async (t) => {
  const s = await setup(t, { ...crewWorld(), delivered: [mail('sys1', '@system', '2026-11-20T09:00:00Z')] }, { tree: crewTree(), active: false })
  const agent = await rowMenu(s.row('member'))
  const has = (list: string[] | null, label: string) => !!list?.some(x => x.startsWith(label))
  assert.equal(agent?.[0], 'Open chat'); assert.equal(has(agent, 'Agent…'), true); assert.equal(has(agent, 'Project…'), false)
  await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(4) })
  const proj = await rowMenu(s.row('crew'))
  assert.equal(has(proj, 'Project…'), true); assert.equal(has(proj, 'Agent…'), false)
  assert.equal(proj?.includes('Revoke the project’s audience'), true, 'what its close does, by name')
  await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(4) })
  const system = await rowMenu(s.row('@system'))
  assert.deepEqual(system, ['Open chat'], 'the system is no agent: no such entry')
})

test('the system\'s chat wears an S in the chip a model letter is drawn in', async (t) => {
  const s = await setup(t, { delivered: [mail('sys1', '@system', '2026-11-20T09:00:00Z')] }, { active: false })
  const chip = s.row('@system')!.querySelector('.dm-av .tier.letter-chip')
  // USER 2026-11-23 m2561610f7494 "system chat called "System" not "Orgtree"", m619caab7c62b "give it an icon
  // appropriate for system messages so it isnt confused with an agent": the S chip is on its MESSAGES
  assert.equal(chip === null, true, 'its picture is no letter chip: it is not an agent')
  assert.equal(s.row('@system')!.querySelector('.dm-av.dm-av-system svg') !== null, true, 'but the system\'s own icon')
  assert.equal(s.row('@system')!.querySelector('.dm-row-name')?.textContent, 'System')
  assert.equal(s.row('lead')!.querySelector('.dm-av .tier.letter-chip') !== null, true, 'POSITIVE CONTROL: an agent\'s letter is that chip')
  await s.openChat('@system')
  assert.equal(document.querySelector('.dm-head .dm-av.dm-av-system svg') !== null, true, 'in its header too')
  assert.match(document.querySelector('.dm-head .dm-who-name')?.textContent ?? '', /^System$/)
  const tag = document.querySelector('.dm-msg[data-dm-entry="sys1"] .dm-via')
  assert.equal(tag?.querySelector('.tier.letter-chip')?.textContent, 'S', 'each of its messages is tagged S, in the chip a model letter is drawn in')
  assert.match(tag?.textContent ?? '', /^S\s*System$/)
})

// USER 2026-11-23 mb673f241b650: "list them, since it can be collapsed"
test('a project\'s silent agents are listed under it, last; opening one is an empty chat; a fold hides them', async (t) => {
  const s = await setup(t, { audiences: [grant('office'), grant('envoy')], delivered: [mail('a1', 'aide', '2026-11-20T10:00:00Z')] },
    { tree: officeTree(), active: false, openChat: { peer: 'lead', seq: 1 } })
  assert.deepEqual(order(s), [['office', false], ['aide', true], ['page', true], ['lead', false], ['envoy', false], ['solo', false]])
  await s.openChat('page')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'page')
  assert.equal(document.querySelectorAll('.dm-msg').length, 0, 'nothing has been written')
  assert.equal(document.querySelector('.dm-compose textarea') !== null, true, 'and it can be written to')
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0, 'opening it grants nothing: it already reaches the user through its project')
  await s.openChat('lead')
  await s.click(s.row('office')!.querySelector('.dm-fold'), 'the fold arrow')
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['office', 'lead', 'envoy', 'solo'], 'folded: neither has anything waiting')
})

// ---- the grouped list (USER 2026-11-23 ma97ab61a248c) ----

/** office holds the audience; aide and page reach the user only through it; envoy also holds its own grant */
const officeTree = () => tree({ roots: [
  node('lead', [projectNode('office', [node('aide', [], inheritsFrom('office')), node('page', [], inheritsFrom('office')), node('envoy', [], inheritsFrom('office'))])]),
  node('solo'),
] })
const officeWorld = (): World => ({
  audiences: [grant('office'), grant('envoy')],
  delivered: [mail('a1', 'aide', '2026-11-20T10:00:00Z'), mail('e1', 'envoy', '2026-11-20T09:00:00Z')],
  pending: [mail('p1', 'page', '2026-11-20T11:00:00Z'), mail('p2', 'page', '2026-11-20T11:05:00Z')],
})
const order = (s: Awaited<ReturnType<typeof setup>>) => s.rows().map(r => [r.dataset.dmChat, r.classList.contains('dm-child')])

test('agents that reach the user only through a project are indented under it, newest first; one with its own grant is not', async (t) => {
  const s = await setup(t, officeWorld(), { tree: officeTree(), active: false, openChat: { peer: 'lead', seq: 1 } })
  assert.deepEqual(order(s), [['office', false], ['page', true], ['aide', true], ['envoy', false], ['lead', false], ['solo', false]])
  assert.equal(s.row('page')!.dataset.dmParent, 'office')
  assert.equal(s.row('office')!.querySelector('.dm-badge') === null, true, 'unfolded, the project counts only its own mail')
  assert.equal(s.row('page')!.querySelector('.dm-badge:not(.dm-badge-asks)')?.textContent, '2')
  assert.equal(s.row('envoy')!.querySelector('.dm-fold') === null, true, 'only a project with chats under it folds')
})

test('a project\'s group folds with the docket\'s arrow; folded, it still shows every agent with something unread', async (t) => {
  const s = await setup(t, officeWorld(), { tree: officeTree(), active: false, openChat: { peer: 'lead', seq: 1 } })
  const fold = () => s.row('office')!.querySelector<HTMLButtonElement>('.dm-fold')
  assert.equal(fold()?.getAttribute('aria-expanded'), 'true', 'open by default')
  await s.click(fold(), 'the fold arrow')
  // USER 2026-11-23 m7de1b3240eb0: "agents with unread messages always are shown, regardless of the
  // collapse. the currently open agent dm is also always shown."
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['office', 'page', 'envoy', 'lead', 'solo'],
    'aide, read and not open, is folded away; page has unread mail and stays')
  assert.equal(s.row('page')!.classList.contains('dm-child'), true, 'still under its project')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'lead', 'the arrow folds; it does not open the chat')
  assert.equal(s.row('office')!.querySelector('.dm-badge') === null, true, 'the project\'s row counts only its own mail: nothing that waits is hidden')
  assert.match(fold()?.getAttribute('title') ?? '', /^show the 1 agent hidden under office$/)
  await s.click(fold(), 'the fold arrow again')
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['office', 'page', 'aide', 'envoy', 'lead', 'solo'])
  assert.equal(s.row('office')!.querySelector('.dm-badge') === null, true)
})

test('a fold never hides the chat on screen, and a search shows through it', async (t) => {
  const s = await setup(t, officeWorld(), { tree: officeTree(), active: false, openChat: { peer: 'aide', seq: 1 } })
  await s.click(s.row('office')!.querySelector('.dm-fold'), 'the fold arrow')
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['office', 'page', 'aide', 'envoy', 'lead', 'solo'], 'the open chat stays listed, and so does page with its unread mail')
  const search = document.querySelector('.dm-search') as HTMLInputElement
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value')?.set?.call(search, 'pag')
    search.dispatchEvent(new W.Event('input', { bubbles: true }))
    await flush(4)
  })
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat), ['page'], 'a match inside a folded group is found')
})

test('a row\'s time gives way to its close control on hover, so the two never overlap', async () => {
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  assert.match(css, /\.dm-row:hover:has\(\.dm-row-close\) \.dm-row-l1 \.mtime,\s*\.dm-row:focus-within:has\(\.dm-row-close\) \.dm-row-l1 \.mtime \{ visibility: hidden; \}/)
})

// USER 2026-11-23 mb5a815755600: "for agents under a project with indirect audience only, add a top level
// "acquire audience" context menu option that moves them out from under the project"
test('an agent listed under a project has "Acquire audience" at the top of its row menu; it then moves out, labelled "(and via …)"', async (t) => {
  const s = await setup(t, officeWorld(), { tree: officeTree(), active: false, openChat: { peer: 'lead', seq: 1 } })
  const has = (list: string[] | null, label: string) => !!list?.some(x => x.startsWith(label))
  assert.equal(has(await rowMenu(s.row('envoy')), 'Acquire audience'), false, 'not for an agent with its own audience')
  assert.equal(has(await rowMenu(s.row('office')), 'Acquire audience'), false, 'nor for the project')
  const menu = await rowMenu(s.row('aide'))
  assert.deepEqual(menu?.slice(0, 2), ['Open chat', 'Acquire audience'], 'at the top level, under Open chat')
  const menus = [...document.querySelectorAll('.ctxmenu')].filter(m => !m.parentElement?.closest('.ctxmenu'))
  const item = [...menus[menus.length - 1]!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.trim() === 'Acquire audience')
  await s.click(item, 'Acquire audience')
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'grant', node: 'aide' }], 'the existing grant')
  assert.equal(s.row('aide')!.classList.contains('dm-child'), false, 'it is out from under the project')
  assert.equal(s.row('aide')!.dataset.dmParent, undefined)
  await s.openChat('aide')
  assert.match(document.querySelector('.dm-head .dm-via-projects')?.textContent ?? '', /^\(and via\s*office\)$/)
})

// ============================================================ 4.7.0-alpha.1
// The user's feedback on the installed alpha (USER 2026-11-24 m15c78be3a1db
// and the messages after it), one test per point.

test('alpha.1 point 1: a grant of a name the tree does not hold makes no row', async (t) => {
  const s = await setup(t, { audiences: [grant('worker'), grant('accept-field'), grant('account-card'), grant('argon-hi')] }, { active: false })
  assert.deepEqual(s.rows().map(r => r.dataset.dmChat).sort(), ['lead', 'solo', 'worker'])
})

const deskNode = (id: string) => ({ ...node(id), tier: 'opus', model_id: 'opus', configured_scope: { tools: {}, add_dirs: [] } }) as unknown as CanvasNode
/** what a message box is made of, in order: the element kinds and the classes that style them */
const boxShape = (box: Element) => ({
  columns: [...box.children].filter(e => !e.classList.contains('mention-menu')).map(e => e.tagName.toLowerCase() + (e.classList[0] ? '.' + e.classList[0] : '')),
  left: [...box.querySelectorAll(':scope > .cc-btnstack > *')].map(e => e.classList[0]),
  rows: [...box.querySelectorAll(':scope > .cc-controls > *')].map(e => e.classList[0]),
  fast: [...box.querySelectorAll('.cc-fast-row > *')].map(e => e.classList[0]),
  primary: [...box.querySelectorAll('.cc-primary-row > *')].map(e => e.classList[0]),
  send: box.querySelector('.cc-send svg')?.getAttribute('data-testid') ?? null,
})

test('alpha.1 point 2: the chat\'s message box is the desk\'s: the same parts, classes, order and send glyph', async (t) => {
  syncFastModes([{ tiers: [{ tier: 'opus', fast_mode: true }] }] as unknown as Parameters<typeof syncFastModes>[0])
  t.after(() => syncFastModes([]))
  const s = await setup(t, { audiences: [grant('worker')] }, { active: false })
  await s.openChat('worker')
  const worker = deskNode('worker')
  const desk = await mountView(<DeskChat node={worker} map={new Map([[worker.id, worker]])} slug="mine" op={async () => ({})} toast={() => {}} bare />, el => el)
  t.after(() => desk.unmount())
  await inAct(async () => { await flush(8) })
  const theirs = desk.el.querySelector('.cc-composer'), mine = document.querySelector('.dm-compose .cc-composer')
  assert.ok(theirs, 'POSITIVE CONTROL: the desk drew its message box')
  assert.ok(mine, 'the chat\'s box is a .cc-composer: every rule that styles the desk\'s box styles it')
  assert.deepEqual(boxShape(mine!), boxShape(theirs!))
  assert.deepEqual(boxShape(theirs!).primary, ['eff-wrap', 'cc-send'], 'POSITIVE CONTROL: effort, then the round send')
  assert.deepEqual(boxShape(theirs!).rows, ['cc-fast-row', 'cc-primary-row'], 'POSITIVE CONTROL: fast mode over effort and send')
  assert.equal(document.querySelector('.dm-compose .mail-reply') === null, true, 'not the mail reader\'s reply box')
  assert.equal(document.querySelector('.dm-compose .mail-reply-controls') === null, true)
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  assert.doesNotMatch(css, /\.dm-compose \.(mail-reply|cc-)/, 'and the chats restyle nothing of it')
  assert.equal(document.querySelector('.dm-compose .cc-send')?.getAttribute('aria-label'), 'send', 'the glyph\'s name is the word it replaced')
})

test('alpha.1 point 3: each chat keeps its typed text, its files and what it answers; they are there after another chat and after the panel was closed', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] })
  await s.openChat('worker')
  await s.type('half a thought for worker')
  await s.click(s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'm1')!.querySelector('.dm-actions button[title="Reply"]'), 'the bubble\'s Reply')
  await s.openChat('solo')
  assert.equal(s.draft(), '', 'another chat starts with an empty box')
  await s.type('for solo')
  await s.openChat('worker')
  assert.equal(s.draft(), 'half a thought for worker')
  assert.match(document.querySelector('.dm-replybar')?.textContent ?? '', /body of m1/, 'and it still answers m1')
  await s.openChat('solo')
  assert.equal(s.draft(), 'for solo')
  // closing the panel and opening it again: kept for the app session
  await s.remount()
  await s.openChat('worker')
  assert.equal(s.draft(), 'half a thought for worker', 'the draft outlives the panel')
  // files: listed again when the chat is opened again
  await s.openChat('solo')
  const { writeComposerDraft, readComposerDraft } = await import('../src/composerdrafts')
  const { dmDraftKey } = await import('../src/dm/DmPanel')
  writeComposerDraft(dmDraftKey('mine', 'lead'), { text: 'see the file', attached: [{ name: 'notes.txt', path: 'uploads/notes.txt', bytes: 12 }] })
  await s.openChat('lead')
  assert.match(document.querySelector('.dm-compose .attach-chip')?.textContent ?? '', /notes\.txt/, 'the attached file is back with the text')
  await s.openChat('worker')
  await s.openChat('lead')
  assert.match(document.querySelector('.dm-compose .attach-chip')?.textContent ?? '', /notes\.txt/)
  // sending empties the box, and nothing comes back
  await s.send()
  assert.deepEqual(posts(s.server.calls, /\/nodes\/lead\/message$/).map(c => c.body!.attachments), [['uploads/notes.txt']])
  assert.equal(readComposerDraft(dmDraftKey('mine', 'lead')), null)
  await s.openChat('worker')
  await s.openChat('lead')
  assert.equal(s.draft(), '')
  assert.equal(document.querySelector('.dm-compose .attach-chip') === null, true)
})

const quote = (id: string, from: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ id, from, at, gist: `body of ${id}`, ...extra })
const quoteCard = (s: { all: <T extends Element>(sel: string) => T[] }, entry: string) =>
  s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === entry)?.querySelector<HTMLElement>('.reply-preview') ?? null

test('alpha.1 point 6: the user replies to an agent\'s mail in that agent\'s chat: the quote is not "unavailable", and its click shows the original in the chat', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'),
      // the agent's answer quotes the user's message, which lives in the AGENT's mailbox
      mail('m2', 'worker', '2026-11-20T10:10:00Z', { reply_to: quote('s1', USER, '2026-11-20T10:05:00Z', { kind: 'mail', org: 'mine', box: 'node', node: 'worker' }) })],
    // the user's reply quotes the agent's mail; an older snapshot names no mailbox at all
    sent: [sent('s1', 'worker', '2026-11-20T10:05:00Z', { reply_to: quote('m1', 'worker', '2026-11-20T10:00:00Z') }),
      sent('s2', 'worker', '2026-11-20T10:15:00Z', { reply_to: quote('m2', 'worker', '2026-11-20T10:10:00Z', { kind: 'mail', org: 'mine', box: 'user' }) })],
  }, { active: false })
  await s.openChat('worker')
  for (const [bubble, original] of [['s1', 'm1'], ['m2', 's1'], ['s2', 'm2']] as const) {
    const card = quoteCard(s, bubble)
    assert.ok(card, `${bubble} shows what it answers`)
    assert.doesNotMatch(card!.textContent ?? '', /unavailable/i, `${bubble}: the original is right there`)
    assert.equal(card!.getAttribute('role'), 'link', `${bubble}: the quote can be followed`)
    await s.click(card, `the quote on ${bubble}`)
    assert.deepEqual(s.all<HTMLElement>('.dm-msg.flash').map(m => m.dataset.dmEntry), [original], `${bubble}: the original is shown in this chat`)
    assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker', 'and the chat stays')
  }
  assert.deepEqual(s.state.focused, [], 'nothing navigated away')
  assert.equal(s.state.closed, 0)
})

test('alpha.1 points 6 and 9: a quote of an older message loads history until it is in, then shows it', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m9', 'worker', '2026-11-20T10:00:00Z', { reply_to: quote('s-old', USER, '2026-10-01T10:00:00Z', { kind: 'mail', org: 'mine', box: 'node', node: 'worker' }) })],
    // three pages hold nothing of this chat, so the chat does not read on by itself; the fourth holds the original
    older: [{ delivered: [mail('x1', 'lead', '2026-10-20T10:00:00Z')] }, { delivered: [mail('x2', 'lead', '2026-10-15T10:00:00Z')] },
      { delivered: [mail('x3', 'lead', '2026-10-10T10:00:00Z')] }, { sent: [sent('s-old', 'worker', '2026-10-01T10:00:00Z')] }],
  }, { active: false })
  // a full view: the chat stops asking after pages that hold nothing of it
  const tall = { scrollHeight: Object.getOwnPropertyDescriptor(W.Element.prototype, 'scrollHeight'), clientHeight: Object.getOwnPropertyDescriptor(W.Element.prototype, 'clientHeight') }
  Object.defineProperty(W.Element.prototype, 'scrollHeight', { configurable: true, get() { return (this as Element).classList.contains('dm-timeline') ? 5000 : 0 } })
  Object.defineProperty(W.Element.prototype, 'clientHeight', { configurable: true, get() { return (this as Element).classList.contains('dm-timeline') ? 600 : 0 } })
  t.after(() => { Object.defineProperty(W.Element.prototype, 'scrollHeight', tall.scrollHeight!); Object.defineProperty(W.Element.prototype, 'clientHeight', tall.clientHeight!) })
  await s.openChat('worker')
  await inAct(async () => { await flush(40) })
  assert.equal(s.all('.dm-msg').some(m => (m as HTMLElement).dataset.dmEntry === 's-old'), false, 'POSITIVE CONTROL: the original is not loaded')
  const card = quoteCard(s, 'm9')
  assert.doesNotMatch(card?.textContent ?? '', /unavailable/i, 'an older message of this chat is not "unavailable"')
  await s.click(card, 'the quote')
  await inAct(async () => { await flush(60) })
  assert.equal(s.server.pages.includes('sent:4'), true, 'the history was read on to the page that holds it')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg.flash').map(m => m.dataset.dmEntry), ['s-old'], 'and the original is shown')
})

test('alpha.1 point 7: a typed reply has no "Context" fold in a chat; the classic mailbox keeps it', async (t) => {
  const typed = mail('m2', 'worker', '2026-11-20T10:10:00Z', { body: 'the typed answer', ev: {
    v: 1, variant: 'reply.mail', actor: { kind: 'agent', id: 'worker' }, engine_authored: false, body: 'the typed answer',
    object: { kind: 'mail', org: 'mine', box: 'node', node: 'worker', id: 's1', sender: USER, at: '2026-11-20T10:05:00Z' },
    quote: { from: USER, at: '2026-11-20T10:05:00Z', gist: 'body of s1' } } })
  const s = await setup(t, { audiences: [grant('worker')], delivered: [typed], sent: [sent('s1', 'worker', '2026-11-20T10:05:00Z')] }, { active: false })
  await s.openChat('worker')
  const bubble = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'm2')
  assert.match(bubble?.textContent ?? '', /the typed answer/, 'POSITIVE CONTROL: the typed reply is drawn')
  assert.equal(bubble!.querySelector('details.event-context') === null, true, 'no Context fold under it')
  assert.match(bubble!.querySelector('.reply-preview')?.textContent ?? '', /body of s1/, 'the quote card says what it answers')
  t.after(() => setClassicMailbox(false))
  await inAct(async () => { setClassicMailbox(true); await flush(12) })
  await s.click(s.all<HTMLElement>('.mailrow').find(r => /typed answer/.test(r.textContent ?? '')) ?? document.querySelector('.mailrow'), 'the mail in the classic list')
  assert.equal(document.querySelector('.mailer-read details.event-context') !== null, true, 'POSITIVE CONTROL: the classic reader still has it')
})

/** jsdom lays nothing out: a timeline of rows 100px tall, the first at the top of the content */
function layOut(t: TestContext, height = { scroll: 5000, client: 600 }) {
  const original = W.HTMLElement.prototype.getBoundingClientRect
  const olds = { scrollHeight: Object.getOwnPropertyDescriptor(W.Element.prototype, 'scrollHeight'), clientHeight: Object.getOwnPropertyDescriptor(W.Element.prototype, 'clientHeight') }
  W.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const scroller = this.closest('.dm-timeline') as HTMLElement | null
    if (scroller && this !== scroller && this.dataset.dmEntry) {
      const at = [...scroller.querySelectorAll('[data-dm-entry]')].indexOf(this)
      const top = at * 100 - scroller.scrollTop
      return { top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top } as DOMRect
    }
    return original.call(this)
  }
  Object.defineProperty(W.Element.prototype, 'scrollHeight', { configurable: true, get() { return (this as Element).classList.contains('dm-timeline') ? height.scroll : 0 } })
  Object.defineProperty(W.Element.prototype, 'clientHeight', { configurable: true, get() { return (this as Element).classList.contains('dm-timeline') ? height.client : 0 } })
  t.after(() => {
    W.HTMLElement.prototype.getBoundingClientRect = original
    Object.defineProperty(W.Element.prototype, 'scrollHeight', olds.scrollHeight!); Object.defineProperty(W.Element.prototype, 'clientHeight', olds.clientHeight!)
  })
  return height
}
const scrollTo = async (top: number) => {
  const el = document.querySelector('.dm-timeline') as HTMLElement
  await inAct(async () => { el.scrollTop = top; el.dispatchEvent(new W.Event('scroll', { bubbles: true })); await flush(20) })
}
const topOf = (entry: string) => [...document.querySelectorAll<HTMLElement>('.dm-msg')].find(m => m.dataset.dmEntry === entry)!.getBoundingClientRect().top
const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) =>
  mail(`h${String(from + i).padStart(4, '0')}`, 'worker', new Date(Date.UTC(2026, 9, 1, 0, from + i)).toISOString()))

test('alpha.1 point 9: there is no "Load older" button; older mail comes when the top is near, a page at a time, and the message in view does not move', async (t) => {
  layOut(t)
  const s = await setup(t, {
    audiences: [grant('worker')], delivered: many(6, 100),
    older: [{ delivered: many(5, 50) }, { delivered: many(5, 0) }],
  }, { active: false })
  await s.openChat('worker')
  await scrollTo(4400)
  assert.equal(document.querySelector('button.dm-older') === null, true, 'no button to press')
  assert.doesNotMatch(document.querySelector('.dm-timeline')?.textContent ?? '', /Load older/)
  assert.deepEqual(s.server.pages, [], 'at the newest message nothing older is asked for')
  // the reader scrolls up: the second row is cut by the top edge
  await scrollTo(150)
  assert.deepEqual([...new Set(s.server.pages.map(p => p.split(':')[1]))], ['1'], 'the next page, and only that one')
  assert.equal(s.all('.dm-msg').length, 11, 'its five messages are in')
  assert.equal(topOf('h0101'), -50, 'the message that was in view is exactly where it was: 0 px')
  assert.equal((document.querySelector('.dm-timeline') as HTMLElement).scrollTop, 650, 'POSITIVE CONTROL: the view was moved by the five new rows')
  await inAct(async () => { await flush(30) })
  assert.deepEqual([...new Set(s.server.pages.map(p => p.split(':')[1]))], ['1'], 'away from the top it does not read on')
})

test('alpha.1 point 9: a chat that does not fill its view when it opens loads older mail until it does, or the history ends', async (t) => {
  const height = layOut(t, { scroll: 300, client: 600 })
  const s = await setup(t, {
    audiences: [grant('worker')], delivered: many(3, 100),
    older: [{ delivered: many(2, 50) }, { delivered: many(2, 40) }, { delivered: many(2, 30) }, { delivered: many(2, 20) }],
  }, { active: false })
  await s.openChat('worker')
  await inAct(async () => { await flush(60) })
  assert.equal(document.querySelector('button.dm-older') === null, true)
  assert.equal(s.all('.dm-msg').length, 11, 'every page was read: the view never filled')
  assert.equal(height.scroll < height.client, true, 'POSITIVE CONTROL: this view does not overflow')
})

test('alpha.1 point 14: a long chat draws its newest 50 messages; scrolling up draws 50 more of what is loaded, with nothing moving, before any page is asked for', async (t) => {
  layOut(t, { scroll: 50000, client: 600 })
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(130), older: [{ delivered: [mail('older', 'worker', '2026-09-01T00:00:00Z')] }] }, { active: false })
  await s.openChat('worker')
  await scrollTo(49400)
  const drawn = () => s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry)
  assert.equal(drawn().length, 50)
  assert.deepEqual([drawn()[0], drawn()[49]], ['h0080', 'h0129'], 'the newest fifty')
  await scrollTo(250)
  assert.equal(drawn().length, 100, 'fifty more of what the mailbox already holds')
  assert.equal(topOf('h0082'), -50, 'and the message in view did not move')
  assert.deepEqual(s.server.pages, [], 'no page was asked for: the loaded mail came first')
})

test('alpha.1 point 10: the chats fill their frame in the modal, pinned and popped out: no padding around the panes and no inner frame', async () => {
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  const rule = css.match(/\n\.settings\.dm-panel \{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /padding: 0;/, 'in every presentation: the rule names none')
  assert.match(rule, /--panel-pad-y: 0px; --panel-pad-x: 0px;/, 'the published pair a window\'s title bar cancels, so that bar stays flush')
  assert.match(css, /\n\.dm-panel \.mailer \{ border: 0; border-radius: 0; \}/, 'no frame inside the frame')
  assert.match(css, /\.settings\.dm-panel:not\(\.modalpin-win\):not\(\.modalpin-detached\) > \.modalpin-bar \{ position: absolute;/,
    'the modal keeps its controls, in its title row')
  assert.match(css.match(/\.popout-mount \.settings\.dm-panel \{([^}]*)\}/)?.[1] ?? '', /border: 0; border-radius: 0;/, 'popped out, the window\'s own frame is the only one')
})

test('alpha.1 point 11: nothing is written under the box, after a send or after a refused one; a refused send is a toast, with the text back', async (t) => {
  const world: World = { audiences: [grant('worker')] }
  const s = await setup(t, world)
  await s.openChat('worker')
  await s.type('hello')
  await s.send()
  assert.equal(posts(s.server.calls, /\/nodes\/worker\/message$/).length, 1, 'POSITIVE CONTROL: it was sent')
  assert.equal(document.querySelector('.dm-compose .mail-reply-state') === null, true, 'no "sent to worker" line')
  world.refuse = true
  await s.type('this one fails')
  await s.send()
  assert.equal(document.querySelector('.dm-compose .mail-reply-state') === null, true, 'no "not sent" line either')
  assert.equal(s.state.toasts.some(line => /error: .*not taking mail/.test(line)), true, 'the app\'s toast says why')
  assert.equal(s.draft(), 'this one fails', 'and the text is back in the box')
  const box = document.querySelector('.dm-compose .cc-composer')
  assert.equal(box?.nextElementSibling ?? null, null, 'the box is the last thing in its area')
})

test('alpha.1 points 12 and 13: New chat sweeps out over the chat list; its close and Escape take only the sweep away, and the open chat stays', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] }, { active: false })
  await s.openChat('worker')
  const open = async () => { await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat') }
  await open()
  const sweep = document.querySelector<HTMLElement>('.dm-list > .dm-newchat')
  assert.ok(sweep, 'it is inside the chat list\'s column')
  assert.equal(sweep!.getAttribute('role'), 'dialog'); assert.equal(sweep!.getAttribute('aria-label'), 'New chat')
  assert.equal(sweep!.querySelector('.modalpin-bar') === null, true, 'no window bar of its own: nothing to pin, pop out or close as a window')
  assert.equal(document.querySelectorAll('.overlay').length, 1, 'and no second surface: the inbox is still the only one')
  assert.equal(document.querySelector('.dm-list-rows')?.hasAttribute('inert'), true, 'the rows under it are out of reach')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker', 'the open chat stays beside it')
  await s.click(sweep!.querySelector('.dm-newchat-close'), 'the sweep\'s close')
  assert.equal(document.querySelector('.dm-newchat') === null, true, 'the sweep is gone')
  assert.equal(s.state.closed, 0, 'and the inbox was not closed')
  await open()
  await inAct(async () => { window.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush(8) })
  assert.equal(document.querySelector('.dm-newchat') === null, true, 'Escape takes the sweep away')
  assert.equal(s.state.closed, 0, 'and only the sweep')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker')
  assert.equal(document.querySelector('.dm-list-rows')?.hasAttribute('inert'), false)
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  const rule = css.match(/\.dm-list > \.tray-panel\.dm-newchat \{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /position: absolute; inset: 0;/, 'it fills the list\'s column, so it is never taller than the inbox')
  assert.match(rule, /font: 13px\/1\.5 var\(--sans\);/, 'in the page\'s type size, as the list on the canvas is')
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.dm-list > \.tray-panel\.dm-newchat[^}]*animation: none;/, 'no slide when motion is reduced')
})

test('alpha.1 point 15: a bubble\'s menu has "View in @agent\'s inbox", for mail in both directions, through the panel\'s own route', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('sys1', '@system', '2026-11-20T09:00:00Z')],
    sent: [sent('s1', 'worker', '2026-11-20T10:05:00Z')] }, { active: false })
  await s.openChat('worker')
  const menuOf = async (entry: string) => {
    const bubble = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === entry)!.querySelector('.dm-bubble')!
    await inAct(async () => { bubble.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); await flush(6) })
    return [...document.querySelectorAll<HTMLElement>('.ctx-menu [role="menuitem"], .ctxmenu [role="menuitem"], [role="menu"] [role="menuitem"]')]
  }
  for (const entry of ['m1', 's1']) {
    const item = (await menuOf(entry)).find(i => /View in @worker\u2019s inbox/.test(i.textContent ?? ''))
    assert.ok(item, `${entry}: the entry is in the bubble's menu`)
    await s.click(item, 'View in @worker\'s inbox')
  }
  assert.deepEqual(s.state.opened, [{ kind: 'mail', org: 'mine', box: 'node', node: 'worker', id: 'm1' }, { kind: 'mail', org: 'mine', box: 'node', node: 'worker', id: 's1' }],
    'the agent\'s mailbox, at that message')
  await s.openChat('@system')
  assert.equal((await menuOf('sys1')).some(i => /View in @/.test(i.textContent ?? '')), false, 'Orgtree\'s own mail is in no agent\'s mailbox')
})

test('alpha.1 point 16: the gear asks for the settings window OVER the chat; the chat, and what was typed in it, stay', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] }, { active: false })
  await s.openChat('worker')
  await s.type('still writing this')
  const asks: unknown[] = []
  const hear = (e: Event) => { asks.push((e as CustomEvent).detail) }
  window.addEventListener(OPEN_SETTINGS_AT_EVENT, hear)
  t.after(() => window.removeEventListener(OPEN_SETTINGS_AT_EVENT, hear))
  await s.click(document.querySelector('.dm-head .dm-gear'), 'the gear')
  assert.deepEqual(asks, [{ scope: 'agent', org: 'mine', agentId: 'worker', over: true }])
  assert.equal(s.state.closed, 0, 'the inbox is not closed')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker')
  assert.equal(s.draft(), 'still writing this')
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const app = readFileSync(path.join(__SRC_DIR__, 'App.tsx'), 'utf8')
  const handler = app.match(/onAgentSettings=\{\(id\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] ?? ''
  assert.match(handler, /openSettingsAt\(\{ scope: 'agent', org: slug, agentId: id, over: true \}\)/, 'the shell asks the same way')
  assert.doesNotMatch(handler, /closeIfCentred|setShowInbox\(false\)/, 'and no longer closes a centred inbox for it')
  const canvas = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  assert.match(canvas, /over \? <ModalOverPins>\{children\}<\/ModalOverPins>/, 'the canvas draws a window asked for that way in the band over open panels')
})

test('alpha.1 point 21: anywhere on a chat row the hover is the agent link\'s: the row carries it, and no part of the row has a tooltip of its own', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] }, { active: false })
  const { agentTooltipProps } = await import('../src/canvas/agentnav')
  const row = s.row('worker')!
  for (const [name, value] of Object.entries(agentTooltipProps('worker'))) {
    if (typeof value === 'string') assert.equal(row.getAttribute(name), value, `the row has the agent link's ${name}`)
  }
  assert.equal(row.querySelector('.dm-row-name')?.hasAttribute('title'), false, 'the name has no tooltip of its own')
  assert.equal(row.querySelector('.dm-row-name')?.getAttribute('aria-label'), 'Open the chat with worker', 'it keeps its name for a screen reader')
  assert.equal(row.hasAttribute('title'), false)
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  assert.match(readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8'), /\.dm-row > \.dm-av \{ pointer-events: none; \}/,
    'the picture\'s own model tooltip gives way to the row\'s')
})

test('alpha.1 point 22: Up and Down in the chat\'s box walk what was sent to that agent, the desk\'s own history, and the draft comes back', async (t) => {
  const { readHistory, recordSent, clearStash } = await import('../src/composerhistory')
  window.localStorage.clear()
  t.after(() => { clearStash('mine', 'worker'); window.localStorage.clear() })
  // one message went out from worker's DESK before: the chat recalls it too
  recordSent('mine', 'worker', 'sent from the desk')
  const s = await setup(t, { audiences: [grant('worker')] })
  await s.openChat('worker')
  await s.type('sent from the chat')
  await s.send()
  assert.deepEqual(readHistory('mine', 'worker').map(e => e.text), ['sent from the desk', 'sent from the chat'], 'the chat records into the desk\'s history')
  const key = async (name: string) => {
    const ta = document.querySelector('.dm-compose textarea') as HTMLTextAreaElement
    await inAct(async () => { ta.dispatchEvent(new W.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); await flush(4) })
  }
  await s.type('a draft in progress')
  await key('ArrowUp')
  assert.equal(s.draft(), 'sent from the chat', 'Up: the newest message')
  assert.match(document.querySelector('.dm-compose .composer-history-note')?.textContent ?? '', /return to your draft/, 'the desk\'s own note')
  await key('ArrowUp')
  assert.equal(s.draft(), 'sent from the desk', 'Up again: the one before, sent from the desk')
  await key('ArrowDown')
  assert.equal(s.draft(), 'sent from the chat')
  await key('ArrowDown')
  assert.equal(s.draft(), 'a draft in progress', 'Down past the newest: the draft is back')
  assert.equal(document.querySelector('.dm-compose .composer-history-note') === null, true)
  await key('ArrowUp')
  await key('Escape')
  assert.equal(s.draft(), 'a draft in progress', 'Escape puts the draft back too')
  assert.equal(s.state.closed, 0, 'and does not close the inbox')
})

test('alpha.1 point 1: a retired agent that held an audience is not listed; its chat can still be opened, is listed while open, and leaves when another is selected', async (t) => {
  const withRetired = { ...tree(), roots: [node('lead', [node('worker'), node('gone', [], { state: 'archived' })]), node('solo')] } as unknown as TreePayload
  const s = await setup(t, { audiences: [grant('worker'), grant('gone')], delivered: [mail('g1', 'gone', '2026-11-10T10:00:00Z')] },
    { active: false, tree: withRetired })
  assert.equal(s.row('gone'), undefined, 'not in the list by default')
  await inAct(async () => { s.rerender({ openChat: { peer: 'gone', seq: 1 } }); await flush(12) })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'gone', 'its chat opens')
  assert.equal(s.row('gone')?.classList.contains('sel'), true, 'and is listed while it is open, as the selected row')
  assert.match(document.querySelector('.dm-head .dm-who-l1')?.textContent ?? '', /retired/, 'marked retired')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['g1'], 'its history can be read')
  assert.equal(document.querySelector('.dm-compose textarea') === null, true, 'it cannot be written to')
  assert.match(document.querySelector('.dm-nowrite')?.textContent ?? '', /gone is retired and cannot be written to/)
  await s.openChat('worker')
  assert.equal(s.row('gone'), undefined, 'the row is gone as soon as another chat is selected')
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0, 'and nothing was revoked')
})

test('alpha.1 point 9: a short chat whose older mail lies beyond pages of other chats\' mail still gets it by itself: no button, nothing to scroll', async (t) => {
  const { dmTiming } = await import('../src/dm/DmPanel')
  const was = dmTiming.slowPageMs
  dmTiming.slowPageMs = 5
  t.after(() => { dmTiming.slowPageMs = was })
  // five pages of lead's mail, then the page that holds worker's older message
  const others = Array.from({ length: 5 }, (_, i) => ({ delivered: [mail(`x${i}`, 'lead', `2026-10-${String(20 - i).padStart(2, '0')}T10:00:00Z`)] }))
  const s = await setup(t, {
    audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')],
    older: [...others, { delivered: [mail('m0', 'worker', '2026-10-01T10:00:00Z')] }],
  }, { active: false })
  await s.openChat('worker')
  for (let i = 0; i < 200 && !s.all<HTMLElement>('.dm-msg').some(m => m.dataset.dmEntry === 'm0'); i++) {
    await inAct(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await flush(6) })
  }
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['m0', 'm1'], `the older message came in (pages read: ${s.server.pages.join(' ')})`)
  assert.equal(document.querySelector('button.dm-older') === null, true, 'with no button')
  assert.equal(s.server.pages.includes('inbox:6'), true, 'the history was read to its end')
})
