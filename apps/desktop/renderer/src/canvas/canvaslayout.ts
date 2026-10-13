// Shared display projection for the canvas and reparent landing ghosts.
import type { TreePayload } from '../types'
import { DRAFT, DOG_W, DOG_H, NODE_W, NODE_H, INBOX, USER, layout, placeOrgInbox, cardFurniture } from './shared'
import type { CanvasNode, Pile, ChartLayout } from './shared'

/** hide-retired's DISPLAY prune of the layout tree (pure — the canvas memos
 *  it; tests call it directly). Removes archived subtrees from the children
 *  lists, EXCEPT: a knowledge bearer (its floating card is an active
 *  consultation surface), an archived node with a LIVE descendant (hiding it
 *  would hide live agents), and anything the session has revealed. Returns
 *  the pruned root, the hidden retirees grouped by their visible parent (the
 *  retired-list token's data), and the full id set of everything pruned
 *  (centerOn's reveal hook). */
export function pruneRetiredView(root: CanvasNode, hideRetired: boolean,
  shownRetired: ReadonlySet<string>): {
  root: CanvasNode
  retiredByParent: Map<string, CanvasNode[]>
  prunedIds: Set<string>
} {
  const retiredByParent = new Map<string, CanvasNode[]>()
  const prunedIds = new Set<string>()
  if (!hideRetired) return { root, retiredByParent, prunedIds }
  const hasLive = (n: CanvasNode): boolean => n.state === 'live'
    || (n.children ?? []).some(hasLive)
  const collect = (n: CanvasNode) => {
    prunedIds.add(n.id)
    ;(n.children ?? []).forEach(collect)
  }
  const walk = (n: CanvasNode): CanvasNode => {
    const keep: CanvasNode[] = []
    const gone: CanvasNode[] = []
    for (const c of n.children ?? []) {
      if (c.state === 'archived' && !c.isBearerOf && !shownRetired.has(c.id)
          && !hasLive(c)) { gone.push(c); collect(c) }
      else keep.push(walk(c))
    }
    if (gone.length) retiredByParent.set(n.id, gone)
    return gone.length || keep.some((c, i) => c !== (n.children ?? [])[i])
      ? { ...n, children: keep } : n
  }
  return { root: walk(root), retiredByParent, prunedIds }
}

export function canonPiles(n: CanvasNode): CanvasNode {
    const kids = (n.children ?? []).map(canonPiles)
    const arch = kids.filter((c) => c.state === 'archived')
    if (arch.length < 2) return { ...n, children: kids }
    const at = kids.findIndex((c) => c.state === 'archived')
    const before = kids.slice(0, at).filter((c) => c.state !== 'archived')
    const after = kids.slice(at).filter((c) => c.state !== 'archived')
    return { ...n, children: [...before, ...arch, ...after] }
  }

export function viewPiles(vroot: CanvasNode, pileFront: Record<string, string>, crowdPiles: boolean, hideRetired: boolean, shownRetired: ReadonlySet<string>) {   // pile key ("<parent>|a"/"<parent>|c") → pile
    const out = new Map<string, Pile>()
    const walk = (n: CanvasNode) => {
      const kids = n.children ?? []
      // When hide-retired is active, an explicitly revealed retiree is a
      // real card again, not a member of the retired pile. Keeping several
      // revealed cards in the pile would silently hide all but its front and
      // make independent reveal/dismiss impossible.
      const arch = kids.filter((c) => c.state === 'archived'
        && !(hideRetired && shownRetired.has(c.id)))
      const retiredTotal = arch.length + (hideRetired ? 0 : n.hidden_retired_children ?? 0)
      if (retiredTotal >= 2 && arch.length > 0) {
        const key = n.id + '|a'
        const want = pileFront[key]
        out.set(key, {
          key, parent: n.id, kind: 'a',
          list: arch.map((c) => c.id),
          total: retiredTotal,
          front: arch.some((c) => c.id === want) ? want! : arch[arch.length - 1]!.id, // nUIA: some() hit ⇒ want defined; length>=2 checked
        })
      }
      // CROWD pile (user spec 2026-07-31): a WIDE team — more than 8 active
      // reports under one agent — stacks its LEAF reports (no subtree of
      // their own) into one pile, same front/picker mechanics as the retired
      // pile. Non-leaf reports keep their own columns; the draft card never
      // stacks (hiring stays visible at any width).
      // ⚠ OPT-IN since D-198 (user ruling 2026-08-29): OFF unless the reader
      // has turned it on, so a wide team shows every one of its agents by
      // default. Gated HERE, at the one place a crowd pile is constructed,
      // rather than at each consumer: `hidden`, `layout`, `pileByFront`,
      // `pileOfRef`, the picker and the `.pile-stack` render all derive from
      // this map, so an empty map is exactly the shape they already handle for
      // every org with eight reports or fewer. The RETIRED pile above is a
      // separate behaviour and is deliberately untouched.
      const active = kids.filter((c) => c.state !== 'archived' && c.id !== DRAFT)
      if (crowdPiles && active.length > 8) {
        const leaves = active.filter((c) => !(c.children ?? []).length)
        if (leaves.length >= 2) {
          const key = n.id + '|c'
          const want = pileFront[key]
          out.set(key, {
            key, parent: n.id, kind: 'c',
            list: leaves.map((c) => c.id),
            front: leaves.some((c) => c.id === want) ? want! // nUIA: some() hit ⇒ want defined
              : leaves[leaves.length - 1]!.id,               // nUIA: leaves.length >= 2 checked
          })
        }
      }
      kids.forEach(walk)
    }
    walk(vroot)
    return out
}

export function viewHidden(vroot: CanvasNode, piles: ReadonlyMap<string, Pile>) {     // piled-away id → its pile's front id
    const out = new Map<string, string>()
    const bury = (n: CanvasNode, front: string) => {
      out.set(n.id, front)
      ;(n.children ?? []).forEach((c) => bury(c, front))
    }
    const walk = (n: CanvasNode) => {
      const pa = piles.get(n.id + '|a')
      const pc = piles.get(n.id + '|c')
      const crowd = pc ? new Set(pc.list) : null
      ;(n.children ?? []).forEach((c) => {
        if (pa && c.state === 'archived' && c.id !== pa.front) bury(c, pa.front)
        else if (crowd && crowd.has(c.id) && c.id !== pc!.front) {
          out.set(c.id, pc!.front)   // leaves by definition: nothing beneath
        } else walk(c)
      })
    }
    walk(vroot)
    return out
}

export function canvasTargets(vroot: CanvasNode, map: ReadonlyMap<string, CanvasNode>, hidden: Map<string, string>, chartLayout: ChartLayout, tree: TreePayload, inboxPxc: number, draftCredits?: number) {
    const t = layout(vroot, hidden, chartLayout)
    for (const n of map.values()) {           // live bearers float ABOVE the successor
      // (clear of its card — overlap made both unclickable)
      if (n.isBearerOf && t.has(n.isBearerOf)) {
        const p = t.get(n.isBearerOf)!
        t.set(n.id, {
          x: p.x + 42 + 18 * n.bearerIndex!,
          y: p.y - (NODE_H + 26) - 20 * n.bearerIndex!,
        })
      }
    }
    // FR-18: watchdogs fan out BELOW their owner like a miniature subtree,
    // in the corridor between the agent and its reports (user revision
    // 2026-08-14 — the old left-side column crossed into an adjacent card
    // by 14px). Rows of 3 centered on the owner: a full row is 162px
    // against the 186px sibling pitch, so it never reaches a neighboring
    // card and clears even a maxed-out sibling's own chips by 24px. Only
    // dogs 7–8 open a third row, which can brush the children's row 200px
    // down — the 8-per-agent cap keeps that the rare case. Having a target
    // position is ALL a spark needs, so launchSpark(dog → owner) works
    // with zero animation code.
    {
      const byOwner: Record<string, number> = {}
      for (const w of tree.watchdogs ?? [])
        if (t.has(w.owner)) byOwner[w.owner] = (byOwner[w.owner] ?? 0) + 1
      const seen: Record<string, number> = {}
      const PER_ROW = 3, GX = 6, GY = 4
      for (const w of tree.watchdogs ?? []) {
        if (!t.has(w.owner)) continue
        const p = t.get(w.owner)!
        const i = seen[w.owner] ?? 0
        seen[w.owner] = i + 1
        const row = Math.floor(i / PER_ROW), col = i % PER_ROW
        const inRow = Math.min(PER_ROW, byOwner[w.owner]! - row * PER_ROW)
        const rowW = inRow * DOG_W + (inRow - 1) * GX
        t.set('dog:' + w.id, {
          x: p.x + NODE_W / 2 - rowW / 2 + col * (DOG_W + GX),
          y: p.y + NODE_H + 8 + row * (DOG_H + GY),
        })
      }
    }
    // the ORG INBOX panel (user spec): up and to the RIGHT of the overseer —
    // "out of the way" of the org structure, not stacked on its axis — and it
    // only exists once the org has received outside mail or granted an inbox
    // audience; until then the canvas is unchanged. Placed LAST of the cards,
    // so it can step clear of every one of them (placeOrgInbox: the circle
    // view's rings can grow round to its usual place) and of what they always
    // draw beside them: credit bars (as tall as the holding) and document chips
    if ((tree.org_inbox?.enabled !== false && tree.org_inbox?.visible)) {
      const at = placeOrgInbox(t, (id, p) => {
        const n = map.get(id)
        return cardFurniture(id, p, inboxPxc, {
          credits: id === DRAFT ? draftCredits
            : n && n.state === 'live' && !n.isBearerOf ? n.seat! + n.grant! : undefined,
          docs: n?.documents?.length ?? 0,
        })
      })
      if (at) t.set(INBOX, at)
    }
    let minY = Infinity
    for (const p of t.values()) minY = Math.min(minY, p.y)
    // headroom for the eye's infinite bar (2× the eye card, fading upward)
    if (minY < 140) for (const p of t.values()) p.y += 140 - minY
    // piled-away retirees sit exactly under their pile's front card (they
    // aren't rendered, but wires/sparks/centerOn need a sane position)
    for (const [hid, front] of hidden) {
      const fp = t.get(front)
      if (fp) t.set(hid, { x: fp.x, y: fp.y })
    }
    return t
}
