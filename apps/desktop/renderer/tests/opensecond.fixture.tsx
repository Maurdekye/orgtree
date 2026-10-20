import { useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { senderMenuAction, ticketOwnerAction } from '../src/canvas/objectactions'
import type { CanvasNode } from '../src/canvas/shared'
import { UserNode } from '../src/canvas/cards'

const noop = () => {}
export const node = (project = false) => ({ id: project ? 'synthetic-project' : 'synthetic-agent',
  state: 'live', tier: project ? 'project' : 'sol', kind: project ? 'project' : undefined,
  children: [], turns: [], seat: 2, grant: 10, free: 8 } as unknown as CanvasNode)
export const entries = (project = false): MenuEntry[] => agentMenuEntries(node(project), {
  onInbox: noop, onSettings: noop, onTeam: noop, onOpenDesk: noop, onOpenTemporary: noop,
  onPin: noop, onPopout: noop, onHire: noop, onNewProject: noop,
}, { codexHire: { enabled: true, installed: true, reason: null } })

export function MenuFixture({ kind = 'agent' }: { kind?: string }) {
  const menu = useContextMenu()
  const base = entries(kind === 'project')
  const wrapped = kind === 'owner' ? ticketOwnerAction(document.body, 'synthetic-agent', base)
    : kind === 'sender' ? senderMenuAction(document.body, 'synthetic-agent', base) : undefined
  const list: MenuEntry[] = kind === 'mention' ? [{ label: 'Mention', onSelect: noop },
    { label: 'Copy mention', onSelect: noop }, ...base] : wrapped ? [wrapped] : base
  return <><button data-target data-copy-agent-name={kind === 'agent' || kind === 'project' ? node(kind === 'project').id : undefined}
    onContextMenu={e => {
      const id = menu.open(e, kind === 'async' ? [{ label: 'Loading', onSelect: noop }] : list)
      if (id !== undefined && kind === 'async') void Promise.resolve().then(() => menu.replace(list, id))
    }}>{kind} target</button>{menu.node}</>
}

export function SwitchboardFixture() {
  return <UserNode pos={{ x: 30, y: 30 }} isDrop={false} stats={{ circ: 0, seats: 0, free: 0 }} pip={null}
    seats={{ sol: 2 }} pxc={1} zoom={1} onInbox={noop} onDocket={noop} onPresentations={noop}
    onSpawn={noop} onNewProject={noop} onAgents={noop} onMailLink={noop} onWorkLink={noop} focused={false}
    eyeW={600} onFocus={noop} posX={() => 0} map={new Map()} op={async () => ({})}
    slug="synthetic-open-order" toast={noop} codexHire={{ enabled: true, installed: true, reason: null }} />
}
