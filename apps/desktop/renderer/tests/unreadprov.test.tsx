// unreadprov.test.tsx — unread counts and jump accents wear the TARGET
// agent's provider theme (user spec 2026-09-01).
//
// The rule under test: every unread-mail count is themed by the provider of
// the agent IT COUNTS FOR — matching that agent's working-spinner hue — and a
// jump/nav card's accent follows its JUMP TARGET, independent of the desk it
// renders inside. The named regression case: a card hosted inside a
// Codex-themed desk pointing at a Claude agent wears prov-claude, not the
// host's prov-openai.
//
// jsdom does no styling, so the assertions read the CLASS CONTRACT the CSS
// keys on (`.eye-count.prov-*`, `.cc-spin.prov-*`, `.edge-jump.prov-*`,
// `.desk-nav-chip.prov-*` — styles.css pins each to the same --prov-* var);
// the pixel truth is checked live via tools/ui_probe.py in review.
//
// Run:  cd frontend && node tests/run.mjs unreadprov

import { FakeServer, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EyeDesk, NodeSquare } from '../src/canvas/cards'
import { NavChip } from '../src/canvas/desk'
import { providerOf, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 }
const hire = { enabled: true, installed: true, reason: null }

function agent(id: string, tier: string, mail: number): CanvasNode {
  return {
    id, state: 'live', tier, model_id: tier, parent: USER, busy: true,
    mail_pending: mail, children: [], seat: 1, grant: 0, free: 0,
    audiences_held: [], proc_warm: false, proc_live: false,
    proc_relaunch: false, proc_relaunch_reason: null,
    scope: { tools: {}, add_dirs: [] },
  } as unknown as CanvasNode
}

const MIX = [agent('ann', 'haiku', 3), agent('cox', 'luna', 5),
  agent('gem', 'flash', 7)]

test('switchboard tabs: each unread count wears ITS agent\'s provider, like its spinner', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  // every line minimized: the tab strip renders without panel fetches
  localStorage.setItem('orgtree-eyemin-swb',
    JSON.stringify(MIX.map((a) => a.id)))
  localStorage.removeItem('orgtree-eyeseen-swb')
  const map = new Map<string, CanvasNode>(MIX.map((a) => [a.id, a]))
  const view = await mountView(
    <EyeDesk map={map} op={op} slug="swb" toast={noop} pip={null} pub={false}
      eyeW={1200} posX={() => 0} onMailLink={noop} />, (el) => el)
  t.after(() => view.unmount())
  const tabs = [...view.el.querySelectorAll('.eye-tab')]
  assert.equal(tabs.length, 3, 'three direct lines, three tabs')
  for (const a of MIX) {
    const tab = tabs.find((el) => el.textContent?.includes(a.id))!
    assert.ok(tab, `tab for ${a.id}`)
    const want = 'prov-' + providerOf(a.tier!)
    const badge = tab.querySelector('.eye-count')!
    assert.ok(badge, `unread badge for ${a.id}`)
    assert.ok(badge.classList.contains(want),
      `${a.id}'s badge classes [${badge.className}] miss ${want}`)
    const spin = tab.querySelector('.cc-spin')!
    assert.ok(spin.classList.contains(want),
      `${a.id}'s spinner should share ${want} — the badge matches the spinner`)
    // …and never one global tint: no badge carries another provider's class
    for (const other of ['prov-claude', 'prov-openai', 'prov-google']) {
      if (other !== want) {
        assert.ok(!badge.classList.contains(other),
          `${a.id}'s badge wrongly carries ${other}`)
      }
    }
  }
})

test('nav/jump chips theme by DESTINATION, not by the themed desk hosting them', async (t) => {
  // the named case: a Codex-hosted chip pointing at a Claude agent is Claude
  // orange — plus the inverse and the Antigravity variant
  const cases: [string, string][] = [
    ['prov-openai', 'haiku'],    // codex host → claude target
    ['prov-claude', 'sol'],      // claude host → codex target
    ['prov-openai', 'flash'],    // codex host → antigravity target
  ]
  for (const [hostProv, targetTier] of cases) {
    const target = agent('tgt-' + targetTier, targetTier, 4)
    const view = await mountView(
      <div className={'desk-body ' + hostProv}>
        <NavChip n={target} dir="up" onJump={noop} />
      </div>, (el) => el)
    const chip = view.el.querySelector('.desk-nav-chip')!
    const want = 'prov-' + providerOf(targetTier)
    assert.ok(chip.classList.contains(want),
      `chip in ${hostProv} host targeting ${targetTier}: `
      + `[${chip.className}] misses ${want}`)
    if (hostProv !== want) {
      assert.ok(!chip.classList.contains(hostProv),
        `chip stole its HOST's ${hostProv} theme`)
    }
    const badge = chip.querySelector('.eye-count')!
    assert.ok(badge.classList.contains(want),
      `badge in ${hostProv} host targeting ${targetTier} misses ${want}`)
    const spin = chip.querySelector('.cc-spin')!
    assert.ok(spin.classList.contains(want), 'spinner names the destination')
    await view.unmount()
  }
})

test('an agent card\'s own mail count is themed by that agent\'s provider', async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  for (const tier of ['haiku', 'luna', 'flash']) {
    const n = agent('card-' + tier, tier, 2)
    const view = await mountView(
      <NodeSquare node={n} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
        dragging={false} isDrop={false} seats={seats} codexHire={hire}
        antigravityHire={hire} claudeHire={hire} map={new Map([[n.id, n]])} op={op}
        slug="org" toast={noop} pxc={1} zoom={1} compactAt={.8} pub={false}
        maxTop={0} kioskRemaining={null} cascadeAlloc onSpawn={noop}
        onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop}
        onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop}
        onMailLink={noop} onDragStart={noop} onDragMove={noop}
        onDragEnd={noop} onDragCancel={noop} />, (el) => el)
    const count = view.el.querySelector('.mailbtn .count')!
    assert.ok(count, `mail count for ${tier}`)
    assert.ok(count.classList.contains('prov-' + providerOf(tier)),
      `${tier} card count classes [${count.className}]`)
    await view.unmount()
  }
})
