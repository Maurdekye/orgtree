import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { HubContactChip, setHubchatInstalled, setKnownOrgs } from '../src/canvas/agentmentions'
import { RefMdBody } from '../src/canvas/refmd'
import { RefProse } from '../src/canvas/reflinks'
import { ToolRefs } from '../src/canvas/toolrefs'
import type { RefWorld } from '../src/canvas/reflinks'

const world: RefWorld = { org: 'org', agents: new Map(), items: new Map() }
let now = 1_800_000_000_000

function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => now)
  setHubchatInstalled(false)
  now += 61_000
  const oldFetch = globalThis.fetch, oldOpen = window.open
  const requests: string[] = [], opened: string[] = []
  let answer: unknown = { hubchat_pc: false }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    if (answer instanceof Error) throw answer
    return { ok: true, status: 200, headers: new Headers(), json: async () => answer }
  }) as typeof fetch
  window.open = ((url: string | URL) => { opened.push(String(url)); return null }) as typeof window.open
  t.after(() => { globalThis.fetch = oldFetch; window.open = oldOpen; setKnownOrgs([]); setHubchatInstalled(false) })
  return { requests, opened, answer: (v: unknown) => { answer = v } }
}

test('hub chips discover an installed Hubchat without phone UI and update Markdown, prose and tools', async t => {
  const f = fixture(t)
  let resolve!: (v: Response) => void
  globalThis.fetch = ((input: RequestInfo | URL) => {
    f.requests.push(String(input))
    return new Promise<Response>(r => { resolve = r })
  }) as typeof fetch
  const view = await mountView(<div>
    <RefMdBody html={{ __html: '<p>Ask @net:alice.123456</p>' }} world={world} />
    <RefProse text="Ask @net:bob.abcdef" world={world} />
    <ToolRefs refs={[{ kind: 'hub' as never, id: '@org:remote-org' }]} />
  </div>, h => h)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelectorAll('[data-hub-address]').length, 3)
  assert.equal(f.requests.length, 1, 'all chip surfaces share one availability request without a phone panel')
  assert.ok(f.requests[0].endsWith('/api/desktop/phone'))
  await inAct(async () => {
    resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ hubchat_pc: true }) } as Response)
    await flush(5)
  })
  for (const chip of view.el.querySelectorAll<HTMLButtonElement>('[data-hub-address]')) {
    assert.equal(chip.hasAttribute('aria-disabled'), false, chip.dataset.hubAddress)
    await inAct(async () => { chip.click(); await flush(2) })
  }
  assert.deepEqual(f.opened, ['hubchat://chat?to=%40net%3Aalice.123456',
    'hubchat://chat?to=%40net%3Abob.abcdef', 'hubchat://chat?to=%40org%3Aremote-org'])
})

test('genuinely absent Hubchat keeps external chips inert while local organizations stay available', async t => {
  const f = fixture(t)
  setKnownOrgs(['local-org'])
  const view = await mountView(<div><HubContactChip address="@net:alice.123456" />
    <HubContactChip address="@org:local-org" /></div>, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  assert.equal(f.requests.length, 1, 'absence is checked independently of phone UI')
  const remote = view.el.querySelector<HTMLButtonElement>('[data-hub-address="@net:alice.123456"]')!
  assert.equal(remote.getAttribute('aria-disabled'), 'true')
  assert.equal(remote.title, "Hubchat isn't installed")
  remote.click()
  assert.deepEqual(f.opened, [])
  assert.equal(view.el.querySelector('[data-hub-address="@org:local-org"]')?.hasAttribute('aria-disabled'), false)
})

test('focus refreshes stale availability once and updates mounted chips after uninstall', async t => {
  const f = fixture(t)
  f.answer({ hubchat_pc: true })
  const view = await mountView(<div><HubContactChip address="@net:alice.123456" />
    <HubContactChip address="@net:bob.abcdef" /></div>, h => h)
  await inAct(async () => { await flush(5) })
  assert.equal(f.requests.length, 1)
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(3) })
  assert.equal(f.requests.length, 1, 'fresh cache avoids a request on every focus')
  now += 61_000
  f.answer({ hubchat_pc: false })
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(5) })
  assert.equal(f.requests.length, 2, 'one refresh shared by mounted consumers')
  assert.equal(view.el.querySelectorAll('[aria-disabled="true"]').length, 2)
  await view.unmount()
  now += 61_000
  window.dispatchEvent(new Event('focus'))
  await flush(3)
  assert.equal(f.requests.length, 2, 'unmount removes the shared focus listener')
})

test('failed and malformed availability reads preserve the last known state and allow a later retry', async t => {
  const f = fixture(t)
  setHubchatInstalled(true)
  now += 61_000
  f.answer(new Error('offline'))
  const view = await mountView(<HubContactChip address="@net:alice.123456" />, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  assert.equal(f.requests.length, 1)
  assert.equal(view.el.querySelector('button')?.hasAttribute('aria-disabled'), false)
  now += 61_000
  f.answer({ hubchat_pc: 'false' })
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(5) })
  assert.equal(f.requests.length, 2)
  assert.equal(view.el.querySelector('button')?.hasAttribute('aria-disabled'), false, 'malformed value cannot erase known installation')
  now += 61_000
  f.answer({ hubchat_pc: false })
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(5) })
  assert.equal(f.requests.length, 3)
  assert.equal(view.el.querySelector('button')?.getAttribute('aria-disabled'), 'true')
})
