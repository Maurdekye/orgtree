import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { OrgInboxEntry, TreePayload } from '../src/types'

// The org mailbox updates live (USER 2026-11-26 15:05:32Z m553423f79f7e "i think the org mailbox doesnt update in
// realtime as new mail arrives or is sent, unlike other mailboxes"; docket org-mailbox-panel-doesn-t-update-live-as-mail-ar).
// The user's and agents' mailboxes read from the live record feed. The org mailbox's live part is the tree's org_inbox
// summary (its newest few rows, total and unread), which the feed keeps current; the panel fetched the full log ONCE
// when it opened and never again, so an arrival or a send showed only after a reopen.

const row = (id: string, dir: 'in' | 'out', body: string, state?: OrgInboxEntry['state']): OrgInboxEntry =>
  ({ id, dir, peer: '@net:alice.fixture.aa0011', body, at: '2026-11-26T15:00:00Z', ...(dir === 'out' ? { by: 'front' } : {}),
    ...(state ? { state } : {}) }) as OrgInboxEntry
const summary = (log: OrgInboxEntry[], unread = 0) =>
  ({ entries: log.slice(-3).map(e => ({ ...e })), total: log.length, unread, visible: true, holders: [] }) as unknown as TreePayload['org_inbox']
const NET = { slug: 'home.fixture.123abc', hubs: [] } as unknown as TreePayload['net']

async function open(t: test.TestContext, log: OrgInboxEntry[]) {
  const reads = { n: 0 }
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/org_inbox')) reads.n++
    const body = url.endsWith('/org_inbox') ? { entries: log.map(e => ({ ...e })), total: log.length, unread: 0 } : { transfers: [] }
    return new Response(JSON.stringify(body), { headers: { 'X-Orgtree-Instance': 'fixture' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const el = (inbox: TreePayload['org_inbox']) =>
    <OrgInboxModal slug="mine" map={new Map()} toast={() => {}} close={() => {}} inbox={inbox} net={NET} />
  const view = await mountView(el(summary(log)), host => host)
  t.after(() => view.unmount())
  await flush(6)
  const rerender = async (inbox: TreePayload['org_inbox']) => { await view.render(el(inbox)); await inAct(async () => { await flush(8) }) }
  return { view, reads, rerender }
}
const text = (el: HTMLElement) => el.textContent ?? ''
const folder = async (el: HTMLElement, name: RegExp) => {
  const b = [...el.querySelectorAll('button')].find(x => name.test(x.textContent?.trim() ?? '')) ?? assert.fail(`no ${name} folder`)
  await inAct(() => b.click()); await flush(6)
}

test('an arrival and a send show in the open org mailbox as soon as the live summary moves, without a reopen', async t => {
  // a log longer than the summary's preview, so the panel shows the fetched log, not the preview
  const log = [row('m0', 'in', 'zeroth letter'), row('m1', 'in', 'first letter'), row('m2', 'out', 'first answer', 'delivered'),
    row('m3', 'in', 'third letter')]
  const { view, reads, rerender } = await open(t, log)
  assert.match(text(view.el), /zeroth letter/)
  const before = reads.n
  log.push(row('m4', 'in', 'second arrival'), row('m5', 'out', 'reply sent as the org', 'queued'))
  await rerender(summary(log, 1))
  assert.ok(reads.n > before, 'the moved summary reads the org mailbox log again')
  assert.match(text(view.el), /second arrival/, 'the arrival shows in the open inbox')
  assert.match(text(view.el), /zeroth letter/, 'the older rows stay')
  await folder(view.el, /^sent/i)
  assert.match(text(view.el), /reply sent as the org/, 'the send shows in the open sent folder')
})

test('a delivery mark moving on a sent row re-reads the log; an unchanged summary reads nothing', async t => {
  const log = [row('m1', 'in', 'first letter'), row('m2', 'out', 'first answer', 'queued')]
  const { reads, rerender } = await open(t, log)
  const before = reads.n
  await rerender(summary(log))
  assert.equal(reads.n, before, 'a new tree object with the same summary reads nothing')
  log[1] = { ...log[1]!, state: 'delivered' }
  await rerender(summary(log))
  assert.equal(reads.n, before + 1, 'the tick moved: one read')
})
