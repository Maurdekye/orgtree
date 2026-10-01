// attentionpopout.test.tsx — ONE pop-out on the Attention view's agent desk.
//
// User report 2026-09-30 (image-34): the desk in the Attention view's right
// panel showed TWO ↗ buttons — the panel's own, beside its pin and close, and
// the desk's, beside "files" and the settings gear. The panel's is kept; the
// desk drops its own only there (`hidePopout`). What is pinned here:
//
//   • a desk in the registry (the real host, `DeskHosts` → `MovableSurface`)
//     draws its ↗ — the control case, so a zero below means something;
//   • the same desk with `hidePopout` draws none;
//   • the whole Attention view, desk panel included, draws exactly ONE ↗ in
//     that panel, and it is the panel's header one.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionpopout

import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { resetConvos } from '../src/convo'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import type { OpFn, OpResult, TreePayload } from '../src/types'
import { CurrentOrg } from '../src/popout'
import { forgetModalPins } from '../src/canvas/modalpin'
import { forgetAttentionMode, setAttentionLayout, setOrgView } from '../src/attention/mode'
import { AttentionView } from '../src/attention/AttentionView'

const SLUG = 'org1'
const noop = () => {}
const op = (() => Promise.resolve({} as OpResult)) as unknown as OpFn

const agent = (id: string, parent: string | null = null): CanvasNode => ({
  id, tier: 'opus', state: 'live', generation: 0, parent, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode)

const tree = (): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
  max_top_grant: 1000,
} as unknown as TreePayload)

const setup = () => {
  localStorage.clear()
  forgetAttentionMode()
  forgetModalPins()
  resetConvos()
  installFetch(new FakeServer())
}

/** the desk's own header — where the duplicate sat */
const deskArrows = () => [...document.querySelectorAll('.cc-head .popout-button')]

function oneDesk(extra: Record<string, unknown>) {
  const n = agent('alpha')
  const map = new Map([[n.id, n]])
  return <CurrentOrg.Provider value={SLUG}>
    <DeskHosts map={map} slug={SLUG}>
      <DeskSlot node={n} map={map} op={op} slug={SLUG} toast={noop} pub={false}
        bare {...extra} />
    </DeskHosts>
  </CurrentOrg.Provider>
}

test('§1 control: a desk in the registry draws its own pop-out', async (t: TestContext) => {
  setup()
  const v = await mountView(oneDesk({}), (el) => el)
  t.after(() => v.unmount())
  await inAct(() => flush(8))
  assert.ok(document.querySelector('.cc-head'), 'the desk header rendered')
  assert.equal(deskArrows().length, 1, 'a normal desk keeps its ↗')
})

test('§2 hidePopout: the same desk draws none', async (t: TestContext) => {
  setup()
  const v = await mountView(oneDesk({ hidePopout: true }), (el) => el)
  t.after(() => v.unmount())
  await inAct(() => flush(8))
  assert.ok(document.querySelector('.cc-head'), 'the desk header rendered')
  assert.equal(deskArrows().length, 0, 'the desk ↗ is gone')
})

test('§3 the Attention view desk panel shows exactly one pop-out: the panel\'s',
  async (t: TestContext) => {
    setup()
    setOrgView(SLUG, 'attention')
    setAttentionLayout(SLUG, { agent: 'alpha' })
    const map = new Map<string, CanvasNode>([
      [USER, { id: USER, parent: null, tier: null, state: 'user', children: [] } as unknown as CanvasNode],
      ['alpha', agent('alpha', USER)],
    ])
    const v = await mountView(<CurrentOrg.Provider value={SLUG}>
      <DeskHosts map={map} slug={SLUG}>
        <AttentionView slug={SLUG} tree={tree()} op={op} toast={noop} map={map} />
      </DeskHosts>
    </CurrentOrg.Provider>, (el) => el)
    t.after(() => v.unmount())
    await inAct(() => flush(8))
    const panel = document.querySelector('.attn-panel-desk')
    assert.ok(panel, 'the desk panel is on screen')
    assert.ok(panel!.querySelector('.cc-head'), 'with the agent\'s desk in it')
    const arrows = [...panel!.querySelectorAll('.popout-button')]
    assert.equal(arrows.length, 1, `one ↗ in the desk panel, found ${arrows.length}`)
    assert.equal(arrows[0].closest('.cc-head'), null, 'and it is the panel\'s, not the desk\'s')
  })
