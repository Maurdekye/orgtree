// Synthetic production-component screenshots: bridge calls are recorded only.
import { createRoot } from 'react-dom/client'
import { SettingsPanel } from '../src/App'
import { UserNode } from '../src/canvas/cards'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import type { CanvasNode } from '../src/canvas/shared'
import { useContextMenu } from '../src/canvas/contextmenu'
import { scratchFolderAction } from '../src/scratch-folder'
import { applyTheme } from '../src/themes'
import type { NativeDesktop } from '../src/desktop'
import type { TreePayload, ToastFn } from '../src/types'
import '../src/styles.css'

const noop = () => {}
const action = scratchFolderAction as (org: string, node: string, toast: ToastFn,
  scope?: 'team' | 'shared') => (() => void) | undefined
;(window as Window & { orgtreeDesktop?: NativeDesktop }).orgtreeDesktop = {
  scratchFolderScopes: ['team', 'shared'],
  openAgentScratchFolder: async () => ({ ok: true }),
} as unknown as NativeDesktop
window.fetch = async input => new Response(JSON.stringify(String(input).includes('/orgmd')
  ? { content: '# Example organization' } : String(input).includes('/accounts') ? { accounts: [] } : {}),
{ headers: { 'content-type': 'application/json' } })
const node = { id: 'example-agent', state: 'live', children: [] } as unknown as CanvasNode
const tree = { slug: 'fixture', name: 'Example organization', nodes: [], edges: [], net: { hubs: [] } } as unknown as TreePayload
function Fixture() {
  const menu = useContextMenu()
  const mode = new URLSearchParams(location.search).get('entry')
  if (mode === 'settings') return <SettingsPanel tree={tree} toast={noop} close={noop} />
  if (mode === 'switchboard') return <UserNode pos={{ x: 80, y: 110 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={{ haiku: 1 }}
    pxc={1} zoom={1} onSpawn={noop} onMailLink={noop} onWorkLink={noop}
    focused={false} eyeW={124} posX={() => 0} onFocus={noop}
    map={new Map()} op={async () => ({} as never)} slug="fixture" toast={noop}
    onInbox={noop} onGear={noop} onDocket={noop} onPresentations={noop} />
  const handlers: AgentMenuHandlers & { onTeamScratchFolder?: () => void } = {
    onInbox: noop, onSettings: noop, onOpenDesk: noop,
    onScratchFolder: scratchFolderAction('fixture', node.id, noop),
    onTeamScratchFolder: action('fixture', node.id, noop, 'team'),
  }
  return <><button id="agent" style={{ position: 'absolute', left: 80, top: 90 }}
    onContextMenu={event => menu.open(event, () => agentMenuEntries(node, handlers))}>
    Example agent</button>{menu.node}</>
}
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Fixture />)
