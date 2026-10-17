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
// "Focus" mean the right thing in each place: the card re-centres the
// camera on itself, the list row glides to the agent (and brings it to the
// front of its pile first). A handler a surface cannot offer is simply absent,
// and its entry disappears — the same way the card's own menu already dropped
// entries whose props were undefined.
//
// ⚠ NO COPY ENTRIES HERE. `useContextMenu().open` prepends the object's
// "Copy …" items itself, from the `data-copy-*` attributes on the element the
// menu was opened from (contextmenu.tsx), so a builder that added its own
// would double them.

import { useCurrentOrg } from '../popout'
import { historyEnabled, historyUndo } from '../historyregistry'
import { continueOnAccount, refreshAgyModels } from '../api'
import type { ToastFn } from '../types'
import { BulkCompactConfirm, subtreeAgents } from './bulkcompact'
import type { MenuEntry } from './contextmenu'
import { ConfirmModal } from './modals'
import { AgentCompactConfirm } from './agentcompact'
import { fmtCredits, hireTierChoices, subtreeDocCount, tierLabel, USER } from './shared'
import type { CanvasNode, HireProviders, OpFn } from './shared'

/** Which lifecycle confirm the menu decided on. The choice is the BUILDER's
 *  (a node with live reports dissolves, one without retires) so no caller has
 *  to write that rule a second time — it is handed the answer.
 *  `cheap-compact-subtree` rides the same plumbing so that every surface that
 *  already hosts the retire confirm hosts the bulk compaction confirm too,
 *  without a second piece of state per surface (canvas/bulkcompact.tsx). */
export type RetireKind = 'retire' | 'dissolve' | 'retire-all' | 'cheap-compact' | 'cheap-compact-subtree' | 'cheap-compact-subordinates'
  | 'halt-subtree' | 'halt-subordinates' | 'unhalt-subtree' | 'unhalt-subordinates'

export interface AgentMenuHandlers {
  /** open this agent's desk — the card re-centres the camera on itself, the
   *  Agents List row glides to it. Absent leaves the entry disabled rather
   *  than dropping it: "Focus" is the first thing a reader looks for, and
   *  a gap where it should be reads as a broken menu. */
  onOpenDesk?: () => void
  onInbox: () => void
  onScratchFolder?: () => void
  onTeamScratchFolder?: () => void
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
  /** TEAM presentations: this agent's and everyone's under it, through
   *  projects (user 2026-10-17 22:47Z), beside the team docket */
  onTeamPresentations?: () => void
  onLineage?: () => void
  onSettings: () => void
  /** grant or revoke this agent's user audience through the audited API */
  onToggleUserAudience?: () => void
  /** pin this agent's desk as a window / raise the one already pinned */
  onPin?: () => void
  onShowPin?: () => void
  /** pop this agent's desk out into a NATIVE window / raise the one already
   *  popped out (user request 2026-09-12: popout belongs in every agent menu,
   *  and the per-agent pin and popout buttons left the Agents List with it) */
  onPopout?: () => void
  onShowWindow?: () => void
  /** OPEN THIS AGENT'S DESK TEMPORARILY, in a modal, for a quick look.
   *
   *  ⚠ THE POINT IS THAT IT LEAVES NOTHING BEHIND. Reading another agent's
   *  desk previously meant changing the tree's focus, pinning it, or opening a
   *  window — each of which rearranges the workspace for a glance. This
   *  changes no focus, pins nothing, opens no window and persists no layout,
   *  and dismissing it puts everything back exactly as it was. It is offered
   *  for EVERY agent, including one whose desk is pinned or popped out: it
   *  borrows the canonical desk and returns it to the same placement, rather
   *  than drawing a second read-only imitation. */
  onOpenTemporary?: () => void
  /** Open the existing local hire form; no seat is created until confirmation. */
  onHire?: (tier: string) => void
  onHalt?: () => void
  /** open the confirm for `kind`; render `AgentRetireConfirm` from it */
  onRetireAsk?: (kind: RetireKind) => void
  /** hide an explicitly revealed retired agent again (hide-retired setting) */
  onDismiss?: () => void
  /** ⭐ continue this FROZEN agent on another account (user requirement
   *  2026-09-14). One entry per id in `node.continue_accounts`; the handler
   *  performs the switch-then-release and reports what actually happened.
   *  A surface that cannot offer it passes nothing and the entries vanish,
   *  exactly like every other handler-gated entry here. */
  onContinueOn?: (account: string) => void
  /** create a project node under this node (docs/rust-engine/PROJECT-NODES.md) */
  onNewProject?: () => void
  /** a PROJECT's coworker and parent hires (point 19's strips, offered in its
   *  menu too: review of a590555, coordinator ruling 2026-10-17 23:29Z) */
  onHireBeside?: (tier: string) => void
  onHireAbove?: (tier: string) => void
}

export interface AgentMenuState extends HireProviders {
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
  if (node.kind === 'project') return projectMenuEntries(node, h, s)
  const live = node.state === 'live'
  // a bearer pseudo-card is a lineage ghost, not a seat: it cannot be retired,
  // dissolved or hired under
  const canRetire = live && !node.isBearerOf && !node.bearer_state
  const canHire = canRetire && !s.piled
  const entries: MenuEntry[] = []
  // User 2026-09-30: swap Focus and Open desk. The copy entry still precedes
  // these, and every other entry keeps its existing position.
  entries.push({ label: 'Focus', onSelect: () => h.onOpenDesk?.(), disabled: !h.onOpenDesk })
  const deskEntries: MenuEntry[] = []
  const openEntries: MenuEntry[] = []
  const temporary = h.onOpenTemporary
  if (temporary) deskEntries.push({
    label: 'Open desk',
    title: `read ${node.id}'s desk in a modal without changing the focused `
      + 'agent, pinning it, or opening a window — closing puts everything back',
    onSelect: () => temporary(),
  })
  openEntries.push(
    { label: 'Open inbox', onSelect: () => h.onInbox() },
  )
  if (h.onScratchFolder && (live || node.state === 'archived')) {
    openEntries.push({ label: 'Open scratch folder', onSelect: h.onScratchFolder })
  }
  if (h.onTeamScratchFolder && (live || node.state === 'archived')) {
    openEntries.push({ label: 'Open team scratch folder', onSelect: h.onTeamScratchFolder })
  }
  const docket = h.onDocket
  if (docket) openEntries.push({ label: 'Open docket', onSelect: () => docket() })
  // …and the same docket widened to this agent's REPORTS. It sits next to
  // "Open docket" because the two answer the same question at two scopes, and
  // the label says whose team it is rather than "Team docket": the menu is
  // already raised on the agent, so the scope is the news.
  const teamDocket = h.onTeamDocket
  if (teamDocket) {
    openEntries.push({
      label: 'Open team docket',
      title: `tickets assigned to ${node.id} or to any agent below it`,
      onSelect: () => teamDocket(),
    })
  }
  const teamPresentations = h.onTeamPresentations
  if (teamPresentations) {
    openEntries.push({
      label: 'Open team presentations',
      title: `documents presented by ${node.id} or by any agent below it, through projects`,
      onSelect: () => teamPresentations(),
    })
  }
  const presentations = h.onPresentations
  if (presentations && (node.documents?.length ?? 0) > 0) {
    openEntries.push({ label: 'Open presentations', onSelect: () => presentations() })
  }
  // ⭐ RECOVERY BEFORE CONFIGURATION. A frozen agent that another account
  // could carry is the one thing an operator opened this menu to fix, so the
  // entries sit above Settings rather than under the lifecycle actions at the
  // bottom — and they are absent for every healthy agent, so they cost an
  // ordinary reader nothing.
  //
  // ⚠ EVERY GATE IS THE BACKEND'S. `continue_accounts` is empty unless the
  // agent is frozen, its automatic fallback is off, and the account is a
  // signed-in, same-provider alternative to the one it is on that nothing has
  // positively reported full (`account_fallback.offered`). Re-deciding any of
  // that here would be a second definition of eligible. The label carries the
  // immutable account id verbatim — never an email, a mutable label, or a
  // provider display name.
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
  const pin = h.onPin, showPin = h.onShowPin
  // …and the OS window beside the in-app one. "Open desk in a new window" and
  // not the bare "Open in new window" every pinnable panel uses (modalpin.tsx,
  // popout.tsx): there the object IS the surface, here the object is an agent
  // and what pops out is its desk.
  const popout = h.onPopout, showWindow = h.onShowWindow
  if (popout && !s.detached) {
    deskEntries.push({ label: 'Open desk in a new window', onSelect: () => popout() })
  }
  if (s.detached && showWindow) {
    deskEntries.push({ label: 'Show desk window', onSelect: () => showWindow() })
  }
  if (pin && !s.pinned) deskEntries.push({ label: 'Pin desk as a window', onSelect: () => pin() })
  if (s.pinned && showPin) deskEntries.push({ label: 'Show pinned window', onSelect: () => showPin() })
  entries.splice(1, 0, {
    label: 'Open', submenuOnly: true, onSelect: () => {},
    children: [...deskEntries, ...(deskEntries.length ? ['sep' as const] : []), ...openEntries],
  })
  const hire = h.onHire
  if (canHire && hire) {
    // the menu just opened on a model choice: re-read agy's model list
    refreshAgyModels()
    const choices = hireTierChoices(s)
    // Copy agent name is prepended by useContextMenu: Focus, then Hire.
    entries.splice(1, 0, {
      label: 'Hire a subordinate',
      title: 'Choose a tier to open its hire form',
      submenuOnly: true,
      disabled: choices.length === 0,
      onSelect: () => {},
      children: choices.map(({ tier, offer, reason }) => ({
        label: tierLabel(tier),
        disabled: offer !== 'offer',
        title: offer === 'offer' ? `Open a ${tierLabel(tier)} hire under ${node.id}` : reason,
        onSelect: () => hire(tier),
      })),
    })
  }
  const ask = h.onRetireAsk
  if (!live && h.onDismiss) {
    const dismiss = h.onDismiss
    entries.push({
      label: 'Dismiss',
      title: 'hide this retired agent again',
      onSelect: () => dismiss(),
    })
  }
  entries.push({ label: 'Settings', onSelect: () => h.onSettings() })
  if (live && !node.isBearerOf && h.onToggleUserAudience) {
    const hasUserAudience = node.audiences_held?.includes(USER) ?? false
    entries.push({
      label: hasUserAudience ? 'Drop audience' : 'Acquire audience',
      title: hasUserAudience ? 'Revoke this agent\'s user audience' : 'Grant this agent the user audience',
      onSelect: h.onToggleUserAudience,
    })
  }
  // Clickable single-agent roots; team scopes expand on hover / ArrowRight.
  const subtree = subtreeAgents(node)
  const descendants = subtree.filter((target) => target.id !== node.id)
  const hasTeam = canRetire && descendants.length > 0
  const lifecycle: MenuEntry[] = []
  if (ask) lifecycle.push({
    label: 'Compact…', warning: true,
    disabled: !canRetire,
    actionDisabled: !!node.busy || !node.session_id,
    title: !canRetire ? 'Only live agents can be compacted'
      : node.busy ? 'Wait until this agent finishes its turn'
      : !node.session_id ? 'No conversation to compact yet'
      : 'Choose normal harness compaction or a fresh session with a summary handoff',
    onSelect: () => ask('cheap-compact'),
    children: hasTeam ? [
      { label: 'Cheap compact subtree…', warning: true,
        title: `Cheap-compact ${node.id} and its live descendants; busy agents are skipped`,
        onSelect: () => ask('cheap-compact-subtree') },
      { label: 'Cheap compact all subordinates…', warning: true,
        title: `Cheap-compact live descendants only; ${node.id} stays unchanged`,
        onSelect: () => ask('cheap-compact-subordinates') },
    ] : undefined,
  })
  if (canRetire && h.onHalt) lifecycle.push({
    label: (node.halt?.phase === 'halted' ? 'Unhalt' : 'Halt') + (hasTeam && ask ? '…' : ''),
    title: node.halt?.phase === 'halted' ? 'Allow pending work to resume'
      : node.halt?.phase === 'halting' ? 'Finish halting the active turn'
      : 'End this turn and block wakes until explicitly unhalted',
    danger: node.halt?.phase !== 'halted',
    onSelect: h.onHalt,
    children: hasTeam && ask ? ([
      ['subtree', subtree, 'subtree'],
      ['subordinates', descendants, 'all subordinates'],
    ] as const).map(([scope, targets, label]) => {
      const unhalt = targets.every((target) => target.halt?.phase === 'halted')
      return {
        label, danger: !unhalt,
        title: `${unhalt ? 'Unhalt' : 'Halt'} ${targets.length} live agents${scope === 'subtree' ? ` including ${node.id}` : ` below ${node.id}; this agent stays unchanged`}`,
        onSelect: () => ask(`${unhalt ? 'unhalt' : 'halt'}-${scope}`),
      }
    }) : undefined,
  })
  // The engine's retire operation includes a manager's team. Keep that scope
  // explicit rather than promising an unavailable manager-only retirement.
  if (canRetire && ask) lifecycle.push({
    label: hasTeam ? 'Dissolve…' : 'Retire…', danger: true,
    onSelect: () => ask(hasTeam ? 'dissolve' : 'retire'),
    children: hasTeam ? [
      { label: 'subtree', danger: true, onSelect: () => ask('dissolve'),
        title: `Retire ${node.id} and its ${descendants.length} live descendants` },
      { label: 'all subordinates', danger: true, onSelect: () => ask('retire-all'),
        title: `Retire all live descendants; ${node.id} stays live` },
    ] : undefined,
  })
  if (h.onNewProject && canRetire) {
    // directly under "Hire a subordinate" (user 2026-10-17 21:18Z); after
    // Focus when the agent offers no hire
    const at = entries.findIndex((e) => e !== 'sep' && e.label === 'Hire a subordinate')
    entries.splice(at >= 0 ? at + 1 : 1, 0, { label: 'New project…',
      title: `a project node under ${node.id}: its agents work on it and ${node.id} pays for them`,
      onSelect: h.onNewProject })
  }
  if (lifecycle.length) entries.push('sep', ...lifecycle)
  return entries
}

/**
 * A PROJECT NODE's menu (docs/rust-engine/PROJECT-NODES.md; user 2026-10-16):
 * its mailbox, folder and presentations, hires and nested projects under it,
 * and its retirement. No desk, settings, audience, halt or compaction: a
 * project runs no turns. Shared by the project card and the Agents List row.
 */
export function projectMenuEntries(node: CanvasNode, h: AgentMenuHandlers,
  s: AgentMenuState = {}): MenuEntry[] {
  // The agent and switchboard menus' entries, adapted to a project (user
  // 2026-10-17 22:23Z): what a project holds opens from Open, whole-subtree
  // versions stand in for compaction and halting, and model, account,
  // audience and credit entries are left out (a project takes no turns).
  const live = node.state === 'live'
  const agents = subtreeAgents(node).filter((a) => a.id !== node.id)
  const entries: MenuEntry[] = [{ label: 'Focus', onSelect: () => h.onOpenDesk?.(), disabled: !h.onOpenDesk }]
  // its desk as a temporary modal, or in a window of its own (user 2026-10-17
  // 23:28Z, 23:29:47Z), first as on the agent menu
  const desk: MenuEntry[] = []
  const temp = h.onOpenTemporary, popout = h.onPopout
  if (temp) desk.push({ label: 'Open desk', title: `glance at ${node.id}'s desk without moving the camera`, onSelect: () => temp() })
  if (popout) desk.push({ label: 'Pop out to new window', title: `${node.id}'s desk in a window of its own`, onSelect: () => popout() })
  const open: MenuEntry[] = [...desk, ...(desk.length ? ['sep' as const] : []),
    { label: 'Open project mailbox', onSelect: () => h.onInbox() }]
  if (h.onScratchFolder && (live || node.state === 'archived')) {
    open.push({ label: 'Open project folder', onSelect: h.onScratchFolder })
  }
  // point 27: its presentations are the documents attributed to the project;
  // its team presentations add every one by the agents under it
  const presentations = h.onPresentations
  if (presentations && (node.documents_count ?? node.documents?.length ?? 0) > 0) {
    open.push({ label: 'Open presentations', onSelect: () => presentations() })
  }
  const teamPresentations = h.onTeamPresentations
  if (teamPresentations && subtreeDocCount(node) > 0) {
    open.push({ label: 'Open team presentations',
      title: `documents attributed to ${node.id} and those presented by the agents under it`,
      onSelect: () => teamPresentations() })
  }
  // the project's docket: the items owned by the agents under it
  const docket = h.onDocket
  if (docket) open.push({ label: 'Open project docket', onSelect: () => docket() })
  const pin = h.onPin, showPin = h.onShowPin
  if (pin && !s.pinned) open.push({ label: 'Pin desk as a window', onSelect: () => pin() })
  if (s.pinned && showPin) open.push({ label: 'Show pinned window', onSelect: () => showPin() })
  entries.push({ label: 'Open', submenuOnly: true, onSelect: () => {}, children: open })
  const hire = h.onHire
  if (live && hire && !s.piled) {
    refreshAgyModels()
    const choices = hireTierChoices(s)
    entries.push({
      label: 'Hire under this project',
      title: 'agents under a project work on it; the agent above the project pays for them',
      submenuOnly: true,
      disabled: choices.length === 0,
      onSelect: () => {},
      children: choices.map(({ tier, offer, reason }) => ({
        label: tierLabel(tier),
        disabled: offer !== 'offer',
        title: offer === 'offer' ? `Open a ${tierLabel(tier)} hire under project ${node.id}` : reason,
        onSelect: () => hire(tier),
      })),
    })
    // a coworker beside it and a superior above it, as its side and top hire
    // strips offer (point 19)
    for (const [label, act, where] of [
      ['Hire beside this project', h.onHireBeside, 'beside'],
      ['Hire above this project', h.onHireAbove, 'above'],
    ] as const) {
      if (!act) continue
      entries.push({
        label, submenuOnly: true, disabled: choices.length === 0, onSelect: () => {},
        children: choices.map(({ tier, offer, reason }) => ({
          label: tierLabel(tier),
          disabled: offer !== 'offer',
          title: offer === 'offer' ? `Open a ${tierLabel(tier)} hire ${where} project ${node.id}` : reason,
          onSelect: () => act(tier),
        })),
      })
    }
  }
  if (live && h.onNewProject) {
    entries.push({ label: 'New project…', title: `a project nested in ${node.id}`, onSelect: h.onNewProject })
  }
  if (live) entries.push({ label: 'Settings', onSelect: h.onSettings })
  if (!live && h.onDismiss) {
    const dismiss = h.onDismiss
    entries.push({ label: 'Dismiss', title: 'hide this retired project again', onSelect: () => dismiss() })
  }
  const ask = h.onRetireAsk
  if (live && ask) {
    const team = (node.children ?? []).some((c) => c.state === 'live')
    const lifecycle: MenuEntry[] = []
    if (agents.length > 0) {
      lifecycle.push({
        label: 'Cheap-compact all agents under it…', warning: true,
        title: `give the ${agents.length} live agents under ${node.id} a fresh session; mid-turn agents are skipped`,
        onSelect: () => ask('cheap-compact-subtree'),
      })
      const unhalt = agents.every((a) => a.halt?.phase === 'halted')
      lifecycle.push({
        label: unhalt ? 'Unhalt all agents under it…' : 'Halt all agents under it…', danger: !unhalt,
        title: `${unhalt ? 'Release' : 'Halt'} the ${agents.length} live agents under ${node.id}`,
        onSelect: () => ask(unhalt ? 'unhalt-subtree' : 'halt-subtree'),
      })
    }
    lifecycle.push({
      label: 'Retire project…', danger: true,
      title: team ? `retire ${node.id} with the agents and projects under it` : `retire ${node.id}`,
      onSelect: () => ask(team ? 'dissolve' : 'retire'),
    })
    entries.push('sep', ...lifecycle)
  }
  return entries
}

/** Shared count confirmation and batch outcome report for team and org controls. */
export function AgentBatchHaltConfirm({ targets, unhalt, scope, detail = '', op, toast, close }: {
  targets: CanvasNode[]; unhalt: boolean; scope: string; detail?: string
  op: OpFn; toast: ToastFn; close: () => void
}) {
  const verb = unhalt ? 'unhalt' : 'halt'
  return <ConfirmModal title={`${verb} ${scope}?`}
    body={`${unhalt ? 'Release' : 'Halt'} ${targets.length} live agent${targets.length === 1 ? '' : 's'}. `
      + detail
      + (unhalt ? 'Pending work may resume.' : 'Active turns stop and new wakes wait until explicitly unhalted.')}
    confirmLabel={`${verb} ${targets.length} agent${targets.length === 1 ? '' : 's'}`}
    onConfirm={async () => {
      if (!targets.length) { toast(['No live agents remain in this set.']); return }
      try {
        const result = await op({ op: verb, nodes: targets.map((target) => target.id) }, { quiet: true })
        const outcomes = result.nodes as Record<string, { error?: string }> | undefined
        const failed = outcomes ? Object.entries(outcomes).filter(([, value]) => value.error) : []
        const count = targets.length - failed.length
        toast([`${unhalt ? 'Released' : 'Halted'} ${count} agent${count === 1 ? '' : 's'}.`,
          ...failed.map(([name, value]) => `Could not ${verb} ${name}: ${value.error}`)])
      } catch (e) { toast([`Could not ${verb} ${scope}: ${(e as Error).message}`]) }
    }} close={close} />
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
  const historyOrg = useCurrentOrg()
  if (kind === 'halt-subtree' || kind === 'halt-subordinates'
    || kind === 'unhalt-subtree' || kind === 'unhalt-subordinates') {
    const unhalt = kind.startsWith('unhalt-')
    const descendantsOnly = kind.endsWith('-subordinates')
    const targets = subtreeAgents(node).filter((target) => !descendantsOnly || target.id !== node.id)
    const project = node.kind === 'project'
    const scope = project ? `all agents under project ${node.id}`
      : descendantsOnly ? `all subordinates of ${node.id}` : `${node.id} and its subtree`
    return <AgentBatchHaltConfirm targets={targets} unhalt={unhalt} scope={scope}
      detail={project ? '' : descendantsOnly ? `${node.id} stays unchanged. ` : `${node.id} is included. `}
      op={op} toast={toast} close={close} />
  }
  if (kind === 'cheap-compact') {
    return <AgentCompactConfirm node={node} op={op} toast={toast} close={close}/>
  }
  if (kind === 'cheap-compact-subtree' || kind === 'cheap-compact-subordinates') {
    const descendantsOnly = kind === 'cheap-compact-subordinates'
    const scope = descendantsOnly ? `all subordinates of ${node.id}` : `subtree of ${node.id}`
    return (
      <BulkCompactConfirm title={`cheap-compact ${scope}?`}
        scope={scope} targets={subtreeAgents(node).filter((target) => !descendantsOnly || target.id !== node.id)}
        op={op} toast={toast} close={close} />
    )
  }
  if (kind === 'retire-all') {
    const direct = node.children.filter((child) => child.state === 'live')
    const total = subtreeAgents(node).filter((target) => target.id !== node.id).length
    const nested = Math.max(0, total - direct.length)
    const warning = nested
      ? ` Nested descendants (${nested}) are included through each report's existing recursive retirement path.`
      : ''
    const body = direct.length
      ? `This retires ${total} live agent${total === 1 ? '' : 's'} through ${direct.length} direct report${direct.length === 1 ? '' : 's'} of ${node.id}.${warning} ${node.id} stays live. Each report is processed through the normal retirement operation; if another change wins first, the result will show what was already retired or failed.`
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
        body={`This retires ${subtreeAgents(node).length} live agents, including ${node.id} and its entire suborganization. Context is kept; rehire brings nodes back.`}
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
      onConfirm={() => op({ op: 'retire', node: node.id }).then(r =>
        toast([`${node.id} retired`],
          historyOrg && (r.history_entry || historyEnabled(historyOrg)) ? historyUndo(historyOrg, r)
            : () => op({ op: 'rehire', node: node.id }).catch(() => {})))
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
