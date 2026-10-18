// canvas/identity.tsx — ONE way to draw an agent's identity: its model chip
// and its name, and one decision about whether that name navigates.
//
// THE CONTRACT, in three parts:
//
// ⚠ IT RENDERS A FRAGMENT, NOT A WRAPPER. Call sites already have containers
// doing real layout work — `.sender`, `.docket-actor`, `.cc-head-left` where
// `.cc-name` carries `flex: 1 1 12ch` and an ellipsis. A wrapper here would
// collapse each into one flex item and change layout at every site.
//
// ⚠ NO TIER MEANS NO CHIP. `tier` null is a real answer — "the model this
// identity ran under is not known" — and must never be back-filled with
// today's model for a historical generation. `actorFit` (docket.tsx) decides
// that for work-item actors; this component only obeys it.
//
// ⚠ THE OWN-DESK EXEMPTION IS EXPLICIT AND KEYED ON DESTINATION. `atDestination`
// is supplied by the surface, never inferred here from the id.

import { createContext, useContext } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { FolderIcon } from '../icons'
import { AGENT_NAV_ATTR, AGENT_TOOLTIP_ATTR, AGENT_TOOLTIP_NAME_FIRST_ATTR,
  agentNavProps, agentTooltipProps } from './agentnav'
import { nodeMenuAction, nodeMenuEntry, ticketOwnerAction } from './objectactions'
import { TIER_LETTER, tierLabel } from './shared'

export { nodeMenuAction, nodeMenuEntry, ticketOwnerAction }

/** Resolve the identity tier for any tree node (agent or project). */
export function nodeTierOf(
  node?: { kind?: string | null; tier?: string | null } | null,
): string | null | undefined {
  if (!node) return undefined
  return node.kind === 'project' ? 'project' : node.tier
}

/** The model card: the letter chip every surface uses for a tier.
 *
 *  Nothing renders without a tier — that is the no-invented-identity rule, not
 *  an omission. Moved here from gallery.tsx (user request 2026-09-03, "for
 *  each agent entry, show its model icon card"); gallery re-exports it so
 *  existing importers are untouched. */
export function TierChip({ tier, agentName }: { tier?: string | null; agentName?: string }) {
  if (!tier) return null
  if (tier === 'project') {
    return (
      <span data-copy-agent-name={agentName} {...agentTooltipProps(agentName, true)}
        className="project-mark" title={agentName ? undefined : 'Project'}>
        <FolderIcon fontSize="inherit" fill="currentColor" />
      </span>
    )
  }
  return (
    <span data-copy-agent-name={agentName} {...agentTooltipProps(agentName, true)}
      className={'tier t-' + tier} title={agentName ? undefined : tierLabel(tier)}>
      {TIER_LETTER[tier] ?? tier.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Build the DOM equivalent of `<TierChip />` for markdown DOM linkification (`refmd.tsx`). */
export function createTierChipEl(
  doc: Document,
  tier?: string | null,
  agentName?: string | null,
): HTMLElement | null {
  if (!tier) return null
  if (tier === 'project') {
    const span = doc.createElement('span')
    span.className = 'project-mark'
    if (agentName) {
      span.setAttribute('data-copy-agent-name', agentName)
      span.setAttribute(AGENT_TOOLTIP_ATTR, agentName)
      span.setAttribute(AGENT_TOOLTIP_NAME_FIRST_ATTR, 'true')
    } else {
      span.title = 'Project'
    }
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'MuiSvgIcon-root MuiSvgIcon-fontSizeInherit')
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('width', '1em')
    svg.setAttribute('height', '1em')
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2m0 12H4V8h16z')
    svg.appendChild(path)
    span.appendChild(svg)
    return span
  }
  const t = doc.createElement('span')
  t.className = 'tier t-' + tier
  if (agentName) {
    t.setAttribute('data-copy-agent-name', agentName)
    t.setAttribute(AGENT_TOOLTIP_ATTR, agentName)
    t.setAttribute(AGENT_TOOLTIP_NAME_FIRST_ATTR, 'true')
  } else {
    t.title = tierLabel(tier)
  }
  t.textContent = TIER_LETTER[tier] ?? tier.slice(0, 1).toUpperCase()
  return t
}

export interface AgentNameProps {
  /** the agent id as recorded. Rendered verbatim: never resolved, corrected
   *  or prettified, so a deleted or unknown name still reads as what it was. */
  id: string
  /** the model to attribute, or null/undefined for NO chip. Null is a real
   *  answer — "not recorded" — and must not be filled in from the live tree. */
  tier?: string | null
  /** why this identity is secondary or its chip withheld; becomes the title
   *  of the name element when there is no navigation to describe there. */
  why?: string | null
  /** navigate to this agent. Omit it and the name is plain text.
   *
   *  The activation event is passed through because some surfaces have to tell
   *  a POINTER activation from a KEYBOARD one: `e.detail` is 0 for a click
   *  synthesised by Enter/Space and >= 1 for a real mouse click. pins.tsx
   *  needs that — its name sits on a pointer-capturing drag handle, where the
   *  mouse path is driven by the gesture and only the keyboard may go through
   *  this handler. */
  onFocus?: (id: string, e: ReactMouseEvent<HTMLButtonElement>) => void
  /** ⚠ THIS SURFACE IS THE DESTINATION, so the click would be a no-op — the
   *  agent's own focused desk. NOT "the name matches the agent whose surface
   *  this is": a switchboard panel and a pinned window BOTH show that same
   *  agent's name and both must still navigate, because clicking takes you
   *  somewhere you are not. Keyed on destination, supplied by the surface,
   *  never inferred here from the id. */
  atDestination?: boolean
  /** rendered before the name inside the same element — the '@' of mail
   *  attribution, so the sigil is part of the click target rather than
   *  stranded beside it. */
  prefix?: string
  /** Extra classes for the name element. */
  nameClass?: string
  /** Suppress browser titles when an owning surface provides the shared
   *  identity tooltip for this name. */
  nativeTitle?: boolean
}

/**
 * An agent's chip and name, as a fragment: `<TierChip/>` then the name.
 *
 * The name is a `button.cc-name.cc-name-jump` when it navigates and a
 * `span.cc-name` when it does not, which is the markup every existing site
 * already produces — so this is a consolidation, not a restyle.
 */
export function AgentName({
  id, tier, why, onFocus, atDestination, prefix, nameClass, nativeTitle = true,
}: AgentNameProps): ReactNode {
  const label = (prefix ?? '') + id
  const extra = nameClass ? ' ' + nameClass : ''
  if (!onFocus || atDestination) {
    return (
      <>
        <TierChip tier={tier} agentName={id} />
        <span data-copy-agent-name={id} {...(nativeTitle ? agentTooltipProps(id) : {})} className={'cc-name' + extra}
          title={nativeTitle ? why ?? undefined : undefined}>{label}</span>
      </>
    )
  }
  return (
    <>
      <TierChip tier={tier} agentName={id} />
      {/* type="button": this is embedded inside forms, where the default
          submit behaviour would be wrong */}
      {/* ⚠ THE MARKER GOES ON THE NAVIGATING BRANCH ONLY. This `if` is
          already the one place the app decides whether an agent's name is a
          route, so marking it here is what makes "every navigation target has
          the agent's menu" true by construction rather than by fourteen call
          sites remembering. The `span` branch above is deliberately bare: it
          did not navigate, so the expanded scope does not reach it. */}
      <button type="button" data-copy-agent-name={id} {...agentNavProps(id)}
        className={'cc-name cc-name-jump' + extra}
        title={nativeTitle ? why ?? `focus ${id}'s desk` : undefined}
        onMouseDown={(e) => { if (e.button !== 0) e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); onFocus(id, e) }}>
        {label}
      </button>
    </>
  )
}

export interface NodeLinkProps {
  id: string
  tier?: string | null
  label?: string
  why?: string | null
  onFocus?: (id: string, e: ReactMouseEvent<HTMLButtonElement>) => void
  atDestination?: boolean
  className?: string
  nativeTitle?: boolean
}

/** Shared inline agent/project link base (`button.ref-chip.ref-agent.ref-ready`
 *  when live, `span` when inert/atDestination) so mentions, chips, and inline
 *  agent/project references all share the same badge, rich tooltip, context
 *  menu, click behavior, and style. */
export function NodeLink({
  id, tier, label, why, onFocus, atDestination, className, nativeTitle = true,
}: NodeLinkProps) {
  const text = label ?? id
  const nameFirst = !text.includes(id)
  const cls = className ?? ('ref-chip ref-agent ref-ready' + (atDestination ? ' ref-here' : ''))
  const defaultTitle = atDestination
    ? `${id} — this is its own desk`
    : `open the ${tier === 'project' ? 'project' : 'agent'} ${id}`
  const title = nativeTitle ? (why ?? defaultTitle) : undefined
  if (onFocus && !atDestination) {
    return (
      <button type="button" data-copy-agent-name={id} {...agentNavProps(id, nameFirst)}
        className={cls} title={title}
        onMouseDown={(e) => { if (e.button !== 0) e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); onFocus(id, e) }}>
        <TierChip tier={tier} agentName={id} />
        {text}
      </button>
    )
  }
  return (
    <span data-copy-agent-name={id} {...agentTooltipProps(id, nameFirst)}
      className={cls} title={title}
      onMouseDown={(e) => { if (e.button !== 0) e.stopPropagation() }}>
      <TierChip tier={tier} agentName={id} />
      {text}
    </span>
  )
}

export function AgentLink(props: NodeLinkProps) {
  return <NodeLink {...props} />
}

export function ProjectLink(props: Omit<NodeLinkProps, 'tier'>) {
  return <NodeLink {...props} tier="project" />
}

/** DOM equivalent of `<NodeLink />` for markdown DOM linkification (`refmd.tsx`). */
export function createNodeLinkEl(
  doc: Document,
  opts: {
    id: string
    tier?: string | null
    label?: string
    why?: string | null
    live?: boolean
    atDestination?: boolean
    className?: string
  },
): HTMLElement {
  const live = Boolean(opts.live && !opts.atDestination)
  const el: HTMLElement = doc.createElement(live ? 'button' : 'span')
  if (live) (el as HTMLButtonElement).type = 'button'
  el.className = opts.className ?? ('ref-chip ref-agent ref-ready' + (opts.atDestination ? ' ref-here' : ''))
  const defaultTitle = opts.atDestination
    ? `${opts.id} — this is its own desk`
    : `open the ${opts.tier === 'project' ? 'project' : 'agent'} ${opts.id}`
  el.title = opts.why ?? defaultTitle
  el.setAttribute('data-copy-agent-name', opts.id)
  el.setAttribute(AGENT_TOOLTIP_ATTR, opts.id)
  if (!(opts.label ?? opts.id).includes(opts.id)) {
    el.setAttribute(AGENT_TOOLTIP_NAME_FIRST_ATTR, 'true')
  }
  if (live) el.setAttribute(AGENT_NAV_ATTR, opts.id)
  el.addEventListener('mousedown', (e) => { if (e.button !== 0) e.stopPropagation() })
  const chip = createTierChipEl(doc, opts.tier, opts.id)
  if (chip) el.appendChild(chip)
  el.appendChild(doc.createTextNode(opts.label ?? opts.id))
  return el
}

/** What a deep surface knows about the agents it names. Supplied by context
 *  because the consumers are `memo`'d rows inside a windowed list.
 *  No provider = plain text: a surface that cannot vouch for a name draws
 *  neither a chip nor a jump for it. */
export interface AgentDirectory {
  /** the agent, or `undefined` when this tree holds no node by that id.
   *  EXISTENCE only — half of the sender eligibility test in desk.tsx. */
  resolve: (id: string) => { tier?: string | null } | undefined
  /** focus that agent's desk. Omitted = resolved names wear a chip but do
   *  not click, which is the honest state for a read-only surface. */
  onFocus?: (id: string) => void
  /** the agent whose FOCUSED DESK this surface is — the one id whose jump
   *  would land you where you already are. Omitted/null = this surface is
   *  nobody's focused desk, so every name navigates, its own included.
   *  Same contract as `AgentName.atDestination`: keyed on destination,
   *  supplied by the surface, never inferred from the id. */
  destination?: string | null
}

/** The ids this directory holds and the tier of each. Memoise the context
 *  value on it: an id or tier CHANGE must notify the memo'd consumers, and a
 *  ref write notifies nobody. Same facts → same string → no churn. */
export function agentFactsSig(
  map: Map<string, { tier?: string | null }> | null | undefined,
): string {
  if (!map) return ''
  let s = ''
  // the two separators cannot occur in an agent id, so no two distinct
  // trees can collide by concatenation
  for (const [id, n] of map) s += id + '\u0000' + (n?.tier ?? '') + '\u0001'
  return s
}

const AgentDirectoryCtx = createContext<AgentDirectory | null>(null)

export const AgentDirectoryProvider = AgentDirectoryCtx.Provider

/** null when no surface above supplied one — callers render plain text. */
export function useAgentDirectory(): AgentDirectory | null {
  return useContext(AgentDirectoryCtx)
}
