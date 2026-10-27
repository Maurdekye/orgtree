// pinrelease.visual.tsx — the frame capture for USER 2026-10-27 m061e2860fd9b ("when i drag and release a
// pinned app panel, it briefly flickers back to its initial pre-drag positon for 1 frame before settling in the
// new location"; @item:orgtree/4-5-0-bug-pinning-a-floating-open-panel-makes-it). The app's own Apps workspace
// with one window-pinned panel over a fixture canvas area; browser-only fixture data, no engine, bridge or live
// org. The save of a placement answers after `saveDelay` ms, as a real round trip does, and a panel list read can
// be held for `listDelay` ms to answer after a drop is saved. tools/rig/pinrelease-visual.mjs drives it.
import { createRoot } from 'react-dom/client'
import { AppsWorkspace } from '../src/canvas/apps/ui'
import { invalidateCustomApps } from '../src/canvas/apps/store'
import '../src/styles.css'

const slug = 'org'
const knobs = { saveDelay: 150, listDelay: 0 }
const app = { id: 'notes', name: 'Notes', description: 'Saved notes', rev: 1, permission_rev: 1, width: 360, height: 280, capabilities: [],
  permissions: {}, created_by: 'maker', updated_at: '', definition: { name: 'Notes', description: '', html: '<p>Notes</p>', initial_state: {},
    capabilities: [], width: 360, height: 280 } }
const panels = [{ id: 'one', app: 'notes', label: 'Panel 1', rev: 1, open: true, running: true, state: {}, event_seq: 0,
  placement: { mode: 'window', x: 120, y: 80, width: 400, height: 300 }, used_at: '2026-10-27', updated_at: '', created_at: '2026-10-27T09:00:00Z' }]
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const json = (out: unknown, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } })
window.fetch = (async (raw: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(raw), 'http://fixture.invalid')
  const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
  if (input.action === 'list') {
    // what the read finds when it is made, answered after the delay
    const items = input.kind === 'apps' ? [app] : JSON.parse(JSON.stringify(panels))
    if (input.kind !== 'apps' && knobs.listDelay) await wait(knobs.listDelay)
    return json({ items, next_cursor: null, new_count: 0 })
  }
  if (input.action === 'app_get') return json(app)
  if (input.action === 'panel_get') return json(panels[0])
  if (input.action === 'events') return json({ events: [], next_cursor: null, oldest_retained: null })
  if (input.action === 'session_close' || input.action === 'runtime') return json({ items: [], next_cursor: null })
  if (input.action === 'panel_update') {
    await wait(knobs.saveDelay)
    const p = panels[0]!
    if (input.expected_rev !== p.rev) return json({ detail: 'stale revision' }, 409)
    for (const k of ['label', 'open', 'placement']) if (k in input) (p as Record<string, unknown>)[k] = input[k]
    p.rev++
    return json(p)
  }
  return json({ ok: true })
}) as typeof fetch

// every animation frame, where the panel is painted
const samples: { t: number; x: number; y: number }[] = []
let sampling = false
const frameLoop = () => {
  const el = document.querySelector<HTMLElement>('[data-custom-panel="one"]')
  if (el) { const r = el.getBoundingClientRect(); samples.push({ t: performance.now(), x: Math.round(r.x), y: Math.round(r.y) }) }
  if (sampling) requestAnimationFrame(frameLoop)
}
Object.assign(window, { pinReleaseVisual: {
  knobs,
  rect: () => { const el = document.querySelector<HTMLElement>('[data-custom-panel="one"]'); const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null },
  bar: () => { const r = document.querySelector<HTMLElement>('[data-custom-panel="one"] .custom-app-title')?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 3), y: Math.round(r.y + r.height / 2) } : null },
  start: () => { samples.length = 0; sampling = true; requestAnimationFrame(frameLoop) },
  stop: () => { sampling = false; return [...samples] },
  saved: () => ({ rev: panels[0]!.rev, placement: { ...panels[0]!.placement } }),
  reset: (x: number, y: number) => { panels[0]!.placement = { ...panels[0]!.placement, x, y } },
  invalidate: () => invalidateCustomApps(slug),
} })

function Surface() {
  // the org's canvas area, as OrgCanvas's viewport publishes it for pin layers
  return <div data-pin-org={slug} style={{ position: 'fixed', left: 0, top: 40, width: 1000, height: 620, background: 'var(--bg)', border: 0 }}>
    <AppsWorkspace slug={slug} />
  </div>
}
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
