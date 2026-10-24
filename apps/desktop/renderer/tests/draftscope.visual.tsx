import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DraftNode, type DraftForm } from '../src/canvas/cards'
import type { TreePayload } from '../src/types'
import { CurrentOrg } from '../src/popout'

// Real draft card and menu, with no engine or native desktop bridge.
window.fetch = (async () => new Response(JSON.stringify({ accounts: [], servers: ['synthetic-mcp'], charters: [] }),
  { headers: { 'content-type': 'application/json' } })) as typeof fetch
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
const tree = { slug: 'draft-tools-capture', roots: [], dirs: [], tiers: { opus: 5 },
  default_tools: { bash: true, edit: true, web: true, subagents: true, mcp: [] },
  default_visibility: 'team', default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
} as unknown as TreePayload
function Fixture() {
  const [form, setForm] = useState<DraftForm>({ name: 'proposed-agent', charter: 'Synthetic standing task',
    grant: 12, chosen: [], scope: null })
  Object.assign(window, { draftToolsState: () => form })
  return <CurrentOrg.Provider value={tree.slug}>
    <DraftNode pos={{ x: 100, y: 100 }} draft={{ parent: null, tier: 'opus' }} tree={tree}
      map={new Map()} seats={tree.tiers!} maxTop={100} defaultTop={12} zoom={1} pxc={1}
      form={form} onFormChange={setForm} onConfirm={() => { throw new Error('Capture must not hire') }} onCancel={() => {}} />
  </CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
