// teamgallerypersist.test.tsx — a TEAM presentations window keeps its scope
// when it is persisted, restored or raised (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 25; review of
// a590555 by rig-sol-b, 2026-10-17 23:29Z: a pinned or restored Team
// presentations window silently became own-only).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the modal open-state store keeps a gallery's `team` scope;
//   §2 the saved window layout keeps it too;
//   §3 restoredAgentGallery turns a pinned or saved gallery back into its
//      agent AND its scope, team or ordinary, and drops a stale generation.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs teamgallerypersist

import test from 'node:test'
import assert from 'node:assert/strict'
import { forgetModalOpenCache, readModalOpen, rememberModalOpen } from '../src/canvas/modalpin'
import { restoredAgentGallery, savedWindows, WINDOW_LAYOUT_KEY } from '../src/windowlayout'

test('§1 the open-state store keeps a team gallery\'s scope', (t) => {
  t.after(() => { localStorage.clear(); forgetModalOpenCache() })
  localStorage.clear(); forgetModalOpenCache()
  rememberModalOpen('agent-gallery', 'org', { agent: 'boss', generation: 1, team: true })
  forgetModalOpenCache()
  const got = readModalOpen('org').find((o) => o.kind === 'agent-gallery')
  assert.deepEqual(got?.restore, { agent: 'boss', generation: 1, team: true })
})

test('§2 the saved window layout keeps it too', (t) => {
  t.after(() => { localStorage.clear() })
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{ key: 'k', kind: 'agent-gallery', org: 'org', open: true,
    restore: { agent: 'boss', generation: 1, team: true }, rect: { x: 0, y: 0, width: 800, height: 600 } }]))
  assert.deepEqual(savedWindows()[0]?.restore, { agent: 'boss', generation: 1, team: true })
})

test('§3 a restored gallery comes back as its agent and its scope', () => {
  const nodes = new Map([['boss', { generation: 1 }]])
  const row = (restore: object) => ({ key: 'k', kind: 'agent-gallery', org: 'org', open: true, restore,
    rect: { x: 0, y: 0, width: 800, height: 600 } })
  assert.deepEqual(restoredAgentGallery({ agent: 'boss', generation: 1, team: true }, undefined, nodes), { id: 'boss', team: true })
  assert.deepEqual(restoredAgentGallery({ agent: 'boss', generation: 1 }, undefined, nodes), { id: 'boss', team: false })
  assert.deepEqual(restoredAgentGallery(undefined, row({ agent: 'boss', generation: 1, team: true }), nodes), { id: 'boss', team: true })
  assert.deepEqual(restoredAgentGallery(undefined, row({ agent: 'boss', generation: 1 }), nodes), { id: 'boss', team: false })
  assert.equal(restoredAgentGallery({ agent: 'boss', generation: 2, team: true }, undefined, nodes), null, 'a stale generation')
})
