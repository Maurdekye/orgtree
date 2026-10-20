// retiredpiles.visual.tsx — captures for "with hide retired agents off, no
// retired agents appear on the canvas" (docket
// with-hide-retired-agents-off-no-retired-agents-a, user 2026-10-20 11:00Z).
// The whole OrgCanvas, drawn from a REAL engine snapshot: the driver
// (tools/rig/retiredpiles-visual.mjs) injects the `/records` answer the rig's
// scale proof saved (1411 retired agents in the live org's shape) as
// `window.__RETIRED_SNAPSHOT__`, and the fixture runs it through the real
// record projection, as the app's record feed does. No engine, bridge or
// live org at capture time.
import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { projectTree } from '../src/recordprojection'
import { setHideRetiredOn } from '../src/canvas/shared'
import '../src/styles.css'

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/work-items-page/.test(p) ? { format: 'orgtree.work-page/v1', group: 'items', rows: [], total: 0,
      totals: { items: 0, archived: 0, backlogged: 0 }, matched: { items: 0, archived: 0, backlogged: 0 },
      counts: { active: 0, attention: 0, archived: 0, backlogged: 0 }, assigned_count: 0, next_offset: null, revision: 'r1',
      at: '2026-10-20T11:00:00.000Z' }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null }
    : /\/history(?:\?|$)/.test(p) ? { items: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

type Snapshot = { records: { entity: string; id: string; body: unknown }[] }
const snapshot = (window as unknown as { __RETIRED_SNAPSHOT__?: Snapshot }).__RETIRED_SNAPSHOT__
if (!snapshot) throw new Error('no snapshot injected')
const table = new Map<string, Map<string, unknown>>()
for (const r of snapshot.records) {
  if (!table.has(r.entity)) table.set(r.entity, new Map())
  table.get(r.entity)!.set(r.id, r.body)
}
const t0 = performance.now()
const tree = projectTree(table)
const projectMs = performance.now() - t0
const noop = () => {}

const metrics: Record<string, number> = { projectMs, records: snapshot.records.length }
Object.assign(window, { retiredPilesVisual: {
  metrics,
  /** flip "hide retired agents" live, and time the canvas's answer to the flip */
  hide: (on: boolean) => new Promise<number>((resolve) => {
    const t = performance.now()
    setHideRetiredOn(on)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t)))
  }),
  contrast: (light: boolean) => {
    document.documentElement.classList.toggle('contrast-light', light)
    document.documentElement.classList.toggle('contrast-charcoal', !light)
  },
} })
localStorage.clear()
setHideRetiredOn(false)
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
const root = document.getElementById('root')!
root.style.width = '100vw'
root.style.height = '100vh'
const m0 = performance.now()
createRoot(root).render(<OrgCanvas tree={tree} op={() => Promise.resolve({} as never)} slug={tree.slug ?? 'org'}
  toast={noop} mailEvt={null} />)
requestAnimationFrame(() => requestAnimationFrame(() => { metrics.mountMs = performance.now() - m0 }))
