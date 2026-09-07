import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { useState } from 'react'
import { ImportSettings } from '../src/canvas/importsettings'
import { ConnectHub } from '../src/canvas/connections'
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

test('copy import requires preview, selected organizations and duplicate-work acknowledgement', async () => {
  const original = globalThis.fetch
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(String(url).endsWith('/preview')
      ? { organizations: [{ slug: 'first', name: 'First' }, { slug: 'second', name: 'Second' }], warnings: ['Copy retains source data.'] }
      : { imported: [{ slug: 'first', name: 'First' }], warnings: [] }), { status: 200 })
  }
  const v = await mountView(<ImportSettings />, el => el)
  try {
    await type(v.el.querySelector('input')!, 'C:\\synthetic-v1-root')
    await click(v.el, 'Preview organizations')
    assert.match(v.el.textContent!, /both copies can perform the same work/)
    const copy = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Copy selected organizations')!
    assert.equal(copy.disabled, true)
    await inAct(() => { copy.click() })
    assert.equal(calls.length, 1, 'disabled copy cannot send acknowledgement on behalf of the user')
    const boxes = v.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await inAct(() => { boxes[1]!.click(); boxes[2]!.click() })
    assert.equal(copy.disabled, false)
    await click(v.el, 'Copy selected organizations')
    assert.deepEqual(calls[1], { url: '/api/desktop/import-v1', body: {
      source_root: 'C:\\synthetic-v1-root', organizations: ['first'], acknowledge_duplicate_work: true,
    } })
    assert.match(v.el.textContent!, /Imported First/)
  } finally { await v.unmount(); globalThis.fetch = original }
})

test('connect sends issued credential once, clears it after success and never persists it', async () => {
  localStorage.clear()
  const original = globalThis.fetch
  const sent: unknown[] = []
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }) }
  function Fixture() {
    const [address, setAddress] = useState('https://mail.example')
    return <ConnectHub slug="org" identity="org-network" address={address} setAddress={setAddress} toast={() => {}} />
  }
  const v = await mountView(<Fixture />, el => el)
  try {
    const inputs = v.el.querySelectorAll<HTMLInputElement>('form input')
    await type(inputs[1]!, 'peer-credential')
    await type(inputs[3]!, 'scoped-example-credential')
    await click(v.el, 'Connect')
    assert.deepEqual(sent, [{ address: 'https://mail.example', peer_id: 'peer-credential', peer_slug: 'org-network', peer_token: 'scoped-example-credential' }])
    assert.equal(inputs[3]!.value, '')
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
