/** USER 2026-11-19 ma217f83e0e6a: retired counts are plain indicators.
 * The owning node's context menu opens its existing retired list. */
export function RetiredBadge({ parent, count, className = 'retired-token' }: {
  parent: string; count: number; className?: string
}) {
  if (count < 1) return null
  return <span className={`badge retired-badge ${className}`.trim()} data-retired-parent={parent}
    aria-label={`${count} retired agent${count === 1 ? '' : 's'}`}>{count} retired</span>
}
