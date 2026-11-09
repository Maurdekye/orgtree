// orgrename.test.tsx — Org settings > Basic > Name changes an org's DISPLAY
// name; the slug never changes. Docket
// `org-settings-rename-an-org-s-display-name-4-5-10` (USER 2026-11-09
// mabc0f5462fb8 "add it").
//
//   §1 Basic opens on a Name field holding the current name, with a read-only
//      line naming the permanent id (the slug)
//   §2 editing it saves automatically as `org_name` (trimmed on the engine);
//      nothing else is sent with it
//   §3 an empty name is not saved: the same inline status error as other
//      Basic fields, and no request goes out
//   §4 an untouched name sends nothing
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
type Seen = { method: string; path: string; body: unknown }[]

const tree = (): TreePayload => ({
  slug: 'acme-co', name: 'Acme Co', nodes: [], edges: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
  default_effort: '', cascade_hire: true, cascade_alloc: true,
  fable_limit_policy: 'halt', fable_filter_policy: 'halt',
  auto_cheap_compact: { enabled: false, occ: 0.5 }, auto_resume_compact: false,
  net: { hubs: [] },
} as unknown as TreePayload)

function stubFetch(seen: Seen) {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    seen.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    const payload = path.includes('/orgmd') ? { content: '# Acme\n' }
      : path.includes('/net') ? { hubs: [], identity: null }
        : path === '/api/mcp-servers' ? { servers: [] }
          : path === '/api/accounts' ? { accounts: [] } : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}

async function mountOrg() {
  const view = await mountView(<SettingsPanel tree={tree()} toast={() => {}} close={() => {}} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

async function setField(el: HTMLInputElement, v: string) {
  const w = el.ownerDocument.defaultView as unknown as { HTMLInputElement: typeof HTMLInputElement; Event: typeof Event }
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter)
  await inAct(async () => {
    setter!.call(el, v)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
    await flush()
  })
}

const settingsPosts = (seen: Seen) =>
  seen.filter((r) => r.method === 'POST' && r.path === '/api/orgs/acme-co/settings').map((r) => r.body as Record<string, unknown>)
const nameField = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[aria-label="Organization name"]')

test('§1 Basic shows the current name and the permanent id', async () => {
  const seen: Seen = []; stubFetch(seen)
  const view = await mountOrg()
  try {
    const f = nameField(view.el)
    assert.ok(f, 'a Name field on Basic')
    assert.equal(f!.value, 'Acme Co')
    assert.match(view.el.textContent ?? '', /ID: acme-co/)
  } finally { await view.unmount(); delete g.fetch }
})

test('§2 an edited name saves as org_name and nothing else', async () => {
  const seen: Seen = []; stubFetch(seen)
  const view = await mountOrg()
  try {
    await setField(nameField(view.el)!, 'Acme Labs')
    await inAct(async () => { await new Promise((r) => setTimeout(r, 900)); await flush(12) })
    assert.deepEqual(settingsPosts(seen), [{ org_name: 'Acme Labs' }])
  } finally { await view.unmount(); delete g.fetch }
})

test('§3 an empty name is not saved and the status says why', async () => {
  const seen: Seen = []; stubFetch(seen)
  const view = await mountOrg()
  try {
    await setField(nameField(view.el)!, '   ')
    await inAct(async () => { await new Promise((r) => setTimeout(r, 900)); await flush(12) })
    assert.deepEqual(settingsPosts(seen), [], 'no request for an empty name')
    assert.match(view.el.querySelector('.settings-save-status')?.textContent ?? '', /name/i)
  } finally { await view.unmount(); delete g.fetch }
})

test('§4 an untouched name sends nothing', async () => {
  const seen: Seen = []; stubFetch(seen)
  const view = await mountOrg()
  try {
    await inAct(async () => { await new Promise((r) => setTimeout(r, 900)); await flush(12) })
    assert.deepEqual(settingsPosts(seen), [])
  } finally { await view.unmount(); delete g.fetch }
})
