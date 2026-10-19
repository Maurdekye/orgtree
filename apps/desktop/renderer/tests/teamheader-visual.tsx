import { createRoot } from 'react-dom/client'
import { TeamModal } from '../src/canvas/team'
import { CurrentOrg } from '../src/popout'
import { AgentNavProvider } from '../src/canvas/agentnav'
import { commitModalRect, forgetModalOpenCache, forgetModalPins, pinModal, unpinModal } from '../src/canvas/modalpin'
import type { CanvasNode } from '../src/canvas/shared'

// Real Team/PinFrame/MovableSurface, with synthetic feed and native-command
// stubs only. window.open still creates a real isolated Electron child.
const org = 'team-header-synthetic'
const nid = 'synthetic-team-lead-with-a-deliberately-long-name'
const make = (id: string, parent?: string, busy = false) => ({ id, title: id, parent, busy,
  generation: 1, state: 'live', tier: 'sol', children: [], turns: [], seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] } } as CanvasNode)
const lead = make(nid), member = make('active-member', nid, true), idle = make('idle-member', nid)
lead.children = [member, idle]
const map = new Map([lead, member, idle].map(n => [n.id, n]))
window.fetch = (() => Promise.reject(Error('No network reads in Team header fixture'))) as typeof fetch
;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
  minimizePopout: async () => {}, toggleMaximizePopout: async () => {}, closePopout: async () => {},
  getPopoutState: async () => ({ maximized: false }), onEvent: () => () => {},
}
localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
Object.assign(window, { teamHeaderMode(mode: string, width: number) {
  if (mode === 'pinned') {
    pinModal('agent-team', { x: 40, y: 50, w: width, h: 360 }, org)
    commitModalRect('agent-team', { x: 40, y: 50, w: width, h: 360 }, org)
  } else unpinModal('agent-team', org)
} })
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value={org}><AgentNavProvider>
  <TeamModal map={map} nid={nid} onPick={() => {}} refs={{ world: { org }, onOpen() {} } as never} close={() => {}} />
</AgentNavProvider></CurrentOrg.Provider>)
