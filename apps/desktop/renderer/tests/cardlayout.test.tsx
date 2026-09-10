// Focused rendered coverage for the zoomed-out agent-card rows.
//
// This mounts the real NodeSquare and clicks the real expand controls. jsdom
// does not lay out flex boxes, so the hit-center check supplies measured card
// and button rectangles at the DOM boundary; CSS ownership is checked against
// the shipped stylesheet below. The existing pins suite covers the full
// OrgCanvas pin operation, while this fixture proves the card opens the
// correct agent and does not offer a duplicate action once pinned.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = {
  haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': .2, luna: .2, terra: 2, sol: 5, flash: 1, pro: 2,
}
const hire = { enabled: true, installed: true, reason: null }

function node(id: string, tier: string, busy: boolean): CanvasNode {
  return {
    id, title: id, state: 'live', tier, model_id: tier,
    seat: seats[tier as keyof typeof seats] ?? 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false,
    mail_pending: 3, last_status: { status: 'working', summary: 'render fixture', at: '' },
    prev_status: null, inflight_at: busy ? 'now' : null, last_denials: [],
    occupancy: 620, occupancy_est: false, context_window: 1000,
    busy, activity: { phase: 'tool', tool: 'shell · render fixture' },
    proc_warm: true, proc_live: true, proc_relaunch: false,
    proc_relaunch_reason: null, isBearerOf: null,
  } as unknown as CanvasNode
}

function card(n: CanvasNode, lod: 'mini' | 'norm', onPin: () => void,
  pinned = false, onDocket: (() => void) | undefined = undefined,
  onOpenAgentGallery: ((id: string) => void) | undefined = undefined) {
  return <NodeSquare key={n.id} node={n} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
    dragging={false} isDrop={false} seats={seats} codexHire={hire}
    antigravityHire={hire} claudeHire={hire} map={new Map([[n.id, n]])}
    op={op} slug="render" toast={noop} pxc={1} zoom={lod === 'mini' ? .4 : .8}
    compactAt={.8} pub={false} maxTop={100} kioskRemaining={null}
    cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
    onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
    onOpenAgentGallery={onOpenAgentGallery}
    onDocket={onDocket}
    onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop}
    onDragCancel={noop} onPin={onPin} pinned={pinned} />
}

function centre(r: { left: number; top: number; width: number; height: number }) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

for (const lod of ['norm', 'mini'] as const) {
  test(`${lod} cards render three rows and route expand to the owning agent`, async () => {
    const opened: string[] = []
    const fixtures = [
      node('claude-agent', 'haiku', true),
      node('codex-agent', 'terra', true),
      node('agy-agent', 'flash', true),
    ]
    const view = await mountView(<>
      {fixtures.map((n) => card(n, lod, () => { opened.push(n.id) }))}
    </>, (el) => el)
    try {
      const roots = [...view.el.querySelectorAll<HTMLElement>('.sq')]
      assert.equal(roots.length, 3)
      const cardRect = { left: 100, top: 80, width: 124, height: 124 }
      for (const root of roots) {
        const name = root.querySelector<HTMLElement>('.sq-title .name')
        const meta = root.querySelector<HTMLElement>('.sq-meta')
        const actions = root.querySelector<HTMLElement>('.sq-actions')
        if (lod === 'mini') {
          // far zoom (user 2026-09-10): the shortcut row is UNMOUNTED — a
          // hover exposes no interactive buttons, so a click can only reach
          // the card's own focus pipeline. Title and status rows remain.
          assert.ok(name && meta, 'title and status rows stay mounted at mini')
          assert.equal(actions, null, 'mini cards mount no shortcut action row')
          assert.equal(root.querySelectorAll('.sq-actions button').length, 0,
            'no shortcut button hit targets at far zoom')
          continue
        }
        assert.ok(name && meta && actions, 'all three card rows are mounted')
        assert.ok(meta.querySelector('.sq-workstate .cc-spin'), 'spinning arrow is in Row 2 when busy')
        assert.ok(meta.querySelector('.sq-workstate .sq-idle.working'), 'working state text is in Row 2')
        assert.ok(meta.querySelector('.sq-workstate .sq-idle-time'), 'elapsed turn time is in Row 2')
        assert.equal(meta.querySelector('.proc-state'), null, 'CLI status dot is not mounted in Row 2')
        assert.ok(meta.querySelector('.ctxwheel'), 'context wheel is in Row 2')
        assert.equal(actions.querySelectorAll('button').length, 4,
          'expand, mail, retire, and settings remain available')
        assert.equal(root.querySelector('.sq-badges .statuschip'), null,
          'self-reported state is not duplicated below the action row')
        const expand = actions.querySelector<HTMLButtonElement>('.expandbtn')!
        assert.equal(expand.getAttribute('aria-label'), 'Expand agent window')
        assert.equal(expand.title, 'Expand agent window')
        const buttonRect = { left: 108, top: 180, width: 20, height: 20 }
        Object.defineProperty(expand, 'getBoundingClientRect', {
          configurable: true, value: () => ({ ...buttonRect, right: 128, bottom: 200 }),
        })
        const p = centre(buttonRect)
        const c = centre(cardRect)
        assert.ok(p.x >= cardRect.left && p.x <= cardRect.left + cardRect.width
          && p.y >= cardRect.top && p.y <= cardRect.top + cardRect.height,
          `${name.textContent} expand center stays inside its card`)
        assert.notEqual(p.x, c.x, 'button center is a distinct hit target, not card center')
        expand.click()
      }
      if (lod === 'mini') {
        assert.deepEqual(opened, [], 'no expand routed at mini — nothing to click')
        assert.equal(view.el.querySelectorAll('.sq-badges').length, 0,
          'mini cards do not leave a hidden badge row')
      } else {
        assert.deepEqual(opened.sort(), ['agy-agent', 'claude-agent', 'codex-agent'])
        assert.match(view.el.querySelector('.sq-actions')!.className, /sq-actions/)
        assert.equal(view.el.querySelectorAll('.sq-badges').length, 3,
          'normal cards retain status/badge content below the action row')
      }
    } finally { await view.unmount() }
  })
}

test('pinned cards do not offer a duplicate expand action', async () => {
  // norm, not mini: mini mounts no actions at all, so the null expand would
  // pass vacuously — the sibling-button guard keeps this check load-bearing
  const view = await mountView(card(node('already-pinned', 'terra', false), 'norm', noop, true),
    (el) => el)
  try {
    assert.equal(view.el.querySelector('.expandbtn'), null)
    assert.ok(view.el.querySelectorAll('.sq-actions button').length > 0,
      'other actions remain, so the missing expand is suppression, not absence')
  } finally { await view.unmount() }
})

test('all-action fixture mounts the gear in the constrained action row', async () => {
  const n = node('many-actions', 'haiku', false)
  ;(n as unknown as { documents: unknown[] }).documents = [{ id: 'presented-doc' }]
  const opened: string[] = []
  const view = await mountView(card(n, 'norm', noop, false, noop,
    (id) => opened.push(id)), (el) => el)
  try {
    const actions = view.el.querySelector<HTMLElement>('.sq-actions')!
    assert.equal(actions.querySelectorAll('button').length, 6,
      'action row keeps document, docket, mail, expand, retire, and gear controls')
    assert.ok(actions.querySelector('.gearbtn'), 'gear control is missing')
    const presented = actions.querySelector<HTMLButtonElement>('.presentedbtn')
    assert.ok(presented, 'agent presentation modal control is missing')
    assert.equal(presented?.title, 'open presented documents for many-actions')
    presented?.click()
    assert.deepEqual(opened, ['many-actions'])
    assert.equal(view.el.querySelectorAll('.doc-chips .doc-chip').length, 1,
      'the intended document control remains on the card edge')
  } finally { await view.unmount() }
})

test('zoomed-out card CSS keeps actions left-aligned and tier accents distinct', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.sq-actions\s*\{[^}]*justify-content:\s*flex-start/s)
  assert.match(css, /\.sq-actions\s*\{[^}]*max-width:\s*100%[^}]*flex-wrap:\s*wrap/s)
  assert.match(css, /\.sq\.prov-openai\.busy:not\(\.desk\)[^}]*\{[\s\S]*?--tier-accent/s)
  assert.match(css, /\.sq\.prov-google\.busy:not\(\.desk\)[^}]*\{[\s\S]*?--tier-accent/s)
  for (const tier of ['haiku', 'terra', 'luna', 'flash']) {
    assert.match(css, new RegExp(String.raw`\.sq\.tier-${tier}\s*\{[^}]*--tier-accent`),
      `${tier} retains its own top accent variable`)
  }
})

test('an idle card carries its age BESIDE the state word, not as a separate badge',
  async () => {
    // user 2026-09-05: "when agent idle place idle time beside word Idle, as
    // in desk view … do NOT make separate card". The DOM claim is the parent:
    // the age has to be inside the same `.sq-workstate` seat as the word.
    const idle = node('quiet-agent', 'haiku', false)
    ;(idle as unknown as { turns: unknown[] }).turns =
      [{ at: new Date(Date.now() - 120_000).toISOString(), killed: false, cost: 0, denials: 0 }]
    ;(idle as unknown as { last_status: unknown }).last_status =
      { status: 'done', summary: 'finished', at: '' }
    const view = await mountView(card(idle, 'norm', noop), (el) => el)
    try {
      // ⚠ COUNTS AND BOOLEANS, NEVER DOM NODES. A failing assert.equal on an
      // element makes node:test diff the whole rendered tree, which allocates
      // until it dies — the test then HANGS instead of naming what broke, and
      // the check reads green-or-mysterious rather than green-or-red.
      const seat = view.el.querySelector('.sq-workstate')
      const word = seat?.querySelector('.sq-idle')
      const time = seat?.querySelector('.sq-idle-time')
      assert.equal(Boolean(word), true, 'the state word is gone')
      assert.equal(Boolean(time), true, 'the age is not in the same seat as the word')
      assert.match(time?.textContent ?? '', /\d/, 'the age rendered no number')
      // the word comes first, the age second — "beside", in that order
      assert.equal(word?.nextElementSibling === time, true,
        'the age is not the element immediately after the word')
      // and the badge it used to be is GONE from the whole card
      assert.equal(view.el.querySelectorAll('.turnago').length, 0,
        'the separate age badge is still rendered somewhere on the card')
    } finally { await view.unmount() }
  })

test('a busy card shows spinning arrow, working state word, and elapsed turn time', async () => {
  const busy = node('running-agent', 'haiku', true)
  busy.inflight_at = new Date(Date.now() - 45_000).toISOString()
  ;(busy as unknown as { turns: unknown[] }).turns =
    [{ at: new Date(Date.now() - 120_000).toISOString(), killed: false, cost: 0, denials: 0 }]
  const view = await mountView(card(busy, 'norm', noop), (el) => el)
  try {
    const seat = view.el.querySelector('.sq-workstate')
    const spin = seat?.querySelector('.cc-spin')
    const word = seat?.querySelector('.sq-idle.working')
    const time = seat?.querySelector('.sq-idle-time')
    assert.equal(Boolean(spin), true, 'the busy spinning arrow is missing from sq-workstate')
    assert.equal(word?.textContent, 'Active', 'the executing-turn state text is missing (Title Case)')
    assert.equal(Boolean(time), true, 'the elapsed turn time is missing from sq-workstate')
    assert.match(time?.textContent ?? '', /\d|—/, 'the elapsed time rendered')
    // the spinning arrow is on the left (first element in sq-workstate)
    assert.equal(seat?.firstElementChild === spin, true, 'spinning arrow must be on the left')
    assert.equal(view.el.querySelectorAll('.turnago').length, 0,
      'a busy card shows the old age badge')
  } finally { await view.unmount() }
})


test('bound account shades reach mounted cards without changing work-state colors', async () => {
  const base = node('base', 'sonnet', true)
  const alt = node('alt', 'sonnet', true)
  const unbound = node('unbound', 'sonnet', true)
  base.account = 'a'; base.account_tint_ordinal = 1
  alt.account = 'b'; alt.account_tint_ordinal = 2
  const mounted = await mountView(<>{card(base, 'norm', noop)}{card(alt, 'norm', noop)}{card(unbound, 'norm', noop)}</>, el => el)
  try {
    const cards = [...mounted.el.querySelectorAll<HTMLElement>('.sq')]
    const find = (id: string) => cards.find(c => c.querySelector('.name')?.textContent === id)!
    assert.ok(find('base'))
    const channel = (id: string) => find(id).style.getPropertyValue('--provider-accent')
    assert.ok(channel('base')); assert.ok(channel('alt'))
    assert.notEqual(channel('base'), channel('alt'))
    assert.equal(channel('unbound'), '')
    for (const id of ['base', 'alt', 'unbound']) {
      assert.equal(find(id).style.getPropertyValue('--work-accent'), '')
      assert.equal(find(id).style.getPropertyValue('--accent'), '')
    }
  } finally { await mounted.unmount() }
})
