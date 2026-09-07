import { FakeServer, fireResize, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { intersectsViewport, pathBounds, ViewportPath, worldViewport } from '../src/canvas/viewport'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { setCrowdPilesOn } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

test('viewport transform handles pan, zoom, boundary intersection and absent measurement', () => {
  assert.deepEqual(worldViewport({ x: -200, y: 100, z: 2 }, 800, 600, 0), { x: 100, y: -50, w: 400, h: 300 })
  assert.equal(worldViewport({ x: 0, y: 0, z: 1 }, 0, 500), null)
  const vp = { x: 100, y: 100, w: 300, h: 200 }
  assert.equal(intersectsViewport({ x: 0, y: 0, w: 100, h: 100 }, vp), true)
  assert.equal(intersectsViewport({ x: 0, y: 0, w: 99, h: 99 }, vp), false)
  assert.equal(intersectsViewport({ x: -9000, y: 0, w: 1, h: 1 }, null), true)
})

test('offscreen SVG paths unmount but crossing curves and unsupported path shapes remain', async () => {
  const viewport = { x: 0, y: 0, w: 200, h: 200 }
  const view = await mountView(<svg>
    <ViewportPath viewport={viewport} data-testid="off" d="M 300 300 L 400 400" />
    <ViewportPath viewport={viewport} data-testid="cross" d="M -100 100 C 0 0, 200 200, 300 100" />
    <ViewportPath viewport={viewport} data-testid="unknown" d="M 500 500 Q 10 20 30 40" />
  </svg>, el => el)
  try {
    assert.equal(view.el.querySelector('[data-testid="off"]'), null)
    assert.ok(view.el.querySelector('[data-testid="cross"]'))
    assert.ok(view.el.querySelector('[data-testid="unknown"]'), 'unsupported commands fail open, visibly')
    assert.deepEqual(pathBounds('M 1e2 -2e1 L 200 30'), { x: 100, y: -20, w: 100, h: 50 })
  } finally { await view.unmount() }
})

test('real graph removes offscreen cards and restores them on viewport resize', async () => {
  localStorage.clear(); resetConvos(); setCrowdPilesOn(false); installFetch(new FakeServer())
  const roots = Array.from({ length: 20 }, (_, i) => ({ id: `node-${i}`, title: `Node ${i}`, state: 'live', tier: 'haiku',
    generation: 0, children: [], seat: 1, grant: 0, free: 0, turns: [], scope: { tools: {}, add_dirs: [] } }))
  const tree = { slug: 'viewport-fixture', name: 'fixture', roots, tiers: { haiku: 1 },
    audit: { live_nodes: 20, top_level_holds: 20, no_overdraft: true, problems: [] },
    dirs: [], audiences: [], audience_requests: [], credit_requests: [], max_top_grant: 1000,
    default_top_grant: 10, compact_at: 0, user_inbox_count: 0, org_inbox: null, net: null,
  } as unknown as TreePayload
  const view = await mountView(<OrgCanvas tree={tree} slug={tree.slug} op={async () => ({})}
    toast={() => {}} mailEvt={null} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const viewport = view.el.querySelector<HTMLElement>('.viewport')!
    assert.equal(viewport.dataset.culling, 'unmeasured')
    const count = () => view.el.querySelectorAll('.sq:not(.user)').length
    const initial = count()
    assert.ok(initial >= 20, `positive control has actual cards: ${initial}`)
    let size = 1
    viewport.getBoundingClientRect = () => ({ x: 0, y: 0, width: size, height: size, top: 0, left: 0,
      right: size, bottom: size, toJSON: () => ({}) })
    await inAct(async () => { fireResize(viewport) })
    assert.equal(viewport.dataset.culling, 'active')
    const culled = count()
    assert.ok(culled < initial, 'cards really leave the DOM outside the viewport')
    assert.ok(view.el.querySelector('.sq.user'), 'single eye remains for its outboard credit controls')
    size = 100000
    await inAct(async () => { fireResize(viewport) })
    assert.ok(count() > culled, 'expanding the actual viewport remounts cards previously outside it')
    assert.ok(count() <= initial, 'resize never invents or duplicates cards')
  } finally { await view.unmount(); resetConvos(); localStorage.clear(); setCrowdPilesOn(true) }
})
