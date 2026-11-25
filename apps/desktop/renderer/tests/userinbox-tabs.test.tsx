// userinbox-tabs.test.tsx — the user's inbox tab row is inbox · sent ·
// transfers. USER 2026-11-25 09:34:50Z maa0bf05fb7a7: "and remove this record
// tab, it's malformed and not useful anyway"; 09:34Z m1a3bfa49d5b8 "make it a
// tab next to inbox and sent" (docket
// mailboxes-transfers-becomes-its-own-tab-in-every).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userinbox-tabs

import './harness'
import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import * as mail from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import type { MailTransfer } from '../src/api'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

const tree = { slug: 'mine', name: 'Mine', tiers: {}, roots: [], nodes: [], asks: [],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full' } as unknown as TreePayload
const upload: MailTransfer = { id: 'local-fixture', direction: 'upload', peer: '@net:fixture',
  message_id: 'mail-fixture', state: 'uploading', attempt: 1,
  files: [{ id: 'file-fixture', name: 'retained.txt', total: 100, confirmed: 40, processed: 60 }] }

async function mount(tc: TestContext, transfers: MailTransfer[]) {
  const oldFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    const path = String(url); urls.push(path)
    const body = path.includes('/transfers') ? { transfers, next_cursor: null }
      : path.includes('/inbox') ? { pending: [], delivered: [], sent: [] }
      : path.includes('/audiences') ? { audiences: [], requests: [] }
      : path.includes('/events') ? { events: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(<CurrentOrg.Provider value="mine">
    <InboxPanel slug="mine" tree={tree} toast={() => {}} close={() => {}} jumpTo={null} />
  </CurrentOrg.Provider>, el => el)
  tc.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush(10) })
  return { view, urls }
}
const tabs = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.mail-folders button')]
  .map(b => (b.textContent ?? '').replace(/\d+$/, '').trim())

test('the user inbox has no record tab, and its renderer is gone', async t => {
  const { view, urls } = await mount(t, [])
  assert.deepEqual(tabs(view.el), ['inbox', 'sent'], 'inbox · sent, no record')
  assert.equal(urls.some(u => u.includes('/events')), false, 'nothing reads the record for this window')
  assert.equal('OrgRecord' in mail, false, 'the record view is removed, not just unlinked')
})

test('the user inbox gets the transfers tab beside inbox and sent', async t => {
  const { view, urls } = await mount(t, [upload])
  assert.ok(urls.some(u => u.includes('/transfers') && u.includes('agent=user')), "it reads the user's own transfers")
  assert.deepEqual(tabs(view.el), ['inbox', 'sent', 'transfers'], 'inbox · sent · transfers')
  const tab = [...view.el.querySelectorAll<HTMLButtonElement>('.mail-folders button')].at(-1)!
  assert.equal(tab.querySelector('.tab-count')?.textContent, '1', 'the unfinished one is counted')
  await inAct(() => tab.click()); await inAct(async () => { await flush(5) })
  const shown = (el: Element) => !el.closest('[hidden]')
  assert.equal([...view.el.querySelectorAll('.transfer-card')].filter(shown).length, 1, 'the tab lists it')
  assert.equal([...view.el.querySelectorAll('.mailpane')].filter(shown).length, 0, 'the mail lists are hidden')
})
