import { flush, inAct, mountView } from './harness'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { ImportSettings } from '../src/canvas/importsettings'
import { IMPORT_REQUEST_KEY, type ImportJob } from '../src/canvas/importjob'

const id = '168a4b88-a29c-49c8-bb2b-efae97c76fce'
const makeJob = (patch: Partial<ImportJob> = {}): ImportJob => ({ id, state: 'running', phase: 'copying', source_root: 'C:/synthetic', organizations: ['sample'], current_org: 'sample', files_copied: 12, bytes_copied: 4096, started_at: '2026-09-08T14:00:00Z', updated_at: '2026-09-08T14:01:00Z', result: null, error: null, ...patch })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function click(el: HTMLElement, label: string) {
  const b = [...el.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === label)
  assert.ok(b, label); await inAct(async () => { b.click(); await flush(8) })
}
async function prepare(el: HTMLElement) {
  await inAct(() => {
    const input = el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'C:/synthetic')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(el, 'Preview organizations')
  await inAct(() => { el.querySelector<HTMLInputElement>('[aria-label="Acknowledge duplicate work"]')!.click() })
}
async function fixture(saved = false) {
  localStorage.clear(); if (saved) localStorage.setItem(IMPORT_REQUEST_KEY, id)
  const original = globalThis.fetch
  const state = { job: null as ImportJob | null, statusFails: false, startLost: false, acceptStart: true, posts: [] as any[], gets: [] as string[] }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/orgs') return json([])
    if (url.endsWith('/preview')) return json({ organizations: [{ slug: 'sample', name: 'Sample', nodes: 2 }], warnings: [] })
    if (init?.method === 'POST') {
      assert.equal(url, '/api/desktop/import-v1/jobs', 'Copy must use the asynchronous route')
      const body = JSON.parse(String(init.body)); state.posts.push(body)
      assert.equal(localStorage.getItem(IMPORT_REQUEST_KEY), body.request_id, 'identity is durable before transmission')
      assert.equal(localStorage.length, 1, 'source/profile paths and payload are not persisted')
      if (state.acceptStart) state.job = makeJob({ id: body.request_id })
      if (state.startLost) throw new TypeError('Lost start response')
      return json({ job: state.job }, 202)
    }
    state.gets.push(url)
    if (state.statusFails) throw new TypeError('Connection offline')
    if (url.endsWith('/current')) return json({ job: state.job })
    assert.ok(url.startsWith('/api/desktop/import-v1/jobs/'))
    return state.job ? json({ job: state.job }) : json({ detail: 'No saved job' }, 404)
  }
  const mount = async () => {
    const view = await mountView(<ImportSettings />, el => el)
    await inAct(async () => { await flush(8) })
    return view
  }
  return { state, mount, close: () => { globalThis.fetch = original; localStorage.clear() } }
}

test('a job outlives the former ten-minute request window and renders measured indeterminate progress', async () => {
  const f = await fixture(), view = await f.mount()
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    await prepare(view.el); await click(view.el, 'Copy selected organizations')
    assert.equal(f.state.posts.length, 1)
    assert.match(view.el.textContent!, /12 files copied; 4,096 bytes/)
    assert.match(view.el.textContent!, /Copying files — sample/)
    const meter = view.el.querySelector('progress')!
    assert.ok(meter); assert.equal(meter.hasAttribute('value'), false, 'unknown total must not become a percentage')
    await inAct(async () => { mock.timers.tick(11 * 60_000); await flush(8) })
    assert.match(view.el.textContent!, /Import in progress/)
    assert.equal(f.state.posts.length, 1, 'elapsed request window must not repeat start')
    f.state.job = makeJob({ id: f.state.job!.id, state: 'succeeded', phase: 'finished', result: { imported: [{ slug: 'sample', name: 'Sample' }], warnings: [] } })
    await click(view.el, 'Check import status')
    assert.match(view.el.textContent!, /Imported Sample/)
    assert.equal(view.el.querySelector('progress'), null)
    assert.equal(localStorage.getItem(IMPORT_REQUEST_KEY), null)
  } finally { await view.unmount(); mock.timers.reset(); f.close() }
})

test('lost start response reconnects without POST replay, status loss remains locked, and remount restores the job', async () => {
  const f = await fixture(); let view = await f.mount()
  try {
    f.state.startLost = true
    await prepare(view.el); await click(view.el, 'Copy selected organizations')
    assert.match(view.el.textContent!, /Import in progress/)
    const requestId = f.state.posts[0].request_id
    assert.ok(f.state.gets.includes(`/api/desktop/import-v1/jobs/${requestId}`))
    f.state.statusFails = true
    await click(view.el, 'Check import status')
    assert.match(view.el.textContent!, /temporarily unavailable/)
    assert.match(view.el.textContent!, /does not mean the import stopped/)
    assert.equal(view.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!.disabled, true)
    await view.unmount(); view = await f.mount()
    assert.equal(view.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!.disabled, true)
    f.state.statusFails = false
    await click(view.el, 'Check import status')
    assert.match(view.el.textContent!, /Import in progress/)
    assert.doesNotMatch(view.el.textContent!, /temporarily unavailable/)
    assert.equal(f.state.posts.length, 1)
    assert.equal(localStorage.getItem(IMPORT_REQUEST_KEY), requestId)
  } finally { await view.unmount(); f.close() }
})

test('unknown saved request after reload requires reentry and acknowledgement before an explicit same-ID retry', async () => {
  const f = await fixture(true), view = await f.mount()
  try {
    assert.match(view.el.textContent!, /No saved job was found/)
    assert.equal(f.state.posts.length, 0)
    await click(view.el, 'Check import status')
    assert.equal(f.state.posts.length, 0, 'status checks never POST')
    await prepare(view.el)
    assert.ok(![...view.el.querySelectorAll('button')].some(b => b.textContent === 'Copy selected organizations'))
    await click(view.el, 'Retry start with same request ID')
    assert.equal(f.state.posts.length, 1)
    assert.equal(f.state.posts[0].request_id, id)
    assert.equal(f.state.posts[0].acknowledge_duplicate_work, true)
    assert.match(view.el.textContent!, /Import in progress/)
  } finally { await view.unmount(); f.close() }
})

test('an unrecorded start retries only explicitly with the original in-memory payload and same ID', async () => {
  const f = await fixture(), view = await f.mount()
  try {
    f.state.acceptStart = false; f.state.startLost = true
    await prepare(view.el); await click(view.el, 'Copy selected organizations')
    assert.match(view.el.textContent!, /No saved job was found/)
    assert.equal(view.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!.disabled, true, 'original retry fields cannot silently change')
    assert.equal(f.state.posts.length, 1)
    f.state.acceptStart = true; f.state.startLost = false
    await click(view.el, 'Retry start with same request ID')
    assert.equal(f.state.posts.length, 2)
    assert.deepEqual(f.state.posts[1], f.state.posts[0], 'same ID and exact original payload')
  } finally { await view.unmount(); f.close() }
})

test('denied ID persistence refuses transmission and malformed status cannot unlock Copy', async () => {
  const f = await fixture(), view = await f.mount()
  const proto = Object.getPrototypeOf(localStorage), original = proto.setItem
  try {
    await prepare(view.el)
    proto.setItem = () => { throw new Error('Storage denied') }
    await click(view.el, 'Copy selected organizations')
    assert.equal(f.state.posts.length, 0)
    assert.match(view.el.textContent!, /Cannot save the import request ID/)
    proto.setItem = original
    await click(view.el, 'Check import status')
    await click(view.el, 'Copy selected organizations')
    f.state.job!.bytes_copied = Number.NaN
    await click(view.el, 'Check import status')
    assert.match(view.el.textContent!, /invalid job/)
    assert.equal(view.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!.disabled, true)
    assert.equal(f.state.posts.length, 1)
  } finally { proto.setItem = original; await view.unmount(); f.close() }
})

test('interrupted job restores durable partial receipts and does not auto-resume', async () => {
  const f = await fixture(true)
  f.state.job = makeJob({ state: 'interrupted', error: 'Engine restarted; publication outcome needs review.', result: {
    imported: [{ slug: 'sample', name: 'Sample', warnings: ['Skipped linked dependency: node_modules/link.'] }],
    failed: [{ slug: 'next', error: 'Not committed.', not_attempted: ['last'] }], warnings: [],
  } })
  const view = await f.mount()
  try {
    assert.match(view.el.textContent!, /Engine restarted; publication outcome needs review/)
    assert.match(view.el.textContent!, /Imported Sample/)
    assert.match(view.el.textContent!, /Skipped linked dependency/)
    assert.match(view.el.textContent!, /Not copied: last/)
    assert.equal(f.state.posts.length, 0)
    assert.equal(view.el.querySelector('progress'), null)
  } finally { await view.unmount(); f.close() }
})
