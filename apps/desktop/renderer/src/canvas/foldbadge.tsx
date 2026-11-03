import { useContextMenu } from './contextmenu'
import { providerOf } from './shared'
import { useProjectTheme } from './projecttheme'
import { MAX_TUCKS } from './subtreefold'
import type { FoldInfo, FoldTuck } from './subtreefold'

/** One tucked shape: the child's own colour, a project's from its theme. */
function Tuck({ tuck, i }: { tuck: FoldTuck; i: number }) {
  const theme = useProjectTheme(tuck.project ? tuck.id : null)
  const cls = 'fold-tuck t' + Math.min(i, 2) + (tuck.project ? ' project' : ' prov-' + providerOf(tuck.tier ?? ''))
  return <span className={cls} data-tuck={tuck.id}
    style={{ '--tuck-i': i, ...(theme?.color ? { '--provider-accent': theme.color } : {}) } as React.CSSProperties} />
}

/** The subtree fold's only visible sign (USER 2026-11-03 mb215418dd87d +
 *  m580523a2f5d6, replacing the chevron button on mini and norm nodes): a
 *  short stack of up to three small shapes tucked under a COLLAPSED node's
 *  bottom edge, each in its direct child's own colour, wearing the hidden
 *  count and the hidden members' working / attention rollup. Clicking it
 *  expands; collapsing is the node menu's "Collapse subtree" entry. An
 *  expanded node, and a node with no members, draw nothing. */
export function FoldStack({ id, fold, onToggle }: {
  id: string; fold: FoldInfo; onToggle: () => void
}) {
  const menu = useContextMenu()
  if (!fold.collapsed) return null
  const label = `Expand subtree of ${id} (${fold.count} hidden)`
  const facts = fold.working || fold.attention
    ? ` — ${[fold.working && 'a hidden member is working',
        fold.attention && 'a hidden member needs your attention']
        .filter(Boolean).join(', ')}`
    : ''
  const cls = 'fold-stack folded' + (fold.working ? ' working' : '')
    + (fold.attention ? ' attention' : '')
  const tucks = (fold.tucks ?? []).slice(0, MAX_TUCKS)   // the retired pile's three layers
  return <><button type="button" className={cls} data-fold-for={id}
    title={label + facts} aria-label={label} aria-expanded={false}
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onToggle() }}
    onContextMenu={e => menu.open(e, [{ label: 'Expand subtree', onSelect: onToggle }])}>
    {tucks.map((t, i) => <Tuck key={t.id} tuck={t} i={i} />)}
    <span className="fold-count">{fold.count}</span>
  </button>{menu.node}</>
}
