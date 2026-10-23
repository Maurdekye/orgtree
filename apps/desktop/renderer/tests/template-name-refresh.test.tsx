import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CreateOrgView } from '../src/shell/createorg'
import type { TemplateSummary } from '../src/api'
import { presetPlan, presetSummaries } from './templateavailability.fixture'

const settle = () => inAct(async () => { await new Promise(r => setTimeout(r, 240)); await flush(4) })
const click = (el: Element) => inAct(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await flush(4) })
const input = (el: HTMLInputElement, value: string) => inAct(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true })); await flush(4)
})
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.tp-row')]
const row = (name: string) => rows().find(e => e.querySelector('.tp-name')?.textContent === name)!

function deferredBackend() {
  const requests: { name: string; reply: (templates: TemplateSummary[]) => void }[] = []
  const previews: { id: string; name: string; dirs: string[]; overrides: Record<string, { name?: string }> }[] = []
  let initial = true
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const response = (payload: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => payload })
    if (u.pathname.endsWith('/resolve')) {
      const body = JSON.parse(String(init!.body)); previews.push(body)
      return response(presetPlan(body.id, body.overrides))
    }
    assert.equal(u.pathname, '/api/templates')
    if (initial) { initial = false; return response({ templates: presetSummaries(), dir: '/fixture', loading: false }) }
    return new Promise(resolve => requests.push({ name: u.searchParams.get('name') ?? '',
      reply: templates => resolve(response({ templates, dir: '/fixture', loading: false })) }))
  }) as typeof fetch
  const reply = (index: number, templates = presetSummaries()) => inAct(async () => { requests[index].reply(templates); await flush(4) })
  return { requests, previews, reply }
}

test('name keystrokes keep confirmed row appearance and selection while refreshing scoped availability', async () => {
  const server = deferredBackend()
  const v = await mountView(<CreateOrgView onCreated={() => {}} onRequestClose={() => {}} />, el => el)
  try {
    await settle(); await click(row('devteam (Claude)')); await settle()
    await input(v.el.querySelector<HTMLInputElement>('input[aria-label="name of coordinator"]')!, 'captain'); await settle()
    const original = rows(), appearance = original.map(el => el.outerHTML)
    assert.equal(row('devteam (Antigravity)').classList.contains('collapsed'), true)
    const name = v.el.querySelector<HTMLInputElement>('#shell-create-name')!
    for (let i = 1; i <= 'Kite Studio'.length; i++) {
      const value = 'Kite Studio'.slice(0, i)
      await input(name, value)
      assert.equal(server.requests.length, i); assert.equal(server.requests[i - 1].name, value)
      assert.deepEqual(rows().map(el => el.outerHTML), appearance, `pending ${value} must not expand or reset rows`)
      assert.equal(rows().every((el, j) => el === original[j]), true, 'stable row nodes')
      await server.reply(i - 1)
      assert.deepEqual(rows().map(el => el.outerHTML), appearance, `completed ${value}`)
    }
    await settle()
    assert.equal(server.previews.at(-1)?.name, 'Kite Studio')
    assert.equal(server.previews.at(-1)?.id, 'ready')
    assert.deepEqual(server.previews.at(-1)?.dirs, [])
    assert.equal(server.previews.at(-1)?.overrides.coordinator.name, 'captain')
    assert.equal(row('devteam (Claude)').getAttribute('aria-selected'), 'true')
  } finally { await v.unmount() }
})

test('fresh name and Reload results still update availability, and stale name replies stay ignored', async () => {
  const server = deferredBackend()
  const v = await mountView(<CreateOrgView onCreated={() => {}} onRequestClose={() => {}} />, el => el)
  try {
    await settle()
    const name = v.el.querySelector<HTMLInputElement>('#shell-create-name')!
    await input(name, 'Old'); await input(name, 'New')
    const available = presetSummaries().map(t => ({ ...t, availability: { unusable: false, checking: false, reason: null } }))
    await server.reply(1, available)
    assert.equal(row('devteam (Antigravity)').classList.contains('collapsed'), false)
    await server.reply(0)
    assert.equal(row('devteam (Antigravity)').classList.contains('collapsed'), false, 'late old-name result is ignored')
    await click([...v.el.querySelectorAll('button')].find(b => b.textContent === 'Reload')!)
    assert.equal(server.requests.at(-1)?.name, 'New')
    assert.equal(row('devteam (Antigravity)').classList.contains('collapsed'), false)
    await server.reply(2)
    assert.equal(row('devteam (Antigravity)').classList.contains('collapsed'), true, 'Reload applies its new confirmed result')
    assert.equal(rows()[0].getAttribute('aria-selected'), 'true', 'Empty stays selected')
  } finally { await v.unmount() }
})
