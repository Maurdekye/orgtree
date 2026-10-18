import { withoutMailTransfers } from './mailtransfers.fixture'
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import { InboxView } from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const TREE = { slug: 'history', name: 'History', roots: [], nodes: [], tiers: {}, asks: [],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, default_visibility: 'full' } as unknown as TreePayload
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = () => {}
const mail = (n: number, sent = false) => ({ id: `${sent ? 's' : 'm'}${n}`, from: sent ? '@user' : 'peer', to: sent ? 'peer' : '@user',
  at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(), body: `${sent ? 'sent' : 'incoming'}-history-${n}`, kind: 'message' })

for (const scope of ['user', 'agent', 'project'] as const) for (const folder of ['inbox', 'sent'] as const) test(`${scope} ${folder} scrolls past the feed cap to the oldest row without moving the reader`, async t => {
  const pageSize = scope === 'user' ? 200 : 150
  const archive = Array.from({ length: 650 }, (_, i) => mail(i + 1)).reverse()
  const outgoing = Array.from({ length: 430 }, (_, i) => mail(i + 1, true)).reverse()
  const calls: { folder: string; before: string | null }[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = withoutMailTransfers((async (input: string) => {
    const url = new URL(String(input), 'http://fixture.invalid')
    let body: unknown = {}
    if (url.pathname.endsWith('/inbox') && url.searchParams.has('folder')) {
      const f = url.searchParams.get('folder')!, before = url.searchParams.get('before')
      calls.push({ folder: f, before })
      const all = (f === 'sent' ? outgoing : archive).filter(m => !before || Number(m.id.slice(1)) < Number(before))
      const rows = all.slice(0, pageSize)
      body = { pending: [], delivered: f === 'inbox' ? rows : [], sent: f === 'sent' ? rows : [],
        next_cursor: all.length > pageSize ? rows.at(-1)!.id.slice(1) : null }
    } else if (url.searchParams.has('tags_only')) body = { tag_choices: [] }
    else if (url.pathname.endsWith('/inbox')) body = { pending: [], delivered: archive.slice(0, pageSize), sent: outgoing.slice(0, pageSize) }
    else if (url.pathname.endsWith('/audiences')) body = { audiences: [], requests: [] }
    else if (url.pathname.endsWith('/events')) body = { events: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  t.after(() => { globalThis.fetch = oldFetch })
  const view = await mountView(<CurrentOrg.Provider value="history">{scope === 'user'
    ? <InboxPanel slug="history" tree={TREE} close={() => {}} jumpTo={null} toast={() => {}} />
    : <InboxView slug="history" nid={scope} toast={() => {}} />}</CurrentOrg.Provider>, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(10) })
  if (folder === 'sent') {
    const button = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim().toLowerCase() === 'sent')
    assert.ok(button, 'positive control: sent folder exists')
    await inAct(async () => { button.click(); await flush(5) })
  }
  const row = view.el.querySelector<HTMLElement>('.mailrow')
  assert.ok(row, 'positive control: the bounded feed rendered mail')
  await inAct(() => row.click())
  const selected = view.el.querySelector('.mailer-read')?.textContent
  const list = view.el.querySelector<HTMLElement>('.mailer-list')!
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 400 } })
  list.scrollTop = 900
  for (let i = 0; i < 24; i++) await inAct(async () => {
    list.dispatchEvent(new window.Event('scroll', { bubbles: true })); await flush(2)
  })
  assert.equal(new RegExp(`${folder === 'sent' ? 'sent' : 'incoming'}-history-1(?![0-9])`).test(view.el.textContent!), true, 'the oldest retained mail must be reachable beyond the feed cap')
  assert.equal(list.scrollTop, 900, 'appending older rows must retain scroll offset')
  assert.equal(view.el.querySelector('.mailer-read')?.textContent, selected, 'paging must retain the selected mail')
  const requested = calls.filter(c => c.folder === folder)
  const cursors: (string | null)[] = [null]
  for (let n = (folder === 'sent' ? 430 : 650) - pageSize + 1; n > 1; n -= pageSize) cursors.push(String(n))
  assert.deepEqual(requested.map(c => c.before), cursors, 'bounded pages seek from the prior numeric id, never offset or dates')
})
