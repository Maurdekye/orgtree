// agymodelsrefresh.test.tsx — opening a model choice re-reads agy's model list.
//
// User 2026-10-14 (docket gemini-4-argon-is-selectable-in-agy-but-orgtree-d):
// no polling; the list is read at engine start and again each time a model
// selector, quick staffing's model choice, Quick chat's model choice or the
// providers page opens. The renderer asks with POST
// /api/providers/agy-models/refresh; the engine debounces (one read in
// flight, a result under 30 s reused) and republishes the providers value.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { refreshAgyModels } from '../src/api'
import { setOfferedConditionalTiers, USER, useAgyModelsRefresh } from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import type { LineageEntry, OpResult, ProviderInfo, TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const noop = () => {}
const SEATS = { haiku: 1, sonnet: 2, opus: 4, fable: 10, luna: 0.1, sol: 2, astra: 10, flash: 1, pro: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
const REFRESH = '/api/providers/agy-models/refresh'
const g = globalThis as unknown as { fetch: (url: string, init?: { method?: string }) => Promise<unknown> }

/** a fake server, and the refresh calls the renderer makes through it */
function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  setOfferedConditionalTiers([])
  const inner = g.fetch
  const calls: string[] = []
  g.fetch = (url, init) => {
    if (new URL(String(url), 'http://localhost').pathname === REFRESH) calls.push(init?.method ?? 'GET')
    return inner(url, init)
  }
  t.after(() => { g.fetch = inner; setOfferedConditionalTiers([]) })
  return calls
}

function agent(tier = 'flash', lineage: LineageEntry[] = []): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [], lineage,
  } as unknown as CanvasNode
}

test('§1 a choice that opens asks once; a closed one does not', async (t: TestContext) => {
  const calls = fresh(t)
  let setOpen: (v: boolean) => void = noop
  function Picker() {
    const [open, set] = useState(false)
    setOpen = set
    useAgyModelsRefresh(open)
    return null
  }
  const v = await mountView(<Picker />, (el) => el)
  t.after(() => v.unmount())
  await flush()
  assert.deepEqual(calls, [], 'a closed choice asked for a refresh')
  await inAct(() => { setOpen(true) })
  await flush()
  assert.deepEqual(calls, ['POST'], 'opening the choice did not ask once, by POST')
  await inAct(() => { setOpen(false) })
  await inAct(() => { setOpen(true) })
  await flush()
  assert.equal(calls.length, 2, 'opening it again did not ask again (the engine debounces, not the renderer)')
})

test('§1 one request in flight: a second opening meanwhile adds none', async (t: TestContext) => {
  const calls = fresh(t)
  refreshAgyModels()
  refreshAgyModels()
  assert.equal(calls.length, 1)
  await flush()
})

test('§2 the hire sheet asks as it opens', async (t: TestContext) => {
  const calls = fresh(t)
  const v = await mountView(
    <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
      claudeHire={ON} codexHire={ON} antigravityHire={ON}
      onHire={noop} onClose={noop} />, (el) => el)
  t.after(() => v.unmount())
  await flush()
  assert.equal(calls.length, 1)
})

test('§2 agent settings ask when the Model tab opens, not before', async (t: TestContext) => {
  const calls = fresh(t)
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const provider = { id: 'google', label: 'Antigravity', cli: 'agy', tiers: [],
    status: { installed: true, connected: true, kind: 'google' }, hire_enabled: true, reason: null } as unknown as ProviderInfo
  const node = agent()
  const v = await mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={provider} close={noop} />, (el) => el)
  t.after(() => v.unmount())
  await flush()
  assert.equal(calls.length, 0, 'the Charter tab asked for a model refresh')
  const tab = [...v.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === 'Model')
  assert.ok(tab, 'positive control: the Model tab rendered')
  await inAct(() => { tab!.click() })
  await flush()
  assert.equal(calls.length, 1, 'opening the Model tab did not ask')
})

test('§2 the lineage rehire list asks as it opens', async (t: TestContext) => {
  const calls = fresh(t)
  const node = agent('flash', [{ id: 'agent@1', generation: 1, state: 'archived',
    bearer_state: 'knowledge', tier: 'flash' } as LineageEntry])
  const v = await mountView(
    <LineagePanel node={node} slug="org" close={noop} op={() => Promise.resolve({} as OpResult)} />, (el) => el)
  t.after(() => v.unmount())
  await flush()
  assert.equal(calls.length, 1)
})

test('§3 every other model choice asks as it opens', () => {
  // the menus are built when they open, Quick chat's pop-up and the providers
  // tab key the hook on being open, quick staffing builds its entry on opening
  const src = (f: string) => readFileSync(path.join(__SRC_DIR__, f), 'utf8')
  assert.match(src('canvas/agentmenu.tsx'), /refreshAgyModels\(\)\s*\n\s*const choices = hireTierChoices\(s\)/)
  assert.match(src('canvas/cards.tsx'), /refreshAgyModels\(\)\s*\n\s*const choices = hireTierChoices\(/)
  assert.match(src('canvas/quickstaff.ts'), /feedback: \(text: string\) => void\): MenuItem \{[^]*?refreshAgyModels\(\)/)
  assert.match(src('QuickChatBox.tsx'), /useAgyModelsRefresh\(pop\?\.kind === 'model'\)/)
  assert.match(src('canvas/accounts.tsx'), /useAgyModelsRefresh\(tab === 'providers'\)/)
  assert.match(src('canvas/modals.tsx'), /HireDefaultsTabProps\) \{\s*\n[^\n]*\n\s*useAgyModelsRefresh\(\)/)
})
