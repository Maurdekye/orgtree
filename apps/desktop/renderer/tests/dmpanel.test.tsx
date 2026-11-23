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
}

function engine(world: World) {
  const calls: Call[] = []
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
    if (/\/nodes\/[^/]+\/message$/.test(path)) return json({ accepted: true, id: 'm-new', ref: '@mail:m-new' })
    if (/\/nodes\/[^/]+\/batch$/.test(path)) return json({ resolved: 'ok' })
    if (/\/inbox(\?|$)/.test(path)) {
      return json({ pending: world.pending ?? [], delivered: world.delivered ?? [], sent: world.sent ?? [], next_cursor: null })
    }
    return json({})
  }) as typeof fetch)
  return { calls, fetcher }
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
  const state = { closed: 0, focused: [] as string[], toasts: [] as string[] }
  const panel = (o = opts) => (
    <CurrentOrg.Provider value="mine">
      <UserMailbox slug="mine" tree={o.tree ?? opts.tree ?? tree()} toast={(lines) => { state.toasts.push(...lines) }}
        close={() => { state.closed++ }} jumpTo={o.jumpTo ?? null} jumpSeq={o.jumpTo ? 1 : null}
        openChat={o.openChat ?? null} onFocusAgent={(id) => { state.focused.push(id) }} />
    </CurrentOrg.Provider>
  )
  const view = await mountView(panel(), el => el)
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
    const ta = document.querySelector('.dm-compose .mail-reply textarea') as HTMLTextAreaElement
    assert.ok(ta, 'the message box is on screen')
    await inAct(async () => {
      Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, text)
      ta.dispatchEvent(new W.Event('input', { bubbles: true }))
      await flush(2)
    })
  }
  const send = async () => { await click(document.querySelector('.dm-compose .mail-reply-send'), 'the send button') }
  return { view, state, server, confirms, all, click, rows, row, openChat, type, send, rerender: (o: typeof opts) => view.render(panel({ ...opts, ...o })) }
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
  assert.equal(picker!.querySelector('.tray') !== null, true, 'it is the shared agents list')
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

test('a notice has a dashed border in its own text colour, a request its label, and files are chips', async (t) => {
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
  assert.equal(bubble('p1').classList.contains('notice'), false, 'an ordinary message is not dashed')
  assert.equal(bubble('r1').querySelector('.dm-kind')?.textContent, 'Request')
  assert.equal(bubble('p1').querySelector('.dm-kind') === null, true, 'an ordinary message wears no label')
  const chip = bubble('f1').querySelector<HTMLAnchorElement>('.attach-row a.attach-chip')
  assert.match(chip?.textContent ?? '', /report\.pdf/)
  assert.match(chip?.getAttribute('href') ?? '', /\/api\/orgs\/mine\/nodes\/worker\/file\?path=outbox%2Freport\.pdf$/,
    'the file is the sender\'s, read through the route the classic mailbox uses')
  // the rule that draws it: dashed, in the bubble's own colour
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
  assert.match(css, /\.dm-bubble\.notice \{ border: 1px var\(--notice-edge-style\) currentColor; \}/)
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

  // New chat steps out of the list, so the chat it opens is not behind it
  await s.click(document.querySelector('.dm-list-head .dm-new'), 'New chat')
  assert.equal(document.querySelector('.dm-newchat') !== null, true)
  assert.equal(box.classList.contains('narrow-list-open'), false)
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
