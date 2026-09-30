import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Profiler } from 'react'
import { JSDOM } from 'jsdom'
import { installBridge, removeBridge } from './shellbridge'
import { EyeDesk } from '../src/canvas/cards'
import { DeskHosts } from '../src/canvas/deskhosts'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { PinFrame, pinModal, forgetModalPins } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { resetConvos } from '../src/convo'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

test('switchboard tabs with the same agent open in the Attention desk settle', async t => {
  resetConvos(); localStorage.clear(); installFetch(new FakeServer())
  installBridge({})
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const cw = child.window as unknown as Window
  cw.focus = () => {}; cw.requestAnimationFrame = () => 1; cw.cancelAnimationFrame = () => {}
  const realOpen = window.open
  window.open = (() => cw) as typeof window.open
  const g = globalThis as unknown as { MutationObserver: typeof MutationObserver }
  const realObserver = g.MutationObserver
  g.MutationObserver = (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver
  t.after(() => { window.open = realOpen; g.MutationObserver = realObserver; removeBridge(); child.window.close() })
  const agents = ['coordinator-opus', 'peer-a', 'peer-b'].map(id => ({
    id, tier: 'opus', state: 'live', generation: 0, parent: USER, children: [],
    seat: 4, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
  } as unknown as CanvasNode))
  const map = new Map(agents.map(n => [n.id, n]))
  const tree = { slug: 'org', roots: agents, asks: [], asks_open: 0,
    work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0 } as unknown as TreePayload
  localStorage.setItem('orgtree-eyemin-org', JSON.stringify(agents.map(n => n.id)))
  setAttentionLayout('org', { agent: agents[0]!.id })
  forgetModalPins(); setOrgView('org', 'canvas')
  pinModal('attention-desk', { x: 20, y: 20, w: 640, h: 720 }, 'org')
  let commits = 0
  const view = await mountView(<Profiler id="switchboard" onRender={() => {
    assert.ok(++commits < 100, 'tab selection caused a render loop')
  }}><CurrentOrg.Provider value="org"><DeskHosts map={map} slug="org">
    <div data-place="attention"><AttentionView slug="org" tree={tree} map={map}
      op={op} toast={noop} /></div>
    <PinFrame inline kind="switchboard-fixture" title="Switchboard" panel="switchboard-fixture" close={noop}>
    <div data-place="switchboard"><EyeDesk slug="org" map={map} op={op}
      toast={noop} pub={false} eyeW={1400} posX={() => 0}
      onMailLink={noop} onWorkLink={noop} /></div>
    </PinFrame>
  </DeskHosts></CurrentOrg.Provider></Profiler>, el => el)
  t.after(() => view.unmount())
  await flush()
  assert.ok(document.querySelector('.attn-panel-desk textarea'))
  const pop = document.querySelector<HTMLButtonElement>('.switchboard-fixture .popout-button')!
  assert.ok(pop, 'switchboard window control missing')
  await inAct(() => pop.click()); await flush()
  assert.ok(cw.document.querySelector('.eye-tabs'), 'switchboard did not enter separate document')
  for (const n of agents) {
    const tab = [...cw.document.querySelectorAll<HTMLButtonElement>('.eye-tab-main')]
      .find(b => b.textContent?.includes(n.id))!
    assert.ok(tab, `missing ${n.id} tab`)
    await inAct(() => tab.click()); await flush()
    assert.ok(cw.document.querySelector('[data-place="switchboard"] textarea'), 'tab opened no desk')
    await inAct(() => tab.click()); await flush()
  }
  const settled = commits
  await flush()
  assert.equal(commits, settled, 'desks keep rendering after tab selection')
})
