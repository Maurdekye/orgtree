import { createRoot } from 'react-dom/client'
import { DraftScopeModal } from '../src/canvas/modals'
import { CurrentOrg } from '../src/popout'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

// Synthetic modal only: no engine, sign-in or live application access.
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
localStorage.clear()
window.fetch = (async () => new Response(JSON.stringify({ servers: [], tiers: [], accounts: [] }),
  { headers: { 'content-type': 'application/json' } })) as typeof fetch
const tree = { slug: 'superior-scope', dirs: [], default_visibility: 'team',
  default_effort: 'high', tiers: { sol: 2 } } as unknown as TreePayload
const target = { id: 'coordinator', scope: { add_dirs: [{ path: 'D:/synthetic/work', mode: 'ro' }],
  tools: { bash: true, mcp: [] }, org_visibility: 'self' } } as CanvasNode
const accounts = [{ id: 'openai-test', provider: 'openai', label: 'Synthetic account', standing: { state: 'ready' } }]
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value={tree.slug}>
  <DraftScopeModal draft={{ parent: null, tier: 'sol', above: { anchor: target.id } }}
    map={new Map([[target.id, target]])} tree={tree} accounts={accounts}
    scope={{ add_dirs: [], tools: {}, org_visibility: 'team', effort: 'high', account: 'openai-test' }}
    onSave={() => {}} close={() => {}} />
</CurrentOrg.Provider>)
