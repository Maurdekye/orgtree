// Real CSS and canvas, synthetic data only; driven by run-edgejumpgeometry.mjs.
import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { setChartLayout, setCrowdPilesOn, layout, withDraftTree } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

const noop = () => {}
// Hidden native windows can suppress animation frames. Keep the production
// camera clock advancing; all element bounds still come from Chromium layout.
window.requestAnimationFrame = cb => window.setTimeout(() => cb(performance.now()), 16)
window.cancelAnimationFrame = id => window.clearTimeout(id)
;(window as any).orgtreeDesktop = { onEvent: () => noop, getPreferences: async () => ({}) }
window.fetch = (async (input: RequestInfo | URL) => {
  const path = String(input)
  let body: unknown = {}
  if (/chat|history/.test(path)) body = {items: [], more: false, cursor: null}
  if (/work-items/.test(path)) body = {items: [], counts: {}, now: new Date().toISOString()}
  return new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}})
}) as typeof fetch
setChartLayout('circular'); setCrowdPilesOn(false)
const ids = Array.from({length: 30}, (_, i) => `agent-${i}`)
const roots = ids.map(id => ({id, title: id, tier: 'opus', model_id: 'opus', state: 'live', generation: 0,
  children: [], parent: null, seat: 1, grant: 0, free: 0, lineage: [], turns: [],
  scope: {tools: {}, add_dirs: [], org_visibility: 'team'}}))
const tree = {slug: 'geometry', name: 'Geometry', roots, tiers: {opus: 1},
  dirs: [], credit_requests: [], audiences: [], audience_requests: [], compact_at: 0,
  max_top_grant: 1000, audit: {live_nodes: 30, problems: []}} as unknown as TreePayload
const positions = layout(withDraftTree(tree, null), new Map(), 'circular')
createRoot(document.getElementById('root')!).render(
  <div style={{position: 'fixed', inset: 0, display: 'flex'}}>
    <OrgCanvas tree={tree} slug="geometry" op={async () => ({})} toast={noop}
      mailEvt={null} onOpenAgentGallery={noop} />
  </div>)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const box = (el: Element) => {
  const b = el.getBoundingClientRect()
  return {x0: b.left, x1: b.right, y0: b.top, y1: b.bottom}
}
;(window as any).edgeProbe = {
  async run() {
    await wait(1500)
    if (!document.querySelector('.tray-name')) document.querySelector<HTMLButtonElement>('.tray-toggle')!.click()
    await wait(100)
    const measured = []
    for (const at of [0, 1, 5, 14, 15, 24, 28, 29]) {
      const row = [...document.querySelectorAll<HTMLElement>('.tray-row')]
        .find(el => el.querySelector('.tray-name')?.textContent === ids[at])
      if (!row) throw Error('Missing tray row ' + ids[at])
      row.querySelector<HTMLButtonElement>('.tray-main')!.click()
      for (let n = 0; n < 80; n++) {
        await wait(50)
        if (document.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name') === ids[at]) break
      }
      await wait(500)
      for (const zoom of ['focused', 'zoom in', 'zoom out']) {
        if (zoom !== 'focused') {
          document.querySelector<HTMLButtonElement>(`.zoomhud [title="${zoom}"]`)!.click()
          await wait(300)
        }
        const cards = [...document.querySelectorAll<HTMLButtonElement>('.edge-jump')]
        // At a short-window zoom a neighbour can itself be visible; it then
        // correctly needs no proxy. Require real measurements for the case below.
        const current = document.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name')
        if (zoom === 'focused' && current !== ids[at]) throw Error('Camera did not reach ' + ids[at])
        for (const card of cards) {
          card.focus(); await wait(20)
          const id = card.getAttribute('data-copy-agent-name')!
          const want = positions.get(id)!.x < positions.get(current!)!.x ? 'l' : 'r'
          if (!card.classList.contains(want)) throw Error('Wrong screen side ' + JSON.stringify({from: ids[at], to: id, zoom,
            focus: document.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name'), classes: card.className}))
          const c = box(card), h = box(document.querySelector('.zoomhud')!)
          if (c.x0 < h.x1 && c.x1 > h.x0 && c.y0 < h.y1 && c.y1 > h.y0)
            throw Error('Navigation overlap ' + JSON.stringify({at, id, zoom, c, h}))
          measured.push({at, id, zoom, card: c, hud: h})
          card.blur()
        }
      }
    }
    if (measured.length < 10) throw Error('Insufficient real proxy measurements')
    return {width: innerWidth, height: innerHeight, measured}
  },
}
