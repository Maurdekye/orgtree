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

import { continueOnAccount } from '../api'
import { lineageCount } from '../archived'
import type { ToastFn } from '../types'
import type { MenuEntry } from './contextmenu'
import { ConfirmModal } from './modals'
import { fmtCredits } from './shared'
import type { CanvasNode, OpFn } from './shared'

/** Which lifecycle confirm the menu decided on. The choice is the BUILDER's
 *  (a node with live reports dissolves, one without retires) so no caller has
 *  to write that rule a second time — it is handed the answer. */
export type RetireKind = 'retire' | 'dissolve' | 'retire-all'

export interface AgentMenuHandlers {
  /** open this agent's desk — the card re-centres the camera on itself, the
   *  Agents List row glides to it. Absent leaves the entry disabled rather
   *  than dropping it: "Open desk" is the first thing a reader looks for, and
   *  a gap where it should be reads as a broken menu. */
  onOpenDesk?: () => void
  onInbox: () => void
  onDocket?: () => void
  /** the reduced docket for this agent's WHOLE TEAM — it and everyone below
   *  it. For 2.1.5-RC1 this menu entry is the only door to that view, so the
   *  gate is the handler: a surface that cannot open the panel (or a viewer
   *  the panel is not available to) simply passes nothing and the entry is
   *  absent, exactly the way "Open docket" above already behaves. */
  onTeamDocket?: () => void
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
  /** presentation-layer authority gate for bulk retirement. The backend still
   *  rechecks authority for every normal retire operation. */
  canRetireAll?: boolean
  /** hide an explicitly revealed retired agent again (hide-retired setting) */
  onDismiss?: () => void
  /** ⭐ continue this FROZEN agent on another account (user requirement
   *  2026-09-14). One entry per id in `node.continue_accounts`; the handler
   *  performs the switch-then-release and reports what actually happened.
   *  A surface that cannot offer it passes nothing and the entries vanish,
   *  exactly like every other handler-gated entry here. */
  onContinueOn?: (account: string) => void
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
  // …and the same docket widened to this agent's REPORTS. It sits next to
  // "Open docket" because the two answer the same question at two scopes, and
  // the label says whose team it is rather than "Team docket": the menu is
  // already raised on the agent, so the scope is the news.
  const teamDocket = h.onTeamDocket
  if (teamDocket) {
    entries.push({
      label: 'Open team docket',
      title: `tickets assigned to ${node.id} or to any agent below it`,
      onSelect: () => teamDocket(),
    })
  }
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
  // ⭐ RECOVERY BEFORE CONFIGURATION. A frozen agent that another account
  // could carry is the one thing an operator opened this menu to fix, so the
  // entries sit above Settings rather than under the lifecycle actions at the
  // bottom — and they are absent for every healthy agent, so they cost an
  // ordinary reader nothing.
  //
  // ⚠ EVERY GATE IS THE BACKEND'S. `continue_accounts` is empty unless the
  // agent is frozen, its automatic fallback is off, and the account is a
  // signed-in, same-provider, capacity-clear alternative to the one it is on.
  // Re-deciding any of that here would be a second definition of eligible.
  // The label carries the immutable account id verbatim — never an email, a
  // mutable label, or a provider display name.
  const continueOn = h.onContinueOn
  if (continueOn && live) {
    for (const account of node.continue_accounts ?? []) {
      entries.push({
        label: `Continue on ${account}`,
        title: `move ${node.id} to account ${account} and release its freeze `
          + 'so the work it is holding continues there',
        onSelect: () => continueOn(account),
      })
    }
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
    if (liveKids && h.canRetireAll !== false) entries.push({
      label: 'Retire all subordinates…', danger: true,
      title: 'retires every live direct report; nested subtrees are included',
      onSelect: () => ask('retire-all'),
    })
    entries.push('sep', liveKids
      ? { label: 'Dissolve suborganization…', danger: true, onSelect: () => ask('dissolve') }
      : { label: 'Retire…', danger: true, onSelect: () => ask('retire') })
  } else if (!live && h.onDismiss) {
    const dismiss = h.onDismiss
    entries.push('sep', {
      label: 'Dismiss',
      title: 'hide this retired agent again',
      onSelect: () => dismiss(),
    })
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
  if (kind === 'retire-all') {
    const direct = node.children.filter((child) => child.state === 'live')
    const nested = direct.reduce((count, child) => {
      const descendants = (n: CanvasNode): number =>
        n.children.reduce((total, c) => total + 1 + descendants(c), 0)
      return count + descendants(child)
    }, 0)
    const warning = nested
      ? ` Nested descendants (${nested}) are included through each report's existing recursive retirement path.`
      : ''
    const body = direct.length
      ? `This retires ${direct.length} live direct report${direct.length === 1 ? '' : 's'} of ${node.id}.${warning} ${node.id} stays live. Each report is processed through the normal retirement operation; if another change wins first, the result will show what was already retired or failed.`
      : `No live direct reports of ${node.id} remain. Nothing will be retired, and ${node.id} stays live.`
    return (
      <ConfirmModal title={`retire all subordinates of ${node.id}?`}
        body={body}
        confirmLabel="retire all subordinates"
        onConfirm={() => retireAllSubordinates(node, op, toast)}
        close={close} />
    )
  }
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

/** The nodes with a continuation already in flight. A context menu can be
 *  re-raised, an entry double-activated, and a tree refresh can land between
 *  the two — and the operation behind it moves an account binding, so the
 *  second firing must not happen at all rather than race the first. The
 *  backend refuses a concurrent second attempt too (409); this keeps the
 *  operator from seeing that refusal for their own double-click. */
const continuing = new Set<string>()

/**
 * Switch a frozen agent onto `account` and release its freeze — the shared
 * executor behind every `Continue on <id>` entry, so both surfaces report the
 * same outcomes in the same words.
 *
 * ⚠ IT REPORTS THREE OUTCOMES, NOT TWO. The switch can succeed while the
 * release fails, and that is a real state — the agent is on the new account
 * and still frozen. Saying "continued" there would be a lie the operator acts
 * on; saying "failed" would send them to re-run a switch that already
 * happened. So the middle state is named, and the toast says what remains.
 */
export async function continueFrozenOnAccount(slug: string, nid: string,
  account: string, toast: ToastFn): Promise<void> {
  const key = `${slug}/${nid}`
  if (continuing.has(key)) return
  continuing.add(key)
  try {
    const r = await continueOnAccount(slug, nid, account)
    if (r.state === 'switched_not_resumed') {
      toast([r.status ?? `${nid} was moved to ${account} but is still frozen.`,
        'Its held work has NOT resumed — use unstick on the agent to finish the move.'])
      return
    }
    toast([r.status ?? `${nid} continues on ${account}`, ...(r.warnings ?? [])])
  } catch (e) {
    // Nothing was changed on this path: the backend refuses before it
    // switches, and a failed switch never reaches the release.
    toast([`could not continue ${nid} on ${account}: ${(e as Error).message}`])
  } finally {
    continuing.delete(key)
  }
}

/** Execute one normal retirement per current direct report. Keeping this as a
 * client-side fan-out is intentional: each call re-enters the established
 * authority, active-turn interruption, recursive subtree, and seat/grant
 * accounting path. A concurrent change can therefore affect one target
 * without making the remaining targets unreportable. */
export async function retireAllSubordinates(node: CanvasNode, op: OpFn,
  toast: ToastFn): Promise<void> {
  const targets = node.children.filter((child) => child.state === 'live')
  if (!targets.length) {
    toast([`No live subordinates of ${node.id} remained; nothing was retired.`])
    return
  }
  const retired: string[] = []
  const alreadyRetired: string[] = []
  const failed: string[] = []
  for (const target of targets) {
    try {
      const result = await op({ op: 'retire', node: target.id })
      if ((result.warnings ?? []).some((warning) => /already archived/i.test(warning))) {
        alreadyRetired.push(target.id)
      } else {
        retired.push(target.id)
      }
    } catch {
      failed.push(target.id)
    }
  }
  const lines: string[] = []
  if (retired.length) lines.push(`Retired ${retired.length} subordinate${retired.length === 1 ? '' : 's'}: ${retired.join(', ')}.`)
  if (alreadyRetired.length) lines.push(`Already retired before execution (${alreadyRetired.length}): ${alreadyRetired.join(', ')}.`)
  if (failed.length) lines.push(`Could not retire ${failed.length} subordinate${failed.length === 1 ? '' : 's'}: ${failed.join(', ')}.`)
  toast(lines)
}
