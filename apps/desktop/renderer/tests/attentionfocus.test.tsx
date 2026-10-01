import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas, resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { AttentionView } from '../src/attention/AttentionView'
import { forgetAttentionMode, setOrgView, useOrgView } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const slug = 'attention-focus'
const noop = () => {}
const op = () => Promise.resolve({})
const node = (id: string) => ({
  id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', generation: 0,
  seat: 1, grant: 0, free: 0, children: [], lineage: [], turns: [], occupancy: null,
  context_window: null, charter: null, mail_pending: 0, last_status: null,
  audiences_held: [], scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
})
const tree = {
  slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000, default_top_grant: 50,
  compact_at: 0, tiers: { haiku: 1, opus: 4 }, roots: [node('alpha'), node('beta')],
  audiences: [], credit_requests: [], audience_requests: [], asks: [], asks_open: 0,
  audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0,
} as unknown as TreePayload

// App's composition: Canvas stays mounted across the mode switch; only its
// world is hidden. Both destinations share OrgCanvas's real DeskHosts registry.
function WindowFixture() {
  const mode = useOrgView(slug)
  return <CurrentOrg.Provider value={slug}>
    <OrgCanvas tree={tree} slug={slug} op={op} toast={noop} mailEvt={null}
      canvasContent={mode === 'attention' ? 'hidden' : 'shown'}
      renderOrgSlot={ctx => <AttentionView slug={slug} tree={tree} op={op} toast={noop}
        map={ctx.map} posOf={ctx.posOf} onFocusAgent={ctx.onFocusAgent} deskExtras={ctx.deskExtras} />} />
  </CurrentOrg.Provider>
}

test('zoomed Canvas desk transfers to Attention and returns on the same mounted camera', async t => {
  localStorage.clear(); forgetAttentionMode(); resetCanvasSessionForTests(); resetConvos()
  useFakeClock(); installFetch(new FakeServer())
  const proto = window.HTMLElement.prototype
  const rect = proto.getBoundingClientRect
  const capture = proto.setPointerCapture, release = proto.releasePointerCapture
  proto.getBoundingClientRect = function () {
    return this.classList.contains('viewport')
      ? { x: 0, y: 0, left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, toJSON() {} } as DOMRect
      : rect.call(this)
  }
  proto.setPointerCapture = noop; proto.releasePointerCapture = noop
  const view = await mountView(<WindowFixture />, h => h)
  t.after(async () => {
    await view.unmount(); proto.getBoundingClientRect = rect
    proto.setPointerCapture = capture; proto.releasePointerCapture = release
    realClock(); resetConvos(); localStorage.clear(); forgetAttentionMode()
  })
  await advance(2500)
  const card = view.el.querySelector('[data-first-use-agent="alpha"]')!
  for (const type of ['pointerdown', 'pointerup']) {
    await inAct(() => card.dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, button: 0, clientX: 200, clientY: 200,
    })))
  }
  await advance(1800)
  const canvasDesk = () => view.el.querySelector('[data-first-use-agent="alpha"].desk')
  assert.equal(!!canvasDesk()?.querySelector('.cc-composer'), true, 'positive control: Canvas really zoomed into alpha')
  const spaceTransform = () => (view.el.querySelector('.space') as HTMLElement).style.transform
  const camera = spaceTransform()
  await inAct(() => setOrgView(slug, 'attention'))
  await inAct(() => flush(4))
  assert.equal(view.el.querySelector('.attn-desk .cc-head-left')?.textContent?.includes('alpha'), true,
    'Attention owns the actual desk, not its open-elsewhere placeholder')
  assert.equal(!!view.el.querySelector('.attn-desk .cc-composer'), true)
  assert.equal(document.querySelectorAll('.cc-composer').length, 1, 'one live composer for the agent')
  // Focus from the desk's canonical menu must use Attention even while the
  // same agent still has a zoomed Canvas destination mounted underneath.
  const header = view.el.querySelector('.attn-desk .cc-head-left')!
  await inAct(() => header.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30,
  })))
  const focus = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button')]
    .find(button => button.textContent?.trim() === 'Focus')!
  assert.equal(!!focus, true)
  await inAct(() => focus.click())
  await inAct(() => flush(4))
  assert.equal(!!view.el.querySelector('.attn-desk .cc-composer'), true)
  assert.equal(spaceTransform(), camera,
    'Focus leaves the hidden camera alone')
  await inAct(() => setOrgView(slug, 'canvas'))
  await inAct(() => flush(4))
  assert.equal(!!canvasDesk()?.querySelector('.cc-composer'), true, 'Canvas gets the existing desk back')
  assert.equal(spaceTransform(), camera, 'camera retained across both switches')
})
