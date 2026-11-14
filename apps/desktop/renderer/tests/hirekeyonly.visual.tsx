// hirekeyonly.visual.tsx: the fixture for hirekeyonly.capture.cjs (coordinator's ruling 2026-11-14 m30df0e222e4d:
// only a metered API key can run the model, so nothing is picked and the hire waits for the user's choice).
//
// The REAL draft card (`DraftNode`) of an Opus hire in an organization whose staffing answer says: the own sign-in is
// signed out, the default account cannot run Opus, a metered key can. Browser-only: no engine, bridge or live org;
// every request is answered here. `window.hired` is what the card would have hired.
import { createRoot } from 'react-dom/client'
import { DraftNode } from '../src/canvas/cards'
import { prefetchStaffingOptions } from '../src/canvas/staffingoptions'
import type { TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

const ORG = 'alpha'
localStorage.clear()
const key = { id: 'claude-key', value: 'claude-key', provider: 'claude', ambient: false, kind: 'apikey', email: null }
window.fetch = (async (url: RequestInfo | URL) => {
  const p = new URL(String(url), 'http://localhost').pathname
  const payload = p.endsWith('/staffing-options') ? {
    tiers: [{ tier: 'opus', seat: 5, provider: 'claude', efforts: ['low', 'medium', 'high'], accounts: [key], default_ok: false, native_ok: false, by_room: [] }],
    spent: [], at: 1, stale: false, errors: [], loading: false, generation: 1 }
    : p === '/api/accounts' ? { accounts: [
      { id: 'claude-key', provider: 'claude', label: 'Metered key', mode: 'apikey', standing: { state: 'ready' } },
      { id: 'claude-9', provider: 'claude', label: 'Signed out', standing: { state: 'ready' } }] }
    : p === '/api/charters' ? { charters: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const tree = { slug: ORG, name: 'Alpha', dirs: [], tiers: { opus: 5 }, max_top_grant: 100, default_top_grant: 50, default_effort: '', effort_default: 'high',
  cascade_hire: true, cascade_alloc: true, default_account: 'claude-9' } as unknown as TreePayload
const hired: unknown[] = []
;(window as unknown as { hired: unknown[] }).hired = hired

void prefetchStaffingOptions(ORG).then(() => {
  createRoot(document.getElementById('root')!).render(
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: 'var(--bg)' }}>
      <div style={{ position: 'absolute', left: '50%', top: 150 }}>
        <DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'opus' }} map={new Map()} seats={{ opus: 5 }} maxTop={100} defaultTop={50}
          tree={tree} zoom={1} pxc={1} onConfirm={(name, _grant, _charter, scope) => { hired.push({ name, account: scope?.account ?? null }) }} onCancel={() => {}} />
      </div>
    </div>)
})
