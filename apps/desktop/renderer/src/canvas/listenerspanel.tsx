// canvas/listenerspanel.tsx — a project's event listeners as a standalone
// panel: the Listeners tab's pin / pop-out / modal buttons open it (docket
// slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20 16:43Z:
// "add pin pop & modal buttons for this screen"). The tab's own view in the
// standard persisted modal / pin / window host, as the slots panel is; its
// header row keeps the Register… menu. While the project's event listeners
// are off there is no tab, and the panel says so instead of a table.

import { PinFrame } from './modalpin'
import { instanceKind } from '../modalkinds'
import { ListenersView } from './listenersdesk'
import { eventListenersOn } from './listeners'
import { ListenersIcon } from '../icons'
import type { CanvasNode, OpFn } from './shared'
import type { ToastFn, TreePayload } from '../types'
import type { RefRoutes } from './reflinks'

export function ProjectListenersModal({ slug, nid, map, tree, op, toast, close, onJump, refs }: {
  slug: string; nid: string; map: Map<string, CanvasNode>; tree: TreePayload; op: OpFn; toast: ToastFn
  close: () => void; onJump?: (id: string) => void; refs?: RefRoutes
}) {
  const node = map.get(nid)
  const on = node?.kind === 'project' && eventListenersOn(node)
  return <PinFrame kind={instanceKind('project-listeners', nid)} title={`${nid} · listeners`} panel="settings wide" close={close}
    restore={{ agent: nid, generation: node?.generation }} dialogLabel={`${nid} · listeners`}>
    <h3 data-copy-agent-name={nid}><ListenersIcon fontSize="inherit" /> {nid} <span className="dim">· listeners</span></h3>
    {node && on
      ? <ListenersView node={node} dogs={tree.watchdogs ?? []} map={map} onJump={onJump} op={op} toast={toast} refs={refs} />
      : <div className="hint" role="status">{!node ? 'This project is no longer available.'
          : node.kind !== 'project' ? `${nid} is not a project.`
          : `${nid}'s event listeners are off. An agent turns them on by registering a listener; the user or an agent above the project turns them on in its settings.`}</div>}
  </PinFrame>
}
