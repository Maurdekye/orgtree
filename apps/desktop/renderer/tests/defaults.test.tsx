import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DefaultsPanel } from '../src/App'

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
    assert.match(view.el.textContent ?? '', /default org settings/)
  } finally {
    await view.unmount()
    delete g.fetch
  }
})
