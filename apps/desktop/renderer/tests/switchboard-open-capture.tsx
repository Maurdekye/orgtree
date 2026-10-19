import { createRoot } from 'react-dom/client'
import { UserNode } from '../src/canvas/cards'
import { applyTheme } from '../src/themes'
import type { NativeDesktop } from '../src/desktop'

const noop = () => {}
const focused = new URLSearchParams(location.search).get('focused') === 'true'
const eyeW = Math.min(760, innerWidth - 80)
const fake = {
  scratchFolderScopes: ['shared'],
  openAgentScratchFolder: async () => ({ ok: true }),
  agentScratchAgentsFileExists: async () => ({ ok: true, exists: true }),
  openAgentScratchAgentsFile: async () => ({ ok: true }),
} as unknown as NativeDesktop
Object.assign(window, { orgtreeDesktop: fake })
window.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<UserNode
  pos={{ x: focused ? (eyeW - 124) / 2 + 35 : 45, y: 90 }} isDrop={false} stats={{ circ: 0, seats: 0, free: 0 }} pip={null}
  seats={{ haiku: 1 }} pxc={1} zoom={1} focused={focused} eyeW={eyeW}
  onSpawn={noop} onInbox={noop} onGear={noop} onDocket={noop} onPresentations={noop}
  onFocus={noop} onAgents={noop} onNewProject={noop} onMailLink={noop} onWorkLink={noop}
  posX={() => 0} map={new Map()} op={async () => ({} as never)} slug="fixture" toast={noop} />)
