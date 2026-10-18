import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
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
    // a boolean, never the node: a DOM element handed to the reporter as
    // `actual` serialises its whole document on failure (attentionaudit §5)
    assert.equal(!!document.querySelector('.ctxmenu'), false, `${selector}: Escape closes the menu`)
  }
  // Opening a menu was the old regression. Also execute Focus: it changes the
  // selected desk through the Canvas-owned menu builder while Canvas is hidden.
  for (const id of ['beta', 'alpha', 'beta']) {
    await inAct(() => { v.el.querySelector<HTMLButtonElement>('.attn-agents-toggle')!.click() })
    const target = v.el.querySelector(`[data-attn-agent="${id}"]`)!
    await inAct(() => { target.dispatchEvent(new window.MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
    const focus = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button')]
      .find(button => button.textContent?.trim() === 'Focus')
    assert.equal(!!focus, true, 'canonical Focus action is present')
    await inAct(() => { focus!.click() })
    await inAct(() => flush(4))
    assert.equal(!!document.querySelector('.ctxmenu'), false, 'Focus closes the menu')
    assert.equal(v.el.querySelector('[data-attn-agent][aria-selected=true]')?.getAttribute('data-attn-agent'), id)
    assert.equal(v.el.querySelector('.attn-desk .cc-head-left')?.textContent?.includes(id), true,
      'Focus renders the requested desk in Attention')
  }
})

test('Attention Hire a subordinate opens the draft in the Agent desk panel', async (t) => {
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
        attentionDraft={ctx.attentionDraft}
        onFocusAgent={ctx.onFocusAgent} deskExtras={ctx.deskExtras} />} />
  </CurrentOrg.Provider>, h => h)
  t.after(() => v.unmount())
  await inAct(() => flush(8))
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.attn-agents-toggle')!.click() })
  const agent = v.el.querySelector('[data-attn-agent="alpha"]')!
  await inAct(() => { agent.dispatchEvent(new window.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
  await inAct(() => flush(3))
  const hire = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button')]
    .find(button => button.textContent?.trim().startsWith('Hire a subordinate'))
  assert.equal(!!hire, true, 'the canonical Hire submenu is available')
  await inAct(() => { hire!.click() })
  await inAct(() => flush(3))
  const tier = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu-submenu button')]
    .find(button => !button.disabled)
  assert.ok(tier, 'at least one eligible hire tier is offered')
  await inAct(() => { tier!.click() })
  await inAct(() => flush(8))
  assert.equal(!!v.el.querySelector('.attn-desk .sq.draft'), true,
    'the reusable uninitialized desk is presented inside the Attention agent desk')
  assert.equal(!!v.el.querySelector('.attn-desk .df-name'), true,
    'the same name field is available in the panel')
  assert.equal(!!document.querySelector('.viewport .sq.draft'), false,
    'Attention hire does not open a hidden canvas draft')
  const cancel = [...v.el.querySelectorAll<HTMLButtonElement>('.attn-desk .df-foot button')]
    .find(button => button.textContent?.trim().startsWith('cancel'))
  assert.ok(cancel, 'the shared draft exposes its cancel action')
  await inAct(() => { cancel!.click() })
  await inAct(() => flush(4))
  assert.equal(!!v.el.querySelector('.attn-desk .sq.draft'), false,
    'cancelling the draft leaves no draft or hire behind')
})

test('Hire from an Attention desk header opens its draft in that desk', async (t) => {
  localStorage.clear()
  forgetAttentionMode()
  resetConvos()
  installFetch(new FakeServer())
  setOrgView(slug, 'attention')
  const op = () => Promise.resolve({})
  const toast = () => {}
  function Harness() {
    const [canvasContent, setCanvasContent] = useState<'hidden' | 'shown'>('hidden')
    return <CurrentOrg.Provider value={slug}>
      <button className="toggle-canvas" onClick={() => setCanvasContent(v => v === 'hidden' ? 'shown' : 'hidden')}>
        switch view
      </button>
      <OrgCanvas tree={tree} slug={slug} op={op} toast={toast} mailEvt={null}
        canvasContent={canvasContent} renderOrgSlot={ctx => <AttentionView
          slug={slug} tree={tree} op={op} toast={toast} map={ctx.map} posOf={ctx.posOf}
          attentionDraft={ctx.attentionDraft}
          onFocusAgent={ctx.onFocusAgent} deskExtras={ctx.deskExtras} />} />
    </CurrentOrg.Provider>
  }
  const v = await mountView(<Harness />, h => h)
  t.after(() => v.unmount())
  await inAct(() => flush(8))

  const header = v.el.querySelector('.attn-desk .cc-head-left')
  assert.ok(header, 'the Attention agent desk header is mounted')
  await inAct(() => { header!.dispatchEvent(new window.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
  await inAct(() => flush(3))
  const hire = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button')]
    .find(button => button.textContent?.trim().startsWith('Hire a subordinate'))
  assert.ok(hire, 'the desk header exposes the canonical Hire submenu')
  await inAct(() => { hire!.click() })
  await inAct(() => flush(3))
  const tier = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu-submenu button')]
    .find(button => !button.disabled)
  assert.ok(tier, 'at least one eligible hire tier is offered')
  await inAct(() => { tier!.click() })
  await inAct(() => flush(8))
  assert.equal(!!v.el.querySelector('.attn-desk .sq.draft'), true,
    'the desk action replaces the Attention agent desk with the uninitialized desk')
  const name = v.el.querySelector<HTMLInputElement>('.attn-desk .df-name')!
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'shared draft name')
    name.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.toggle-canvas')!.click() })
  await inAct(() => flush(6))
  const canvasName = v.el.querySelector<HTMLInputElement>('.viewport .sq.draft .df-name')
  assert.equal(canvasName?.value, 'shared draft name',
    'switching to Canvas shows the same draft fields')
  assert.equal(!!v.el.querySelector('.attn-desk .sq.draft'), false,
    'the draft occupies only the active surface')
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.toggle-canvas')!.click() })
  await inAct(() => flush(6))
  assert.equal(v.el.querySelector<HTMLInputElement>('.attn-desk .df-name')?.value, 'shared draft name',
    'switching back retains the typed name')
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.toggle-canvas')!.click() })
  await inAct(() => flush(6))
  const canvasCancel = [...v.el.querySelectorAll<HTMLButtonElement>('.viewport .sq.draft .df-foot button')]
    .find(button => button.textContent?.trim().startsWith('cancel'))
  assert.ok(canvasCancel, 'the Canvas copy exposes the shared cancel action')
  await inAct(() => { canvasCancel!.click() })
  await inAct(() => flush(5))
  assert.equal(!!v.el.querySelector('.viewport .sq.draft'), false,
    'cancelling from Canvas clears the shared draft')
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.toggle-canvas')!.click() })
  await inAct(() => flush(5))
  assert.equal(!!v.el.querySelector('.attn-desk .sq.draft'), false,
    'the cancelled draft is also gone from Attention')
})
