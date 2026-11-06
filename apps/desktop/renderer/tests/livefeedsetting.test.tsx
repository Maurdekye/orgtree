import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveFeedSetting, feedStatusText, validFeedPort } from '../src/canvas/livefeedsetting'

const W = window as unknown as Window & typeof globalThis

type Seen = { method: string; path: string; body: Record<string, unknown> | null }

function stub(seen: Seen[], opts: { state?: 'off' | 'listening' | 'error'; tokens?: unknown[] } = {}) {
  let enabled = opts.state !== 'off'
  let port = 47830
  let tokens = opts.tokens ?? []
  const status = () => enabled
    ? opts.state === 'error' ? { state: 'error', error: `port ${port} is in use` } : { state: 'listening', url: `ws://127.0.0.1:${port}/v1/events` }
    : { state: 'off' }
  const old = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    seen.push({ method, path, body })
    if (path === '/api/app-settings/runtime') {
      if (method === 'PUT' && body) {
        if (typeof body.live_feed_enabled === 'boolean') enabled = body.live_feed_enabled
        if (typeof body.live_feed_port === 'number') port = body.live_feed_port
      }
      return new Response(JSON.stringify({ live_feed_enabled: enabled, live_feed_port: port, live_feed_status: status() }))
    }
    if (path === '/api/orgs') return new Response(JSON.stringify([{ slug: 'o1', name: 'One', nodes: 1, live: 1, created: null }]))
    if (path === '/api/app-settings/live-feed/tokens' && method === 'GET') return new Response(JSON.stringify({ tokens }))
    if (path === '/api/app-settings/live-feed/tokens' && method === 'POST') {
      tokens = [{ id: 'tk1', label: String(body?.label), org: 'o1', agent: String(body?.agent), created_at: '2026-11-06T10:00:00Z', last_used: null, agent_live: true }]
      return new Response(JSON.stringify({ id: 'tk1', token: 'otf_secret_value_shown_once' }))
    }
    if (path.startsWith('/api/app-settings/live-feed/tokens/') && method === 'DELETE') { tokens = []; return new Response(JSON.stringify({ revoked: 'tk1' })) }
    return new Response('unexpected', { status: 500 })
  }
  return () => { globalThis.fetch = old }
}

const q = <T extends Element>(l: string) => document.querySelector<T>(`[aria-label="${l}"]`)!
const typeInto = async (el: HTMLInputElement, value: string) => {
  await inAct(() => {
    Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new W.Event('input', { bubbles: true }))
  }); await flush()
}

test('status text and port validation', () => {
  assert.equal(feedStatusText({ state: 'off' }), 'Off')
  assert.equal(feedStatusText({ state: 'listening', url: 'ws://127.0.0.1:47830/v1/events' }), 'Listening on ws://127.0.0.1:47830/v1/events')
  assert.equal(feedStatusText({ state: 'error', error: 'port 47830 is in use' }), 'port 47830 is in use; retrying every 30 s')
  assert.equal(validFeedPort('1024'), 1024)
  assert.equal(validFeedPort('65535'), 65535)
  for (const bad of ['', '80', '1023', '65536', 'abc', '1.5']) assert.equal(validFeedPort(bad), null)
})

test('the toggle saves live_feed_enabled and the status line follows', async t => {
  const seen: Seen[] = []; t.after(stub(seen))
  const v = await mountView(<LiveFeedSetting />, h => h); t.after(() => v.unmount()); await flush()
  assert.match(q('Live feed status').textContent ?? '', /Listening on ws:\/\/127\.0\.0\.1:47830\/v1\/events/)
  const toggle = document.querySelector<HTMLInputElement>('input[type=checkbox]')!
  assert.equal(toggle.checked, true, 'default on')
  await inAct(() => { toggle.click() }); await flush()
  assert.deepEqual(seen.filter(s => s.method === 'PUT').at(-1)?.body, { live_feed_enabled: false })
  assert.equal(q('Live feed status').textContent, 'Off')
})

test('the port field validates and saves', async t => {
  const seen: Seen[] = []; t.after(stub(seen))
  const v = await mountView(<LiveFeedSetting />, h => h); t.after(() => v.unmount()); await flush()
  const save = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save port')!
  assert.equal(save.disabled, true, 'unchanged')
  await typeInto(q<HTMLInputElement>('Live feed port'), '80')
  assert.equal(q<HTMLInputElement>('Live feed port').getAttribute('aria-invalid'), 'true')
  assert.equal(save.disabled, true)
  await typeInto(q<HTMLInputElement>('Live feed port'), '50123')
  assert.equal(save.disabled, false)
  await inAct(() => { save.click() }); await flush()
  assert.deepEqual(seen.filter(s => s.method === 'PUT').at(-1)?.body, { live_feed_port: 50123 })
  assert.match(q('Live feed status').textContent ?? '', /:50123\//)
})

test('an error status says it retries', async t => {
  const seen: Seen[] = []; t.after(stub(seen, { state: 'error' }))
  const v = await mountView(<LiveFeedSetting />, h => h); t.after(() => v.unmount()); await flush()
  assert.equal(q('Live feed status').textContent, 'port 47830 is in use; retrying every 30 s')
})

test('a new token is shown once, then only its row remains; revoke calls DELETE', async t => {
  const seen: Seen[] = []; t.after(stub(seen))
  const v = await mountView(<LiveFeedSetting />, h => h); t.after(() => v.unmount()); await flush()
  await typeInto(q<HTMLInputElement>('Token label'), 'overlay')
  await typeInto(q<HTMLInputElement>('Token agent'), 'A')
  const create = [...document.querySelectorAll('button')].find(b => b.textContent === 'New token')!
  await inAct(() => { create.click() }); await flush()
  assert.deepEqual(seen.find(s => s.method === 'POST')?.body, { label: 'overlay', org: 'o1', agent: 'A' })
  assert.equal(q('New token value').textContent, 'otf_secret_value_shown_once')
  const done = [...document.querySelectorAll('button')].find(b => b.textContent === 'Done')!
  await inAct(() => { done.click() }); await flush()
  assert.doesNotMatch(document.body.textContent ?? '', /otf_secret_value_shown_once/, 'gone once dismissed')
  assert.match(document.body.textContent ?? '', /overlay/)
  await inAct(() => { q<HTMLButtonElement>('Revoke overlay').click() }); await flush()
  assert.ok(seen.some(s => s.method === 'DELETE' && s.path === '/api/app-settings/live-feed/tokens/tk1'))
  assert.equal(document.querySelector('[aria-label="Revoke overlay"]'), null)
})
