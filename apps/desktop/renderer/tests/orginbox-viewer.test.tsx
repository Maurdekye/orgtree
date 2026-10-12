import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { OrgInboxEntry } from '../src/types'
const entries: OrgInboxEntry[] = [
  { id: 'incoming', dir: 'in', peer: '@net:peer.fixture', body: 'Retained incoming body', at: '2026-10-12T08:00:00Z', attachments: [{ name: 'retained.txt', path: 'legacy/path', bytes: 3 }] },
  { id: 'outgoing', dir: 'out', peer: '@org:neighbor', body: 'Retained outgoing body', by: 'user', at: '2026-10-12T08:01:00Z', reply_to: { id: 'incoming', from: '@net:peer.fixture', at: '2026-10-12T08:00:00Z', gist: 'Recorded reply quote' } },
]
test('org inbox reads retained mail and attachments without human composition', async t => {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return new Response(JSON.stringify(url.endsWith('/org_inbox') ? { entries, total: 2, unread: 1 } : { transfers: [] }),
      { headers: { 'X-Orgtree-Instance': 'fixture' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const view = await mountView(<OrgInboxModal slug="mine" map={new Map()} toast={() => {}} close={() => {}}
    inbox={{ entries: [], total: 2, unread: 1, visible: true, holders: [] }} jumpTo="incoming"
    net={{ hubs: [{ id: 'fixture', address: 'http://127.0.0.1', name: 'Fixture hub', enabled: false, connected: false, queued: 0, roster: [] }] }} />, host => host)
  t.after(() => view.unmount())
  await flush(8)
  const buttons = () => [...view.el.querySelectorAll('button')]
  const click = async (label: string) => {
    const button = buttons().find(b => b.textContent?.trim().toLowerCase().startsWith(label))
    assert.ok(button, label + ' control exists')
    await inAct(() => button.click()); await flush(3)
  }
  assert.match(view.el.textContent ?? '', /Retained incoming body/)
  assert.match(view.el.textContent ?? '', /retained.txt/)
  assert.ok(calls.some(c => c.endsWith('/org_inbox')), 'full mailbox requested')
  assert.equal(buttons().some(b => /compose mail|^reply$|^send$|attach saved/i.test(b.textContent?.trim() ?? '')), false)
  assert.equal(view.el.querySelector('textarea,input[type="file"],.mail-reply,.cmp-modal'), null)
  await click('sent')
  const row = view.el.querySelector<HTMLElement>('.mailrow')
  assert.ok(row, 'retained sent row still listed')
  await inAct(() => row.click()); await flush(3)
  assert.match(view.el.textContent ?? '', /Retained outgoing body/)
  assert.match(view.el.textContent ?? '', /Recorded reply quote/)
  await click('mailservers')
  assert.match(view.el.textContent ?? '', /Fixture hub/)
  assert.equal(calls.some(c => /org_inbox\/(send|upload|staging)/.test(c)), false)
})
