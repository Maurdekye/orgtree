import { useContextMenu } from './contextmenu'

/** USER 2026-10-21 11:16Z: one clickable header badge on agents and projects.
 * The retired-list identity owns this gesture, rather than the containing node. */
export function RetiredBadge({ parent, count, onOpen, className = 'retired-token' }: {
  parent: string; count: number; onOpen: () => void; className?: string
}) {
  const menu = useContextMenu()
  if (count < 1) return null
  return <><button type="button" className={`badge retired-badge ${className}`.trim()} data-retired-parent={parent}
    title={`${count} retired agent${count === 1 ? '' : 's'} hidden here — click to list`}
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onOpen() }}
    onContextMenu={e => menu.open(e, [{ label: 'Open retired list', onSelect: onOpen }])}>{count} retired</button>{menu.node}</>
}
