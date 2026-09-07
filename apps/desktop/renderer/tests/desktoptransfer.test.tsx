import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { useState } from 'react'
import { ImportSettings } from '../src/canvas/importsettings'
import { ConnectHub } from '../src/canvas/connections'
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

test('native source profiles are shared by preview and copy and changing them invalidates approval', async () => {
  const original = globalThis.fetch
  localStorage.clear()
  const calls: any[] = []
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/orgs') return new Response('[]')
    calls.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(String(url).endsWith('/preview') ? {
      organizations: [{ slug: 'native', name: 'Native', native_context: [
        { node: 'ready', provider: 'claude', status: 'available', source_path: 'C:/source/session.jsonl' },
        { node: 'held', provider: 'codex', status: 'held', reason: 'Native session file is missing.' },
      ] }], warnings: [],
    } : { imported: [{ slug: 'native', name: 'Native' }], warnings: [] }))
  }
  const v = await mountView(<ImportSettings />, el => el)
  try {
    await type(v.el.querySelector('[aria-label="V1 data folder"]')!, 'C:/synthetic-v1')
    await type(v.el.querySelector('[aria-label="Source Claude profile"]')!, ' C:/source/claude ')
    await type(v.el.querySelector('[aria-label="Source Codex profile"]')!, 'C:/source/codex')
    await click(v.el, 'Preview organizations')
    assert.match(v.el.textContent!, /native context available/)
    assert.match(v.el.textContent!, /held - native context unavailable/)
    assert.match(v.el.textContent!, /Native session file is missing/)
    await inAct(() => { v.el.querySelector<HTMLInputElement>('[aria-label="Acknowledge duplicate work"]')!.click() })
    await type(v.el.querySelector('[aria-label="Source Codex profile"]')!, 'C:/source/codex-other')
    assert.ok(![...v.el.querySelectorAll('button')].some(b => b.textContent === 'Copy selected organizations'))
    await click(v.el, 'Preview organizations')
    const copy = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Copy selected organizations')!
    assert.equal(copy.disabled, true, 'changed source requires a fresh acknowledgement')
    await inAct(() => { v.el.querySelector<HTMLInputElement>('[aria-label="Acknowledge duplicate work"]')!.click() })
    await click(v.el, 'Copy selected organizations')
    const expected = { claude_profile: 'C:/source/claude', codex_profile: 'C:/source/codex-other' }
    assert.deepEqual(calls[1].native_sources, expected)
    assert.deepEqual(calls[2].native_sources, expected)
    assert.equal(localStorage.length, 0, 'source profile paths are not retained in renderer storage')
  } finally { await v.unmount(); globalThis.fetch = original }
})

test('copy import requires preview, selected organizations and duplicate-work acknowledgement', async () => {
  const original = globalThis.fetch
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/orgs') return new Response('[]')
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


test('partial import shows committed copies, recovery and per-org warnings, and refreshes without retrying', async () => {
  const original = globalThis.fetch
  let copied = 0, refreshes = 0
  const refresh = () => { refreshes++ }
  window.addEventListener('orgtree:organizations-imported', refresh)
  globalThis.fetch = async url => {
    if (String(url) === '/api/orgs') return new Response('[]')
    if (String(url).endsWith('/preview')) return new Response(JSON.stringify({ organizations: [
      { slug: 'first', name: 'First', conflict: null }, { slug: 'second', name: 'Second', conflict: null },
      { slug: 'existing', name: 'Existing', conflict: 'Already exists in this installation' },
    ], warnings: ['Readable history is copied.'] }))
    copied++
    return new Response(JSON.stringify({ imported: [{ slug: 'first', name: 'First', recovery_pending: true,
      warnings: ['Independent provider sessions will start.', 'Account configuration was skipped.'] }],
      failed: [{ slug: 'second', error: 'Copy failed', not_attempted: ['third'] }], warnings: ['Original data is untouched.', 'Independent provider sessions will start.'] }))
  }
  const v = await mountView(<ImportSettings />, el => el)
  try {
    await type(v.el.querySelector('input')!, 'C:\\synthetic-partial')
    await click(v.el, 'Preview organizations')
    const checkboxes = v.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    assert.equal(checkboxes[2]!.disabled, true)
    assert.equal(checkboxes[2]!.checked, false)
    await inAct(() => { v.el.querySelector<HTMLInputElement>('input[aria-label="Acknowledge duplicate work"]')!.click() })
    await click(v.el, 'Copy selected organizations')
    assert.match(v.el.textContent!, /Imported First/)
    assert.match(v.el.textContent!, /Independent provider sessions/)
    assert.equal(v.el.textContent!.split('Independent provider sessions will start.').length - 1, 1, 'duplicate continuity warning appears once')
    assert.match(v.el.textContent!, /Account configuration was skipped/)
    assert.match(v.el.textContent!, /resuming its active work is still pending/)
    assert.match(v.el.textContent!, /second: Copy failed/)
    assert.match(v.el.textContent!, /Not copied: third/)
    assert.equal(refreshes, 1)
    assert.equal(copied, 1)
    assert.ok(![...v.el.querySelectorAll('button')].some(b => b.textContent === 'Copy selected organizations'), 'a committed partial copy cannot be blindly retried')
  } finally { await v.unmount(); globalThis.fetch = original; window.removeEventListener('orgtree:organizations-imported', refresh) }
})


test('mail hosting saves explicit network and TLS paths, shows runtime status and retains errors for correction', async () => {
  localStorage.clear()
  const original = globalThis.fetch
  const writes: any[] = []
  let fail = false
  const config = { version: 1, enabled: false, bind_host: '127.0.0.1', port: 0, advertise_host: '', tls_configured: false,
    status: { ready: false, port: 0, address: '', public: false } }
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/desktop/hub')
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body)
      if (fail) return new Response('Port already in use', { status: 409 })
      return new Response(JSON.stringify({ ...body, tls_configured: true, status: { ready: true, port: 8443,
        address: 'https://mail.example:8443', public: true }, tls_keyfile: 'must-not-retain-key-path' }))
    }
    return new Response(JSON.stringify(config))
  }
  const v = await mountView(<HostHub />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await inAct(() => {
      v.el.querySelector<HTMLInputElement>('[aria-label="Enable mail hub"]')!.click()
      const select = v.el.querySelector<HTMLSelectElement>('select')!
      select.value = '0.0.0.0'; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save hosting settings')!
    assert.equal(save.disabled, true, 'public hosting cannot be submitted without configured TLS paths')
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub port"]')!, '8443')
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Advertised mail hub host"]')!, 'mail.example')
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="TLS certificate file"]')!, 'C:\\tls\\certificate.pem')
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="TLS private key file"]')!, 'C:\\tls\\key.pem')
    assert.equal(save.disabled, false)
    await click(v.el, 'Save hosting settings')
    assert.deepEqual(writes[0], { version: 1, enabled: true, bind_host: '0.0.0.0', port: 8443,
      advertise_host: 'mail.example', tls_certfile: 'C:\\tls\\certificate.pem', tls_keyfile: 'C:\\tls\\key.pem' })
    assert.match(v.el.textContent!, /Running at https:\/\/mail.example:8443/)
    assert.equal(v.el.querySelector<HTMLInputElement>('[aria-label="TLS private key file"]')!.value, '')
    assert.equal(localStorage.length, 0)
    assert.doesNotMatch(v.el.textContent!, /must-not-retain/)
    fail = true
    await type(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub port"]')!, '9000')
    await click(v.el, 'Save hosting settings')
    assert.match(v.el.querySelector('[role="alert"]')!.textContent!, /409|Port already in use/)
    assert.equal(v.el.querySelector<HTMLInputElement>('[aria-label="Mail hub port"]')!.value, '9000')
  } finally { await v.unmount(); globalThis.fetch = original }
})
