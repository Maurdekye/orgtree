// The user mailbox panel as chats (4.7.0). One test per ruling of USER
// 2026-11-22 m200806e4af28 / m1454e651500e / m321dab754e52 and 2026-11-23
// m79c022311f95 / me0241bccf7b4, driven on the mounted panel against a fake
// engine. dmmodel.test.tsx holds the pure rules; this file shows the panel
// obeys them and calls exactly the engine routes the classic mailbox calls.
//
// Run:  node apps/desktop/renderer/tests/run.mjs dmpanel

import './harness'
import React from 'react'
import { mentionHighlightOf, resetSeenMentions } from '../src/canvas/agentmentions'
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
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import type { CanvasNode } from '../src/canvas/shared'
import { syncFastModes } from '../src/canvas/fastmode'
import { OPEN_SETTINGS_AT_EVENT } from '../src/canvas/settingskit'
import { STREAMER_ZONES } from '../src/streamer-boundary'
import { withoutMailTransfers } from './mailtransfers.fixture'
import type { TreePayload } from '../src/types'
import { InboxView } from '../src/canvas/mail'
import { classicMailbox, mailLinkToChat, onMailViewRequest } from '../src/mailboxpref'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'

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
  /** the time of what is sent from now on: the fake engine then keeps sent mail in the mailbox */
  keepSent?: string
  pending?: unknown[]; delivered?: unknown[]; sent?: unknown[]
  audiences?: unknown[]; requests?: unknown[]
  /** a mail the by-id lookup knows, outside the loaded window */
  byId?: Record<string, unknown>
  /** the engine refuses every message */
  refuse?: boolean
  /** the engine refuses every audience grant */
  refuseGrant?: boolean
  /** an engine from before the chat folder: `folder=chat` is refused, as it refuses any unknown folder */
  noChatFolder?: boolean
  /** what the engine's @ menu read answers (tickets and the rest), in the engine's own order */
  candidates?: unknown[]
  /** the next this-many reads of the chat folder fail with a 503 (the engine is there, the read is not) */
  chatFails?: number
  /** older history, a page per entry: the first read says there is more, and
   *  `before=<n>` returns page n (1-based) */
  older?: { delivered?: unknown[]; sent?: unknown[] }[]
  /** an older page (any `before=` read) is answered only once this settles: a page on its way */
  holdPages?: Promise<void>
  /** a take-back (the desk's retract) is refused, as the engine refuses mail already delivered */
  retractRefuse?: boolean
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
        if (world.refuseGrant && b.action === 'grant') return json({ error: 'the grant is refused' }, 403)
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
    // the desk's retract: the user's own mail to that agent, while still pending (http::nodes::retract)
    const retract = method === 'DELETE' ? path.match(/\/nodes\/([^/]+)\/mail\/([^/?]+)$/) : null
    if (retract) {
      if (world.retractRefuse) return json({ error: 'that message was already delivered (or is not yours to retract)' }, 409)
      world.sent = (world.sent ?? []).map(m => (m as { id: string }).id === retract[2] ? { ...(m as object), retracted: true, delivered: undefined } : m)
      return json({ retracted: retract[2] })
    }
    const byId = path.match(/\/mail\/user\/([^?]+)/)
    if (byId) {
      const found = world.byId?.[decodeURIComponent(byId[1]!)] ?? null
      return json({ found: !!found, mail: found })
    }
    if (/\/nodes\/[^/]+\/message$/.test(path)) {
      if (world.refuse) return json({ error: 'the agent is not taking mail' }, 500)
      // `keepSent`: the sent mail is in the mailbox at the next read, as on the engine
      // the receipt names the row it stores, as the engine's does (instant send matches its bubble by that id)
      const id = world.keepSent ? `m-new-${(world.sent ?? []).length}` : 'm-new'
      if (world.keepSent) world.sent = [...(world.sent ?? []), sent(id, path.match(/\/nodes\/([^/]+)\/message$/)![1]!, world.keepSent)]
      return json({ accepted: true, id, ref: `@mail:${id}` })
    }
    // a desk's own chat read (the desk box mounted beside the chats' box)
    if (/\/nodes\/[^/]+\/chat(\?|$)/.test(path)) return json({ messages: [], live: [], pending_mail: [], busy: false, responding: false,
      windowed: true, has_older: false, before: null, draft_epoch: 'synthetic:0' })
    if (/\/nodes\/[^/]+\/batch$/.test(path)) return json({ resolved: 'ok' })
    // the megaphone's route: one copy to each agent under the project
    if (/\/nodes\/[^/]+\/broadcast$/.test(path)) return json({ sent: [{ to: 'member' }, { to: 'mate' }], refused: [] })
    if (/\/nodes\/[^/]+\/scope$/.test(path)) return json({ ok: true })
    if (/\/mention-candidates(\?|$)/.test(path)) return json({ items: world.candidates ?? [], next_cursor: null, nodes: [], outside: [] })
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
      if (q.get('folder') === 'chat') {
        // ONE CHAT'S OWN PAGES, as the engine cuts them: both directions of `peer`, newest first, 50 a
        // page; the cursor here is how many rows came before
        if (world.noChatFolder || !q.get('peer')) return json({ detail: 'mail folder must be inbox or sent' }, 400)
        if (world.chatFails) { world.chatFails--; return json({ detail: 'the database is busy' }, 503) }
        const peer = q.get('peer')!
        const received = [...(world.pending ?? []), ...(world.delivered ?? []), ...older.flatMap(p => p.delivered ?? [])] as { id: string; from: string; at: string }[]
        const written = [...(world.sent ?? []), ...older.flatMap(p => p.sent ?? [])] as { id: string; to: string; at: string }[]
        const unread = new Set((world.pending ?? []).map(m => (m as { id: string }).id))
        const rows = [...received.filter(m => m.from === peer).map(m => ({ m, sent: false })), ...written.filter(m => m.to === peer).map(m => ({ m, sent: true }))]
          .sort((a, b) => (a.m.at < b.m.at ? 1 : a.m.at > b.m.at ? -1 : 0))
        const from = before ? Number(before) : 0
        if (before) pages.push(`chat:${before}`)
        if (before && world.holdPages) await world.holdPages
        const page = rows.slice(from, from + 50)
        return json({ pending: page.filter(r => !r.sent && unread.has(r.m.id)).map(r => r.m), delivered: page.filter(r => !r.sent && !unread.has(r.m.id)).map(r => r.m),
          sent: page.filter(r => r.sent).map(r => r.m), next_cursor: from + 50 < rows.length ? String(from + 50) : null })
      }
      if (before) {
        pages.push(`${q.get('folder')}:${before}`)
        if (world.holdPages) await world.holdPages
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
  tree?: TreePayload; jumpTo?: string | null; jumpPeer?: string; active?: boolean; openChat?: { peer: string; seq: number; grant?: boolean } | null
  /** around the panel, e.g. the canvas's agent-menu registry */
  wrap?: (panel: React.ReactElement) => React.ReactElement
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
  window.localStorage.removeItem('orgtree-dm-open:mine')
  window.sessionStorage.clear()
  resetLocalReads()
  resetComposerDrafts()
  const state = { closed: 0, focused: [] as string[], toasts: [] as string[], opened: [] as unknown[] }
  const panel = (o = opts) => (
    <CurrentOrg.Provider value="mine">
      <UserMailbox slug="mine" tree={o.tree ?? opts.tree ?? tree()} toast={(lines) => { state.toasts.push(...lines) }}
        close={() => { state.closed++ }} jumpTo={o.jumpTo ?? null} jumpSeq={o.jumpTo ? 1 : null} jumpPeer={o.jumpPeer}
        openChat={o.openChat ?? null} onFocusAgent={(id) => { state.focused.push(id) }}
        onOpenMail={(ref) => { state.opened.push(ref) }} />
    </CurrentOrg.Provider>
  )
  const wrapped = () => opts.wrap ? opts.wrap(panel()) : panel()
  let view = await mountView(wrapped(), el => el)
  /** close the panel and open it again, as closing and reopening the inbox does */
  const remount = async () => {
    await view.unmount()
    view = await mountView(wrapped(), el => el)
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
    window.localStorage.removeItem('orgtree-dm-open:mine')
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

test('selecting a chat never moves a chat in the list: the open chat\'s own pages do not set the order (USER 2026-11-25 mbad35d25d10f)', async (t) => {
  // solo's only mail lies outside the mailbox's loaded window; opening solo reads its own pages, which hold it
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'lead', '2026-11-20T12:00:00Z')],
    older: [{ delivered: [mail('o1', 'solo', '2026-11-19T10:00:00Z')] }],
  }, { active: false })
  const order = () => s.rows().map(r => r.dataset.dmChat)
  const before = order()
  assert.deepEqual(before, ['lead', 'worker', 'solo'], 'POSITIVE CONTROL: solo has nothing in the loaded window, so it sits in tree order')
  await s.openChat('solo')
  await inAct(async () => { await flush(20) })
  assert.ok(s.all<HTMLElement>('.dm-msg').some(b => b.dataset.dmEntry === 'o1'), 'POSITIVE CONTROL: the open chat read its own page')
  assert.deepEqual(order(), before, 'opening solo moved no chat')
  await s.openChat('worker')
  await inAct(async () => { await flush(20) })
  assert.deepEqual(order(), before, 'and opening another moved none either')
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

// INBOX LINKS' OPEN CHAT (USER 2026-11-25 14:24:01Z ma84dfc37f5a6): a request with `grant` takes New chat's path
test('an Open chat request that grants: an agent without an audience is granted one, then its chat opens', async (t) => {
  const s = await setup(t, { audiences: [] }, { openChat: { peer: 'helper', seq: 1, grant: true } })
  await inAct(async () => { await flush(12) })
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'grant', node: 'helper' }],
    'the existing grant, once')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'helper', "and helper's chat is open")
  assert.equal(s.row('helper') !== undefined, true, 'with its row in the list')
})

test('an Open chat request that grants, for one that can already write to the user, opens it and grants nothing', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')] }, { openChat: { peer: 'worker', seq: 1, grant: true } })
  await inAct(async () => { await flush(12) })
  assert.equal(posts(s.server.calls, /\/audiences$/).length, 0, 'worker holds a grant')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker')
})

test('an Open chat request whose grant is refused shows the error and opens no empty chat', async (t) => {
  const s = await setup(t, { audiences: [], refuseGrant: true }, { openChat: { peer: 'helper', seq: 1, grant: true } })
  await inAct(async () => { await flush(12) })
  assert.deepEqual(posts(s.server.calls, /\/audiences$/).map(c => c.body), [{ action: 'grant', node: 'helper' }], 'it tried')
  assert.notEqual(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'helper', 'no chat with helper is open')
  assert.ok(s.state.toasts.some(line => /could not open a chat with helper/.test(line)), `the error is shown: ${JSON.stringify(s.state.toasts)}`)
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

test('Orgtree\'s own chat has nothing where the message box would be: no line, no empty strip; a retired agent keeps its line (USER 2026-11-26 m5ade5cb71f04)', async (t) => {
  const s = await setup(t, { delivered: [mail('sys1', '@system', '2026-11-20T10:00:00Z'), mail('g1', 'gone', '2026-11-20T09:00:00Z')] },
    { tree: tree({ roots: [node('lead'), node('solo'), node('gone', [], { state: 'archived' })] }), active: false })
  await s.openChat('@system')
  assert.ok(document.querySelector('.dm-msg[data-dm-entry="sys1"]'), 'POSITIVE CONTROL: the System chat is open on its mail')
  assert.equal(document.querySelector('.dm-nowrite'), null, '"remove this": no line under it')
  assert.equal(document.querySelector('.dm-compose'), null, 'and no empty box strip either: the messages run to the bottom')
  await inAct(async () => { s.rerender({ openChat: { peer: 'gone', seq: 1 } }); await flush(12) })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'gone', 'POSITIVE CONTROL: the chat of the retired agent is open')
  assert.match(document.querySelector('.dm-nowrite')?.textContent ?? '', /gone is retired and cannot be written to/, 'a retired agent still says why')
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
  // the window is named after its view, live (USER 2026-11-25 m3599f869626b); the switch says "classic inbox" (mf9341d56d281)
  assert.equal(document.querySelector('.settings h3')?.textContent?.trim(), 'Chats', 'the chats are "Chats" (USER m5e271cdf9dd1)')
  assert.equal(box().closest('label')?.textContent?.trim(), 'classic inbox', 'the switch reads "classic inbox"')
  assert.match(bell.el.querySelector('button')?.getAttribute('title') ?? '', /^chats/, 'the bell tooltip names the window as it is')
  assert.equal(document.querySelector('.settings h3 [data-testid="ChatBubbleOutlineOutlinedIcon"]') !== null, true)
  assert.equal(bell.el.querySelector('[data-testid="ChatBubbleOutlineOutlinedIcon"]') !== null, true, 'the panel\'s icon is a chat bubble')
  assert.equal(bell.el.querySelector('[data-testid="MailOutlinedIcon"]') === null, true)

  await s.click(box(), 'the classic checkbox')
  assert.equal(window.localStorage.getItem(CLASSIC_MAILBOX_KEY), '1', 'saved for every org and window')
  assert.equal(document.querySelector('.settings.dm-panel') === null, true)
  assert.equal(document.querySelector('.settings h3')?.textContent?.trim(), 'Your inbox', 'today\'s panel keeps its name')
  assert.match(bell.el.querySelector('button')?.getAttribute('title') ?? '', /^your inbox/, 'and the bell tooltip follows, live')
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

test('opening a project\'s chat never moves a chat in the list: the older mailbox pages it loads do not set the order (coordinator m3854136c7a6e)', async (t) => {
  // crew's chat is a thread of the whole mailbox's pages; it does not fill its view, so it reads older pages,
  // and those hold solo's only mail
  layOut(t, { scroll: 300, client: 600 })
  const s = await setup(t, {
    audiences: [grant('crew')],
    delivered: [mail('m1', 'lead', '2026-11-20T12:00:00Z')],
    sent: [sent('j1', 'crew', '2026-11-20T11:00:00Z')],
    older: [{ delivered: [mail('o1', 'solo', '2026-11-19T10:00:00Z')] }],
  }, { tree: tree({ roots: [node('lead'), projectNode('crew', [node('member')]), node('idle'), node('solo')] }), active: false })
  const order = () => s.rows().map(r => r.dataset.dmChat)
  const before = order()
  assert.deepEqual(before, ['lead', 'crew', 'member', 'idle', 'solo'], 'POSITIVE CONTROL: solo has nothing in the loaded window, so it sits in tree order (member under crew)')
  await s.openChat('crew')
  await inAct(async () => { await flush(60) })
  assert.ok(s.server.pages.some(p => /^(inbox|sent):1$/.test(p)), `POSITIVE CONTROL: the project's chat read an older mailbox page (${s.server.pages.join(', ')})`)
  assert.deepEqual(order(), before, 'opening crew moved no chat')
  await s.openChat('lead')
  await inAct(async () => { await flush(20) })
  assert.deepEqual(order(), before, 'and opening another moved none either')
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
  // USER 2026-11-26 m13310210ae7e: the project itself gets no losing mark, only the agents who would lose their line
  assert.deepEqual(losing(), ['clerk'], 'clerk only: not the project itself, and runner keeps its own grant')
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
  await hover(s.row('crew')!.querySelector('.dm-row-close'), true)
  assert.deepEqual(losing(), [], 'hovering its close marks no row: nobody loses a line, and the project itself is never marked')
  await hover(s.row('crew')!.querySelector('.dm-row-close'), false)
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
  assert.deepEqual(losing(), ['clerk'], 'the same mark as on the project\'s own close: clerk, never the project row')
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
    // sixty newer messages of this chat stand between the answer and what it answers: the original is on the chat's second page
    delivered: [mail('m9', 'worker', '2026-11-20T10:00:00Z', { reply_to: quote('s-old', USER, '2026-09-01T10:00:00Z', { kind: 'mail', org: 'mine', box: 'node', node: 'worker' }) }),
      ...many(60)],
    older: [{ sent: [sent('s-old', 'worker', '2026-09-01T10:00:00Z')] }],
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
  assert.deepEqual(s.server.pages, ['chat:50'], 'the chat\'s own next page was read, and it holds the original')
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
  // 66 messages of this chat: the six newest in the mailbox's first window, sixty older ones beyond it
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(6, 100), older: [{ delivered: many(60, 0) }] }, { active: false })
  await s.openChat('worker')
  await scrollTo(4400)
  assert.equal(document.querySelector('button.dm-older') === null, true, 'no button to press')
  assert.doesNotMatch(document.querySelector('.dm-timeline')?.textContent ?? '', /Load older/)
  assert.equal(s.all('.dm-msg').length, 50, 'the chat opened on its own newest page: fifty messages')
  assert.deepEqual(s.server.pages, [], 'at the newest message nothing older is asked for')
  // the reader scrolls up: the second row is cut by the top edge
  await scrollTo(150)
  assert.deepEqual(s.server.pages, ['chat:50'], 'the chat\'s next page, and only that one')
  assert.equal(s.all('.dm-msg').length, 66, 'its sixteen messages are in')
  assert.equal(topOf('h0017'), -50, 'the message that was in view is exactly where it was: 0 px')
  assert.equal((document.querySelector('.dm-timeline') as HTMLElement).scrollTop, 1750, 'POSITIVE CONTROL: the view was moved by the sixteen new rows')
  await inAct(async () => { await flush(30) })
  assert.deepEqual(s.server.pages, ['chat:50'], 'away from the top it does not read on')
})

test('alpha.1 point 9: a chat that does not fill its view when it opens loads older mail until it does, or the history ends', async (t) => {
  const height = layOut(t, { scroll: 300, client: 600 })
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(3, 200), older: [{ delivered: many(117, 0) }] }, { active: false })
  await s.openChat('worker')
  await inAct(async () => { await flush(80) })
  assert.equal(document.querySelector('button.dm-older') === null, true)
  assert.equal(s.all('.dm-msg').length, 120, 'every page of the chat was read and drawn: the view never filled')
  assert.deepEqual(s.server.pages, ['chat:50', 'chat:100'], 'a page at a time, to the end of the chat')
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

test('alpha.1 point 11: nothing is written under the box, after a send or after a refused one; a refused send is a toast, and its failed bubble keeps the text', async (t) => {
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
  // the text no longer comes back into the box by itself: it stays in the chat as Hubchat's failed
  // bubble, with Retry and Discard (Discard puts it back); USER 2026-11-25 m1454b39b8fd0, point 1
  assert.equal(s.draft(), '', 'the box stays empty')
  assert.equal(s.all<HTMLElement>('.dm-msg.failed').some(m => m.textContent?.includes('this one fails')), true,
    'the refused message is its failed bubble')
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

test('alpha.1 point 14: a chat reads its own pages, so its older mail is one page away however much other mail there is', async (t) => {
  // five pages of lead's mail lie between worker's newest message and its older one in the MAILBOX; in the chat they are neighbours
  const others = Array.from({ length: 5 }, (_, i) => ({ delivered: [mail(`x${i}`, 'lead', `2026-10-${String(20 - i).padStart(2, '0')}T10:00:00Z`)] }))
  const s = await setup(t, {
    audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')],
    older: [...others, { delivered: [mail('m0', 'worker', '2026-10-01T10:00:00Z')], sent: [sent('s0', 'worker', '2026-10-02T10:00:00Z')] }],
  }, { active: false })
  await s.openChat('worker')
  await inAct(async () => { await flush(20) })
  assert.deepEqual(s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry), ['m0', 's0', 'm1'], 'both directions of the chat, from its own first page')
  assert.deepEqual(s.server.pages, [], 'and no page of the mailbox was read for it')
})

test('alpha.1 point 14: a failed read of the chat\'s own pages is not "this engine cannot": the chat keeps its own pages, and Retry reads them', async (t) => {
  // coordinator 2026-11-24 m5eba9c2e1bf1: only a 4xx answer marks the engine as not knowing the chat
  // folder; a network fault or a 5xx retries and never downgrades the panel to the mailbox's pages
  layOut(t, { scroll: 300, client: 600 })
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(3, 200), older: [{ delivered: many(117, 0) }], chatFails: 1 }, { active: false })
  await s.openChat('worker')
  await inAct(async () => { await flush(40) })
  assert.deepEqual(s.server.pages, [], 'the failed read did not send the chat to the pages of the whole mailbox')
  const retry = [...document.querySelectorAll<HTMLButtonElement>('.dm-history-error button')].find(b => b.textContent === 'Retry')
  assert.ok(retry, 'the failed read is said, with Retry')
  await s.click(retry, 'Retry')
  await inAct(async () => { await flush(80) })
  assert.equal(s.all('.dm-msg').length, 120, 'the whole chat came in')
  assert.deepEqual(s.server.pages, ['chat:50', 'chat:100'], 'by its own pages, never the mailbox\'s')
})

test('alpha.1 point 9: with an engine that has no chat folder, a short chat whose older mail lies beyond pages of other chats\' mail still gets it by itself', async (t) => {
  const { dmTiming } = await import('../src/dm/DmPanel')
  const was = dmTiming.slowPageMs
  dmTiming.slowPageMs = 5
  t.after(() => { dmTiming.slowPageMs = was })
  // five pages of lead's mail, then the page that holds worker's older message
  const others = Array.from({ length: 5 }, (_, i) => ({ delivered: [mail(`x${i}`, 'lead', `2026-10-${String(20 - i).padStart(2, '0')}T10:00:00Z`)] }))
  const s = await setup(t, {
    audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')], noChatFolder: true,
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

test('alpha.1 point 5: while an agent writes to the user its row says "typing…" and its open chat shows three dots; nothing for the others, nothing in the classic mailbox', async (t) => {
  const writes = (who: 'worker' | 'nobody') => ({
    ...tree(), roots: [node('lead', [node('worker', [], who === 'worker' ? { writing_to_user: true } : { writing_to_user: false }), node('helper')]), node('solo')],
  }) as unknown as TreePayload
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('m2', 'lead', '2026-11-20T09:00:00Z')] },
    { active: false, tree: writes('nobody') })
  await s.openChat('worker')
  assert.equal(document.querySelector('.dm-typing-row, .dm-row-typing'), null, 'POSITIVE CONTROL: nobody writes, nothing shows')
  // the tree says worker is writing a message to the user
  await inAct(async () => { s.rerender({ tree: writes('worker') }); await flush(6) })
  const typing = s.all<HTMLElement>('.dm-row-typing')
  assert.deepEqual(typing.map(el => el.closest<HTMLElement>('.dm-row')?.dataset.dmChat), ['worker'], 'only that agent\u2019s row')
  assert.match(typing[0]!.textContent ?? '', /typing…/)
  assert.equal(s.row('worker')!.querySelector('.dm-row-text'), null, 'in the preview\u2019s place')
  const dots = document.querySelector<HTMLElement>('.dm-timeline .dm-typing-row')
  assert.ok(dots, 'and its open chat shows the row')
  assert.equal(dots.querySelectorAll('.dm-typing-dots i').length, 3, 'three dots')
  assert.equal(dots.textContent, 'worker is typing…')
  assert.equal(dots.getAttribute('role'), 'status')
  assert.equal(dots.previousElementSibling?.matches('.dm-msg'), true, 'under the last message')
  // another agent's open chat shows none
  await s.openChat('lead')
  assert.equal(document.querySelector('.dm-timeline .dm-typing-row'), null, 'not in another agent\u2019s chat')
  assert.equal(s.all('.dm-row-typing').length, 1, 'the row still says it')
  // the call ended
  await inAct(async () => { s.rerender({ tree: writes('nobody') }); await flush(6) })
  assert.equal(document.querySelector('.dm-typing-row, .dm-row-typing'), null, 'gone when the flag goes')
  assert.match(s.row('worker')!.querySelector('.dm-row-text')?.textContent ?? '', /body of m1/, 'and the preview is back')
  // the classic mailbox never shows it
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  await s.remount()
  await inAct(async () => { s.rerender({ tree: writes('worker') }); await flush(6) })
  assert.equal(document.querySelector('.dm-panel'), null, 'POSITIVE CONTROL: this is the classic mailbox')
  assert.equal(document.querySelector('.dm-typing-row, .dm-row-typing, .dm-typing-dots'), null)
})

// USER 2026-11-25 mcc1bee9a2771 + ma76e93d834d1: grey check when sent, green check when read, live. One check
// throughout (USER 2026-11-24 m0a5d2a5b266e); sent a darker grey, read a brighter green (USER 2026-11-25 mb3ad4035c5bb; tests/dmticks.test.ts).
test('the user\u2019s own message shows a grey check while the agent has not read it and Hubchat\u2019s green read mark once it has, live; an agent\u2019s message and an older engine\u2019s row show no mark', async (t) => {
  const world: World = {
    audiences: [grant('worker')],
    delivered: [mail('in1', 'worker', '2026-11-20T10:00:00Z')],
    sent: [
      sent('old', 'worker', '2026-11-20T09:00:00Z'),                                   // an older engine: nothing said
      sent('done', 'worker', '2026-11-20T11:00:00Z', { delivered: true }),
      sent('held', 'worker', '2026-11-20T12:00:00Z', { delivered: false, dnd_held: true }),
      sent('wait', 'worker', '2026-11-20T13:00:00Z', { delivered: false }),
    ],
  }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  const tick = (id: string) => s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === id)?.querySelector<HTMLElement>('.dm-meta .dm-tick') ?? null
  const state = (id: string) => { const el = tick(id); return el ? [el.className, el.getAttribute('aria-label'), el.getAttribute('role')] : null }
  assert.deepEqual(state('wait'), ['dm-tick t-sent', 'Sent: worker has not read it yet', 'img'], 'a grey check while it is not read')
  assert.deepEqual(state('held'), ['dm-tick t-sent', 'Sent: worker is on Do Not Disturb', 'img'])
  assert.deepEqual(state('done'), ['dm-tick t-read', 'Read: worker has it', 'img'], 'the read mark once the agent has it')
  assert.equal(tick('done')!.querySelectorAll('svg').length, 1, 'one mark, never two')
  assert.equal(tick('done')!.querySelector('svg')?.getAttribute('data-testid'), 'CheckIcon', 'read: the same one check, green (USER 2026-11-24 m0a5d2a5b266e "simple 1-checkmark read receipts")')
  assert.equal(tick('wait')!.querySelector('svg')?.getAttribute('data-testid'), 'CheckIcon', 'sent: one check, never a clock')
  {
    const { readFileSync } = await import('node:fs')
    const { default: path } = await import('node:path')
    const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
    assert.match(css, /\.dm-tick\.t-read \{ color: var\(--dm-tick-read\); \}/, 'read is the panel\u2019s brighter green (USER 2026-11-25 mb3ad4035c5bb; tests/dmticks.test.ts)')
    assert.match(css, /\.dm-tick\.t-sent \{ color: var\(--dm-tick-sent\); \}/, 'sent is the panel\u2019s darker grey')
  }
  assert.equal(tick('done')!.previousElementSibling?.tagName, 'TIME', 'after the time, as in Hubchat')
  assert.equal(state('old'), null, 'an older engine\u2019s row: no mark, never a clock that cannot turn')
  assert.equal(state('in1'), null, 'the agent\u2019s own message has none')
  assert.equal(s.all('.dm-msg.in .dm-tick').length, 0)
  // the agent takes the waiting mail: the engine publishes the user's mail again, and the mark turns
  // without the chat being opened again
  ;(world.sent as Record<string, unknown>[]).find(m => m.id === 'wait')!.delivered = true
  for (let i = 0; i < 80 && state('wait')?.[0] !== 'dm-tick t-read'; i++) {
    await inAct(async () => { await new Promise(resolve => setTimeout(resolve, 100)); await flush(4) })
  }
  assert.deepEqual(state('wait'), ['dm-tick t-read', 'Read: worker has it', 'img'], 'the grey check turned green, live')
  assert.deepEqual(state('held')?.[0], 'dm-tick t-sent', 'and only that one')
})

test('alpha.1 point 15: a bubble\u2019s menu has "View in transcript" for the agent\u2019s mail and for the user\u2019s delivered mail only; it asks that agent\u2019s desk for the row', async (t) => {
  resetSeenMentions()
  t.after(() => resetSeenMentions())
  const world: World = {
    audiences: [grant('worker')],
    delivered: [mail('in1', 'worker', '2026-11-20T10:00:00Z')],
    sent: [
      sent('old', 'worker', '2026-11-20T09:00:00Z'),                       // an older engine: not known to be delivered
      sent('done', 'worker', '2026-11-20T11:00:00Z', { delivered: true }),
      sent('wait', 'worker', '2026-11-20T13:00:00Z', { delivered: false }),
    ],
    byId: { in1: { ...mail('in1', 'worker', '2026-11-20T10:00:00Z'), to: USER }, done: sent('done', 'worker', '2026-11-20T11:00:00Z') },
  }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  const menuOf = async (id: string) => {
    const bubble = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === id)?.querySelector<HTMLElement>('.dm-bubble')
    assert.ok(bubble, `the bubble of ${id}`)
    await inAct(async () => { bubble.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(4) })
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    const items = menus.length ? [...menus[menus.length - 1]!.querySelectorAll<HTMLElement>('[role="menuitem"]')] : []
    return { labels: items.map(i => i.textContent?.trim() ?? ''), item: (label: string) => items.find(i => i.textContent?.trim() === label) }
  }
  const closeMenu = async () => inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(3) })
  // the agent's own mail: always
  let menu = await menuOf('in1')
  assert.equal(menu.labels.includes('View in transcript'), true, `the agent\u2019s mail has it (${menu.labels.join(' | ')})`)
  assert.equal(menu.labels.indexOf('View in transcript') + 1, menu.labels.findIndex(l => l.startsWith('View in @worker')), 'next to "View in @worker\u2019s inbox" (the View in group, USER 2026-11-25 md7da554ce837)')
  await s.click(menu.item('View in transcript'), 'View in transcript')
  assert.deepEqual([mentionHighlightOf('mine', 'worker')?.mailId, mentionHighlightOf('mine', 'worker')?.at], ['in1', '2026-11-20T10:00:00Z'], 'the desk of that agent is asked for that mail\u2019s row')
  assert.deepEqual(s.state.focused, ['worker'], 'and its desk is shown')
  // the user's own mail: only once it is delivered
  menu = await menuOf('done')
  assert.equal(menu.labels.includes('View in transcript'), true, 'a delivered message has it')
  await closeMenu()
  menu = await menuOf('wait')
  assert.equal(menu.labels.includes('View in transcript'), false, `a waiting message has no such entry, not a greyed one (${menu.labels.join(' | ')})`)
  assert.equal(menu.labels.some(l => l.startsWith('View in @worker')), true, 'POSITIVE CONTROL: its menu is the bubble menu')
  await closeMenu()
  menu = await menuOf('old')
  assert.equal(menu.labels.includes('View in transcript'), false, 'nor one the engine says nothing about')
  await closeMenu()
  // it appears live when the mail is delivered
  ;(world.sent as Record<string, unknown>[]).find(m => m.id === 'wait')!.delivered = true
  for (let i = 0; i < 80 && !s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'wait')?.querySelector('.dm-tick.t-read'); i++) {
    await inAct(async () => { await new Promise(resolve => setTimeout(resolve, 100)); await flush(4) })
  }
  menu = await menuOf('wait')
  assert.equal(menu.labels.includes('View in transcript'), true, 'the entry is there once the mail is delivered, with no reopening')
})

test('alpha.1 point 20: the user\u2019s own message has Reply; the reply goes to the chat\u2019s agent with that message as its target, and its quote shows in the chat', async (t) => {
  const world: World = {
    audiences: [grant('worker')],
    delivered: [mail('in1', 'worker', '2026-11-20T10:00:00Z')],
    sent: [sent('mine1', 'worker', '2026-11-20T11:00:00Z', { body: 'my first thought' })],
  }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  const own = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'mine1')!
  assert.equal(own.classList.contains('out'), true, 'POSITIVE CONTROL: it is the user\u2019s own bubble')
  const reply = own.querySelector<HTMLButtonElement>('.dm-actions button[aria-label="Reply"]')
  assert.ok(reply, 'the hover action is Reply, as on the agent\u2019s bubble')
  // the menu has it too
  await inAct(async () => { own.querySelector('.dm-bubble')!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(4) })
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
  assert.equal([...menus[menus.length - 1]!.querySelectorAll('[role="menuitem"]')].some(i => i.textContent?.trim() === 'Reply'), true, 'and the menu')
  await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(3) })
  await s.click(reply, 'Reply on my own message')
  assert.match(document.querySelector('.dm-replybar')?.textContent ?? '', /my first thought/, 'it is staged above the box')
  // several can be staged: the agent's and my own together
  await s.click(s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'in1')!.querySelector('.dm-actions button[aria-label="Reply"]'), 'Reply on the agent\u2019s')
  assert.equal(s.all('.dm-replybar-row').length, 2)
  await s.type('and one more thing')
  await s.send()
  const call = s.server.calls.find(c => /\/nodes\/worker\//.test(c.path) && c.method === 'POST' && JSON.stringify(c.body).includes('and one more thing'))
  assert.ok(call, `the reply was sent to the chat\u2019s agent (${s.server.calls.map(c => c.path).join(' ')})`)
  const body = JSON.stringify(call.body)
  assert.match(body, /"id":"mine1"/, 'with my own message as a reply target')
  assert.match(body, /"id":"in1"/, 'and the agent\u2019s')
  assert.match(body, /"box":"user"/, 'named as mail of the user\u2019s mailbox, as every reply from the chats is')
  // the sent reply renders its quote of my own message, and the quote finds it in this chat
  ;(world.sent as unknown[]).push(sent('mine2', 'worker', '2026-11-20T12:00:00Z', { body: 'and one more thing',
    reply_to: { id: 'mine1', kind: 'mail', from: USER, at: '2026-11-20T11:00:00Z', gist: 'my first thought' } }))
  await s.remount()
  await s.openChat('worker')
  const quote = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'mine2')?.querySelector<HTMLElement>('.reply-preview')
  assert.ok(quote, 'the reply shows what it answers')
  assert.match(quote.textContent ?? '', /my first thought/)
  assert.equal(/unavailable/i.test(quote.textContent ?? ''), false, 'and the original is not called unavailable')
})

test('alpha.1 point 20: in a project\u2019s chat the user\u2019s own message keeps "Follow up on this message"', async (t) => {
  const s = await setup(t, { audiences: [grant('crew')], sent: [sent('job1', 'crew', '2026-11-20T11:00:00Z')] },
    { active: false, tree: { ...tree(), roots: [node('lead', [projectNode('crew', [node('member')])]), node('solo')] } as unknown as TreePayload })
  await s.openChat('crew')
  const own = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'job1')
  assert.ok(own, 'POSITIVE CONTROL: the job is in the project\u2019s chat')
  assert.equal(!!own.querySelector('.dm-actions button[aria-label="Follow up on this message"]'), true)
  assert.equal(!!own.querySelector('.dm-actions button[aria-label="Reply"]'), false)
})

test('alpha.1 point 27: Escape with a file in the message box removes the file added last, one a press, and never closes the chat or the inbox', async (t) => {
  const { writeComposerDraft } = await import('../src/composerdrafts')
  const { dmDraftKey } = await import('../src/dm/DmPanel')
  const s = await setup(t, { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')] }, { active: false })
  writeComposerDraft(dmDraftKey('mine', 'worker'), { text: 'two files', attached: [
    { name: 'first.txt', path: 'uploads/first.txt', bytes: 12 }, { name: 'second.txt', path: 'uploads/second.txt', bytes: 34 }] })
  await s.openChat('worker')
  const chips = () => s.all<HTMLElement>('.dm-compose .attach-chip').map(c => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
  assert.equal(chips().length, 2, 'POSITIVE CONTROL: two files are in the box')
  const esc = async () => inAct(async () => { window.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush(6) })
  await esc()
  assert.equal(chips().length, 1, 'one press, one file')
  assert.match(chips()[0]!, /first\.txt/, 'the one added last went')
  assert.equal(s.state.closed, 0, 'the inbox is still open')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker', 'and so is the chat')
  await esc()
  assert.equal(chips().length, 0)
  assert.equal(s.state.closed, 0)
  assert.equal(s.draft(), 'two files', 'the text stays')
  // with no file left Escape is the panel's again
  await esc()
  assert.equal(s.state.closed, 1, 'POSITIVE CONTROL: without a file Escape closes the inbox, as before')
})

test('a chat\u2019s header shows the model icon once: beside the name there is no second chip', async (t) => {
  const s = await setup(t, { audiences: [grant('worker'), grant('crew')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('sys1', '@system', '2026-11-20T09:00:00Z')] },
    { active: false, tree: { ...tree(), roots: [node('lead', [node('worker'), projectNode('crew', [node('member')])]), node('solo')] } as unknown as TreePayload })
  const icons = () => document.querySelectorAll('.dm-head .tier, .dm-head .project-mark, .dm-head .dm-av-system, .dm-head .dm-av-other').length
  await s.openChat('worker')
  assert.equal(document.querySelectorAll('.dm-head .dm-av .tier').length, 1, 'POSITIVE CONTROL: the large picture is the model\u2019s chip')
  assert.equal(icons(), 1, 'an agent\u2019s header: one icon')
  assert.equal(document.querySelector('.dm-head .dm-who-name button')?.textContent, 'worker', 'the name is still the agent link')
  assert.equal(s.row('worker')!.querySelectorAll('.tier').length >= 1, true, 'the list row keeps its own')
  await s.openChat('crew')
  assert.equal(icons(), 1, 'a project\u2019s header keeps its one icon')
  const system = s.rows().find(r => r.dataset.dmChat === '@system')
  if (system) { await s.click(system, 'the System chat'); assert.equal(icons(), 1, 'the System chat keeps its icon') }
})

test('alpha.1 point 24: a bubble\u2019s menu has "Sender…" with the agent\u2019s full menu from the shared builder, right above the View in group; the user\u2019s own bubble has none', async (t) => {
  const { AgentNavProvider, useProvideAgentNav } = await import('../src/canvas/agentnav')
  const { agentLinkMenuEntries } = await import('../src/canvas/contextmenu')
  // the canonical menu, as the surface that owns the handlers registers it
  const canonical = (id: string) => [{ label: 'Focus', onSelect() {} }, { label: 'Open', onSelect() {}, children: [{ label: 'Mail', onSelect() {} }] },
    { label: 'Settings', onSelect() {} }, 'sep' as const, { label: `Retire ${id}…`, onSelect() {} }]
  const built: string[] = []
  function Provide() { useProvideAgentNav((id) => { built.push(id); return canonical(id) }); return null }
  const oldFetch = globalThis.fetch
  const server = engine({ audiences: [grant('worker')], delivered: [mail('in1', 'worker', '2026-11-20T10:00:00Z')], sent: [sent('out1', 'worker', '2026-11-20T11:00:00Z')] })
  globalThis.fetch = server.fetcher
  resetLocalReads(); resetComposerDrafts(); window.sessionStorage.clear(); window.localStorage.removeItem('orgtree-dm-open:mine'); window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  const view = await mountView(<CurrentOrg.Provider value="mine"><AgentNavProvider><Provide />
    <UserMailbox slug="mine" tree={tree()} toast={() => {}} close={() => {}} jumpTo={null} jumpSeq={null} openChat={null}
      onFocusAgent={() => {}} onOpenMail={() => {}} /></AgentNavProvider></CurrentOrg.Provider>, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush(12) })
  await inAct(async () => { [...document.querySelectorAll<HTMLElement>('.dm-row')].find(r => r.dataset.dmChat === 'worker')!.click(); await flush(8) })
  const menuOf = async (id: string) => {
    const bubble = [...document.querySelectorAll<HTMLElement>('.dm-msg')].find(m => m.dataset.dmEntry === id)!.querySelector<HTMLElement>('.dm-bubble')!
    await inAct(async () => { bubble.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(4) })
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    const top = menus[0]!
    return { bubble, labels: [...top.children].flatMap(c => c.matches('[role="separator"]') ? [] : [(c.querySelector('[role="menuitem"]') ?? c).textContent?.trim() ?? '']),
      item: (label: string) => [...top.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent?.trim().startsWith(label)) }
  }
  const esc = async () => inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(3) })
  let m = await menuOf('in1')
  const at = m.labels.findIndex(l => l.startsWith('Sender'))
  assert.equal(at >= 0, true, `the agent\u2019s bubble has Sender… (${m.labels.join(' | ')})`)
  assert.equal(m.labels[at + 1]?.startsWith('View in'), true, `the View in group follows it, USER 2026-11-25 md7da554ce837 (${m.labels.join(' | ')})`)
  assert.equal(m.labels.indexOf('Reply') < at, true, 'the bubble\u2019s own entries stay at the top level, before it')
  assert.deepEqual(built.at(-1), 'worker', 'built by the shared builder, for the bubble\u2019s author')
  // its submenu is the agent link's menu: the same labels in the same order
  const sender = m.item('Sender')!
  await inAct(async () => { sender.dispatchEvent(new W.MouseEvent('mouseover', { bubbles: true, cancelable: true })); await flush(6) })
  const branch = sender.closest('.ctxmenu-branch')!.querySelector<HTMLElement>('.ctxmenu-submenu')
  assert.ok(branch, 'the submenu opened')
  const sub = [...branch.children].flatMap(c => c.matches('[role="separator"]') ? ['-'] : c.matches('.ctxmenu-description') ? [] : [(c.querySelector('[role="menuitem"]') ?? c).textContent?.trim() ?? ''])
  const want = agentLinkMenuEntries(m.bubble, 'worker', canonical('worker')).map(e => (e === 'sep' ? '-' : e.label))
  // every menu draws its Open submenu second (contextmenu.tsx MenuEntries): the agent link's own menu does too
  want.splice(1, 0, ...want.splice(want.indexOf('Open'), 1))
  assert.deepEqual(sub.map(l => l.replace(/\s*[▸›]\s*$/, '')), want, 'the Sender submenu is the agent link\u2019s menu')
  await esc(); await esc()
  m = await menuOf('out1')
  assert.equal(m.labels.some(l => l.startsWith('Sender')), false, `the user\u2019s own bubble has no Sender entry (${m.labels.join(' | ')})`)
})

// USER 2026-11-24 m3018ae8d050f: "tab + shift-tab to scroll up and down through messages to highlight them
// and send replies with r like hubchat". Hubchat's rules (its Conversation.tsx `keys`): from the message box
// the first Shift+Tab highlights the newest message and the focus moves to the timeline; Shift+Tab goes
// older, Tab newer, Tab past the newest and Escape go back to the box, R replies. Only bubbles count.
const pressOn = async (el: Element, key: string, init: Record<string, unknown> = {}) => inAct(async () => {
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); await flush(4)
})
const hlOf = () => [...document.querySelectorAll<HTMLElement>('.dm-msg.hl')].map(m => m.dataset.dmEntry)

test('alpha.1 point 23: Shift+Tab from the message box walks the bubbles, Tab comes back, R replies to the highlighted one, Escape returns to the box', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')],
    delivered: [mail('a', 'worker', '2026-11-20T10:00:00Z'), mail('c', 'worker', '2026-11-20T12:00:00Z')],
    sent: [sent('b', 'worker', '2026-11-20T11:00:00Z')] }, { active: false })
  await s.openChat('worker')
  const box = () => document.querySelector<HTMLTextAreaElement>('.dm-compose textarea')!
  const timeline = () => document.querySelector<HTMLElement>('.dm-timeline')!
  box().focus()
  assert.deepEqual(hlOf(), [], 'POSITIVE CONTROL: nothing is highlighted')
  // a plain Tab in the box is not ours
  await pressOn(box(), 'Tab')
  assert.deepEqual(hlOf(), [])
  await pressOn(box(), 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), ['c'], 'the newest message is highlighted')
  assert.equal(document.activeElement, timeline(), 'and the focus is on the timeline, so the keys do not type into the box')
  assert.match(document.querySelector('.dm-walk-said')?.textContent ?? '', /worker: body of c/, 'a screen reader is told what the highlight is on')
  await pressOn(timeline(), 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), ['b'], 'Shift+Tab goes older')
  assert.match(document.querySelector('.dm-walk-said')?.textContent ?? '', /You: body of b/)
  await pressOn(timeline(), 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), ['a'])
  await pressOn(timeline(), 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), ['a'], 'at the oldest one, with no older mail, it stays')
  await pressOn(timeline(), 'Tab')
  assert.deepEqual(hlOf(), ['b'], 'Tab goes newer')
  // R replies to the highlighted message (my own, point 20) and returns to the box
  await pressOn(timeline(), 'r')
  assert.deepEqual(hlOf(), [], 'the highlight is gone')
  assert.equal(document.activeElement, box(), 'the focus is back in the message box')
  assert.match(document.querySelector('.dm-replybar')?.textContent ?? '', /body of b/, 'and that message is staged for a reply')
  assert.equal(s.draft(), '', 'the R was not typed')
  // Tab past the newest goes back to the box
  await pressOn(box(), 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), ['c'])
  await pressOn(timeline(), 'Tab')
  assert.deepEqual(hlOf(), [])
  assert.equal(document.activeElement, box())
  // Escape takes the highlight only: the inbox stays open (the staged reply is cleared by the next one)
  await pressOn(box(), 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), ['c'])
  await inAct(async () => { window.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush(6) })
  assert.deepEqual(hlOf(), [], 'Escape takes the highlight')
  assert.equal(document.activeElement, box())
  assert.equal(s.state.closed, 0, 'and not the inbox')
  assert.equal(s.all('.dm-replybar-row').length, 1, 'nor the staged reply')
  // a modifier chord is never ours, and an r typed in the box is text
  await pressOn(box(), 'Tab', { shiftKey: true, ctrlKey: true })
  assert.deepEqual(hlOf(), [])
  // a click in the timeline ends the walk
  await pressOn(box(), 'Tab', { shiftKey: true })
  await inAct(async () => { timeline().dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true })); await flush(3) })
  assert.deepEqual(hlOf(), [], 'a click ends it')
})

test('alpha.1 point 23: the walk steps onto older messages as they come in: first the loaded ones not drawn yet, then the chat\u2019s next page', async (t) => {
  layOut(t, { scroll: 50000, client: 600 })
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(60, 200), older: [{ delivered: many(30, 0) }] }, { active: false })
  await s.openChat('worker')
  await scrollTo(49400)
  const box = document.querySelector<HTMLTextAreaElement>('.dm-compose textarea')!
  const timeline = document.querySelector<HTMLElement>('.dm-timeline')!
  box.focus()
  await pressOn(box, 'Tab', { shiftKey: true })
  const drawn = () => s.all<HTMLElement>('.dm-msg').length
  const first = () => s.all<HTMLElement>('.dm-msg')[0]!.dataset.dmEntry
  assert.equal(drawn(), 50, 'POSITIVE CONTROL: the window of fifty')
  for (let i = 0; i < 49; i++) await pressOn(timeline, 'Tab', { shiftKey: true })
  assert.deepEqual(hlOf(), [first()], 'the highlight reached the oldest drawn message')
  const was = first()
  // one more: the older messages come in, and the highlight steps onto the one before
  for (let i = 0; i < 40 && hlOf()[0] === was; i++) {
    await pressOn(timeline, 'Tab', { shiftKey: true })
    await inAct(async () => { await flush(20) })
  }
  assert.equal(drawn() > 50, true, `older messages were drawn (${drawn()})`)
  const order = s.all<HTMLElement>('.dm-msg').map(m => m.dataset.dmEntry)
  assert.equal(order.indexOf(hlOf()[0]!), order.indexOf(was) - 1, 'the highlight is on the message just before the one it stood on')
})

test('alpha.1 point 24: in the chats a quote of the user\u2019s own message has no "Sender…" entry; a quote of an agent\u2019s message keeps it', async (t) => {
  const s = await setup(t, { audiences: [grant('worker')],
    delivered: [mail('in1', 'worker', '2026-11-20T10:00:00Z'),
      // the agent answers the user's message: its quote is of the user's own mail
      mail('in2', 'worker', '2026-11-20T12:00:00Z', { reply_to: { id: 'mine1', kind: 'mail', from: USER, at: '2026-11-20T11:00:00Z', gist: 'body of mine1' } })],
    sent: [sent('mine1', 'worker', '2026-11-20T11:00:00Z'),
      // the user answers the agent's message: its quote is of the agent's mail
      sent('mine2', 'worker', '2026-11-20T13:00:00Z', { reply_to: { id: 'in1', kind: 'mail', from: 'worker', at: '2026-11-20T10:00:00Z', gist: 'body of in1' } })] }, { active: false })
  await s.openChat('worker')
  const quoteMenu = async (id: string) => {
    const quote = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === id)?.querySelector<HTMLElement>('.reply-preview')
    assert.ok(quote, `the quote card of ${id}`)
    await inAct(async () => { quote.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(6) })
    const menus = [...document.querySelectorAll<HTMLElement>('.ctxmenu')].filter(m => !m.parentElement?.closest('.ctxmenu'))
    const labels = [...menus[menus.length - 1]!.children].flatMap(c => c.matches('[role="separator"]') ? [] : [(c.querySelector('[role="menuitem"]') ?? c).textContent?.trim() ?? ''])
    await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(3) })
    return labels
  }
  const own = await quoteMenu('in2')
  assert.equal(own.includes('Copy contents'), true, `POSITIVE CONTROL: this is the quote card\u2019s menu (${own.join(' | ')})`)
  assert.equal(own.some(l => l.startsWith('Sender')), false, 'a quote of my own message: no Sender entry')
  const theirs = await quoteMenu('mine2')
  assert.equal(theirs.some(l => l.startsWith('Sender')), true, `a quote of the agent\u2019s message keeps it (${theirs.join(' | ')})`)
})

// USER 2026-11-24 mf13638fa83f8: "can mention ordering in the mentions menu be based off of mention order of
// objects in the chat window in the chat inbox?" The chat's message box ranks what the open chat's loaded
// messages mention first, newest mention first, exactly as a desk does with its transcript; the rest follow
// in the engine's order (tickets by their latest status change, mbad08856cdb4).
test('the @ menu of a chat\u2019s message box lists what that chat mentions first, newest mention first, then the rest in the engine\u2019s order', async (t) => {
  const { resetMentionSearchForTests } = await import('../src/canvas/mentionsearch')
  resetMentionSearchForTests()
  t.after(() => resetMentionSearchForTests())
  const item = (id: string, label: string, at: string) => ({ kind: 'item', id, label, at, status: 'open' })
  const s = await setup(t, {
    audiences: [grant('worker')],
    // the chat mentions two tickets and one agent: alpha first, then beta, and the agent in the newest message
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z', { body: 'Start with @item:mine/alpha-ticket please.' }),
      mail('m3', 'worker', '2026-11-20T12:00:00Z', { body: 'Then @item:mine/beta-ticket.' })],
    sent: [sent('m2', 'worker', '2026-11-20T11:00:00Z', { body: 'ok' }), sent('m4', 'worker', '2026-11-20T13:00:00Z', { body: 'Thanks @worker, go on.' })],
    // the engine's order: three tickets by their status change, none of it knowing this chat
    candidates: [item('gamma-ticket', 'Gamma ticket', '2026-11-19T10:00:00Z'), item('alpha-ticket', 'Alpha ticket', '2026-11-12T10:00:00Z'),
      item('delta-ticket', 'Delta ticket', '2026-11-11T10:00:00Z'), item('beta-ticket', 'Beta ticket', '2026-11-10T10:00:00Z')],
  }, { active: false })
  await s.openChat('worker')
  const box = document.querySelector<HTMLTextAreaElement>('.dm-compose textarea')!
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'about @')
    box.dispatchEvent(new W.Event('input', { bubbles: true }))
    box.focus(); box.setSelectionRange(7, 7)
    box.dispatchEvent(new W.Event('select', { bubbles: true }))
    await flush(8)
  })
  for (let i = 0; i < 6; i++) await inAct(async () => { await flush(6) })
  // best first (the list is drawn bottom-up, the best next to the box)
  const ranked = [...document.querySelectorAll<HTMLElement>('.agent-mentions .agent-mention-item')].reverse()
    .map(r => r.querySelector('.agent-mention-name')?.textContent ?? '')
  const at = (name: string) => ranked.indexOf(name)
  for (const name of ['Alpha ticket', 'Beta ticket', 'Gamma ticket', 'Delta ticket', '@worker'])
    assert.equal(at(name) >= 0, true, `POSITIVE CONTROL: ${name} is offered (${ranked.join(' | ')})`)
  assert.deepEqual(ranked.slice(0, 3), ['@worker', 'Beta ticket', 'Alpha ticket'], 'what the chat mentions, newest mention first: the agent, then the two tickets')
  assert.equal(at('Gamma ticket') < at('Delta ticket'), true, 'the tickets it does not mention keep the engine\u2019s order')
  assert.equal(at('Alpha ticket') < at('Gamma ticket'), true, 'under the ones it mentions')
})

// STREAM PRIVACY IN THE CHATS (coordinator m66afe2293a15, found while preparing its capture): what the
// classic mailbox hides the chats hide too. An outside sender's name is an always-hidden field wherever
// the panel writes it, and the two places that show a message's words outside a bubble are free-form
// zones, so an address or a key in them is matched.
test('stream privacy: an outside sender\u2019s name is a hidden field in the chats, and the row\u2019s preview and the reply bar are matched for private text', async (t) => {
  const OUT = '@net:casey.4f2a9c'
  const s = await setup(t, {
    // an outside sender is listed while something of theirs waits
    pending: [mail('n1', OUT, '2026-11-20T10:00:00Z', { body: 'write to casey@example.org please' })],
    delivered: [mail('m1', 'worker', '2026-11-20T09:00:00Z')],
    audiences: [grant('worker')],
  }, { active: false })
  const field = (el: Element | null | undefined) => el?.getAttribute('data-streamer-field') ?? null
  const row = document.querySelector(`[data-dm-chat="${OUT}"]`)!
  assert.ok(row, 'POSITIVE CONTROL: the outside sender has a chat row')
  assert.equal(field(row.querySelector('.dm-row-name')), 'external', 'its name in the list')
  assert.equal(field(row.querySelector('.dm-av')), 'external', 'and the letter picture made from it')
  assert.equal(row.querySelector('.dm-row-text')?.matches(STREAMER_ZONES.freeform), true, 'the preview of its last message is matched')
  // an agent of this organization is never hidden: names are the app's own
  const mine = document.querySelector('[data-dm-chat="worker"]')!
  assert.equal(field(mine.querySelector('.dm-row-name')), null, 'an agent\u2019s name stays')
  assert.equal(field(mine.querySelector('.dm-av')), null)
  await s.openChat(OUT)
  const head = document.querySelector('.dm-head')!
  assert.equal(head.getAttribute('data-dm-peer'), OUT)
  assert.equal(field(head.querySelector('[data-hub-address]')), 'external', 'POSITIVE CONTROL: the header\u2019s chip was a hidden field already')
  assert.equal(field(head.querySelector('.dm-av')), 'external', 'the header\u2019s picture')
  // a bubble is matched whole: its quote card names who is quoted and repeats their words, and neither is in the message's own text
  const bubble = document.querySelector('[data-dm-entry="n1"] .dm-bubble')!
  assert.equal(bubble.matches(STREAMER_ZONES.freeform), true, 'the bubble, with its quote card')
  assert.equal(bubble.querySelector('.dm-meta')?.matches(STREAMER_ZONES.structured), true, 'its time row is structure, not text to match')
  assert.equal(document.querySelector('.dm-nowrite')?.matches(STREAMER_ZONES.freeform), true, 'the line that says the sender cannot be written to names it')
  const bar = document.createElement('span'); bar.className = 'dm-replybar-text'
  assert.equal(bar.matches(STREAMER_ZONES.freeform), true, 'the staged reply\u2019s excerpt is matched')
})

// ---- a project chat's message box has the project desk's megaphone (USER 2026-11-25 m12fea20d9690:
// "project messageboxes need the megaphone toggle like on their desk") ----

const megaphone = () => document.querySelector<HTMLButtonElement>('.dm-compose .cc-broadcast-toggle')
const altB = async () => {
  const ta = document.querySelector('.dm-compose textarea') as HTMLTextAreaElement
  await inAct(async () => { ta.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'b', altKey: true, bubbles: true, cancelable: true })); await flush(4) })
}

test('a project chat\'s message box has the desk\'s megaphone, worded as on the desk; an agent\'s chat has none', async (t) => {
  const world = crewWorld()
  world.audiences = [grant('crew'), grant('lead')]
  const s = await setup(t, world, { tree: crewTree(), active: false })
  await s.openChat('lead')
  assert.equal(megaphone(), null, 'an agent\'s chat has no megaphone')
  await s.openChat('crew')
  const b = megaphone()
  assert.ok(b, 'the project chat\'s box has the megaphone button')
  assert.equal(b.disabled, false)
  assert.equal(b.getAttribute('aria-pressed'), 'false')
  assert.equal(b.getAttribute('aria-label'), 'Megaphone: send to all 2 agents under crew instead of the project\'s inbox')
  assert.equal(b.getAttribute('title'),
    'send to all 2 agents under crew at once, through sub-projects but not below agent recipients, instead of the project\'s inbox that one agent claims (Alt+B)')
  await s.click(b, 'the megaphone')
  assert.equal(megaphone()!.getAttribute('aria-pressed'), 'true')
  assert.equal(megaphone()!.classList.contains('armed'), true)
  assert.equal(megaphone()!.getAttribute('aria-label'), 'Megaphone on: messages go to all 2 agents under crew')
  assert.equal(megaphone()!.getAttribute('title'),
    'on: each message goes to all 2 agents under crew; click or press Alt+B to send to the project\'s inbox again')
  await altB()
  assert.equal(megaphone()!.getAttribute('aria-pressed'), 'false', 'Alt+B in the box turns it off')
  await altB()
  assert.equal(megaphone()!.getAttribute('aria-pressed'), 'true', 'and on')
})

test('an armed megaphone sends a project chat\'s message to every agent under the project, by the desk\'s route, and then is off', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  await s.click(megaphone(), 'the megaphone')
  await s.type('All hands: stop.')
  await s.send()
  const casts = posts(s.server.calls, /\/broadcast$/)
  assert.deepEqual(casts.map(c => c.path.replace(/^.*\/orgs\/mine/, '')), ['/nodes/crew/broadcast'])
  assert.deepEqual(casts[0]!.body, { text: 'All hands: stop.' })
  assert.equal(posts(s.server.calls, /\/message$/).length, 0, 'nothing goes to the project\'s inbox')
  assert.deepEqual(s.state.toasts, ['sent to 2 of 2 agents under crew'], 'the desk\'s own line')
  assert.equal(megaphone()!.getAttribute('aria-pressed'), 'false', 'one send, then it is off, as the desk\'s is')
  // unarmed: the project's inbox, as before
  await s.type('For the queue.')
  await s.send()
  assert.equal(posts(s.server.calls, /\/broadcast$/).length, 1)
  assert.deepEqual(posts(s.server.calls, /\/message$/).map(c => c.path.replace(/^.*\/orgs\/mine/, '')), ['/nodes/crew/message'])
})

test('the megaphone is disabled when no agent works under the project', async (t) => {
  const lone = tree({ roots: [node('lead'), projectNode('crew', [node('gone', [], { state: 'retired' })])] })
  const s = await setup(t, { audiences: [grant('crew')], sent: [sent('j1', 'crew', '2026-11-20T10:00:00Z')] }, { tree: lone, active: false })
  await s.openChat('crew')
  assert.ok(megaphone(), 'the button is there')
  assert.equal(megaphone()!.disabled, true)
  assert.equal(megaphone()!.getAttribute('title'), 'no agent works under crew yet')
  await altB()
  assert.equal(megaphone()!.getAttribute('aria-pressed'), 'false', 'Alt+B does not arm it')
})

// USER 2026-11-25 13:02:57Z mccd2710e1a87: "the megaphone should be on the right side of the chatbox, like
// it is in the project desk". The desk's composer has notice and attach on the left, and on the right
// one column of the urgent option, the megaphone and send (projectdesk.tsx ProjectComposer).
test('the megaphone sits on the right of the box, over send, as on the project desk; notice and attach stay on the left', async (t) => {
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  const box = document.querySelector('.dm-compose .cc-composer')!
  const b = megaphone()!
  const ta = box.querySelector('textarea')!
  const send = box.querySelector<HTMLButtonElement>('.cc-send')!
  assert.ok(b && ta && send, 'POSITIVE CONTROL: the box has its megaphone, text field and send')
  assert.deepEqual([...box.querySelectorAll<HTMLElement>(':scope > .cc-btnstack > button')].map(x => x.className.split(' ')[0]),
    ['cc-notice-toggle', 'cc-attach'], 'the left column is notice over attach, as on the desk')
  assert.equal(b.closest('.cc-btnstack'), null, 'the megaphone is not in the left column')
  assert.ok(ta.compareDocumentPosition(b) & W.Node.DOCUMENT_POSITION_FOLLOWING, 'the megaphone comes after the text field: the right side')
  assert.ok(b.closest('.cc-controls'), "it is with the box's right-hand controls")
  assert.ok(b.compareDocumentPosition(send) & W.Node.DOCUMENT_POSITION_FOLLOWING, 'send comes after it: the megaphone is over send')
  assert.notEqual(b.parentElement, send.parentElement, "its own row, above send's, not beside send")
  await s.click(b, 'the megaphone')
  assert.equal(megaphone()!.closest('.cc-controls') !== null && megaphone()!.getAttribute('aria-pressed'), 'true', 'armed, it stays where it was')
})

test('a project chat says its inbox may not be read, as the desk does, until a listener is there or the megaphone is on', async (t) => {
  const hint = () => document.querySelector('.dm-compose .inbox-no-listeners')
  const s = await setup(t, crewWorld(), { tree: crewTree(), active: false })
  await s.openChat('crew')
  assert.match(hint()?.textContent ?? '', /^Messages sent here may not be read by anyone\. Turn on broadcast \(megaphone\)/)
  await s.click(megaphone(), 'the megaphone')
  assert.equal(hint(), null, 'the megaphone reaches every agent: no hint')
  await s.click(megaphone(), 'the megaphone')
  assert.ok(hint(), 'off again: the hint is back')
  const listened = { ...crewTree(), watchdogs: [{ id: 'q1', owner: 'member', name: 'q1', kind: 'fair_queue', target: 'crew', interval_s: 5, state: 'armed' }] } as unknown as TreePayload
  await inAct(async () => { s.rerender({ tree: listened }); await flush(8) })
  assert.equal(hint(), null, 'an agent listens on the inbox: no hint')
})

// ---- the chat stays at its newest message (USER 2026-11-25 m9165e9874f48: "when i send a message it
// doesnt stick to the bottom (i want a jump to bottom button like in hubchat thats visible while not
// stuck)"; m694bf862b15a: "it doesnt seem stuck to the bottom at all, any new message i receive i have to
// scroll for"; m279ace747448: "use the same sticky logic that hubchat uses, it just works there").
// Hubchat's Conversation.tsx: pinned within 80 px of the end, a ResizeObserver on the timeline and its
// content for what grows late. The button shows whenever the chat is not stuck, from 80 px (@coordinator-opus
// 2026-11-25 m66f9dc335c98, after the user's "visible while not stuck"; Hubchat itself waits for 300 px). ----

const timeline = () => document.querySelector('.dm-timeline') as HTMLElement
const jumpButton = () => document.querySelector<HTMLButtonElement>('.dm-conv .dm-jump')
/** the mailbox is read again every five seconds: what arrived meanwhile is in */
const nextRead = async () => { await inAct(async () => { await new Promise(r => setTimeout(r, 5300)); await flush(30) }) }

test('MEASURED CAUSE: a chat of more than fifty messages stays at its newest message when one arrives', async (t) => {
  const height = layOut(t)
  const world: World = { audiences: [grant('worker')], delivered: many(60) }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  assert.equal(s.all('.dm-msg').length, 50, 'POSITIVE CONTROL: the newest fifty are drawn, of sixty')
  assert.equal(timeline().scrollTop, 5000, 'POSITIVE CONTROL: the chat opened at its newest message')
  // a message arrives: the timeline is one row taller, and still fifty rows are drawn
  height.scroll = 5100
  world.delivered = [...world.delivered!, mail('fresh', 'worker', '2026-11-21T09:00:00Z')]
  await nextRead()
  assert.equal(s.all<HTMLElement>('.dm-msg').some(m => m.dataset.dmEntry === 'fresh'), true, 'POSITIVE CONTROL: the new message is drawn')
  assert.equal(s.all('.dm-msg').length, 50, 'POSITIVE CONTROL: the drawn window is still fifty rows (why a count of rows cannot tell)')
  assert.equal(timeline().scrollTop, 5100, 'the view is at the new message')
  assert.equal(jumpButton(), null, 'at the newest message there is no jump button')
})

test('POSITIVE CONTROL: a short chat stays at its newest message when one is sent', async (t) => {
  const height = layOut(t)
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(6), keepSent: '2026-11-21T09:00:00Z' }, { active: false })
  await s.openChat('worker')
  assert.equal(timeline().scrollTop, 5000)
  height.scroll = 5100
  await s.type('A short one.')
  await s.send()
  await inAct(async () => { await flush(30) })
  assert.equal(s.all('.dm-msg').length, 7, 'the sent message is in')
  assert.equal(timeline().scrollTop, 5100)
})

test('sending goes to the newest message from anywhere in a long chat, and stays there as the sent message comes in', async (t) => {
  const height = layOut(t)
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(60), keepSent: '2026-11-21T09:00:00Z' }, { active: false })
  await s.openChat('worker')
  await scrollTo(2000)
  assert.equal(timeline().scrollTop, 2000, 'POSITIVE CONTROL: the reader is far up')
  await s.type('Read this.')
  height.scroll = 5100
  await s.send()
  await inAct(async () => { await flush(30) })
  assert.equal(s.all<HTMLElement>('.dm-msg').some(m => /^m-new-/.test(m.dataset.dmEntry ?? '')), true, 'POSITIVE CONTROL: the sent message is drawn')
  assert.equal(timeline().scrollTop, 5100, 'the view is at the sent message')
  assert.equal(jumpButton(), null)
})

test('Hubchat\'s jump button: there whenever the chat is not stuck (80 px up), and it goes down and sticks again', async (t) => {
  const height = layOut(t)
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(60) }, { active: false })
  await s.openChat('worker')
  assert.equal(jumpButton(), null, 'at the newest message: none')
  await scrollTo(4950)   // 50 px above the end: still stuck
  assert.equal(jumpButton(), null, 'within 80 px (stuck): none')
  await scrollTo(4150)   // 250 px above the end: not stuck
  assert.ok(jumpButton(), 'not stuck, even if less than 300 px up: the button')
  await scrollTo(4000)   // 400 px above the end
  const b = jumpButton()
  assert.ok(b, 'far above the newest message: the button')
  assert.equal(b.getAttribute('aria-label'), 'Jump to the newest message')
  assert.equal(b.getAttribute('title'), 'Jump to the newest message')
  // the reader is not at the end: what grows below does not move the view
  height.scroll = 5300
  await inAct(async () => { fireResize(timeline()); fireResize(timeline().firstElementChild as HTMLElement); await flush(8) })
  assert.equal(timeline().scrollTop, 4000, 'a reader who scrolled up stays where they are')
  await s.click(jumpButton(), 'the jump button')
  assert.equal(timeline().scrollTop, 5300, 'it goes to the newest message')
  assert.equal(jumpButton(), null, 'and is gone there')
  // stuck again: a picture that loads late, or the typing row, makes the content taller
  height.scroll = 5450
  await inAct(async () => { fireResize(timeline().firstElementChild as HTMLElement); await flush(8) })
  assert.equal(timeline().scrollTop, 5450, 'content that grows late keeps the view at the end')
  // the look is Hubchat's: a round 40 px button at the lower right of the timeline
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  assert.match(css, /\.dm-conv \.dm-jump \{ position: absolute; right: 22px; bottom: 16px; width: 40px; height: 40px; border-radius: 50%; border: 1px solid var\(--line\); background: var\(--panel\); color: var\(--ink\);/)
})

test('Hubchat\'s jump button stays round in a settings-sized window: its rule outweighs `.settings button`', async () => {
  // the chats panel is a `.settings` window, whose button rule (styles.css, weight 0-1-1) set the button's corners
  // to 6px, its padding to 7px 15px and its glyph to 14px (measured by the 4.7.0 integrator, 2026-11-25)
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const styles = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(styles, /\.settings button:where\([^)]*\)\)? \{ font-size: 14px; padding: 7px 15px; border-radius: 6px; \}/, 'POSITIVE CONTROL: the settings rule it must outweigh')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  const at = css.search(/(^|\n)\.dm-conv \.dm-jump \{/)
  assert.ok(at >= 0, 'the button\'s rule is `.dm-conv .dm-jump` (weight 0-2-0)')
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  for (const d of ['border-radius: 50%', 'padding: 0', 'font-size: 20px', 'width: 40px', 'height: 40px']) assert.ok(body.includes(d + ';'), `it sets ${d}`)
  assert.doesNotMatch(css, /(^|\n)\.dm-jump[ :{]/, 'no weaker `.dm-jump` rule is left')
})

// ---- AN ARRIVING MESSAGE NEVER CLOSES AN OPEN CONTEXT MENU (USER 2026-11-25 m1f747c2836f9: "make sure new
// messages in either hubchat or the new inbox dont close any context menu"). Measured cause: a chat at its newest
// message scrolls to the new one, and the menu closes on a scroll that moves its anchor (canvas/contextmenu.tsx
// `scrolled`). The browser sends that scroll when scrollTop changes; jsdom does not, so these tests do. ----

/** as a browser: setting an element's scrollTop to a new value sends it a scroll event */
function browserScrolls(t: TestContext) {
  const own = Object.getOwnPropertyDescriptor(W.Element.prototype, 'scrollTop')!
  Object.defineProperty(W.Element.prototype, 'scrollTop', { configurable: true,
    get() { return own.get!.call(this) },
    set(v: number) {
      const was = own.get!.call(this)
      own.set!.call(this, v)
      if (own.get!.call(this) !== was) this.dispatchEvent(new W.Event('scroll'))
    } })
  t.after(() => { Object.defineProperty(W.Element.prototype, 'scrollTop', own) })
}
const openMenus = () => document.querySelectorAll('[role="menu"]').length
const rightClick = async (el: Element | null | undefined, what: string) => {
  assert.ok(el, what)
  await inAct(async () => { el.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(4) })
}
const bubbleOf = (entry: string) => [...document.querySelectorAll<HTMLElement>('.dm-msg')].find(m => m.dataset.dmEntry === entry)?.querySelector('.dm-bubble')
const escape = async () => inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(6) })

test('POSITIVE CONTROL: the reader\u2019s own scroll of the chat still closes a bubble\u2019s menu', async (t) => {
  layOut(t); browserScrolls(t)
  const s = await setup(t, { audiences: [grant('worker')], delivered: many(6) }, { active: false })
  await s.openChat('worker')
  await rightClick(bubbleOf('h0003'), 'a bubble')
  assert.equal(openMenus(), 1, 'the menu is open')
  await inAct(async () => { timeline().scrollTop = 4000; await flush(6) })
  assert.equal(openMenus(), 0, 'a scroll that moves its message closes it')
})

test('an arriving message keeps a bubble\u2019s menu open; the chat goes to the new message when the menu closes', async (t) => {
  const height = layOut(t); browserScrolls(t)
  const world: World = { audiences: [grant('worker')], delivered: many(6) }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  assert.equal(timeline().scrollTop, 5000, 'POSITIVE CONTROL: at the newest message')
  await rightClick(bubbleOf('h0003'), 'a bubble')
  assert.equal(openMenus(), 1, 'POSITIVE CONTROL: the menu is open')
  height.scroll = 5100
  world.delivered = [...world.delivered!, mail('fresh', 'worker', '2026-11-21T09:00:00Z')]
  await nextRead()
  assert.ok(bubbleOf('fresh'), 'POSITIVE CONTROL: the new message is drawn')
  assert.equal(openMenus(), 1, 'the menu is still open')
  assert.equal(timeline().scrollTop, 5000, 'and its message did not move under it')
  await escape()
  assert.equal(openMenus(), 0, 'Escape closes it')
  assert.equal(timeline().scrollTop, 5100, 'and the chat goes to the new message')
})

test('the typing dots and a read check arriving keep a bubble\u2019s menu open', async (t) => {
  const height = layOut(t); browserScrolls(t)
  const writes = (on: boolean) => ({ ...tree(), roots: [node('lead', [node('worker', [], { writing_to_user: on }), node('helper')]), node('solo')] }) as unknown as TreePayload
  const world: World = { audiences: [grant('worker')], delivered: many(6), sent: [sent('mine', 'worker', '2026-11-21T08:00:00Z', { delivered: false })] }
  const s = await setup(t, world, { active: false, tree: writes(false) })
  await s.openChat('worker')
  await rightClick(bubbleOf('h0002'), 'a bubble')
  assert.equal(openMenus(), 1, 'POSITIVE CONTROL: the menu is open')
  height.scroll = 5050
  await inAct(async () => { s.rerender({ tree: writes(true) }); await flush(8) })
  assert.ok(document.querySelector('.dm-timeline .dm-typing-row'), 'POSITIVE CONTROL: the dots are drawn')
  assert.equal(openMenus(), 1, 'the dots keep the menu open')
  ;(world.sent as Record<string, unknown>[])[0]!.delivered = true
  await nextRead()
  assert.ok(document.querySelector('.dm-tick.t-read'), 'POSITIVE CONTROL: the check turned green')
  assert.equal(openMenus(), 1, 'the read check keeps the menu open')
})

test('a message arriving in another chat keeps a chat row\u2019s menu open, though the list re-sorts', async (t) => {
  const world: World = { audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('m2', 'lead', '2026-11-20T11:00:00Z')] }
  const s = await setup(t, world, { active: false })
  await s.openChat('lead')
  const before = s.rows().map(r => r.dataset.dmChat)
  await rightClick(s.row('worker'), 'worker\u2019s row')
  assert.equal(openMenus(), 1, 'POSITIVE CONTROL: the row\u2019s menu is open')
  world.delivered = [...world.delivered!, mail('m3', 'worker', '2026-11-21T09:00:00Z')]
  await nextRead()
  assert.notDeepEqual(s.rows().map(r => r.dataset.dmChat), before, 'POSITIVE CONTROL: worker\u2019s row moved up')
  assert.equal(openMenus(), 1, 'the row\u2019s menu is still open')
})

test('MEASURED CAUSE (real browser): in a long chat an arriving message slides the drawn window and drops its oldest row, and the browser\u2019s scroll anchoring then scrolls under the menu; while a menu is open the window keeps its first row', async (t) => {
  const height = layOut(t); browserScrolls(t)
  const world: World = { audiences: [grant('worker')], delivered: many(60) }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  const first = () => s.all<HTMLElement>('.dm-msg')[0]?.dataset.dmEntry
  assert.equal(s.all('.dm-msg').length, 50, 'POSITIVE CONTROL: fifty of sixty drawn')
  const was = first()
  await rightClick(bubbleOf('h0058'), 'a bubble')
  assert.equal(openMenus(), 1, 'POSITIVE CONTROL: the menu is open')
  height.scroll = 5100
  world.delivered = [...world.delivered!, mail('fresh', 'worker', '2026-11-21T09:00:00Z')]
  await nextRead()
  assert.ok(bubbleOf('fresh'), 'POSITIVE CONTROL: the new message is drawn')
  assert.equal(first(), was, 'the oldest drawn row stays: nothing above the menu\u2019s message changes')
  assert.equal(s.all('.dm-msg').length, 51)
  await escape()
  assert.equal(timeline().scrollTop, 5100, 'closing the menu goes to the newest message')
})

test('MEASURED CAUSE (real browser): the mailbox\u2019s regular read does not show "loading older messages\u2026" at the top of an open chat (its row made the browser scroll under an open menu)', async (t) => {
  layOut(t)
  const world: World = { audiences: [grant('worker')], delivered: many(60) }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  const seen: string[] = []
  const watch = new W.MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if ((n as Element).classList?.contains('dm-older')) seen.push((n as Element).textContent ?? '') })
  watch.observe(timeline(), { childList: true, subtree: true })
  t.after(() => watch.disconnect())
  world.delivered = [...world.delivered!, mail('fresh', 'worker', '2026-11-21T09:00:00Z')]
  await nextRead()
  assert.ok(bubbleOf('fresh'), 'POSITIVE CONTROL: the read brought the new message')
  assert.deepEqual(seen, [], 'no "loading older" row for a read of the newest mail')
})

// USER 2026-11-25 15:29:12Z md5374b20b620: "clicking off of the new chat agents list should collapse it as well as
// clicking the x button" (docket chats-panel-the-new-chat-agent-list-closes-on-an). Same rule as the canvas Agents
// List tray (OrgCanvas closeOnOutsidePointer): a press inside, or in the list's own menu, keeps it; a press
// elsewhere closes it and still acts on what it landed on.
test('New chat closes on a press outside it, which still acts; presses inside it and in its row menu and submenu keep it open', async (t) => {
  const picked: string[] = []
  function Menus() {
    useProvideAgentNav(id => [{ label: 'Focus', onSelect: () => { picked.push(id) } },
      { label: 'More', submenuOnly: true, onSelect: () => {}, children: [{ label: 'Deeper', onSelect: () => { picked.push('deeper:' + id) } }] }])
    return null
  }
  const s = await setup(t, { audiences: [] }, { wrap: panel => <AgentNavProvider><Menus />{panel}</AgentNavProvider> })
  const open = () => document.querySelector('.dm-newchat')
  const press = async (el: Element | null | undefined, what: string) => {
    assert.ok(el, what + ' is on screen')
    await inAct(async () => { el!.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); await flush(4) })
  }
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  assert.ok(open(), 'POSITIVE CONTROL: the list is open')
  await press(document.querySelector('.dm-newchat input.tray-filter'), 'the filter')
  await press(document.querySelector('.dm-newchat .dm-newchat-title'), 'the title')
  await press(s.all<HTMLElement>('.dm-newchat .tray-row')[0], 'a row')
  assert.ok(open(), 'presses inside keep it open')
  const row = s.all<HTMLElement>('.dm-newchat .tray-row').find(r => r.dataset.dmPick === 'helper')
  await inAct(async () => { row!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); await flush(6) })
  const menu = [...document.querySelectorAll('.ctxmenu')].filter(m => !m.parentElement?.closest('.ctxmenu')).pop()
  assert.ok(menu, 'POSITIVE CONTROL: the row menu opened')
  const item = (label: string) => [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')].find(b => b.textContent?.trim().startsWith(label))
  await press(item('More'), 'More')
  await s.click(item('More'), 'More')
  const deeper = item('Deeper')
  assert.ok(deeper?.closest('.ctxmenu-submenu'), 'POSITIVE CONTROL: the submenu opened')
  await press(deeper, 'the submenu entry')
  assert.ok(open(), 'presses in its menu and submenu keep it open')
  await s.click(deeper, 'Deeper')
  assert.deepEqual(picked, ['deeper:helper'], 'the submenu entry acted')
  assert.ok(open(), 'and the list is still open')
  // outside: a chat row of the panel. The press closes the list, and the click opens that chat.
  const chat = s.rows()[0]
  assert.ok(chat, 'a chat row is on screen')
  await press(chat, 'a chat row')
  assert.equal(open(), null, 'a press outside closes the list')
  await s.click(chat, 'the chat row')
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), chat.dataset.dmChat, 'and the click still opened that chat')
  // outside the panel altogether
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  assert.ok(open())
  await press(document.body, 'the page')
  assert.equal(open(), null, 'a press anywhere else closes it too')
})

// "LOADING OLDER MESSAGES…" NEVER FLICKERS (4.7.0-alpha.5, USER 2026-11-25 mc186df41cb3c "on chats with few or
// no messages i see a flickering "loading older messages..." pop up for a frame every few seconds at the top,
// offsetting the chat", m8e421f3791ee "also i see something similar for a frame when i send messages here above
// my sent message"; @ticket:orgtree/mailbox-dm-panel-loading-older-messages-flickers). Measured causes:
// (1) a chat that does not fill its view reads older pages by itself (every slowPageMs), and each read drew the
// row; (2) a regular read that replaced an older page on its way left the chat "asking" for good, so every later
// regular read (each new mail, each send) drew the row for its duration.
const olderRows = () => {
  const seen: string[] = []
  const watch = new W.MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) {
    const el = n as Element
    if (el.classList?.contains('dm-older') || el.querySelector?.('.dm-older')) seen.push(el.textContent ?? '')
  } })
  watch.observe(document.querySelector('.mailer-read')!, { childList: true, subtree: true })
  return { seen, stop: () => watch.disconnect() }
}

test('the row never shows in a chat that does not fill its view, while it reads older pages by itself', async (t) => {
  const { dmTiming } = await import('../src/dm/DmPanel')
  const was = dmTiming.slowPageMs
  dmTiming.slowPageMs = 5
  t.after(() => { dmTiming.slowPageMs = was })
  // an engine with no chat folder (as a project's chat): five pages of lead's mail, then worker's older message
  const others = Array.from({ length: 5 }, (_, i) => ({ delivered: [mail(`x${i}`, 'lead', `2026-10-${String(20 - i).padStart(2, '0')}T10:00:00Z`)] }))
  const s = await setup(t, {
    audiences: [grant('worker')], delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')], noChatFolder: true,
    older: [...others, { delivered: [mail('m0', 'worker', '2026-10-01T10:00:00Z')] }],
  }, { active: false })
  const rows = olderRows()
  t.after(rows.stop)
  await s.openChat('worker')
  for (let i = 0; i < 200 && !s.all<HTMLElement>('.dm-msg').some(m => m.dataset.dmEntry === 'm0'); i++) {
    await inAct(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await flush(6) })
  }
  assert.equal(s.server.pages.includes('inbox:6'), true, `POSITIVE CONTROL: the pages were read (${s.server.pages.join(' ')})`)
  assert.deepEqual(rows.seen, [], 'no "loading older messages" row: the view has nothing to scroll')
})

test('a regular read that replaces an older page on its way does not leave the row coming back: not at the next mail, not at a send', { timeout: 40000 }, async (t) => {
  layOut(t)
  let release: () => void = () => {}
  const world: World = { audiences: [grant('worker')], delivered: many(6, 100), older: [{ delivered: many(60, 0) }], keepSent: '2026-11-21T08:00:00Z',
    holdPages: new Promise<void>(resolve => { release = resolve }) }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  await scrollTo(4400)
  await scrollTo(150)
  assert.deepEqual(s.server.pages, ['chat:50'], 'POSITIVE CONTROL: the reader at the top asked for the next page, which is on its way')
  assert.ok(document.querySelector('.dm-older'), 'POSITIVE CONTROL: a real older page on its way says so')
  // a new mail: the chat's regular read replaces the page on its way, whose answer is then dropped
  world.delivered = [...world.delivered!, mail('fresh1', 'worker', '2026-11-21T09:00:00Z')]
  await nextRead()
  release()
  await inAct(async () => { await flush(30) })
  assert.equal(document.querySelector('.dm-older'), null, 'nothing on its way now')
  const rows = olderRows()
  t.after(rows.stop)
  world.delivered = [...world.delivered!, mail('fresh2', 'worker', '2026-11-21T09:30:00Z')]
  await nextRead()
  assert.ok(s.all<HTMLElement>('.dm-msg').some(m => m.dataset.dmEntry === 'fresh2'), 'POSITIVE CONTROL: the regular read brought the next mail')
  await s.type('one more thing')
  await s.send()
  await inAct(async () => { await flush(30) })
  await nextRead()
  assert.ok(s.server.calls.some(c => /\/nodes\/worker\/message$/.test(c.path)), 'POSITIVE CONTROL: the message was sent')
  assert.deepEqual(rows.seen, [], 'no "loading older messages" row for a read of the newest mail or a send')
})

// "VIEW IN CLASSIC INBOX" (USER 2026-11-25 ma79665bf7f2e "new context menu entry for messages; "view in classic
// inbox": switches the view to the classic mailbox, and then selects the message clicked in the list and jumps to
// it"; @ticket:orgtree/mailbox-dm-panel-view-in-classic-inbox-message-m). The same switch as the title bar's, then
// the classic mailbox's own reference jump (its folder, a cleared tag filter, a lookup, the not-found notice).
test('a message’s menu has "View in classic inbox": the classic mailbox opens on its folder with that message selected; a message still sending has none', async (t) => {
  const world: World = {
    audiences: [grant('worker')],
    delivered: [mail('in1', 'worker', '2026-11-20T10:00:00Z'), mail('in2', 'worker', '2026-11-20T12:00:00Z')],
    sent: [sent('out1', 'worker', '2026-11-20T11:00:00Z', { delivered: true })],
  }
  const s = await setup(t, world, { active: false })
  await s.openChat('worker')
  const menuOf = async (id: string) => {
    const bubble = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === id)?.querySelector<HTMLElement>('.dm-bubble')
    assert.ok(bubble, `the bubble of ${id}`)
    await inAct(async () => { bubble.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(4) })
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    const items = menus.length ? [...menus[menus.length - 1]!.querySelectorAll<HTMLElement>('[role="menuitem"]')] : []
    return { labels: items.map(i => i.textContent?.trim() ?? ''), item: (label: string) => items.find(i => i.textContent?.trim() === label) }
  }
  const classicShows = () => ({
    chats: document.querySelector('.dm-panel') !== null,
    folder: document.querySelector('.mail-folders button.on')?.textContent?.trim().toLowerCase().replace(/\s*\d+$/, '') ?? null,
    selected: document.querySelector('.mailrow.on')?.textContent ?? null,
  })
  // a received message
  let menu = await menuOf('in1')
  assert.ok(menu.labels.includes('View in classic inbox'), `the agent’s message has it (${menu.labels.join(' | ')})`)
  await s.click(menu.item('View in classic inbox'), 'View in classic inbox')
  await inAct(async () => { await flush(20) })
  let now = classicShows()
  assert.equal(now.chats, false, 'the chats gave way to the classic mailbox')
  assert.equal(window.localStorage.getItem(CLASSIC_MAILBOX_KEY), '1', 'by the same switch as the title bar’s')
  assert.match(now.folder ?? '', /^inbox/, `on the Inbox folder (${now.folder})`)
  assert.match(now.selected ?? '', /body of in1/, 'with that message selected')
  assert.doesNotMatch(now.selected ?? '', /body of in2/, 'POSITIVE CONTROL: not the newest one')
  // back to the chats, and the user's own message
  await inAct(async () => { setClassicMailbox(false); await flush(12) })
  await s.openChat('worker')
  menu = await menuOf('out1')
  assert.ok(menu.labels.includes('View in classic inbox'), 'the user’s own message has it too')
  await s.click(menu.item('View in classic inbox'), 'View in classic inbox')
  await inAct(async () => { await flush(20) })
  now = classicShows()
  assert.equal(now.chats, false)
  assert.match(now.folder ?? '', /^sent/, `on the Sent folder (${now.folder})`)
  assert.match(now.selected ?? '', /body of out1/, 'with that message selected')
  // a message the engine has not taken: its menu is Retry and Discard only
  await inAct(async () => { setClassicMailbox(false); await flush(12) })
  await s.openChat('worker')
  world.refuse = true
  await s.type('this one will not go')
  await s.send()
  await inAct(async () => { await flush(20) })
  const local = document.querySelector<HTMLElement>('.dm-msg.local .dm-bubble')
  assert.ok(local, 'POSITIVE CONTROL: the refused message is on screen')
  await inAct(async () => { local!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(4) })
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
  const labels = menus.length ? [...menus[menus.length - 1]!.querySelectorAll('[role="menuitem"]')].map(i => i.textContent?.trim()) : []
  assert.ok(labels.includes('Retry'), `POSITIVE CONTROL: its menu (${labels.join(' | ')})`)
  assert.equal(labels.includes('View in classic inbox'), false, 'no entry: it has no mail yet')
})

test('the user’s own unread message has the desk’s ×: it takes the mail back through the desk’s own call, and the bubble goes', async (t) => {
  setClassicMailbox(false)
  // USER 2026-11-25 m88681ac17bfd "have an x for unread mail like in the desk which takes it back, but thats it":
  // the desk's rule (PendingMailRow): undelivered and not being handed to a turn; read, on its way into a
  // turn, already taken back, or from an engine that does not say: no ×
  const world: World = { sent: [
    sent('u1', 'solo', '2026-11-20T10:00:00Z', { delivered: false }),
    sent('u2', 'solo', '2026-11-20T10:01:00Z', { delivered: true }),
    sent('u3', 'solo', '2026-11-20T10:02:00Z', { delivered: false, delivering: true }),
    sent('u4', 'solo', '2026-11-20T10:03:00Z'),
    sent('u5', 'solo', '2026-11-20T10:04:00Z', { retracted: true }),
    sent('u6', 'solo', '2026-11-20T10:05:00Z', { delivered: false }),
  ] }
  const s = await setup(t, world)
  await s.openChat('solo')
  const bubble = (id: string) => document.querySelector<HTMLElement>(`.dm-msg[data-dm-entry="${id}"]`)
  const x = (id: string) => bubble(id)?.querySelector<HTMLButtonElement>('button.dm-retract') ?? null
  assert.ok(bubble('u2'), 'POSITIVE CONTROL: the chat is open on its messages')
  assert.equal(bubble('u5'), null, 'a mail already taken back is not in the chat, as it is not on the desk')
  assert.deepEqual(['u1', 'u2', 'u3', 'u4', 'u6'].filter(id => x(id)), ['u1', 'u6'], 'only the unread ones not yet on their way have it')
  assert.equal(x('u1')!.title, 'retract (undelivered)', 'the desk’s tooltip')
  // the bubble's menu has it too, as the classic mailbox's menu does
  const menuOf = async (id: string) => {
    await inAct(async () => { bubble(id)!.querySelector('.dm-bubble')!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); await flush(6) })
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    const labels = menus.length ? [...menus[menus.length - 1]!.querySelectorAll('[role="menuitem"]')].map(i => i.textContent?.trim()) : []
    await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(4) })
    return labels
  }
  assert.ok((await menuOf('u1')).includes('Retract (undelivered)'), 'the menu of an unread one has it')
  assert.equal((await menuOf('u2')).includes('Retract (undelivered)'), false, 'a read one’s menu has not')

  await s.click(x('u1'), 'the × of u1')
  const del = s.server.calls.filter(c => c.method === 'DELETE')
  assert.deepEqual(del.map(c => c.path.replace(/^.*\/api/, '')), ['/orgs/mine/nodes/solo/mail/u1'], 'the desk’s own call, once')
  assert.deepEqual(s.confirms, [], 'no confirmation, as on the desk')
  assert.equal(bubble('u1'), null, 'the bubble goes')
  await inAct(async () => { await flush(12) })
  assert.equal(bubble('u1'), null, 'and stays gone once the engine says it is taken back')

  // refused (read in the meantime): the error is said, and the bubble stays
  world.retractRefuse = true
  await s.click(x('u6'), 'the × of u6')
  await inAct(async () => { await flush(12) })
  assert.ok(bubble('u6'), 'the bubble is back where it was')
  assert.ok(s.state.toasts.some(m => /already delivered/.test(m)), `the engine’s reason is shown (${s.state.toasts.join(' | ')})`)
})

test('the take-back × is a corner overlay of the bubble: the time and tick line is the same with it and without it (USER 2026-11-25 m0c7ae1b9c32d)', async (t) => {
  setClassicMailbox(false)
  // "the cancel on unread meszages should be in the top right and not interfere with the read arrows position"
  const s = await setup(t, { sent: [
    sent('u1', 'solo', '2026-11-20T10:00:00Z', { delivered: false }),
    sent('u2', 'solo', '2026-11-20T10:01:00Z', { delivered: true }),
  ] })
  await s.openChat('solo')
  const bubble = (id: string) => document.querySelector<HTMLElement>(`.dm-msg[data-dm-entry="${id}"] .dm-bubble`)!
  const x = bubble('u1').querySelector<HTMLButtonElement>('button.dm-retract')
  assert.ok(x, 'POSITIVE CONTROL: the unread message has the ×')
  assert.equal(bubble('u2').querySelector('button.dm-retract'), null, 'POSITIVE CONTROL: the read one has none')
  assert.equal(x!.parentElement, bubble('u1'), 'the × sits on the bubble itself, not in its time and tick line')
  // the line the tick is in: the same parts, in the same order, with and without the ×
  const line = (id: string) => [...bubble(id).querySelector('.dm-meta')!.children].map(c => c.tagName + (c.classList.contains('dm-tick') ? '.dm-tick' : ''))
  assert.deepEqual(line('u1'), line('u2'), 'the time and the tick, nothing else, on both')
  assert.deepEqual(line('u1'), ['TIME', 'SPAN.dm-tick'])
  // laid out over the bubble's top-right corner, taking no room (jsdom has no layout: the rule itself)
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  const rule = css.match(/\.dm-bubble > button\.dm-retract\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /position:\s*absolute/, `absolute (${rule.trim()})`)
  // USER 2026-11-26 m3fe10fbaf0f9 "place it inside of the chat bubble but small": fully inside the top-right
  // corner, a plain muted x (no badge), with a hit area of at least 16px
  const px = (re: RegExp, text = rule) => Number(text.match(re)?.[1] ?? NaN)
  const top = px(/(?:^|[\s;])top:\s*(-?\d+)(?:px)?;/), right = px(/(?:^|[\s;])right:\s*(-?\d+)(?:px)?;/), size = px(/(?:^|[\s;])width:\s*(\d+)px/)
  assert.ok(top >= 0 && right >= 0, `inside the bubble's top-right corner (${rule.trim()})`)
  // USER 2026-11-26 19:09:41Z m42f4c372c5f2 "move the x ... further up and to the right a bit, by 4 pixels or so":
  // from 4px in to the corner of the bubble's padding box
  assert.ok(top <= 1 && right <= 1, `about 4px further up and right than 4px in (top ${top}px, right ${right}px)`)
  assert.ok(size >= 16 && px(/height:\s*(\d+)px/) >= 16, 'a hit area of at least 16px')
  assert.ok(px(/font-size:\s*(\d+)px/) <= 12, 'a small glyph, the weight of the tick')
  assert.doesNotMatch(rule, /background:\s*var\(--dm-out\)|box-shadow/, 'no dark circle around it')
  // USER 2026-11-26 (alpha.8) "position it absolutely relative to the message's bounds and dont have it interfere
  // with the body text": the message with the x is laid out exactly as without it. Nothing marks it, and no rule
  // changes its bubble, body or time and tick line; the bubble is the x's containing block
  assert.equal(bubble('u1').closest('.dm-msg')!.classList.contains('has-x'), false, 'the message carries no class for the x')
  assert.deepEqual(css.match(/[^{}]*has-x[^{}]*\{[^}]*\}/g) ?? [], [], 'and no rule pads the bubble or moves its time and tick line for it')
  assert.match(css.match(/(?:^|\s)\.dm-bubble \{([^}]*)\}/)?.[1] ?? '', /position:\s*relative/, 'the bubble holds the x')
})

// VIEW IN CHAT (USER 2026-11-25 m70e86c04946e): the user's own message, outside the loaded window, read back by id
// names no recipient; the asker names the chat (mailboxpref viewMailIn's peer), and it joins that chat's sent mail
test("View in chat on the user's own older message opens the chat the asker named, with the message flashed in it", async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')],
    byId: { old8: { id: 'old8', from: USER, at: '2026-10-01T09:00:00Z', kind: 'message', body: 'body of old8' } },
  }, { jumpTo: 'old8', jumpPeer: 'worker' })
  assert.equal(document.querySelector('.dm-head')?.getAttribute('data-dm-peer'), 'worker', "the named chat, not the user's own")
  const old = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === 'old8')
  assert.ok(old, 'the message is in that chat')
  assert.equal(old!.classList.contains('out'), true, "as the user's own message")
  assert.equal(old!.classList.contains('flash'), true, 'flashed, as a reference jump is')
})

test("without a named chat, the user's own older message says it is not in a chat, and opens nothing", async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')],
    byId: { old8: { id: 'old8', from: USER, at: '2026-10-01T09:00:00Z', kind: 'message', body: 'body of old8' } },
  }, { jumpTo: 'old8' })
  assert.deepEqual(s.state.toasts, ['That message is not in a chat.'])
  assert.equal(s.all<HTMLElement>('.dm-msg').some(m => m.dataset.dmEntry === 'old8'), false)
})

// VIEW IN CHAT FROM AN AGENT'S MAILBOX (requirement 8). The engine's agent mailbox (feed/compute.rs agent_mailbox)
// adds `to` only for the Sent folder, so the user's mail in an agent's inbox reads from=@user with no recipient:
// the mailbox's own agent is the chat. Mounted from @integ-sol-c's bounce fixture.
const nodeBoxTarget = 'older-user-mail'
const nodeBoxSentDate = '2026-10-01T09:00:00Z'

for (const withRecipient of [true, false]) {
  test(withRecipient ? "View in chat from an agent's mailbox: a row that names its recipient opens that chat" :
    "View in chat from an agent's mailbox: the user's mail in its inbox names no recipient (the engine's row shape), and the mailbox's own agent is the chat (integ-sol-c bounce m42d5992dd90a)", async t => {
    setClassicMailbox(true)
    resetLocalReads()
    window.sessionStorage.clear(); window.localStorage.removeItem('orgtree-dm-open:mine')
    const older = mail(nodeBoxTarget, USER, nodeBoxSentDate)
    const row = withRecipient ? { ...older, to: 'worker' } : older
    const server = engine({
      audiences: [grant('worker')],
      delivered: [mail('newer-received', 'worker', '2026-11-20T10:00:00Z')],
      byId: { [nodeBoxTarget]: older },
    })
    const realFetch = globalThis.fetch
    const reads: string[] = []
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input), 'http://fixture').pathname
      reads.push(path)
      if (path === '/api/orgs/mine/nodes/worker/inbox') {
        return Response.json({ pending: [], delivered: [row], sent: [], next_cursor: null })
      }
      return server.fetcher(input, init)
    }) as typeof fetch
    const wires: {id: string; peer: string | null; classic: boolean}[] = []
    const toasts: string[] = []
    const orgTree = tree()
    const toast = (lines: string[]) => { toasts.push(...lines) }
    function Shell() {
      const [jump, setJump] = React.useState<{ id: string; peer?: string } | null>(null)
      React.useEffect(() => onMailViewRequest((_org, id, peer) => {
        wires.push({ id, peer: peer ?? null, classic: classicMailbox() })
        setJump({id, peer})
      }), [])
      return <CurrentOrg.Provider value="mine"><ObjectMenuBoundary>
        <InboxView slug="mine" nid="worker" toast={toast} />
        {jump && <UserMailbox slug="mine" tree={orgTree} toast={toast} close={() => {}}
          jumpTo={jump.id} jumpSeq={1} jumpPeer={jump.peer} />}
      </ObjectMenuBoundary></CurrentOrg.Provider>
    }
    const v = await mountView(<Shell />, el => el)
    try {
      await inAct(async () => { await flush(8) })
      const agentRow = [...v.el.querySelectorAll('.mailrow')].find(el => el.textContent?.includes(older.body))
      assert.ok(agentRow, 'the actual node inbox renders the delivered item')
      await inAct(async () => {
        agentRow.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))
        await flush(6)
      })
      const choices = [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')]
      const action = choices.find(el => el.textContent?.trim() === 'View in chat')
      assert.ok(action, 'the node inbox shows View in chat')
      await inAct(async () => { action.click(); await flush(14) })
      const bubble = v.el.querySelector(`[data-dm-entry="${nodeBoxTarget}"]`)
      const result = {
        withRecipient, wires, toasts,
        peer: v.el.querySelector('.dm-head')?.getAttribute('data-dm-peer') ?? null,
        flashed: bubble?.classList.contains('flash') ?? false,
        lookedUp: reads.includes(`/api/orgs/mine/mail/user/${nodeBoxTarget}`),
      }
      assert.equal(result.lookedUp,true,'the older mail is outside the loaded user window and is fetched by id')
      assert.deepEqual(wires,[{id:nodeBoxTarget,peer:'worker',classic:false}],'the node inbox hands the chat its own recipient')
      assert.equal(result.peer,'worker','the named chat opens')
      assert.equal(result.flashed,true,'the older message flashes')
      assert.deepEqual(result.toasts,[])
    } finally {
      await v.unmount()
      globalThis.fetch = realFetch
      window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
    }
  })
}

// "VIEW IN @AGENT'S INBOX" OPENS THAT MAILBOX, NOT THE CHAT (USER 2026-11-25 21:39:00Z md19d9582d5f0 on alpha.6:
// "View in @xyz's inbox no longer works, it just highlights the message in the chat again"). The entry goes through
// the panel's own mail route, which reaches the canvas's mail-link router; since View in chat that router sends the
// user's mail to the chat while the chats are on (mailboxpref mailLinkToChat). The entry asks for the mailbox
// itself, so the router must honour it; an ordinary mail link keeps going to the chat.
test('View in @agent\'s inbox reaches the agent\'s mailbox through the mail-link router; an ordinary mail link still opens the chat', async (t) => {
  const s = await setup(t, {
    audiences: [grant('worker')],
    delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z')],
    sent: [sent('s1', 'worker', '2026-11-20T10:05:00Z')],
    byId: { m1: { ...mail('m1', 'worker', '2026-11-20T10:00:00Z'), to: USER }, s1: { id: 's1', from: USER, at: '2026-11-20T10:05:00Z', kind: 'message', body: 'body of s1' } },
  }, { active: false })
  await s.openChat('worker')
  const views: { id: string; peer?: string }[] = []
  const off = onMailViewRequest((_org, id, peer) => { views.push({ id, peer }) })
  t.after(off)
  // the canvas's router, as OrgCanvas runs it for a link into worker's mailbox
  const route = async (id: string) => {
    let mailbox = 0
    await inAct(async () => { mailLinkToChat('mine', id, 'worker', () => { mailbox++ }); await flush(8) })
    return mailbox
  }
  for (const entry of ['m1', 's1']) {
    const bubble = s.all<HTMLElement>('.dm-msg').find(m => m.dataset.dmEntry === entry)!.querySelector('.dm-bubble')!
    await inAct(async () => { bubble.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); await flush(6) })
    const item = [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"], [role="menu"] [role="menuitem"]')]
      .find(i => /View in @worker’s inbox/.test(i.textContent ?? ''))
    await s.click(item, `View in @worker's inbox on ${entry}`)
    assert.deepEqual(s.state.opened.at(-1), { kind: 'mail', org: 'mine', box: 'node', node: 'worker', id: entry }, 'POSITIVE CONTROL: the panel asks for that mail in worker\'s mailbox')
    assert.equal(await route(entry), 1, `${entry}: the router opens worker's mailbox, as the entry says`)
    assert.deepEqual(views, [], `${entry}: and does not send it back to the chat`)
  }
  // the entry's request is spent: the next ordinary link to the same mail goes to the chat again (View in chat's rule)
  assert.equal(await route('m1'), 0, 'an ordinary link afterwards does not open the mailbox')
  assert.deepEqual(views, [{ id: 'm1', peer: 'worker' }], 'it opens the chat, as before')
})

// A JUMP HIGHLIGHTS THE WHOLE ROW (USER 2026-11-25 21:40:58Z mba561e16fb40: "the highlight for chat messages needs to
// be more prominent, highlight the whole row"). Every jump (a reference, a quote, View in chat, the search) marks its
// message with `.flash`; that one style tints the whole row across the chat's width, stronger than the old ring
// around the bubble, and fades as before. jsdom draws nothing: the style is read from dm.css, and the capture kit
// measures it in a real window (dm-alpha1 section 29).
test('a jump highlights the whole row across the chat, in one shared style that fades', async () => {
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  const rule = (sel: string) => css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}'))?.[1] ?? null
  const flash = rule('.dm-msg.flash')
  assert.ok(flash, 'the row itself carries the highlight (.dm-msg.flash)')
  assert.match(flash!, /animation: dm-row-flash /, 'one animation, on the row')
  assert.equal(/\.dm-msg\.flash \.dm-bubble[^{]*\{[^}]*animation/.test(css), false, 'no second highlight on the bubble alone')
  const frames = css.match(/@keyframes dm-row-flash \{([\s\S]*?)\}\s*\}/)?.[1] ?? ''
  assert.match(frames, /background-color: color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/, 'the flash token: the accent, mixed')
  const pct = Number(frames.match(/var\(--accent\) (\d+)%/)?.[1])
  assert.ok(pct > 28, `stronger than the old ring's 28% (${pct}%)`)
  assert.match(frames, /box-shadow: 0 0 0 100vmax /, 'it reaches past the row to both sides of the chat')
  assert.match(frames, /clip-path: inset\(-?\d+px -100vmax\)/, 'only sideways: the rows above and below are not tinted')
  assert.match(frames, /100% \{[^}]*transparent/, 'it fades')
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.dm-msg\.flash \{[^}]*animation: dm-row-flash-still /, 'with reduced motion it shows and goes without fading')
})

// THE TOGGLE KEEPS THE OPEN CHAT (USER 2026-11-25 21:34:30Z m4acfafd4792f, 4.7.0-alpha.6: "switching between chats and
// classic inbox changes the active chat window open"). Chats -> classic -> Chats reopens the chat that was open. The
// toggle remounts the chats, so neither the first-open pick (the chat with the oldest unread) nor a jump or an Open
// chat request the chats already followed may choose again.
const openPeer = () => document.querySelector('.dm-head')?.getAttribute('data-dm-peer') ?? null
async function roundTrip(t: TestContext) {
  t.after(() => setClassicMailbox(false))
  await inAct(async () => { setClassicMailbox(true); await flush(12) })
  assert.equal(document.querySelector('.dm-head'), null, 'POSITIVE CONTROL: the classic mailbox is showing')
  await inAct(async () => { setClassicMailbox(false); await flush(12) })
}
const twoChats = (): World => ({
  audiences: [grant('worker'), grant('solo')],
  // worker's is the oldest mail still waiting on the user: the chats open on it the first time
  pending: [mail('w1', 'worker', '2026-11-20T09:00:00Z')],
  delivered: [mail('o1', 'solo', '2026-11-20T10:00:00Z')],
})

test('the toggle keeps the open chat: classic and back reopens the chat that was open, not the one with the oldest unread', async (t) => {
  const s = await setup(t, twoChats(), { active: false })
  assert.equal(openPeer(), 'worker', 'POSITIVE CONTROL: the first open picks the chat with the oldest unread')
  await s.openChat('solo')
  assert.equal(openPeer(), 'solo')
  await roundTrip(t)
  assert.equal(openPeer(), 'solo', 'back from the classic inbox, the same chat is open')
  await roundTrip(t)
  assert.equal(openPeer(), 'solo', 'and again')
})

test('the toggle opens no chat when none was open', async (t) => {
  await setup(t, { audiences: [grant('worker'), grant('solo')], delivered: [mail('o1', 'solo', '2026-11-20T10:00:00Z')] }, { active: false })
  assert.equal(openPeer(), null, 'POSITIVE CONTROL: nothing waits, nothing was open: no chat opens')
  await roundTrip(t)
  assert.equal(openPeer(), null, 'the toggle opens nothing')
})

test('the toggle does not replay a jump the chats already followed', async (t) => {
  const s = await setup(t, twoChats(), { active: false, jumpTo: 'w1' })
  assert.equal(openPeer(), 'worker', 'POSITIVE CONTROL: the jump opened its chat')
  await s.openChat('solo')
  await roundTrip(t)
  assert.equal(openPeer(), 'solo', 'the old jump does not pull the chats back to worker')
  assert.deepEqual(s.all<HTMLElement>('.dm-msg.flash').map(m => m.dataset.dmEntry), [], 'and nothing flashes')
})

test('the toggle does not replay an Open chat request the chats already followed', async (t) => {
  const s = await setup(t, twoChats(), { active: false, openChat: { peer: 'worker', seq: 7 } })
  assert.equal(openPeer(), 'worker', 'POSITIVE CONTROL: the request opened its chat')
  await s.openChat('solo')
  await roundTrip(t)
  assert.equal(openPeer(), 'solo', 'the old request does not pull the chats back to worker')
})

// CLOSING AND REOPENING KEEPS THE OPEN CHAT (USER 2026-11-26 10:49:38Z m96984bdf995c, 4.7.0-alpha.7: "closing and
// reopening the chats panel still loses the active chat i had selected"; @coordinator-opus ruling): reopening the
// panel, in any form or window, shows the chat that was open when it closed, kept with the panel's other remembered
// UI state (localStorage, as the Chats/classic toggle). A remembered chat that is gone falls back to the first-open rule.
test('closing the panel and opening it again reopens the chat that was open, not the one with the oldest unread', async (t) => {
  const s = await setup(t, twoChats(), { active: false })
  assert.equal(openPeer(), 'worker', 'POSITIVE CONTROL: the first open picks the chat with the oldest unread')
  await s.openChat('solo')
  await s.remount()
  assert.equal(openPeer(), 'solo', 'reopened on the chat that was open')
  await s.remount()
  assert.equal(openPeer(), 'solo', 'and again')
})

test('another window (a popped-out panel, or the app after a restart) reopens the same chat: it is not kept per window', async (t) => {
  const s = await setup(t, twoChats(), { active: false })
  await s.openChat('solo')
  window.sessionStorage.clear()   // another window starts with its own, empty session storage
  await s.remount()
  assert.equal(openPeer(), 'solo')
})

test('a remembered chat that is no longer there falls back to the first-open rule', async (t) => {
  const s = await setup(t, twoChats(), { active: false })
  await s.openChat('solo')
  window.localStorage.setItem('orgtree-dm-open:mine', 'gone')   // its audience was revoked elsewhere
  await s.remount()
  assert.equal(openPeer(), 'worker', 'the chat with the oldest unread, as on a first open')
})

test('the open chat is kept per org in local storage, beside the Chats/classic choice', async (t) => {
  const s = await setup(t, twoChats(), { active: false })
  await s.openChat('solo')
  assert.equal(window.localStorage.getItem('orgtree-dm-open:mine'), 'solo', 'kept with the panel state')
})
