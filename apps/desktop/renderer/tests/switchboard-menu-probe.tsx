// Actual menu renderers on synthetic objects; no API or hire execution.
import { createRoot } from 'react-dom/client'
import { UserNode } from '../src/canvas/cards'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { CanvasNode } from '../src/canvas/shared'
import { applyTheme } from '../src/themes'

const noop = () => {}
const node = { id: 'example', state: 'live', children: [], documents: [], session_id: 'fixture' } as unknown as CanvasNode
function Probe() {
  const menu = useContextMenu()
  return <>
    <UserNode pos={{ x: 40, y: 70 }} isDrop={false} stats={{ circ: 0, seats: 0, free: 0 }} pip={null}
      seats={{ haiku: 1 }} pxc={1} zoom={1} onSpawn={noop} onInbox={noop} onGear={noop}
      onDocket={noop} onPresentations={noop} onFocus={noop}
      onMailLink={noop} onWorkLink={noop} focused={false} eyeW={124} posX={() => 0}
      map={new Map()} op={async () => ({} as never)} slug="fixture" toast={noop} />
    <button id="reference" style={{ position: 'absolute', left: 210, top: 70 }}
      onContextMenu={e => menu.open(e, () => agentMenuEntries(node, {
        onOpenDesk: noop, onInbox: noop, onDocket: noop, onSettings: noop,
        onHire: noop, onRetireAsk: noop, onHalt: noop,
      }))}>Agent reference</button>
    {menu.node}
  </>
}
window.fetch = async () => new Response('{}')
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Probe />)
