// Focused coverage for the click-to-zoom cursor on unfocused agent cards.
// The card's actual focus transition remains in OrgCanvas' pointer-up path;
// this suite verifies the DOM state that selects that affordance and the
// CSS overrides that must continue to win for drag surfaces and handles.

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
const seats = { haiku: 1, sonnet: 2, opus: 5 }

function node(state: string = 'live'): CanvasNode {
  return {
    id: 'zoom-target', state, tier: 'haiku', model_id: 'haiku',
    children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] },
    lineage: [], turns: [], audiences_held: [], bearer_state: null,
    frozen: null, limit_locked: false, mail_pending: 0,
    last_status: { status: 'idle', summary: 'fixture', at: '' },
    prev_status: null, inflight_at: null, last_denials: [],
    occupancy: 0, occupancy_est: false, context_window: 1000,
    busy: false, activity: null, proc_warm: true, proc_live: true,
    proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: null,
  } as unknown as CanvasNode
}

function card(nd: CanvasNode, options: {
  lod?: 'mini' | 'norm'
  focused?: boolean
  dragging?: boolean
  mapMode?: boolean
  onDragStart?: (id: string) => void
} = {}) {
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={options.lod ?? 'norm'}
      focused={options.focused ?? false} dragging={options.dragging ?? false}
      isDrop={false} seats={seats} map={new Map([[nd.id, nd]])} op={op}
      slug="org" toast={noop} pxc={1} zoom={options.lod === 'mini' ? .4 : 1}
      compactAt={.8} pub={false} maxTop={10} kioskRemaining={null}
      cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
      onConfig={noop} onInbox={noop} onLineage={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onWorkLink={noop}
      onDragStart={(_e, id) => options.onDragStart?.(id)}
      onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop} mapMode={options.mapMode} />,
    (el) => el)
}

test('norm and far-zoom agent cards expose the zoomable affordance', async (t) => {
  for (const lod of ['norm', 'mini'] as const) {
    const view = await card(node(), { lod })
    t.after(async () => { await view.unmount() })
    const root = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(root.classList.contains('zoomable'), `${lod} card is not zoomable`)
    assert.equal(root.classList.contains('desk'), false)
  }
})

test('focused, draft, and compact-map cards do not claim the zoom cursor', async (t) => {
  const focused = await card(node(), { focused: true })
  const draft = await card(node('draft'))
  const map = await card(node(), { mapMode: true })
  t.after(async () => {
    await focused.unmount(); await draft.unmount(); await map.unmount()
  })
  assert.equal(focused.el.querySelector('.sq')!.classList.contains('zoomable'), false)
  assert.equal(draft.el.querySelector('.sq')!.classList.contains('zoomable'), false)
  assert.equal(map.el.querySelector('.sq')!.classList.contains('zoomable'), false)
})

test('cursor ownership keeps pan, drag, and dedicated handles distinct', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const bodies = (selector: string) => {
    const escaped = selector.replaceAll('.', '\\.')
      .replaceAll(':', '\\:').replaceAll('(', '\\(').replaceAll(')', '\\)')
    const found = [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    assert.ok(found.length, `missing ${selector} rule`)
    return found.map(match => match[1]!)
  }
  const declares = (selector: string, declaration: RegExp) =>
    assert.ok(bodies(selector).some(body => declaration.test(body)),
      `${selector} does not declare ${declaration}`)
  declares('.sq.zoomable:not(.lifted)', /cursor:\s*zoom-in;/)
  declares('.sq.lifted', /cursor:\s*grabbing;/)
  declares('.sq.desk', /cursor:\s*default;/)
  declares('.sq.draft', /cursor:\s*default;/)
  declares('.viewport', /cursor:\s*grab;/)
  declares('.viewport:active', /cursor:\s*grabbing;/)
  declares('.cbar', /cursor:\s*ns-resize;/)
})

test('the zoom cursor is visual-only and preserves the card press handler', async (t) => {
  const downs: string[] = []
  const view = await card(node(), { lod: 'norm', onDragStart: id => downs.push(id) })
  t.after(async () => { await view.unmount() })
  const root = view.el.querySelector<HTMLElement>('.sq')!
  root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  assert.deepEqual(downs, ['zoom-target'])
})
