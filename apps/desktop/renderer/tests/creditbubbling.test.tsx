import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { AccountsPanel } from '../src/canvas/accounts'
import { DefaultsPanel } from '../src/App'

// "Credit cost bubbling" moved from every org's settings (and the new-org defaults) to App settings > Runtime,
// where the two switches govern only the USER's own actions; agents always bubble (USER 2026-10-22 14:30Z).

const g = globalThis as unknown as Record<string, unknown>
const HIRE = 'your hires bubble their cost up the chain'
const ALLOC = 'your allocations & model upgrades bubble their cost up the chain'

function service(initial: { hire?: boolean; alloc?: boolean } = {}) {
  const state = { credit_bubble_hire_enabled: initial.hire, credit_bubble_alloc_enabled: initial.alloc }
  const writes: Record<string, unknown>[] = []
  g.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
    if (path === '/api/app-settings/runtime') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        writes.push(body)
        Object.assign(state, body)
      }
      return json({ warming_enabled: true, working_checkups_enabled: true, ...state })
    }
    if (path === '/api/defaults') return json({ max_top_grant: 1000, default_top_grant: 50, default_effort: '' })
    if (path === '/api/providers') return json({ providers: [] })
    if (path === '/api/accounts') return json({ accounts: [], primary: {}, keys: [], assignments: {} })
    return json({})
  }) as typeof fetch
  return { writes }
}
const row = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLElement>('.set-row')]
  .find(r => r.querySelector('.set-label')?.textContent === label)
const toggle = (el: HTMLElement, label: string) => row(el, label)?.querySelector<HTMLInputElement>('[role="switch"]') ?? null
const mountRuntime = async () => {
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="runtime" />, el => el)
  await inAct(async () => { await flush(20) })
  return view
}

test('App settings > Runtime has both credit-bubbling switches, ON by default, worded as the user\'s own actions', async () => {
  service()
  const view = await mountRuntime()
  try {
    for (const label of [HIRE, ALLOC]) {
      const t = toggle(view.el, label)
      assert.ok(t, `${label}: the switch is in Runtime`)
      assert.equal(t!.checked, true, `${label}: ON by default`)
    }
    assert.match(row(view.el, HIRE)!.textContent ?? '', /agents always bubble/i, 'the hint says agents always bubble')
    assert.match(row(view.el, ALLOC)!.textContent ?? '', /agents always bubble/i)
  } finally { await view.unmount(); delete g.fetch }
})

test('a switch saves app-wide through the Runtime settings and stays off when the panel reopens', async () => {
  const svc = service()
  let view = await mountRuntime()
  try {
    await inAct(async () => { toggle(view.el, HIRE)!.click(); await flush(20) })
    assert.deepEqual(svc.writes, [{ credit_bubble_hire_enabled: false }])
    assert.equal(toggle(view.el, HIRE)!.checked, false)
    assert.equal(toggle(view.el, ALLOC)!.checked, true, 'the other switch is untouched')
    await view.unmount()
    view = await mountRuntime()
    assert.equal(toggle(view.el, HIRE)!.checked, false, 'confirmed value survives a reopen')
    await inAct(async () => { toggle(view.el, ALLOC)!.click(); await flush(20) })
    assert.deepEqual(svc.writes.at(-1), { credit_bubble_alloc_enabled: false })
  } finally { await view.unmount(); delete g.fetch }
})

test('the new-org defaults no longer carry credit bubbling', async () => {
  service()
  const view = await mountView(<DefaultsPanel toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(20) })
    assert.doesNotMatch(view.el.textContent ?? '', /bubble their cost|Credit cost bubbling/)
  } finally { await view.unmount(); delete g.fetch }
})
