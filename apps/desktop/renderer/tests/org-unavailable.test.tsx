import { flush, mountView } from './harness'
import { act } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgRows } from '../src/shell/orgrows'
import type { OrgListEntry } from '../src/types'

const unavailable: OrgListEntry = {
  slug: 'held-back', name: 'Held back', nodes: 0, live: 0, created: null,
  state: 'unavailable', state_reason: 'Conversion failed at an agent record.',
}

test('unavailable org has a reason and only Retry; clicks and Enter cannot open it', async t => {
  const picked: string[] = [], deleted: string[] = []
  const view = await mountView(<OrgRows orgs={[unavailable]} slug={null}
    onPick={s => picked.push(s)} onDelete={o => deleted.push(o.slug)} />, el => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.org') as HTMLElement
  assert.match(row.textContent || '', /Held back/)
  assert.match(row.textContent || '', /Unavailable — Conversion failed/)
  assert.deepEqual([...row.querySelectorAll('button')].map(b => b.textContent), ['Retry'])
  assert.equal(row.getAttribute('role'), null)
  assert.equal(row.getAttribute('tabindex'), null)
  await act(async () => {
    row.click()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  assert.deepEqual(picked, [])
  assert.deepEqual(deleted, [])
})

test('Retry sends one lifecycle request and success makes the row normal', async t => {
  const old = globalThis.fetch
  let finish!: (r: Response) => void
  const requests: [string, string | undefined][] = []
  globalThis.fetch = ((url, init) => {
    // OrgRows now reads import-failure notices through the shared app feed.
    // This fixture has no feed; keep its read separate from lifecycle writes.
    if (String(url) === '/api/app/records') return Promise.resolve(
      new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }))
    requests.push([String(url), init?.method])
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = old })
  const picked: string[] = []
  const view = await mountView(<OrgRows orgs={[unavailable]} slug={null}
    onPick={s => picked.push(s)} onDelete={() => {}} />, el => el)
  t.after(() => view.unmount())
  const retry = view.el.querySelector('button')!
  await act(async () => { retry.click(); retry.click() })
  assert.deepEqual(requests, [['/api/orgs/held-back/retry', 'POST']])
  assert.equal(retry.disabled, true)
  await act(async () => {
    finish(new Response(JSON.stringify({ ...unavailable, state: 'active', state_reason: null, live: 2 }),
      { headers: { 'Content-Type': 'application/json' } }))
    await flush()
  })
  assert.equal(view.el.querySelector('.org-unavailable'), null)
  assert.equal(view.el.querySelector('.org')?.getAttribute('role'), 'button')
  assert.equal(view.el.querySelector('.org-counts')?.textContent, '2')
  await act(async () => { (view.el.querySelector('.org') as HTMLElement).click() })
  assert.deepEqual(picked, ['held-back'])
})

test('failed Retry keeps the row unavailable and shows the new reason', async t => {
  const old = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...unavailable,
    state_reason: 'The migration was written by a newer build.' }),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  t.after(() => { globalThis.fetch = old })
  const view = await mountView(<OrgRows orgs={[unavailable]} slug={null}
    onPick={() => assert.fail('unavailable org opened')} onDelete={() => assert.fail('deleted')} />, el => el)
  t.after(() => view.unmount())
  await act(async () => { view.el.querySelector('button')!.click(); await flush() })
  assert.match(view.el.textContent || '', /newer build/)
  assert.ok(view.el.querySelector('.org-unavailable'))
  assert.equal(view.el.querySelector('button')?.textContent, 'Retry')
  assert.equal(view.el.querySelector('.org-del'), null)
})

test('Retry of a legacy trashed org removes its row without making it openable', async t => {
  const old = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...unavailable, state: 'trashed' }),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  t.after(() => { globalThis.fetch = old })
  const view = await mountView(<OrgRows orgs={[unavailable]} slug={null}
    onPick={() => assert.fail('trashed org opened')} onDelete={() => assert.fail('deleted')} />, el => el)
  t.after(() => view.unmount())
  await act(async () => { view.el.querySelector('button')!.click(); await flush() })
  assert.equal(view.el.querySelector('.org'), null)
})
