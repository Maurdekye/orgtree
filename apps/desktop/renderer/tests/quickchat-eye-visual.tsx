import { createRoot } from 'react-dom/client'
import { QuickChat } from '../src/QuickChatBox'
import { rememberSuperior } from '../src/quickchat'
import type { TreePayload } from '../src/types'

// Synthetic fixture only. No request can reach a real engine.
window.fetch = (async (url: string) => new Response(JSON.stringify(String(url).includes('/api/providers')
  ? { providers: [{ id: 'claude', hire_enabled: true, status: { installed: true } }] }
  : String(url).includes('/staffing-options')
    ? { tiers: [{ tier: 'opus', seat: 4, efforts: ['low', 'high', 'max'], accounts: [], default_ok: true, native_ok: true }], loading: false, errors: [], stale: false, at: 0, generation: 0 }
    : { items: [], references: {}, revisions: {}, next_cursor: null }),
{ headers: { 'content-type': 'application/json' } })) as typeof fetch
const tree = { slug: 'synthetic', name: 'Synthetic', roots: [
  { id: 'lead', tier: 'sonnet', state: 'live', children: [] },
] } as unknown as TreePayload
localStorage.clear()
rememberSuperior('eye-agent', 'lead')
const noop = () => {}
createRoot(document.getElementById('root')!).render(<>
  <div className="sample" id="top-sample">
    <div className="caption">Quick chat · top level selected</div>
    <QuickChat slug="eye-top" tree={tree} op={async () => ({})} toast={noop} onHired={noop} />
  </div>
  <div className="sample" id="agent-sample">
    <div className="caption">Quick chat · agent superior retains its model card</div>
    <QuickChat slug="eye-agent" tree={tree} op={async () => ({})} toast={noop} onHired={noop} />
  </div>
</>)
