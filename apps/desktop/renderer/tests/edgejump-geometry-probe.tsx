// Real CSS and canvas, synthetic data only; driven by run-edgejumpgeometry.mjs.
import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { setChartLayout, setCrowdPilesOn, layout, withDraftTree } from '../src/canvas/shared'
import type { TreeNode, TreePayload } from '../src/types'
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
const makeNode = (id: string, children: TreeNode[] = [], parent: string | null = null): TreeNode => ({id, title: id, tier: 'opus', model_id: 'opus', state: 'live', generation: 0,
  children, parent, seat: 1, grant: 0, free: 0, lineage: [], turns: [],
  scope: {tools: {}, add_dirs: [], org_visibility: 'team'}} as unknown as TreeNode)
const roots = ids.map(id => makeNode(id))
roots[0]!.children = ['top-a', 'top-b', 'top-c'].map(id => makeNode(id, [], ids[0]!))
roots[0]!.children[0]!.children = [makeNode('grandchild', [], 'top-a')]
for (const i of [14, 15]) roots[i]!.children = Array.from({length: 12}, (_, j) => makeNode(`team-${i}-${j}`, [], ids[i]!))
const tree = {slug: 'geometry', name: 'Geometry', roots, tiers: {opus: 1},
  dirs: [], credit_requests: [], audiences: [], audience_requests: [], compact_at: 0,
  max_top_grant: 1000, audit: {live_nodes: 58, problems: []}} as unknown as TreePayload
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
    document.querySelector<HTMLButtonElement>('[title="fit the whole org"]')!.click()
    await wait(900)
    const centre = (selector: string) => {
      const el = document.querySelector(selector)
      if (!el) throw Error('Missing card ' + selector)
      const r = el.getBoundingClientRect()
      return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2}
    }
    const eye = centre('.sq.user')
    const angle = (id: string) => {
      const p = centre(`.sq[data-copy-agent-name="${id}"]`)
      return Math.atan2(p.y - eye.y, p.x - eye.x)
    }
    const delta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
    const parent = angle(ids[0]!)
    const topOffsets = ['top-a', 'top-b', 'top-c'].map(id => delta(angle(id), parent))
    if (Math.abs(topOffsets.reduce((a, b) => a + b, 0)) > .02 || Math.sin(angle('top-b')) >= 0)
      throw Error('Native top arc not centred: ' + JSON.stringify(topOffsets))
    if (Math.abs(delta(angle('grandchild'), angle('top-a'))) > .02) throw Error('Native grandchild not centred')
    if (!document.querySelector('.tray-name')) document.querySelector<HTMLButtonElement>('.tray-toggle')!.click()
    await wait(100)
    const measured = []
    const targets = [0, 1, 5, 14, 15, 24, 28, 29].map(i => ids[i]!).concat(['top-a', 'top-c', 'team-14-0', 'team-14-11'])
    for (const target of targets) {
      const at = target
      const row = [...document.querySelectorAll<HTMLElement>('.tray-row')]
        .find(el => el.querySelector('.tray-name')?.textContent === target)
      if (!row) throw Error('Missing tray row ' + target)
      row.querySelector<HTMLButtonElement>('.tray-main')!.click()
      for (let n = 0; n < 80; n++) {
        await wait(50)
        if (document.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name') === target) break
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
        if (zoom === 'focused' && current !== target) throw Error('Camera did not reach ' + target)
        for (const card of cards) {
          card.focus(); await wait(20)
          const id = card.getAttribute('data-copy-agent-name')!
          const want = positions.get(id)!.x < positions.get(current!)!.x ? 'l' : 'r'
          if (!card.classList.contains(want)) throw Error('Wrong screen side ' + JSON.stringify({from: target, to: id, zoom,
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
    return {width: innerWidth, height: innerHeight, topOffsets, measured}
  },
}
