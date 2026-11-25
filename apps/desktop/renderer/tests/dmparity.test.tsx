// dmparity.test.tsx — the chats panel behaves as Hubchat does, for the points
// the user picked (USER 2026-11-25 10:44:48Z m1454b39b8fd0 "correct 1, 2, 5,
// 6, 7."; docket chats-panel-parity-with-hubchat-instant-send-ret):
//
//   §1  instant send: the user's message is a bubble at once, with the clock
//       tick; a refused send stays as a bubble with "Not sent", Retry and
//       Discard (Hubchat MessageView's failed line and menu); Discard puts the
//       text back in the box; the engine's row replaces the local one, once
//   §2  files dropped on the chat join the message box's attachments
//   §5  a plain web link in a bubble has "Open link" and "Copy link"
//   §6  "Copy mention" in the chat row's and the chat header's menus
//   §7  a bubble's attachments show their transfer's progress and state
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs dmparity

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { UserMailbox } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { CLASSIC_MAILBOX_KEY, OPEN_CHAT_ON_REPLY_KEY } from '../src/mailboxpref'
import { resetLocalReads } from '../src/mailread'
import { resetComposerDrafts } from '../src/composerdrafts'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}
const USER = '@user'

const node = (id: string) => ({
  id, title: id, tier: 'opus', model_id: 'opus', state: 'live', seat: 1, grant: 0, free: 0, ui_order: 0,
  cost_usd: 0, occupancy: null, context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [], turns: [], frozen: null,
  audiences_held: [], bearer_state: null, generation: 0, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
})
const tree = () => ({
  slug: 'mine', name: 'Mine', tiers: { opus: { name: 'Opus' } }, roots: [node('lead')],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, default_visibility: 'full',
}) as unknown as TreePayload
const mail = (id: string, from: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ id, from, at, kind: 'message', body: `body of ${id}`, ...extra })
const sentMail = (id: string, to: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ id, from: USER, to, at, kind: 'message', body: `body of ${id}`, ...extra })

interface World {
  delivered?: unknown[]; sent?: unknown[]
  /** how the engine answers a sent message */
  send?: 'ok' | 'refuse' | 'hold'
  transfers?: unknown[]
}

function engine(world: World) {
  const posts: { path: string; body: unknown }[] = []
  let release: (() => void) | null = null
  let n = 0
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null
    if (method !== 'GET') posts.push({ path, body })
    if (/\/transfers(\?|$)/.test(path)) return json({ transfers: world.transfers ?? [], next_cursor: null })
    if (/\/audiences$/.test(path)) return json({ audiences: [], requests: [] })
    if (/\/upload\?/.test(path)) return json({ path: 'inbox/' + decodeURIComponent(path.split('name=')[1]!), bytes: 3 })
    if (/\/nodes\/[^/]+\/message$/.test(path)) {
      if (world.send === 'refuse') return json({ error: 'the agent is not taking mail' }, 500)
      if (world.send === 'hold') await new Promise<void>(r => { release = r })
      const id = `m-new-${++n}`
      const text = (body as { message?: string; text?: string; body?: string })
      world.sent = [...(world.sent ?? []), sentMail(id, 'lead', '2026-11-25T12:00:0' + n + 'Z',
        { body: text?.message ?? text?.text ?? text?.body ?? '' })]
      return json({ accepted: true, id, ref: `@mail:${id}` })
    }
    if (/\/nodes\/[^/]+\/chat(\?|$)/.test(path)) return json({ messages: [], live: [], pending_mail: [], busy: false, responding: false,
      windowed: true, has_older: false, before: null, draft_epoch: 'synthetic:0' })
    if (/\/mention-candidates(\?|$)/.test(path)) return json({ items: [], next_cursor: null, nodes: [], outside: [] })
    if (/\/inbox(\?|$)/.test(path)) {
      const q = new URL(path, 'http://x').searchParams
      const ids = q.get('ids')
      if (ids) {
        const want = JSON.parse(ids) as string[]
        return json({ pending: [], delivered: (world.delivered ?? []).filter(m => want.includes((m as { id: string }).id)),
          sent: (world.sent ?? []).filter(m => want.includes((m as { id: string }).id)), refreshed_ids: want })
      }
      if (q.get('folder') === 'chat') {
        const peer = q.get('peer')
        return json({ pending: [], delivered: (world.delivered ?? []).filter(m => (m as { from: string }).from === peer),
          sent: (world.sent ?? []).filter(m => (m as { to: string }).to === peer), next_cursor: null })
      }
      return json({ pending: [], delivered: world.delivered ?? [], sent: world.sent ?? [], next_cursor: null })
    }
    return json({})
  }) as typeof fetch
  return { posts, fetcher, release: () => { release?.(); release = null } }
}

async function setup(t: TestContext, world: World) {
  const oldFetch = globalThis.fetch
  const server = engine(world)
  globalThis.fetch = server.fetcher
  const oldFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')
  Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
  // the clipboard is a stub: nothing reaches the real one
  const copied: string[] = []
  const nav = W.navigator as unknown as { clipboard?: unknown }
  const oldClip = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { copied.push(s) } } })
  const oldOpen = W.open
  const opened: string[] = []
  W.open = ((u?: string | URL) => { opened.push(String(u)); return null }) as typeof W.open
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  window.localStorage.removeItem(OPEN_CHAT_ON_REPLY_KEY)
  window.sessionStorage.clear()
  resetLocalReads()
  resetComposerDrafts()
  const toasts: string[] = []
  const view = await mountView(<CurrentOrg.Provider value="mine">
    <UserMailbox slug="mine" tree={tree()} toast={(lines) => { toasts.push(...lines) }} close={() => {}}
      jumpTo={null} jumpSeq={null} openChat={null} onFocusAgent={() => {}} onOpenMail={() => {}} />
  </CurrentOrg.Provider>, el => el)
  t.after(async () => {
    await view.unmount()
    globalThis.fetch = oldFetch
    W.open = oldOpen
    if (oldClip) Object.defineProperty(nav, 'clipboard', oldClip); else delete nav.clipboard
    if (oldFocus) Object.defineProperty(document, 'hasFocus', oldFocus)
    else delete (document as unknown as Record<string, unknown>).hasFocus
  })
  await inAct(async () => { await flush(12) })
  // open the chat with lead, as a click on its row does
  const lead = document.querySelector<HTMLElement>('.dm-row[data-dm-chat="lead"]')
  assert.ok(lead, 'the chat with lead is listed')
  await inAct(async () => { lead!.click(); await flush(12) })
  const all = <T extends Element>(sel: string) => [...document.querySelectorAll<T>(sel)]
  const click = async (el: Element | null | undefined, what = 'the control') => {
    assert.ok(el, `${what} is on screen`)
    await inAct(async () => { (el as HTMLElement).click(); await flush(8) })
  }
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
  const menuOn = async (el: Element | null | undefined, what: string) => {
    assert.ok(el, `${what} is on screen`)
    await inAct(async () => { el!.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await flush(6) })
    const menus = all<HTMLElement>('[role="menu"]')
    return menus.length ? [...menus[menus.length - 1]!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] : []
  }
  const bubbles = (text: string) => all<HTMLElement>('.dm-msg').filter(b => b.textContent?.includes(text))
  return { server, toasts, copied, opened, all, click, type, send, draft, menuOn, bubbles }
}

const labelsOf = (items: HTMLElement[]) => items.map(i => i.textContent?.trim())

test('§1 a sent message is a bubble at once, with the clock tick, and the engine\'s row replaces it once', async (t) => {
  const world: World = { delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z')], send: 'hold' }
  const s = await setup(t, world)
  await s.type('Hello at once')
  await s.send()
  const now = s.bubbles('Hello at once')
  assert.equal(now.length, 1, 'the message is in the chat before the engine answers')
  assert.ok(now[0]!.classList.contains('out'), 'on the user\'s side')
  assert.ok(now[0]!.classList.contains('local'), 'as a local bubble')
  assert.ok(now[0]!.querySelector('.dm-tick.t-queued'), 'with the clock tick')
  assert.equal(s.draft(), '', 'and the box is empty')
  await inAct(async () => { s.server.release(); await flush(20) })
  const after = s.bubbles('Hello at once')
  assert.equal(after.length, 1, 'the engine\'s row replaces the local bubble: one, never two')
  assert.equal(after[0]!.classList.contains('local'), false, 'it is the engine\'s row now')
})

test('§1 a refused send stays as a bubble saying "Not sent", with Retry and Discard', async (t) => {
  const world: World = { delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z')], send: 'refuse' }
  const s = await setup(t, world)
  await s.type('This one fails')
  await s.send()
  const b = s.bubbles('This one fails')
  assert.equal(b.length, 1, 'the refused message stays in the chat')
  assert.ok(b[0]!.classList.contains('failed'), 'marked failed')
  const line = b[0]!.querySelector('.dm-failed')
  assert.match(line?.textContent ?? '', /Not sent: the agent is not taking mail\./, 'Hubchat\'s failed line, with the reason')
  assert.equal(s.draft(), '', 'the text does not come back into the box by itself')
  const items = labelsOf(await s.menuOn(b[0]!.querySelector('.dm-bubble'), 'the failed bubble'))
  assert.ok(items.includes('Retry') && items.includes('Discard'), `its menu has Retry and Discard (got ${JSON.stringify(items)})`)
  await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(4) })
  // Retry sends the same message again; this time the engine takes it
  world.send = 'ok'
  const sends = () => s.server.posts.filter(p => /\/message$/.test(p.path)).length
  const before = sends()
  await s.click([...line!.querySelectorAll('button')].find(x => x.textContent === 'Retry'), 'Retry')
  await inAct(async () => { await flush(20) })
  assert.equal(sends(), before + 1, 'Retry sends it again')
  const again = s.bubbles('This one fails')
  assert.equal(again.length, 1, 'one bubble')
  assert.equal(again[0]!.classList.contains('failed'), false, 'and it is no longer failed')
})

test('§1 Discard removes the failed bubble and puts its text back in the box', async (t) => {
  const s = await setup(t, { delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z')], send: 'refuse' })
  await s.type('Take it back')
  await s.send()
  const line = s.bubbles('Take it back')[0]?.querySelector('.dm-failed')
  await s.click([...(line?.querySelectorAll('button') ?? [])].find(x => x.textContent === 'Discard'), 'Discard')
  assert.equal(s.bubbles('Take it back').length, 0, 'the bubble is gone')
  assert.equal(s.draft(), 'Take it back', 'its text is back in the box')
})

test('§2 a file dropped on the chat joins the message box\'s attachments', async (t) => {
  const s = await setup(t, { delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z')] })
  const zone = document.querySelector('.dm-timeline')
  assert.ok(zone, 'the chat is open')
  const file = new W.File(['abc'], 'dropped.txt', { type: 'text/plain' })
  const over = new W.Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(over, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
  await inAct(async () => { zone!.dispatchEvent(over); await flush(2) })
  assert.equal(over.defaultPrevented, true, 'the chat accepts the drag (no navigate-away)')
  const drop = new W.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
  await inAct(async () => { zone!.dispatchEvent(drop); await flush(12) })
  assert.ok(s.server.posts.some(p => /\/nodes\/lead\/upload\?name=dropped\.txt$/.test(p.path)), 'it is uploaded for this chat, as a pasted file is')
  assert.match(document.querySelector('.dm-compose')?.textContent ?? '', /dropped\.txt/, 'and shown in the box')
})

test('§5 a plain web link in a bubble has Open link and Copy link', async (t) => {
  const s = await setup(t, { delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z', { body: 'see https://example.com/page for it' })] })
  const link = s.bubbles('example.com')[0]?.querySelector('a[href^="https://example.com"]')
  const items = await s.menuOn(link, 'the link')
  const labels = labelsOf(items)
  assert.deepEqual(labels.slice(0, 2), ['Open link', 'Copy link'], `the link's own entries first (got ${JSON.stringify(labels)})`)
  await s.click(items[1], 'Copy link')
  assert.deepEqual(s.copied, ['https://example.com/page'], 'Copy link copies the address')
  const again = await s.menuOn(link, 'the link')
  await s.click(again[0], 'Open link')
  assert.deepEqual(s.opened, ['https://example.com/page'], 'Open link opens it')
})

test('§6 Copy mention in the chat row\'s menu and the chat header\'s menu', async (t) => {
  const s = await setup(t, { delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z')] })
  const row = s.all<HTMLElement>('.dm-row').find(r => r.dataset.dmChat === 'lead')
  const rowItems = await s.menuOn(row, 'the chat row')
  const copy = rowItems.find(i => i.textContent?.trim() === 'Copy mention')
  assert.ok(copy, `the row's menu has Copy mention (got ${JSON.stringify(labelsOf(rowItems))})`)
  await s.click(copy, 'Copy mention')
  assert.deepEqual(s.copied, ['@lead'], 'it copies the @name token')
  await inAct(async () => { document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(4) })
  const headItems = await s.menuOn(document.querySelector('.dm-head .dm-av, .dm-head'), 'the chat header')
  const copy2 = headItems.find(i => i.textContent?.trim() === 'Copy mention')
  assert.ok(copy2, `the header's menu has Copy mention (got ${JSON.stringify(labelsOf(headItems))})`)
  await s.click(copy2, 'Copy mention')
  assert.deepEqual(s.copied, ['@lead', '@lead'])
})

test('§7 a bubble\'s attachments show their transfer\'s progress and state', async (t) => {
  const s = await setup(t, {
    delivered: [mail('m1', 'lead', '2026-11-25T10:00:00Z')],
    sent: [sentMail('s1', 'lead', '2026-11-25T10:05:00Z', { body: 'files', attachments: [
      { path: 'outbox/shot.png', name: 'shot.png', bytes: 100 }, { path: 'outbox/report.pdf', name: 'report.pdf', bytes: 50 }] })],
    transfers: [{ id: 't1', direction: 'upload', peer: '@net:far', message_id: 's1', state: 'uploading', attempt: 1,
      files: [{ id: 'f1', name: 'shot.png', total: 100, confirmed: 40, processed: 60 },
        { id: 'f2', name: 'report.pdf', total: 50, confirmed: 0, processed: 0 }] }],
  })
  const b = s.bubbles('files')[0]
  assert.ok(b, 'the bubble with the files')
  const pic = b!.querySelector<HTMLElement>('[data-transfer-file="shot.png"]')
  assert.ok(pic, 'the picture carries its transfer')
  assert.equal(pic!.querySelector('progress')?.value, 40, 'its progress, in confirmed bytes')
  assert.match(pic!.textContent ?? '', /Uploading · 40%/, 'and its state')
  const doc = b!.querySelector<HTMLElement>('[data-transfer-file="report.pdf"]')
  assert.match(doc?.textContent ?? '', /Uploading · 0%/, 'the file card too')
  // a message with no transfer shows none
  assert.equal(s.bubbles('body of m1')[0]?.querySelector('[data-transfer-file]') ?? null, null)
})
