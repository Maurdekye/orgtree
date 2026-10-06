/** The Rust tree's sibling key; ord carries the numeric ot.agents.id. */
export interface SiblingOrder {
  id: string
  ui_order?: number
  sibling_order?: number
  created?: string
  ord?: number
}

// Deterministic fallback for incomplete records; real records use numeric ord.
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
  return (x.sibling_order ?? x.ui_order ?? 0) - (y.sibling_order ?? y.ui_order ?? 0)
    || (x.ord ?? 0) - (y.ord ?? 0) || textOrder(x.id, y.id)
}
