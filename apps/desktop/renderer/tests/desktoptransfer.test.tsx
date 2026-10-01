import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { useState } from 'react'
import { AddHub } from '../src/canvas/connections'
import { HostHub } from '../src/canvas/hosthub'
import { downloadDocument, responseFilename } from '../src/canvas/download'

async function type(field: HTMLInputElement, value: string) {
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (el: HTMLElement, label: string) => {
  const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)
  assert.ok(button, label)
  await inAct(async () => { button.click(); await flush(8) })
}

test('adding a hub sends one address field; the test never gates; failure preserves the value', async () => {
  localStorage.clear()
  const original = globalThis.fetch
  const probes: string[] = []
  globalThis.fetch = async (url) => {
    probes.push(String(url))
    return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json' } })
  }
  const patches: unknown[] = []
  let accept = true
  function Fixture() {
    const [address, setAddress] = useState('https://mail.example')
    return <AddHub slug="org" address={address} setAddress={setAddress} toast={() => {}}
      current={[]} busy={false}
      apply={async patch => { patches.push(patch); return accept }} />
  }
  const v = await mountView(<Fixture />, el => el)
  try {
    const inputs = v.el.querySelectorAll<HTMLInputElement>('form input')
    assert.equal(inputs.length, 1, 'the address is the ONLY field — no credentials, no tokens')
    // the reachability test is advisory: an unreachable hub is still addable
    await click(v.el, 'Test')
    await inAct(async () => { await flush(4) })
    assert.ok(probes.some(u => u.includes('/api/net/probe?address=https%3A%2F%2Fmail.example')))
    assert.match(v.el.querySelector('[role="status"]')!.textContent!, /Not answering right now.*still add/s)
    await click(v.el, 'Add')
    await inAct(async () => { await flush(4) })
    assert.deepEqual(patches, [{ net_hubs: [{ address: 'https://mail.example', enabled: true }] }])
    assert.equal(v.el.querySelector<HTMLInputElement>('form input')!.value, '', 'accepted → field cleared')
    // a refused save preserves the entered value for correction
    accept = false
    await type(v.el.querySelector<HTMLInputElement>('form input')!, 'https://second.example')
    await click(v.el, 'Add')
    await inAct(async () => { await flush(4) })
    assert.equal(v.el.querySelector<HTMLInputElement>('form input')!.value, 'https://second.example')
    assert.equal(localStorage.length, 0)
  } finally { await v.unmount(); globalThis.fetch = original }
})

test('a child download uses main fetch and the engine ZIP filename, with no executable HTML injection', async () => {
  const child = new JSDOM('<!doctype html><html><body></body></html>')
  const original = globalThis.fetch
  const create = window.URL.createObjectURL, revoke = window.URL.revokeObjectURL, timeout = window.setTimeout
  const calls: string[] = [], downloads: string[] = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': "attachment; filename*=UTF-8''Full%20prototype.zip" } })
  }
  window.URL.createObjectURL = () => 'blob:fixture-download'
  window.URL.revokeObjectURL = url => { calls.push(`revoke:${url}`) }
  window.setTimeout = ((fn: () => void) => { fn(); return 0 }) as typeof window.setTimeout
  child.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download) }
  try {
    await downloadDocument(child.window.document, 'org', 'prototype', 'Fallback', 'html')
    assert.deepEqual(downloads, ['Full prototype.zip'])
    assert.equal(calls[0], '/api/orgs/org/documents/prototype/download')
    assert.ok(calls.includes('revoke:blob:fixture-download'))
    assert.equal(child.window.document.body.childElementCount, 0)
    assert.equal(responseFilename(new Response('', { headers: { 'Content-Disposition': 'attachment; filename="../unsafe.zip"' } }), 'file.zip'), '..-unsafe.zip')
    globalThis.fetch = async () => new Response('missing', { status: 404 })
    await assert.rejects(downloadDocument(child.window.document, 'org', 'missing', 'x'), /404/)
    assert.equal(downloads.length, 1, 'failure produces no empty artifact')
  } finally {
    globalThis.fetch = original; window.URL.createObjectURL = create; window.URL.revokeObjectURL = revoke; window.setTimeout = timeout; child.window.close()
  }
})


test('mail hosting speaks the hub\'s own model, warns on exposure, and retains errors for correction', async () => {
  localStorage.clear()
  const original = globalThis.fetch
  const writes: any[] = []
  let fail = false
  const config = { version: 2, port: 7370, bind: '127.0.0.1', name: '', retention_days: null,
    org_retention_days: 45, public_listener: false, public_listener_port: 7371,
    status: { running: true, healthy: true, address: 'http://127.0.0.1:7370', exposed: false, hub_name: 'desk', orgs: 2, queued: 0 } }
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/desktop/hub')
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body)
      if (fail) return new Response('Port already in use', { status: 409 })
      return new Response(JSON.stringify({ ...config, ...body,
        status: { running: true, healthy: true, address: `http://127.0.0.1:${body.port}`, exposed: body.bind === '0.0.0.0' } }))
    }
    return new Response(JSON.stringify(config))
  }
  const v = await mountView(<HostHub />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.match(v.el.textContent!, /Running at http:\/\/127\.0\.0\.1:7370/)
    assert.match(v.el.textContent!, /2 registered/)
    // no TLS controls exist: the hub does not terminate TLS (reverse proxy
    // guidance lives in the exposure warning instead)
    assert.equal(v.el.querySelector('[aria-label*="TLS"]'), null)
    assert.doesNotMatch(v.el.textContent!, /Enable mail hub/)
    await inAct(() => {
      const select = v.el.querySelector<HTMLSelectElement>('[aria-label="Mail hub listen interface"]')!
      select.value = '0.0.0.0'; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.match(v.el.textContent!, /read ALL mail/, 'exposure states its scope before it happens')
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub name"]')!, 'office desk')
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub port"]')!, '7380')
    await inAct(() => {
      const keep = v.el.querySelector<HTMLSelectElement>('[aria-label="Mail retention"]')!
      keep.value = 'days'; keep.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Days to keep mail"]')!, '45')
    await inAct(() => { v.el.querySelector<HTMLInputElement>('[aria-label="Serve the relay-only public listener"]')!.click() })
    await click(v.el, 'Save hosting settings')
    assert.deepEqual(writes[0], { version: 2, port: 7380, bind: '0.0.0.0',
      name: 'office desk', retention_days: 45, public_listener: true })
    assert.match(v.el.textContent!, /Running at http:\/\/127\.0\.0\.1:7380/)
    assert.equal(localStorage.length, 0)
    fail = true
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub port"]')!, '9000')
    await click(v.el, 'Save hosting settings')
    assert.match(v.el.querySelector('[role="alert"]')!.textContent!, /409|Port already in use/)
    assert.equal(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub port"]')!.value, '9000',
      'a refused save preserves the entered value for correction')
  } finally { await v.unmount(); globalThis.fetch = original }
})
