// canvas/foldghost.ts — a COLLAPSING subtree animates into its stack
// (USER 2026-11-03 18:22:52Z mf5c66ee4352a "i want the nodes to visibly animate into the collapsed position
// rather than disappearing instantly"; 18:22:56Z m869529f98deb "they already animate out").
//
// EXPAND already works by the spring engine: a node with no spring is born at its parent's spring and glides
// to its layout target. COLLAPSE is the same path reversed, on the same springs with the same constants:
// the members a fold just pruned stay drawn as GHOSTS, their springs kept, aimed at the collapsed node's
// stack, and are removed only once every one is at rest. Pure here so the rules are testable without the
// canvas; OrgCanvas owns the springs and calls these.
import { SPRING_C, SPRING_K } from './shared'

export interface SpringState { x: number; y: number; vx: number; vy: number }
export interface Pt { x: number; y: number }

/** how far below the collapsed node's own position the ghosts aim: under its bottom edge, where the tucked stack is */
export const STACK_DROP = 10

/** where a ghost heads: the collapsed node's CURRENT layout target, under it (it moves when siblings shift) */
export const ghostAim = (standing: Pt): Pt => ({ x: standing.x, y: standing.y + STACK_DROP })

/** one frame of the canvas spring, the same maths the expand glide runs (OrgCanvas spring engine) */
export function stepSpring(s: SpringState, tgt: Pt, dt: number): void {
  const ax = SPRING_K * (tgt.x - s.x) - SPRING_C * s.vx
  const ay = SPRING_K * (tgt.y - s.y) - SPRING_C * s.vy
  s.vx += ax * dt; s.vy += ay * dt
  s.x += s.vx * dt; s.y += s.vy * dt
}
export const springAtRest = (s: SpringState, tgt: Pt): boolean =>
  Math.abs(tgt.x - s.x) <= 0.4 && Math.abs(tgt.y - s.y) <= 0.4 && Math.abs(s.vx) <= 2 && Math.abs(s.vy) <= 2

/** The ghosts after a fold change. `prev` / `next` map each folded-away member to its collapsed node.
 *  A member newly folded away becomes a ghost (only if it was on screen: `seen`), unless the reader asks for
 *  reduced motion (then it simply vanishes, instantly). A ghost whose member is shown again (expanded mid-collapse)
 *  stops being one: its kept spring is then an ordinary node's spring, so it continues from where it is. */
export function nextGhosts(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>, opts: { reduced: boolean; seen: (id: string) => boolean }): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of current.keys()) { const st = next.get(id); if (st) out.set(id, st) }
  if (!opts.reduced) for (const [id, st] of next) if (!prev.has(id) && opts.seen(id)) out.set(id, st)
  return out
}
