import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import { bumpLive } from '../src/livebus'
import type { OrgInboxEntry, TreePayload } from '../src/types'

// The org mailbox updates live (USER 2026-11-26 15:05:32Z m553423f79f7e "i think the org mailbox doesnt update in
// realtime as new mail arrives or is sent, unlike other mailboxes"; docket org-mailbox-panel-doesn-t-update-live-as-mail-ar).
// The other mailboxes read through usePolled, which every ws 'changed' and every local mutation wakes (livebus.ts).
// The org mailbox fetched its log ONCE when it opened, so an arrival or a send showed only after a reopen.

const row = (id: string, dir: 'in' | 'out', body: string): OrgInboxEntry =>
  ({ id, dir, peer: '@net:alice.fixture.aa0011', body, at: '2026-11-26T15:00:00Z', ...(dir === 'out' ? { by: 'front' } : {}) }) as OrgInboxEntry

test('an arrival and a send show in the open org mailbox at the next live bump, without a reopen', async t => {
  const log: OrgInboxEntry[] = [row('m1', 'in', 'first letter')]
  let reads = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/org_inbox')) reads++
    const body = url.endsWith('/org_inbox') ? { entries: [...log], total: log.length, unread: 0 } : { transfers: [] }
    return new Response(JSON.stringify(body), { headers: { 'X-Orgtree-Instance': 'fixture' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const inbox = { entries: [], total: 1, unread: 0, visible: true, holders: [] } as unknown as TreePayload['org_inbox']
  const view = await mountView(<OrgInboxModal slug="mine" map={new Map()} toast={() => {}} close={() => {}} inbox={inbox}
    net={{ slug: 'home.fixture.123abc', hubs: [] } as unknown as TreePayload['net']} />, host => host)
  t.after(() => view.unmount())
  await flush(6)
  assert.match(view.el.textContent ?? '', /first letter/)
  const before = reads
  // mail arrives and an agent sends as the org; the engine's 'changed' wakes the bus (App.tsx's ws handler)
  log.push(row('m2', 'in', 'second arrival'), row('m3', 'out', 'reply sent as the org'))
  await inAct(async () => { bumpLive(); await new Promise(r => setTimeout(r, 220)); await flush(8) })
  assert.ok(reads > before, 'the live bump reads the org mailbox again')
  assert.match(view.el.textContent ?? '', /second arrival/, 'the arrival shows in the open inbox')
  const sent = [...view.el.querySelectorAll('button')].find(b => /^sent/i.test(b.textContent?.trim() ?? ''))
  assert.ok(sent, 'a sent folder button')
  await inAct(() => sent!.click()); await flush(6)
  assert.match(view.el.textContent ?? '', /reply sent as the org/, 'the send shows in the open sent folder')
})
