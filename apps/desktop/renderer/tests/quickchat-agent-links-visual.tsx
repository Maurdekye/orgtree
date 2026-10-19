import { createRoot } from 'react-dom/client'
import { QuickChat } from '../src/QuickChatBox'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { rememberSuperior } from '../src/quickchat'
import type { TreePayload } from '../src/types'

// Synthetic fixture only. No request can reach a real engine.
window.fetch = (async (url: string) => {
  const path = new URL(String(url), location.href).pathname
  const payload = path === '/api/providers'
    ? { providers: [{ id: 'claude', hire_enabled: true, status: { installed: true } }] }
    : path.endsWith('/staffing-options')
      ? { tiers: [{ tier: 'opus', seat: 4, efforts: ['low', 'high', 'max'], accounts: [], default_ok: true, native_ok: true }],
          loading: false, errors: [], stale: false, at: 0, generation: 0 }
      : { items: [], references: {}, revisions: {}, next_cursor: null }
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const tree = {
  slug: 'synthetic', name: 'Synthetic', default_top_grant: 50, default_effort: '', effort_default: 'high',
  roots: [{ id: 'boss', tier: 'sonnet', state: 'live', children: [] }],
} as unknown as TreePayload
const noop = () => {}

function RegisterAgentNav() {
  useProvideAgentNav(
    id => [{ label: `Open ${id}`, onSelect: noop }],
    id => ({ title: `Friendly tooltip for ${id}` }),
  )
  return null
}

localStorage.clear()
rememberSuperior('quickchat-agent-nav-capture', 'boss')
createRoot(document.getElementById('root')!).render(
  <AgentNavProvider>
    <RegisterAgentNav />
    <main style={{ padding: 24, width: 900 }}>
      <h2>Quick chat recipient links</h2>
      <p>The selected recipient and picker rows use the shared agent menu and tooltip.</p>
      <ObjectMenuBoundary className="quickchat-agent-nav-capture">
        <QuickChat slug="quickchat-agent-nav-capture" tree={tree} op={async () => ({})}
          toast={noop} onHired={noop} />
      </ObjectMenuBoundary>
    </main>
  </AgentNavProvider>,
)
