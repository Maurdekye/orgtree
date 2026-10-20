import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { item, preview, TicketStaffFixture } from './ticketstaffmenu.fixture'
import { requestCount, resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { quickStaffPath } from '../src/canvas/quickstaff'
import type { WorkItem } from '../src/types'

const top = () => document.querySelector<HTMLElement>('.ctxmenu:not(.ctxmenu-submenu)')!
const labels = (root = top()) => [...root.children].map(el => el.getAttribute('role') === 'separator' ? 'sep' : el.querySelector('[role="menuitem"]')!.textContent!.trim())
const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.trim() === text)
async function right(target: Element) {
  await inAct(() => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush(5)
}
async function expand(text: string) {
  const b = named(text); assert.ok(!!b, text + ' exists')
  await inAct(() => b!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await flush()
}
async function setup(t: TestContext, value: WorkItem, opts: { mode?: string; denied?: boolean; showRow?: boolean; current?: WorkItem } = {}) {
  resetStaffingOptionsForTests(); const original = globalThis.fetch
  const sent: Record<string, unknown>[] = [], notices: string[][] = [], paths: string[] = []
  globalThis.fetch = async (input, init) => {
    const path = String(input); paths.push((init?.method ?? 'GET') + ' ' + path)
    if (path.endsWith('/quick-staff')) {
      if (opts.denied) return new Response(JSON.stringify({ detail: 'Staffing is not permitted' }), { status: 403 })
      if (init?.method === 'POST') { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ message: 'Synthetic staff request accepted' })) }
      return new Response(JSON.stringify(preview(opts.current ?? value, opts.mode)))
    }
    return new Response(JSON.stringify(path.includes('/work-items/') ? { item: opts.current ?? value } : { providers: [] }))
  }
  const v = await mountView(<TicketStaffFixture value={value} showRow={opts.showRow} notify={message => notices.push(message)} />, el => el)
  await flush(5)
  t.after(async () => { await v.unmount(); globalThis.fetch = original; resetStaffingOptionsForTests() })
  return { v, sent, notices, paths, link: v.el.querySelector('[data-link="markdown"] [data-object-nav="ticket"]')! }
}

for (const status of ['backlogged', 'open', 'done'] as const) test(`${status}: every ticket link has exactly the docket row menu`, async t => {
  const value = item(status, 'parity-' + status), f = await setup(t, value)
  await right(f.v.el.querySelector('.docket-row')!)
  const row = labels()
  assert.equal(row.includes('Staff… ▸'), status === 'backlogged')
  for (const link of f.v.el.querySelectorAll('[data-link] [data-object-nav="ticket"]')) {
    await right(link); assert.deepEqual(labels(), row)
  }
  assert.deepEqual(f.sent, [], 'inspection never submits staffing')
  assert.equal(requestCount(quickStaffPath('synthetic-org', value.slug)), status === 'backlogged' ? 1 : 0)
})

test('archived backlog has the same menu and no staffing offer', async t => {
  const f = await setup(t, { ...item(), archived: true })
  await right(f.v.el.querySelector('.docket-row')!); const row = labels()
  await right(f.link); assert.deepEqual(labels(), row)
  assert.equal(labels().some(label => label.startsWith('Staff')), false)
  assert.equal(f.paths.some(path => path.includes('/quick-staff')), false)
})
test('transcript Staff uses the existing request action once, with shared feedback', async t => {
  const f = await setup(t, item('backlogged', 'submit-request'))
  await right(f.link); const staff = named('Staff… ▸'); assert.ok(!!staff)
  await inAct(() => staff!.click()); await flush(5)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0]!.mode, 'request')
  assert.deepEqual(f.sent[0]!.owner, item().owner)
  assert.equal(typeof f.sent[0]!.request_id, 'string')
  assert.equal(f.notices.some(messages => messages.includes('Synthetic staff request accepted')), true)
})
test('immediate staffing retains model/effort gates and submits the canonical selection', async t => {
  const f = await setup(t, item('backlogged', 'submit-immediate'), { mode: 'top_level' })
  await right(f.link); const staff = named('Staff… ▸'); assert.ok(!!staff)
  assert.equal(staff!.getAttribute('aria-disabled'), 'true')
  await inAct(() => staff!.click()); assert.deepEqual(f.sent, [])
  await expand('Staff… ▸'); await expand('sol ▸')
  await inAct(() => named('high')!.click()); await flush(5)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0]!.mode, 'top_level'); assert.equal(f.sent[0]!.tier, 'sol'); assert.equal(f.sent[0]!.effort, 'high')
})
test('denied staffing remains a disabled canonical entry on row and transcript', async t => {
  const f = await setup(t, item(), { denied: true })
  await right(f.v.el.querySelector('.docket-row')!); const row = labels()
  await right(f.link); assert.deepEqual(labels(), row)
  const staff = named('Staff…'); assert.ok(!!staff); assert.equal(staff!.disabled, true)
  assert.deepEqual(f.sent, [])
})
test('standalone transcript link gains staffing without mounting a hidden docket', async t => {
  const value = item('backlogged', 'standalone'), f = await setup(t, value, { showRow: false })
  await right(f.link); assert.ok(!!named('Staff… ▸'))
  assert.equal(f.v.el.querySelector('.docket-row') === null, true)
  assert.equal(requestCount(quickStaffPath('synthetic-org', value.slug)), 1)
  assert.deepEqual(f.sent, [])
})
test('owner submenu retains canonical Open in second position', async t => {
  const f = await setup(t, item('open'))
  await right(f.link); await expand('Owner… ▸')
  const owner = document.querySelector<HTMLElement>('.ctxmenu-submenu')!
  assert.equal(labels(owner)[1], 'Open ▸')
})
test('current fetched status, rather than the historical link, controls eligibility', async t => {
  const f = await setup(t, item(), { showRow: false, current: item('open') })
  await right(f.link)
  assert.equal(labels().some(label => label.startsWith('Staff')), false)
  assert.equal(f.paths.some(path => path.includes('/quick-staff')), false)
})
