import './harness'
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'

// api.BASE binds at import time. Set the visitor path before dynamically
// loading the real gallery; this file has its own bundled test process.
window.history.replaceState({}, '', '/k/visitor/')
const { BASE } = await import('../src/api')
const { DocGalleryModal } = await import('../src/canvas/gallery')

test('visitor gallery shows HTML metadata and unavailable preview without an active mockup link', async (t) => {
  assert.equal(BASE, '/k/visitor', 'the visitor branch must be exercised')
  useFakeClock()
  const doc = { id: 'mock1', title: 'Interactive prototype', at: '2026-09-06T15:00:00Z',
    format: 'html', node: 'agent', node_state: 'live', evicted: false }
  globalThis.fetch = (async (url) => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => String(url).endsWith('/documents') ? { documents: [doc] } : { ...doc, body: '' },
  } as Response)) as typeof fetch
  const view = await mountView(<DocGalleryModal slug="org" toast={() => {}} close={() => {}} />, host => host)
  t.after(async () => { try { await view.unmount() } finally { realClock() } })
  await flush()
  const row = view.el.querySelector('.doc-gallery-row') as HTMLElement
  assert.ok(row, 'metadata remains visible')
  assert.equal(row.tagName, 'DIV')
  assert.equal(row.getAttribute('href'), null)
  await inAct(() => row.click()); await flush()
  assert.match(view.el.querySelector('.mockup-open')!.textContent!, /operator view/)
  assert.equal(view.el.querySelector('a[href$="/mockup"]'), null)
})
