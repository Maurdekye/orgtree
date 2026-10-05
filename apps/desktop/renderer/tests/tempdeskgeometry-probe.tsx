// Real layout and native-window companion to tempdesk.test.tsx. Fake data only.
import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

const noop = () => {}
;(window as any).orgtreeDesktop = { onEvent: () => noop, getPreferences: async () => ({}) }
window.fetch = (async (input: RequestInfo | URL) => {
  const path = String(input)
  let body: unknown = {}
  if (/chat|history/.test(path)) body = {items: [], more: false, cursor: null}
  if (/work-items/.test(path)) body = {items: [], counts: {}, now: new Date().toISOString()}
  if (/documents/.test(path)) body = {documents: [], total: 0, next_offset: null}
  if (/scratch/.test(path)) body = {path: '', entries: []}
  return new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}})
}) as typeof fetch
const node = {id: 'worker', tier: 'opus', model_id: 'opus', state: 'live', generation: 0,
  children: [], parent: null, seat: 1, grant: 0, free: 0, lineage: [], turns: [],
  scope: {tools: {}, add_dirs: [], org_visibility: 'team'}}
const tree = {slug: 'geometry', name: 'Geometry', roots: [node], tiers: {opus: 1},
  dirs: [], credit_requests: [], audiences: [], audience_requests: [], compact_at: 0,
  max_top_grant: 1000, audit: {live_nodes: 1, problems: []}} as unknown as TreePayload
createRoot(document.getElementById('root')!).render(
  <div style={{position: 'fixed', top: 100, left: 19, right: 15, bottom: 13, display: 'flex'}}>
    <OrgCanvas tree={tree} slug="geometry" op={async () => ({})} toast={noop}
      mailEvt={null} onOpenAgentGallery={noop} />
  </div>)
const pause = () => new Promise(resolve => setTimeout(resolve, 40))
async function until(find: () => HTMLElement | null) {
  for (let n = 0; n < 100; n++) { const el = find(); if (el) return el; await pause() }
  throw Error('Fixture did not render the expected element')
}
const rect = (el: Element) => {
  const b = el.getBoundingClientRect()
  return {x: b.x, y: b.y, width: b.width, height: b.height}
}
;(window as any).geometryProbe = {
  async open() {
    const card = await until(() => document.querySelector('.space [data-copy-agent-name="worker"]'))
    card.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true,
      button: 2, clientX: 200, clientY: 180}))
    const entry = await until(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent?.trim() === 'Open desk') ?? null)
    entry.click()
    const modal = await until(() => document.querySelector('.tempdesk-panel'))
    await until(() => modal.querySelector('textarea'))
    return {rect: rect(modal), screenX, screenY, ratio: devicePixelRatio}
  },
  async pin() {
    document.querySelector<HTMLButtonElement>('.tempdesk-pin')!.click()
    const pin = await until(() => document.querySelector('.pinwin'))
    await pause()
    const r = rect(pin)
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 15)
    return {rect: r, modal: !!document.querySelector('.tempdesk-panel'),
      visible: !!hit && pin.contains(hit), composer: !!pin.querySelector('textarea')}
  },
  unpin() { document.querySelector<HTMLButtonElement>('.pinwin-unpin')!.click() },
  popout() {
    document.querySelector<HTMLButtonElement>('.tempdesk-panel [aria-label="Open in new window"]')!.click()
  },
  state() { return {modal: !!document.querySelector('.tempdesk-panel'),
    backdrop: !!document.querySelector('.tempdesk-over'), composers: document.querySelectorAll('textarea').length} },
}
