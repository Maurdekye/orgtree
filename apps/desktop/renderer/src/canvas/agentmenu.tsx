// canvas/agentmenu.tsx — AN AGENT'S CONTEXT MENU, WRITTEN ONCE (user request
// 2026-09-12: "rows in the Agents List do not expose the same right-click
// operations as the corresponding agent card, forcing operators to locate the
// card before using contextual actions and allowing the two action sets to
// drift").
//
// THE POINT IS THE SINGLE DEFINITION, not the second menu. The card's entry
// list used to be written inline in NodeSquare; giving the Agents List "the
// same menu" by copying that list would have made the drift the ticket names
// inevitable — one surface gains an action, gates it differently, renames a
// label, and the two quietly disagree. So the list lives here, and both
// surfaces call it.
//
// WHAT THIS FILE OWNS: the LABELS, the ORDER, and the STATE GATING — every
// question that can be answered from the node itself (is it live? a bearer? a
// pile front? does it have documents, a lineage, a pinned desk?), plus the
// retire/dissolve confirm, so that the wording, the op and the undo toast are
// the same wherever the menu is raised.
//
// WHAT THE CALLER OWNS: the HANDLERS. They are deliberately not built here
// from `op`/`slug`, because contextmenu.tsx's rule is that a menu item may
// never do something the object's visible controls cannot — each caller hands
// over the very callback its own buttons already call. That is also what lets
// "Open desk" mean the right thing in each place: the card re-centres the
// camera on itself, the list row glides to the agent (and brings it to the
// front of its pile first). A handler a surface cannot offer is simply absent,
// and its entry disappears — the same way the card's own menu already dropped
// entries whose props were undefined.
//
// ⚠ NO COPY ENTRIES HERE. `useContextMenu().open` prepends the object's
// "Copy …" items itself, from the `data-copy-*` attributes on the element the
// menu was opened from (contextmenu.tsx), so a builder that added its own
// would double them.

import { lineageCount } from '../archived'
import type { ToastFn } from '../types'
import type { MenuEntry } from './contextmenu'
import { ConfirmModal } from './modals'
import { fmtCredits } from './shared'
import type { CanvasNode, OpFn } from './shared'

/** Which lifecycle confirm the menu decided on. The choice is the BUILDER's
 *  (a node with live reports dissolves, one without retires) so no caller has
 *  to write that rule a second time — it is handed the answer. */
export type RetireKind = 'retire' | 'dissolve'

export interface AgentMenuHandlers {
  /** open this agent's desk — the card re-centres the camera on itself, the
   *  Agents List row glides to it. Absent leaves the entry disabled rather
   *  than dropping it: "Open desk" is the first thing a reader looks for, and
   *  a gap where it should be reads as a broken menu. */
  onOpenDesk?: () => void
  onInbox: () => void
  onDocket?: () => void
  /** the agent's presented documents — the entry appears only when it has
   *  some, so the gate is here and the caller passes the opener */
  onPresentations?: () => void
  onLineage?: () => void
  onSettings: () => void
  /** pin this agent's desk as a window / raise the one already pinned */
  onPin?: () => void
  onShowPin?: () => void
  /** pop this agent's desk out into a NATIVE window / raise the one already
   *  popped out (user request 2026-09-12: popout belongs in every agent menu,
   *  and the per-agent pin and popout buttons left the Agents List with it) */
  onPopout?: () => void
  onShowWindow?: () => void
  /** reveal the card's bottom hire chips. There is no single "hire" handler —
   *  the tier choice and its provider gating live in SpawnChips — so this
   *  opens the chips the way a bottom-edge hover does. */
  onHire?: () => void
  /** open the confirm for `kind`; render `AgentRetireConfirm` from it */
  onRetireAsk?: (kind: RetireKind) => void
}

export interface AgentMenuState {
  /** this agent's desk is already open as a pinned window */
  pinned?: boolean
  /** …or already popped out into a native window of its own. The two are
   *  independent: a desk can be pinned into the canvas's screen space and
   *  popped out to the OS, so both pairs of entries can appear together. */
  detached?: boolean
  /** the card is (or would become) a pile/crowd FRONT: its edges belong to
   *  the stack, so there is no free side to hire into */
  piled?: boolean
}

/**
 * The agent's menu, in order. Every gate below was the card's own before this
 * file existed; nothing here is new policy.
 */
export function agentMenuEntries(node: CanvasNode, h: AgentMenuHandlers,
  s: AgentMenuState = {}): MenuEntry[] {
  const live = node.state === 'live'
  // a bearer pseudo-card is a lineage ghost, not a seat: it cannot be retired,
  // dissolved or hired under
  const canRetire = live && !node.isBearerOf && !node.bearer_state
  const canHire = canRetire && !s.piled
  const liveKids = node.children.some((c) => c.state === 'live')
  const entries: MenuEntry[] = [
    { label: 'Open desk', onSelect: () => h.onOpenDesk?.(), disabled: !h.onOpenDesk },
    { label: 'Open inbox', onSelect: () => h.onInbox() },
  ]
  const docket = h.onDocket
  if (docket) entries.push({ label: 'Open docket', onSelect: () => docket() })
  const presentations = h.onPresentations
  if (presentations && (node.documents?.length ?? 0) > 0) {
    entries.push({ label: 'Open presentations', onSelect: () => presentations() })
  }
  // §4.8: an archived seat arrives summarised — lineageCount reads whichever
  // of the full list or its count marker is present
  const lineage = h.onLineage
  if (lineage && lineageCount(node) > 0) {
    entries.push({ label: 'Show lineage', onSelect: () => lineage() })
  }
  entries.push({ label: 'Settings', onSelect: () => h.onSettings() })
  const pin = h.onPin, showPin = h.onShowPin
  if (pin && !s.pinned) entries.push({ label: 'Pin desk as a window', onSelect: () => pin() })
  if (s.pinned && showPin) entries.push({ label: 'Show pinned window', onSelect: () => showPin() })
  // …and the OS window beside the in-app one. "Open desk in a new window" and
  // not the bare "Open in new window" every pinnable panel uses (modalpin.tsx,
  // popout.tsx): there the object IS the surface, here the object is an agent
  // and what pops out is its desk — and the menu already says "Open desk" for
  // the camera.
  const popout = h.onPopout, showWindow = h.onShowWindow
  if (popout && !s.detached) {
    entries.push({ label: 'Open desk in a new window', onSelect: () => popout() })
  }
  if (s.detached && showWindow) {
    entries.push({ label: 'Show desk window', onSelect: () => showWindow() })
  }
  const hire = h.onHire
  if (canHire && hire) {
    entries.push({
      label: 'Hire a subordinate…',
      title: 'shows the hire chips under the card — pick a model there',
      onSelect: () => hire(),
    })
  }
  const ask = h.onRetireAsk
  if (canRetire && ask) {
    entries.push('sep', liveKids
      ? { label: 'Dissolve suborganization…', danger: true, onSelect: () => ask('dissolve') }
      : { label: 'Retire…', danger: true, onSelect: () => ask('retire') })
  }
  return entries
}

/**
 * The confirm behind the menu's last entry — the SAME dialog, op and undo
 * toast for every surface that raises the menu (they mirror the desk's
 * cc-actions verbatim).
 *
 * ⚠ WHERE IT IS PORTALED IS THE CALLER'S. A card lives inside the world
 * transform, where `position: fixed` resolves against the SCALED ancestor, so
 * it portals to <body>; a panel that can be popped out portals into its own
 * surface's document. That is a placement question, not a behaviour one.
 */
export function AgentRetireConfirm({ kind, node, op, toast, close }: {
  kind: RetireKind
  node: CanvasNode
  op: OpFn
  toast: ToastFn
  close: () => void
}) {
  if (kind === 'dissolve') {
    return (
      <ConfirmModal title={`dissolve ${node.id}?`}
        body="Its entire suborganization is retired with it. Context is kept; rehire brings nodes back."
        confirmLabel="dissolve"
        onConfirm={() => op({ op: 'dissolve', node: node.id })}
        close={close} />
    )
  }
  return (
    <ConfirmModal title={`retire ${node.id}?`}
      body={`It stops working and frees ${fmtCredits((node.seat ?? 0) + (node.grant ?? 0))} credit(s) back to its superior. Its context is KEPT — rehire brings it back exactly as it was.`
        + (node.busy ? ' ⚠ It is mid-turn right now; that turn is cut off.' : '')}
      confirmLabel="retire"
      onConfirm={() => op({ op: 'retire', node: node.id }).then(() =>
        toast([`${node.id} retired`],
          () => op({ op: 'rehire', node: node.id }).catch(() => {})))
        .catch(() => {})}
      close={close} />
  )
}
