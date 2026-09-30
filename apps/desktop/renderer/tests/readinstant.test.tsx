// readinstant.test.tsx — a mail shows read on the click
// (docket v3-marking-a-mail-as-read-takes-about-half-a-sec, user 2026-09-30).
//
// Reading a mail used to show only after the save returned AND the inbox and
// the tree had been fetched again (measured cause, on the item: the save
// rewrote the whole read archive, since fixed in 7628df6). Now the click
// records the read (mailread.ts) and the list, the unread counts, the bell and
// the header dot all follow at once; the save runs in the background and a
// refused save puts the mail back to unread and says why.
//
// Every test HOLDS the save open, so a pass cannot come from the server
// having answered: the UI must not wait on the save, an inbox reload, a tree
// read or anything else.
//
// Run:  node apps/desktop/renderer/tests/run.mjs readinstant

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AskBell, InboxPanel } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { markReadNow, resetLocalReads, settleReadsFromBox, settleReadsFromTree } from '../src/mailread'
import { publishPending, resetPending, summarizePending } from '../src/pending-attention'
import type { DesktopNotice } from '../src/notifications'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

const TREE = {
  slug: 'mine', name: 'Mine', tiers: { opus: { name: 'Opus' } }, roots: [], nodes: [],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full', user_inbox_count: 2, urgent_unread: 1, asks_open: 0,
} as unknown as TreePayload

const OLD = { id: 'm1', from: 'alpha', at: '2026-09-30T08:00:00Z', body: 'first', urgent: true,
  urgent_reason: 'look now' }
const NEW = { id: 'm2', from: 'beta', at: '2026-09-30T08:05:00Z', body: 'second' }

function deferred() {
  let resolve!: (r: Response) => void
  let reject!: (e: Error) => void
  const promise = new Promise<Response>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b),
  { status, headers: { 'Content-Type': 'application/json' } })

async function inbox(tc: TestContext, save: ReturnType<typeof deferred>) {
  const calls: string[] = []
  const toasts: string[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url)
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.includes('/inbox/read')) return save.promise
    return json(path.includes('/inbox') ? { pending: [OLD, NEW], delivered: [], sent: [] }
      : path.includes('/audiences') ? { audiences: [], requests: [] }
        : path.includes('/events') ? { events: [] } : {})
  }) as typeof fetch
  const view = await mountView(
    <CurrentOrg.Provider value="mine">
      <InboxPanel slug="mine" tree={TREE} toast={(t) => toasts.push(...t)} close={() => {}} jumpTo={null} />
    </CurrentOrg.Provider>, el => el)
  tc.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; resetLocalReads() })
  await inAct(async () => { await flush(10) })
  return { view, calls, toasts }
}

const unreadIds = (el: HTMLElement) => [...el.querySelectorAll('.mailrow.unread')]
  .map((r) => (/first/.test(r.textContent ?? '') ? 'm1' : /second/.test(r.textContent ?? '') ? 'm2' : '?'))
const row = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('.mailrow')]
  .find((r) => text.test(r.textContent ?? '')) as HTMLElement

test('a read mail leaves unread on the click, while the save is still out', async (tc) => {
  resetLocalReads()
  const save = deferred()
  const { view, calls } = await inbox(tc, save)
  assert.deepEqual(unreadIds(view.el).sort(), ['m1', 'm2'], 'both unread; the oldest is open')
  const reloadsBefore = calls.filter((c) => c.startsWith('GET') && c.includes('/inbox')).length

  const t0 = performance.now()
  // clicking OFF the open mail (m1) is what reads it (user ruling)
  await inAct(async () => { row(view.el, /second/).click() })
  const ms = performance.now() - t0
  assert.deepEqual(unreadIds(view.el), ['m2'], 'm1 is read at once')
  assert.ok(ms < 100, `shown read in ${ms.toFixed(1)} ms`)
  assert.ok(calls.some((c) => c.startsWith('POST') && c.includes('/inbox/read')), 'the save went out')
  assert.equal(calls.filter((c) => c.startsWith('GET') && c.includes('/inbox')).length, reloadsBefore,
    'without waiting on an inbox reload')
  assert.ok(row(view.el, /first/), 'the mail is still listed, now as read')

  await inAct(async () => { save.resolve(json({ read: 1 })); await flush(5) })
  assert.deepEqual(unreadIds(view.el), ['m2'])
})

test('a refused save puts the mail back to unread and says why', async (tc) => {
  resetLocalReads()
  const save = deferred()
  const { view, toasts } = await inbox(tc, save)
  await inAct(async () => { row(view.el, /second/).click() })
  assert.deepEqual(unreadIds(view.el), ['m2'])
  await inAct(async () => { save.resolve(json({ detail: 'db down' }, 500)); await flush(5) })
  assert.deepEqual(unreadIds(view.el).sort(), ['m1', 'm2'], 'unread again')
  assert.ok(toasts.some((t) => /could not mark read/.test(t)), toasts.join(' | '))
})

test('the bell count and glow and the header dot drop at the same moment', async (tc) => {
  resetLocalReads()
  resetPending()
  const urgentRow: DesktopNotice = { id: 'mail:m1', org: 'mine', kind: 'urgent-mail', source_id: 'm1',
    agent: 'alpha', title: 'Message from alpha', body: 'look now' }
  const bell = await mountView(<AskBell tree={TREE} onOpen={() => {}} />, el => el)
  tc.after(async () => { await bell.unmount(); resetPending(); resetLocalReads() })
  await inAct(async () => { publishPending(summarizePending([urgentRow])) })
  const btn = () => bell.el.querySelector<HTMLElement>('button.ask-bell')!
  assert.equal(bell.el.querySelector('.eye-count')?.textContent, '1', 'one urgent')
  assert.match(btn().className, /\bglow\b/)
  assert.ok(bell.el.querySelector('.attn-dot'))

  let finish!: () => void
  await inAct(async () => {
    void markReadNow('mine', OLD, () => new Promise<void>((r) => { finish = r }))
  })
  assert.doesNotMatch(btn().className, /\bglow\b/, 'no glow: the urgent mail is read')
  assert.equal(bell.el.querySelector('.eye-count')?.textContent, '1', 'the other unread mail still counts')
  assert.equal(!!bell.el.querySelector('.attn-dot'), false, 'and the dot is gone')

  // once saved and both server views agree, the tree's own count takes over
  await inAct(async () => { finish(); await flush(3) })
  await inAct(async () => {
    settleReadsFromBox('mine', ['m2'])
    settleReadsFromTree('mine', Date.now() + 1)
  })
  const settled = { ...TREE, user_inbox_count: 1, urgent_unread: 0 } as TreePayload
  await bell.render(<AskBell tree={settled} onOpen={() => {}} />)
  assert.equal(bell.el.querySelector('.eye-count')?.textContent, '1', 'counted once, not subtracted twice')
})
