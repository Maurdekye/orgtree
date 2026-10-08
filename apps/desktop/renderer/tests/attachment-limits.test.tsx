import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { orgInboxUpload } from '../src/api'
import { HostHub } from '../src/canvas/hosthub'

const g = globalThis as unknown as Record<string, unknown>
test('attachment preflight uses the smallest recipient limit before sending any bytes', async () => {
  const requests: { url: string; init?: RequestInit }[] = []
  g.fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return new Response(JSON.stringify({ max_attachment_bytes: url.includes('small') ? 3 : 8, too_large: 'small hub limit' }))
  }
  try {
    await assert.rejects(orgInboxUpload('org', new File(['1234'], 'test.txt'), ['@net:large', '@net:small']), /small hub limit/)
    assert.equal(requests.length, 2)
    assert.ok(requests.every(r => !r.init?.body))
    requests.length = 0
    await orgInboxUpload('org', new File(['123'], 'test.txt'), ['@net:large', '@net:small'])
    assert.equal(requests.length, 3)
    assert.match(requests[2].url, /to=%40net%3Asmall/)
    assert.ok(requests[2].init?.body instanceof File, 'original file streams directly to fetch')
  } finally { delete g.fetch }
})

test('hosting UI displays 1 GiB and saves an edited limit in bytes', async () => {
  const config = { version: 2, port: 7370, bind: '127.0.0.1', name: 'test', retention_days: null,
    org_retention_days: 45, public_listener: false, public_listener_port: 7371,
    max_attachment_bytes: 1024 ** 3, status: { running: false, healthy: false, exposed: false, address: '' } }
  let saved: Record<string, unknown> | undefined
  g.fetch = async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') saved = JSON.parse(init.body as string)
    return new Response(JSON.stringify({ ...config, ...saved }))
  }
  const view = await mountView(<HostHub />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const field = view.el.querySelector<HTMLInputElement>('[aria-label="Maximum attachment size (MiB)"]')!
    assert.equal(field.value, '1024')
    await inAct(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, '512')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush(8) })
    assert.equal(saved?.max_attachment_bytes, 512 * 1024 ** 2)
    assert.match(view.el.textContent!, /Hosting settings saved/)
  } finally { await view.unmount(); delete g.fetch }
})
