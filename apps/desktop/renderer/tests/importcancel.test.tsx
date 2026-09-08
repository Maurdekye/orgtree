import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ImportSettings } from '../src/canvas/importsettings'
import { IMPORT_REQUEST_KEY, type ImportJob } from '../src/canvas/importjob'

const id = '168a4b88-a29c-49c8-bb2b-efae97c76fce'
const job = (patch: Partial<ImportJob> = {}): ImportJob => ({ id, state: 'planning', phase: 'counting', source_root: 'C:/synthetic', organizations: ['sample'], current_org: 'sample', files_copied: 0, bytes_copied: 0, started_at: '2026-09-08T16:00:00Z', updated_at: '2026-09-08T16:00:01Z', result: null, error: null, cancellable: true, cancel_requested: false, total_files: null, total_bytes: null, progress_percent: null, eta_seconds: null, ...patch })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
async function click(el: HTMLElement, text: string) {
  const b = [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)
  assert.ok(b); await inAct(async () => { b.click(); await flush(8) })
}
function fixture(initial: ImportJob | null = job()) {
  localStorage.clear(); if (initial) localStorage.setItem(IMPORT_REQUEST_KEY, id)
  const original = globalThis.fetch
  const state = { job: initial, cancels: 0, starts: 0, offline: false, lost: false, refuse: false, delayed: null as Promise<Response> | null, delayedCancel: null as Promise<Response> | null }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/orgs') return json([])
    if (url.endsWith('/preview')) return json({ organizations: [{ slug: 'sample', name: 'Sample', nodes: 1, native_context: [{ node: 'worker', provider: 'claude', status: 'available' }], memory: [{ base: 'worker', nodes: ['worker'], status: 'held', reason: 'Memory destination differs.' }] }], warnings: [] })
    if (init?.method === 'POST') {
      if (!url.endsWith('/cancel')) { state.starts++; throw Error('Unexpected new import') }
      assert.equal(url, `/api/desktop/import-v1/jobs/${id}/cancel`)
      assert.deepEqual(JSON.parse(String(init.body)), {})
      state.cancels++
      if (state.delayedCancel) return state.delayedCancel
      if (state.refuse) { state.job = job({ state: 'running', phase: 'publishing', cancellable: false }); return json({ detail: 'Publication cannot be cancelled.' }, 409) }
      state.job = { ...state.job!, state: 'cancelling', cancel_requested: true, cancellable: false }
      if (state.lost) { state.offline = true; throw new TypeError('Lost cancellation response') }
      return json({ job: state.job })
    }
    if (state.offline) throw new TypeError('Offline')
    if (state.delayed) { const next = state.delayed; state.delayed = null; return next }
    return json({ job: state.job })
  }
  return { state, mount: async () => { const v = await mountView(<ImportSettings />, el => el); await inAct(async () => { await flush(8) }); return v }, close: () => { globalThis.fetch = original; localStorage.clear() } }
}

test('planning cancellation is requested once and remains running until a confirmed stop, preserving receipts', async () => {
  const f = fixture(), v = await f.mount()
  try {
    assert.match(v.el.textContent!, /Counting files and measuring total size/)
    assert.equal(v.el.querySelector('progress')!.hasAttribute('value'), false)
    await click(v.el, 'Cancel Import'); await click(v.el, 'Cancel Import')
    assert.equal(f.state.cancels, 1); assert.equal(f.state.starts, 0)
    assert.match(v.el.textContent!, /Cancellation requested/); assert.doesNotMatch(v.el.textContent!, /Import cancelled/)
    assert.equal(v.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!.disabled, true)
    f.state.job = job({ state: 'cancelled', cancel_requested: true, cancellable: false, error: 'Stopped at a safe checkpoint; published copies were not removed.', result: { imported: [{ slug: 'saved', name: 'Saved copy' }], warnings: [] }, publications: [{ slug: 'saved', state: 'published', recovery: 'not_started' }] })
    await click(v.el, 'Check import status')
    assert.equal(v.el.querySelector('progress'), null)
    assert.match(v.el.textContent!, /Import cancelled/); assert.match(v.el.textContent!, /Saved import results/)
    assert.match(v.el.textContent!, /saved: Copy publication confirmed/); assert.doesNotMatch(v.el.textContent!, /Import complete/)
    assert.equal(localStorage.getItem(IMPORT_REQUEST_KEY), null)
  } finally { await v.unmount(); f.close() }
})

test('lost cancellation response and reload reconnect by GET without replaying cancellation or copy', async () => {
  const f = fixture(job({ state: 'running', phase: 'copying' })); let v = await f.mount()
  try {
    f.state.lost = true; await click(v.el, 'Cancel Import')
    assert.match(v.el.textContent!, /Cancellation could not be confirmed/); assert.doesNotMatch(v.el.textContent!, /Import cancelled/)
    assert.equal(localStorage.getItem(IMPORT_REQUEST_KEY), id)
    await v.unmount(); v = await f.mount()
    assert.match(v.el.textContent!, /Progress is temporarily unavailable/)
    f.state.offline = false; await click(v.el, 'Check import status')
    assert.match(v.el.textContent!, /Cancellation requested/)
    assert.equal(f.state.cancels, 1); assert.equal(f.state.starts, 0)
  } finally { await v.unmount(); f.close() }
})

test('publication refusal remains visible and does not report a stopped import', async () => {
  const f = fixture(), v = await f.mount()
  try {
    f.state.refuse = true; await click(v.el, 'Cancel Import')
    assert.match(v.el.textContent!, /Publication cannot be cancelled/)
    assert.match(v.el.textContent!, /Cancellation is unavailable while publication or recovery/)
    assert.doesNotMatch(v.el.textContent!, /Import cancelled/)
    const button = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Cancel Import')!
    assert.equal(button.disabled, true); assert.equal(f.state.starts, 0)
  } finally { await v.unmount(); f.close() }
})

test('old status response cannot erase a newer cancellation acknowledgment', async () => {
  const f = fixture(), v = await f.mount()
  let resolve!: (response: Response) => void
  try {
    f.state.delayed = new Promise(r => { resolve = r })
    await click(v.el, 'Check import status')
    await click(v.el, 'Cancel Import')
    await inAct(async () => { resolve(json({ job: job() })); await flush(8) })
    assert.match(v.el.textContent!, /Cancellation requested/)
    assert.equal(f.state.cancels, 1)
  } finally { await v.unmount(); f.close() }
})

test('copy percentage and estimate never present finalization as complete', async () => {
  const f = fixture(job({ state: 'running', phase: 'copying', progress_percent: 47.5, eta_seconds: 120, total_files: 20, total_bytes: 1000 })), v = await f.mount()
  try {
    assert.equal(v.el.querySelector('progress')!.getAttribute('value'), '47.5')
    assert.match(v.el.textContent!, /47.5% copy progress/); assert.match(v.el.textContent!, /Estimated copy time remaining: about 2 minutes/)
    for (const [seconds, label] of [[60, 'about 1 minute.'], [3600, 'about 1 hour.']] as const) {
      f.state.job = job({ state: 'running', phase: 'copying', progress_percent: 50, eta_seconds: seconds })
      await click(v.el, 'Check import status'); assert.ok(v.el.textContent!.includes(`Estimated copy time remaining: ${label}`))
    }
    f.state.job = job({ state: 'running', phase: 'validating', progress_percent: 99, eta_seconds: null, total_files: 20 })
    await click(v.el, 'Check import status')
    assert.match(v.el.textContent!, /99.0% copy progress/); assert.doesNotMatch(v.el.textContent!, /Import complete/)
    f.state.job = job({ state: 'running', phase: 'validating', progress_percent: 99.99 })
    await click(v.el, 'Check import status'); assert.match(v.el.textContent!, /99.9% copy progress/); assert.doesNotMatch(v.el.textContent!, /100.0%/)
    f.state.job = job({ state: 'running', progress_percent: 100 })
    await click(v.el, 'Check import status'); assert.match(v.el.textContent!, /invalid job/)
  } finally { await v.unmount(); f.close() }
})

test('a snapshot started during Cancel cannot undo the later cancellation acknowledgment', async () => {
  const f = fixture(), v = await f.mount()
  let cancelResponse!: (value: Response) => void, statusResponse!: (value: Response) => void
  try {
    f.state.delayedCancel = new Promise(resolve => { cancelResponse = resolve })
    await click(v.el, 'Cancel Import')
    assert.match(v.el.textContent!, /Requesting cancellation/)
    f.state.delayed = new Promise(resolve => { statusResponse = resolve })
    await click(v.el, 'Check import status')
    f.state.job = job({ state: 'cancelling', cancel_requested: true, cancellable: false })
    await inAct(async () => { cancelResponse(json({ job: f.state.job })); await flush(8) })
    assert.match(v.el.textContent!, /Cancellation requested/)
    await inAct(async () => { statusResponse(json({ job: job() })); await flush(8) })
    assert.match(v.el.textContent!, /Cancellation requested/)
    await click(v.el, 'Cancel Import'); assert.equal(f.state.cancels, 1)
    f.state.job = job({ state: 'cancelled', cancellable: false })
    await click(v.el, 'Check import status'); assert.match(v.el.textContent!, /Import cancelled/)
  } finally { await v.unmount(); f.close() }
})

test('an engine without cancellation capability does not offer an unexplained disabled button', async () => {
  const f = fixture(job({ cancellable: undefined })), v = await f.mount()
  try { assert.equal([...v.el.querySelectorAll('button')].some(b => b.textContent === 'Cancel Import'), false) }
  finally { await v.unmount(); f.close() }
})

test('compact preview keeps held memory visible even when native conversation is available', async () => {
  const f = fixture(null), v = await f.mount()
  try {
    await inAct(() => { const input = v.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!; Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'C:/synthetic'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(v.el, 'Preview organizations')
    const summary = [...v.el.querySelectorAll('summary')].find(s => s.textContent === 'Claude memory (1 group; 1 held)')!
    assert.ok(summary); assert.equal(summary.parentElement!.hasAttribute('open'), false)
    assert.match(v.el.textContent!, /native context available/); assert.match(v.el.textContent!, /memory held/)
  } finally { await v.unmount(); f.close() }
})
