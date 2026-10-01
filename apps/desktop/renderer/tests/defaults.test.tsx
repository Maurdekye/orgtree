import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DefaultsPanel } from '../src/App'
import { AccountsPanel } from '../src/canvas/accounts'

const g = globalThis as unknown as Record<string, unknown>

test('DefaultsPanel renders without React #310 hook ordering error across loading-to-ready transition', async () => {
  const seen: { method: string; path: string }[] = []
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    seen.push({ method, path })
    if (path === '/api/defaults') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          max_top_grant: 1000,
          default_top_grant: 50,
          default_effort: '',
          fable_limit_policy: 'halt',
          fable_filter_policy: 'halt',
          fable_filter_model: 'opus',
          prefer_reserve: true,
        }),
      })
    }
    if (path === '/api/providers') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ providers: [] }),
      })
    }
    return Promise.reject(new Error(`unexpected fetch ${path}`))
  }

  const toasts: string[][] = []
  const toast = (m: string[] | undefined) => { if (m) toasts.push(m) }
  let closed = false
  const close = () => { closed = true }

  const view = await mountView(<DefaultsPanel toast={toast} close={close} />, (el) => el)
  try {
    await inAct(async () => { await flush() })
    assert.ok(view.el.querySelector('.settings'), 'DefaultsPanel rendered settings container')
    assert.match(view.el.textContent ?? '', /Default org settings/)
    assert.doesNotMatch(view.el.textContent ?? '', /default org settings/)
  } finally {
    await view.unmount()
    delete g.fetch
  }
})

test('default org settings show the subtitle once in the App tab and standalone window', async () => {
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = path === '/api/defaults' ? { max_top_grant: 700, default_top_grant: 50 }
      : path === '/api/providers' ? { providers: [] }
        : path === '/api/accounts' ? { version: 2, primary: { id: 'primary', signed_in: false }, keys: [], assignments: {} }
          : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
  try {
    for (const element of [
      <AccountsPanel toast={() => {}} close={() => {}} initialTab="defaults" />,
      <DefaultsPanel toast={() => {}} close={() => {}} />,
    ]) {
      const view = await mountView(element, el => el)
      try {
        await inAct(async () => { await flush() })
        const subtitles = [...view.el.querySelectorAll('.modalpin-subtitle')]
          .filter(e => e.textContent?.replace(/\s+/g, ' ').trim() === 'applied to every NEW organization')
        assert.equal(subtitles.length, 1)
        assert.equal(view.el.querySelector<HTMLInputElement>('input[type="number"]')?.value, '700',
          'the defaults fields still load in either host')
      } finally { await view.unmount() }
    }
  } finally { delete g.fetch }
})
