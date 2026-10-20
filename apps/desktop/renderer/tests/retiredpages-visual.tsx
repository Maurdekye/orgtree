import { createRoot } from 'react-dom/client'
import { PilePicker } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('contrast-light', params.get('theme') === 'light')
const agent = (id: string, i: number) => ({ id, state: 'archived', tier: i % 3 ? 'sol' : 'sonnet', children: [], turns: i % 4 ? [{ at: new Date(Date.now() - i * 3600000).toISOString() }] : [] })
let requests = 0
window.fetch = (async input => {
  const u = new URL(String(input), location.href); requests++
  const q = u.searchParams.get('q') ?? ''
  const rows = q ? [agent('old-archive-needle', 7)] : Array.from({ length: 50 }, (_, i) => agent(`retired-worker-${String(1401 - i).padStart(4, '0')}`, i))
  return new Response(JSON.stringify({ agents: rows, next_cursor: q ? null : 'next' }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
Object.assign(window, { fixtureRequests: () => requests })
createRoot(document.getElementById('root')!).render(<PilePicker org="synthetic" pile={{ key: 'boss|a', parent: 'boss', kind: 'a', list: ['retired-worker-1401'], front: 'retired-worker-1401', total: 1401 }}
  map={new Map<string, CanvasNode>()} close={() => {}} onPick={() => { document.body.dataset.picked = 'true' }} op={async () => ({ ok: true } as never)} />)
