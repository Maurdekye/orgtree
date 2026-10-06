/** The native tree's sibling key, retained through moves (orgdb.agents). */
export interface SiblingOrder {
  id: string
  ui_order?: number
  sibling_order?: number
  created?: string
  ord?: number
}

// Python sorts Unicode code points; localeCompare and UTF-16 order disagree.
function textOrder(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (order) return order
  }
  return x.length - y.length
}

/** Used by both confirmed record projection and the immediate move preview. */
export function siblingOrder(x: SiblingOrder, y: SiblingOrder): number {
  return (x.ui_order ?? x.sibling_order ?? 0) - (y.ui_order ?? y.sibling_order ?? 0)
    || textOrder(x.created ?? '', y.created ?? '')
    || (x.ord ?? 0) - (y.ord ?? 0) || textOrder(x.id, y.id)
}
