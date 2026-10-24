import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DraftNode, type DraftForm } from '../src/canvas/cards'
import { NodeConfig } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { CurrentOrg } from '../src/popout'
import { syncFastModes } from '../src/canvas/fastmode'

window.fetch = (async () => new Response(JSON.stringify({ accounts: [], servers: ['synthetic-mcp'], charters: [] }),
  { headers: { 'content-type': 'application/json' } })) as typeof fetch
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
syncFastModes([{ tiers: [{ tier: 'opus', fast_mode: true, fast_mode_versions: { '5.5': true } }] }] as never)
const tree = { slug: 'draft-settings-capture', roots: [], dirs: [], tiers: { opus: 5, sol: 2 },
  default_tools: { bash: true, edit: true, web: true, subagents: true, mcp: [] },
  default_visibility: 'team', permission_mode: 'acceptEdits', default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
} as unknown as TreePayload
const liveNode = { id: 'existing-agent', tier: 'opus', state: 'live', parent: null, generation: 1, children: [],
  seat: 5, grant: 12, free: 12, charter: 'Synthetic existing agent', team_charter: '',
  scope: { tools: tree.default_tools, add_dirs: [], org_visibility: 'team', permission_mode: 'acceptEdits' },
} as unknown as CanvasNode
function Fixture() {
  const [form, setForm] = useState<DraftForm>({ name: 'proposed-agent', charter: 'Synthetic standing task',
    grant: 12, chosen: [], scope: null })
  const [tier, setTier] = useState('opus')
  const [live, setLive] = useState(false)
  Object.assign(window, { draftToolsState: () => form, showLiveSettings: () => setLive(true) })
  return <CurrentOrg.Provider value={tree.slug}>{live
    ? <NodeConfig node={liveNode} map={new Map([[liveNode.id, liveNode]])} tree={tree} slug={tree.slug}
        op={async () => { throw new Error('Capture must not mutate an agent') }} toast={() => {}} close={() => setLive(false)} />
    : <DraftNode pos={{ x: 100, y: 100 }} draft={{ parent: null, tier }} tree={tree}
      map={new Map()} seats={tree.tiers!} maxTop={100} defaultTop={12} zoom={1} pxc={1}
      form={form} onFormChange={setForm} onTierChange={setTier} onConfirm={() => { throw new Error('Capture must not hire') }} onCancel={() => {}} />
  }</CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
