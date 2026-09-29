import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AttentionView } from '../src/attention/AttentionView'
import { forgetAttentionMode, setOrgView } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const slug = 'menu-probe'
const node = (id: string) => ({
  id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', generation: 0,
  seat: 1, grant: 0, free: 0, children: [], lineage: [], turns: [], occupancy: null,
  context_window: null, charter: null, mail_pending: 0, last_status: null,
  audiences_held: [], scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
})
const tree = {
  slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000, default_top_grant: 50,
  compact_at: 0, tiers: { haiku: 1, opus: 4 }, roots: [node('alpha'), node('beta'),
    ...Array.from({ length: 23 }, (_, i) => node(`live-${i}`)),
    ...Array.from({ length: 1100 }, (_, i) => ({ ...node(`archived-${i}`), state: 'retired' }))],
  audiences: [], credit_requests: [], audience_requests: [], asks: [], asks_open: 0,
  audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0,
} as unknown as TreePayload

test('large Attention drawer switches agent desks and opens both agent menus', async (t) => {
  localStorage.clear()
  forgetAttentionMode()
  resetConvos()
  installFetch(new FakeServer())
  setOrgView(slug, 'attention')
  const op = () => Promise.resolve({})
  const toast = () => {}
  const v = await mountView(<CurrentOrg.Provider value={slug}>
    <OrgCanvas tree={tree} slug={slug} op={op} toast={toast} mailEvt={null}
      canvasContent="hidden" renderOrgSlot={ctx => <AttentionView
        slug={slug} tree={tree} op={op} toast={toast} map={ctx.map} posOf={ctx.posOf}
        onFocusAgent={ctx.onFocusAgent}
        deskExtras={ctx.deskExtras} />} />
  </CurrentOrg.Provider>, h => h)
  t.after(() => v.unmount())
  await inAct(() => flush(8))
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.attn-agents-toggle')!.click() })
  for (const id of ['beta', 'live-22', 'alpha']) {
    await inAct(() => { v.el.querySelector<HTMLButtonElement>(`[data-attn-agent="${id}"]`)!.click() })
    await inAct(() => flush(3))
    assert.equal(v.el.querySelector('[data-attn-agent][aria-selected=true]')?.getAttribute('data-attn-agent'), id)
    assert.ok(v.el.querySelector('.attn-desk .cc-head-left')?.textContent?.includes(id))
  }
  for (const selector of ['[data-attn-agent="alpha"]', '.attn-desk .cc-head-left']) {
    const target = document.querySelector(selector)
    assert.ok(target, selector)
    await inAct(() => { target.dispatchEvent(new window.MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
    await inAct(() => flush(3))
    assert.ok(document.querySelector('.ctxmenu'), `${selector}: menu opens`)
    await inAct(() => { window.dispatchEvent(new window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true })) })
    assert.equal(document.querySelector('.ctxmenu'), null)
  }
})
