import { useContextMenu } from './contextmenu'
import type { FoldInfo } from './subtreefold'

/** The subtree fold control (liaison spec 2026-11-01): one chevron on every
 *  agent or project that has members — a badge in the norm node's badge row
 *  (the RetiredBadge shape, its own gesture, its own one-item menu) and a
 *  corner chip on the mini node. Collapsed, it carries the hidden count and
 *  summarises the hidden members: `working` while any is mid-turn,
 *  `attention` while any has an open question or an unseen mention — the
 *  same words the card's own busy ring and asking glow already wear. */
export function FoldBadge({ id, fold, onToggle, mini = false }: {
  id: string; fold: FoldInfo; onToggle: () => void; mini?: boolean
}) {
  const menu = useContextMenu()
  const label = fold.collapsed
    ? `Expand subtree of ${id} (${fold.count} hidden)`
    : `Collapse subtree of ${id}`
  const facts = fold.collapsed && (fold.working || fold.attention)
    ? ` — ${[fold.working && 'a hidden member is working',
        fold.attention && 'a hidden member needs your attention']
        .filter(Boolean).join(', ')}`
    : ''
  const cls = (mini ? 'sq-fold-mini' : 'badge subtree-fold')
    + (fold.collapsed ? ' folded' : '')
    + (fold.collapsed && fold.working ? ' working' : '')
    + (fold.collapsed && fold.attention ? ' attention' : '')
  return <><button type="button" className={cls} data-fold-for={id}
    title={label + facts}
    aria-label={label}
    aria-expanded={!fold.collapsed}
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onToggle() }}
    onContextMenu={e => menu.open(e, [{
      label: fold.collapsed ? 'Expand subtree' : 'Collapse subtree',
      onSelect: onToggle,
    }])}>{fold.collapsed
      ? (mini ? `▸${fold.count}` : `▸ ${fold.count} hidden`)
      : '▾'}</button>{menu.node}</>
}
