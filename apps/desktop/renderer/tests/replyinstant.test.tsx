// replyinstant.test.tsx — a mail reply registers on the click
// (docket v3-sending-a-reply-to-a-mail-takes-about-half-a, 2026-09-30).
//
// The reply box used to stay locked on the typed text until the server
// answered, and in the user's inbox that answer also waits for marking the
// replied-to mail read, so a reply took about half a second to register. The
// box now empties at once and says "sending…"; a refused send puts the text
// (and attachments) back with the reason, so nothing typed is lost.
//
// Run:  node apps/desktop/renderer/tests/run.mjs replyinstant

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MailReplyBox } from '../src/canvas/mail'
import { InboxPanel } from '../src/App'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

async function typeInto(root: HTMLElement, text: string) {
  const ta = root.querySelector('.mail-reply textarea') as HTMLTextAreaElement
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function box(t: TestContext, onSend: (text: string) => Promise<unknown>) {
  const view = await mountView(<MailReplyBox target="alpha" slug="mine" onSend={onSend} />, el => el)
  t.after(() => view.unmount())
  return {
    el: view.el,
    ta: () => view.el.querySelector('.mail-reply textarea') as HTMLTextAreaElement,
    send: () => view.el.querySelector('.mail-reply-send') as HTMLButtonElement,
    state: () => view.el.querySelector('.mail-reply-state')?.textContent ?? '',
  }
}

test('the box empties and stays usable on the click, before the server answers', async (t) => {
  const d = deferred()
  const sent: string[] = []
  const b = await box(t, (text) => { sent.push(text); return d.promise })
  await typeInto(b.el, 'on it')
  await inAct(() => b.send().click())
  assert.deepEqual(sent, ['on it'])
  assert.equal(b.ta().value, '', 'the text left the box at once')
  assert.equal(b.ta().disabled, false, 'and the box is not locked while the send is in flight')
  assert.match(b.state(), /sending to alpha/)

  await inAct(async () => { d.resolve({}); await d.promise })
  assert.match(b.state(), /^sent to alpha$/)
  assert.equal(b.ta().value, '')
})

test('a refused send puts the text back and says why', async (t) => {
  const d = deferred()
  const b = await box(t, () => d.promise)
  await typeInto(b.el, 'please retry')
  await inAct(() => b.send().click())
  assert.equal(b.ta().value, '')

  await inAct(async () => { d.reject(new Error('recipient retired')); await d.promise.catch(() => {}) })
  assert.equal(b.ta().value, 'please retry', 'nothing typed is lost')
  assert.match(b.state(), /not sent: recipient retired/)
  assert.equal(b.el.querySelector('.mail-reply-state')?.getAttribute('role'), 'alert')
})

test('text typed while a send is in flight is kept after the refused text', async (t) => {
  const d = deferred()
  const b = await box(t, () => d.promise)
  await typeInto(b.el, 'first')
  await inAct(() => b.send().click())
  await typeInto(b.el, 'second')
  await inAct(async () => { d.reject(new Error('down')); await d.promise.catch(() => {}) })
  assert.equal(b.ta().value, 'first\n\nsecond')
})

test('the user inbox: the reply registers before the send and the mark-read return', async (t) => {
  const TREE = {
    slug: 'mine', name: 'Mine', tiers: { opus: { name: 'Opus' } }, roots: [], nodes: [],
    default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
    default_visibility: 'full',
  } as unknown as TreePayload
  const message = deferred<Response>()
  const calls: string[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url)
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.includes('/nodes/alpha/message')) return message.promise
    const body = path.includes('/inbox/read') ? { read: 1 }
      : path.includes('/inbox') ? { pending: [{ id: 'm1', from: 'alpha', at: '2026-09-30T08:00:00Z', body: 'ok?' }],
        delivered: [], sent: [] }
        : path.includes('/audiences') ? { audiences: [], requests: [] }
          : path.includes('/events') ? { events: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(
    <CurrentOrg.Provider value="mine">
      <InboxPanel slug="mine" tree={TREE} toast={() => {}} close={() => {}} jumpTo={null} />
    </CurrentOrg.Provider>, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush(10) })

  const ta = view.el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
  assert.ok(ta, 'the unread mail is open with its reply box')
  await typeInto(view.el, 'yes, go')
  await inAct(() => (view.el.querySelector('.mail-reply-send') as HTMLButtonElement).click())
  await inAct(async () => { await flush(3) })
  assert.ok(calls.some((c) => c.startsWith('POST') && c.includes('/nodes/alpha/message')), 'the reply went out')
  assert.equal(ta.value, '', 'the box emptied while the server has not answered yet')
  assert.equal(ta.disabled, false)

  await inAct(async () => {
    message.resolve(new Response(JSON.stringify({ accepted: true, queued: 0, id: 'x1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await flush(10)
  })
  assert.match(view.el.querySelector('.mail-reply-state')?.textContent ?? '', /sent to alpha/)
})
