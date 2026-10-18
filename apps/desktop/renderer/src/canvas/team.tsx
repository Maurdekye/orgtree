// The desk's Team list borrows the Agents List rows, filters and canonical menu.
// Membership comes only from the current feed snapshot; opening a tab fetches nothing.
import { createContext, useContext, useMemo, useState } from 'react'
import type { CanvasNode } from './shared'
import type { RefRoutes } from './reflinks'
import { ActiveAgentsFilter, AgentTray, trayRows } from './agenttray'
import { useAgentNavRegistry } from './agentnav'
import { useContextMenu } from './contextmenu'
import { PinFrame } from './modalpin'

export const TeamListOrder = createContext<((a: CanvasNode, b: CanvasNode) => number) | null>(null)
export const TeamListNavigation = createContext<((id: string) => void) | null>(null)

/** Re-root the shared map at this node. Walk parent edges, not retained child
 * objects: a feed update may replace a child without replacing its ancestor. */
export function teamMap(map: Map<string, CanvasNode>, nid: string): Map<string, CanvasNode> {
  if (!map.has(nid)) return new Map()
  const children = new Map<string, string[]>()
  for (const n of map.values()) if (n.parent) {
    const ids = children.get(n.parent) ?? []
    ids.push(n.id); children.set(n.parent, ids)
  }
  const ids = new Set<string>(), pending = [nid]
  while (pending.length) {
    const id = pending.pop()!
    if (ids.has(id)) continue
    ids.add(id); pending.push(...(children.get(id) ?? []))
  }
  // Preserve the host's source order for circular/tree layouts.
  return new Map([...map].filter(([id]) => ids.has(id)))
}

export function AgentTeamView({ map, nid, onPick, refs, compactAt }: {
  map: Map<string, CanvasNode>; nid: string; onPick?: (id: string) => void
  refs?: RefRoutes; compactAt?: number
}) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [active, setActive] = useState(false)
  const compare = useContext(TeamListOrder)
  const navigate = useContext(TeamListNavigation) ?? onPick
  const members = useMemo(() => teamMap(map, nid), [map, nid])
  const rows = trayRows(members, { query, archived, activeOnly: active, compare })
  const registry = useAgentNavRegistry()
  const menu = useContextMenu()
  return <div className="team-list">
    <AgentTray map={members} rows={rows} query={query} onQuery={setQuery}
      archived={archived} onArchived={setArchived} onPick={id => navigate?.(id)}
      filterActions={<ActiveAgentsFilter checked={active} onChange={setActive} />}
      filterLabel={`filter ${nid}'s team`} refs={refs} compactAt={compactAt}
      showQueuedModelBadge={false}
      onRowMenu={(e, node) => menu.open(e, () => registry?.current?.(node.id, e.currentTarget) ?? [])}
      empty={<div className="dim team-empty">no agents match these filters</div>} />
    {menu.node}
  </div>
}

export function TeamModal({ map, nid, onPick, refs, compactAt, close }: {
  map: Map<string, CanvasNode>; nid: string; onPick: (id: string) => void
  refs: RefRoutes; compactAt?: number; close: () => void
}) {
  return <PinFrame kind="agent-team" title={`${nid} · Team`} panel="settings team-panel"
    restore={{ agent: nid, generation: map.get(nid)?.generation }} close={close}>
    <h3 data-copy-agent-name={nid}>{nid} <span className="dim">· Team</span></h3>
    <AgentTeamView map={map} nid={nid} onPick={onPick} refs={refs} compactAt={compactAt} />
    <div className="row"><button className="primary" onClick={close}>Close</button></div>
  </PinFrame>
}
