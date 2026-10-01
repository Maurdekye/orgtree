// The agent-settings save sends the capability fields only when they were
// EDITED (ticket `v3-saving-agent-settings-still-takes-a-couple-of`).
//
// Any of add_dirs / tools / org_visibility / permission_mode in the scope
// POST makes the backend lock and re-clamp the node's whole subtree
// (lifecycle_tx._scope_plan, ledger._sweep_dirs). The panel used to re-send all
// four on every save, so an effort-only save on a large manager measured about
// 2 s on a copy of the live org. Omitted means unchanged on the wire, so an
// untouched field is now left out.
//
// §2 and §3 are the controls: the same mount and the same save, with the field
// edited, DO send it — without them §1 would pass on a panel that never sent
// capabilities at all.

import {
  FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, ProviderInfo, TreePayload } from '../src/types'

const CAPS = ['add_dirs', 'tools', 'org_visibility', 'permission_mode'] as const

function node(): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: {
      permission_mode: 'acceptEdits', add_dirs: [{ path: 'C:/work', mode: 'rw' }],
      tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
      org_visibility: 'team', effort: 'medium',
    },
    charter: 'the role', team_charter: '', turns: [], audiences_held: [],
  }
}

function tree(): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10,
      'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
    }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true, sandboxed: false,
  } as TreePayload
}

function codexProvider(): ProviderInfo {
  return {
    id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
    status: { installed: true, connected: true, kind: 'chatgpt' },
    hire_enabled: true, reason: null,
  }
}

/** the scope POST bodies; everything else goes to the harness stub */
function scopeBodies() {
  const sent: Record<string, unknown>[] = []
  const real = globalThis.fetch as unknown as
    (url: string, init?: { body?: string }) => Promise<unknown>
  const headers = new Headers({ 'X-Orgtree-Instance': 'inst-0' })
  ;(globalThis as unknown as { fetch: unknown }).fetch =
    (url: string, init?: { body?: string }) => {
      if (!/\/scope$/.test(String(url))) return real(url, init)
      if (init?.body) sent.push(JSON.parse(init.body))
      return Promise.resolve({
        ok: true, status: 200, headers,
        json: () => Promise.resolve({ scope: {}, warnings: [] }),
      })
    }
  return sent
}

async function mount(): Promise<HTMLElement> {
  const n = node()
  const view = await mountView(
    <NodeConfig node={n} map={new Map([[n.id, n]])} tree={tree()} slug="org"
      op={() => Promise.resolve({} as OpResult)}
      toast={() => {}} codexProvider={codexProvider()} close={() => {}} />,
    (el) => el,
  )
  await flush()
  return view.el
}

/** the <select> offering `value` among its options */
function selectWith(el: HTMLElement, value: string): HTMLSelectElement {
  const s = [...el.querySelectorAll<HTMLSelectElement>('select')]
    .find((x) => [...x.options].some((o) => o.value === value))
  assert.ok(s, `no select offers ${value}`)
  return s!
}

async function choose(s: HTMLSelectElement, value: string) {
  const { act } = await import('react')
  await act(async () => {
    s.value = value
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function save(el: HTMLElement) {
  const { act } = await import('react')
  const b = [...el.querySelectorAll<HTMLButtonElement>('button')]
    .find((x) => x.textContent?.trim() === 'save')!
  await act(async () => { b.click() })
  await flush()
}

test('§1 an effort-only save sends no capability field', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  t.after(async () => { realClock() })
  const sent = scopeBodies()
  const el = await mount()
  await choose(selectWith(el, 'xhigh'), 'high')
  await save(el)
  assert.equal(sent.length, 1, 'the save must reach the backend')
  assert.equal(sent[0]!.effort, 'high')
  assert.equal(sent[0]!.charter, 'the role')
  for (const k of CAPS) assert.equal(k in sent[0]!, false, `${k} was re-sent untouched`)
})

test('§2 CONTROL: an edited visibility is sent, and only it', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  t.after(async () => { realClock() })
  const sent = scopeBodies()
  const el = await mount()
  await choose(selectWith(el, 'full'), 'full')
  await save(el)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.org_visibility, 'full')
  for (const k of CAPS.filter((c) => c !== 'org_visibility')) {
    assert.equal(k in sent[0]!, false, `${k} rode along`)
  }
})

test('§3 CONTROL: an edited tool and permission mode are sent whole', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  t.after(async () => { realClock() })
  const sent = scopeBodies()
  const el = await mount()
  const { act } = await import('react')
  const box = [...el.querySelectorAll<HTMLInputElement>('label.checkline input')]
    .find((x) => x.checked)
  assert.ok(box, 'no checked tool box')
  await act(async () => { box!.click() })
  await choose(selectWith(el, 'bypassPermissions'), 'default')
  await save(el)
  assert.equal(sent.length, 1)
  const tools = sent[0]!.tools as Record<string, unknown>
  assert.ok(tools, 'the edited tool set was not sent')
  assert.equal(Object.values(tools).filter((v) => v === false).length, 1)
  assert.equal(sent[0]!.permission_mode, 'default')
  assert.equal('add_dirs' in sent[0]!, false)
})
