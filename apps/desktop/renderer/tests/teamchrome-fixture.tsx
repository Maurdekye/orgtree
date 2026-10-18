import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { TeamModal } from '../src/canvas/team'
import { AgentNavProvider } from '../src/canvas/agentnav'
import { CurrentOrg } from '../src/popout'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

export const CHROME_ORG = 'team-chrome-synthetic'
const node = (id: string, parent?: string, extra = {}) => ({ id, title: id, parent, generation: 1,
  state: 'live', tier: 'sol', children: [], turns: [], seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, ...extra } as CanvasNode)
const team = node('build-team', undefined, { kind: 'project', tier: 'project' })
const worker = node('layout-author', team.id, { busy: true,
  last_status: { status: 'working', summary: 'Matching the shared Agents panel' } })
const idle = node('notes-author', team.id, { last_status: { status: 'done', summary: 'Focused evidence is ready' } })
const outside = node('outside-team', undefined)
team.children = [worker, idle]
export const chromeMap = new Map([team, worker, idle, outside].map(n => [n.id, n]))
const tree = { slug: CHROME_ORG, name: 'Synthetic panels', roots: [team, outside], dirs: [], tiers: { sol: 2 },
  audiences: [], credit_requests: [], audience_requests: [], user_inbox_count: 0,
  audit: { live_nodes: 4, top_level_holds: 0, problems: [] }, max_top_grant: 1000, default_top_grant: 50 } as unknown as TreePayload
const noop = () => {}
export function TeamChromeFixture({ onClose }: { onClose?: () => void }) {
  const [active, setActive] = useState(false), [showTeam, setShowTeam] = useState(true)
  return <CurrentOrg.Provider value={CHROME_ORG}><AgentNavProvider>
    <OrgCanvas tree={tree} slug={CHROME_ORG} op={async () => ({})} toast={noop} mailEvt={null}
      activeAgentsOnly={active} onActiveAgentsOnly={setActive} />
    {showTeam && <TeamModal map={chromeMap} nid={team.id} onPick={noop}
      refs={{ world: { org: CHROME_ORG }, onOpen: noop } as never}
      close={() => { onClose?.(); setShowTeam(false) }} />}
  </AgentNavProvider></CurrentOrg.Provider>
}
