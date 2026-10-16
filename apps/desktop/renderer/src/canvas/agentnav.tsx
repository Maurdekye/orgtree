// canvas/agentnav.tsx — THE CANONICAL AGENT MENU, REACHED FROM ANY NAVIGATION
// TARGET (user scope expansion 2026-09-19: "expose the same canonical full
// agent context menu at every renderer location where the primary click would
// navigate or jump to that agent", and "all of these surfaces must use the
// same underlying implementation").
//
// WHY A REGISTRY AND NOT A PROP. The targets are scattered across surfaces
// that do not share a parent: the mail sender chip in App.tsx is a SIBLING of
// OrgCanvas, not a descendant, and the deep ones (docket rows, mail headers,
// gallery entries, prose ref chips) are `memo`'d rows several layers down.
// Threading fifteen handlers through every one of them is precisely the
// surface-specific copying the ticket forbids. So one implementation is
// REGISTERED by the surface that actually owns the handlers — OrgCanvas, whose
// `trayRowMenu` already builds this menu for an arbitrary node — and every
// target reads it at menu-open time.
//
// ⚠ READ AT OPEN TIME, NEVER SUBSCRIBED. The registry is a ref, not state, for
// the same reason `deskhosts.tsx` is consulted through `deskNow` and
// `pins.tsx` through `isPinned` inside the menu thunk: a value captured at
// MOUNT is the answer to a question nobody asked. A `memo`'d row that never
// re-renders must still raise today's menu.
//
// ⚠ ONE REGISTRY PER WINDOW, AND NO REGISTRATION IS A REAL ANSWER. A popped
// out or pinned desk is a different document with its own React root; an
// OrgCanvas portal cannot render into it. A window with no registered
// implementation returns no entries, and its targets keep exactly the menu
// they have today. That is the same rule `agentmenu.tsx` already applies to a
// handler a surface cannot offer — absent, never stubbed.
//
// ⚠ THE MARKER MEANS "HAS NO MENU OF ITS OWN". Surfaces that already build the
// canonical menu themselves (the Agents List row, the agent card, the desk
// header) must NOT carry `data-agent-nav`, or `useContextMenu` would append a
// second copy of the entries they already passed it.
//
// ⚠ BUT A MARKED TARGET MAY SIT INSIDE A SURFACE THAT HAS ITS OWN MENU, AND
// THEN THE MARKER WINS (user ruling 2026-09-20). The rule above is about the
// surface ITSELF, not about its descendants: a mail list row passes its own
// `rowMenu` and draws a marked sender chip inside it. A right-click directly
// on the chip raises the AGENT menu; a right-click elsewhere on the row
// raises the ROW's menu. The two are never combined and there is no submenu.
// `open` decides this — the more specific target wins — and it is the reason
// the nav lookup there is unconditional rather than gated on the surface
// having passed no entries.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MenuEntry } from './contextmenu'

/** the attribute that marks a navigation target as wanting the canonical menu.
 *  Its value is the agent id the primary click would navigate to. */
export const AGENT_NAV_ATTR = 'data-agent-nav'
export const AGENT_TOOLTIP_ATTR = 'data-agent-tooltip'

/** Build the canonical menu for an arbitrary agent id, or return nothing when
 *  this window cannot (no registration, or no such agent in this tree). */
export type AgentNavMenu = (id: string) => MenuEntry[]

export interface AgentTooltipInfo {
  name: string
  provider: string
  model: string
  effort: string
  account: string
}

export type AgentTooltipLookup = (id: string) => AgentTooltipInfo | null

interface Registry {
  current: AgentNavMenu | null
  tooltip: AgentTooltipLookup | null
}

const AgentNavCtx = createContext<Registry | null>(null)

/** Mount per window, above both the canvas and its siblings.
 *
 *  ⚠ NESTING REUSES, IT DOES NOT SHADOW. App.tsx mounts the outer one, so the
 *  mail sender chip and the other siblings of the canvas share a registry with
 *  it; OrgCanvas mounts one too, because it is ALSO mounted on its own — by
 *  every renderer test that exercises the canvas, and by any host that embeds
 *  it without App. If the inner one made a second registry it would shadow the
 *  outer for everything inside the canvas, OrgCanvas would publish into the
 *  inner one, and App's own siblings would read an empty outer one and quietly
 *  lose their menus. So an inner provider hands down the registry it found. */
export function AgentNavProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(AgentNavCtx)
  const reg = useRef<Registry>({ current: null, tooltip: null })
  // a stable identity: consumers read `reg.current` at open time, so a new
  // object here would churn every memo'd row for no change in behaviour
  const own = useMemo<Registry>(() => reg.current, [])
  const value = inherited ?? own
  return <AgentNavCtx.Provider value={value}>
    {children}
    {!inherited && <AgentHoverTooltip />}
  </AgentNavCtx.Provider>
}

/** The surface that owns the handlers publishes its builder here. Called
 *  during render deliberately: registration must be in place for a right
 *  click that happens before effects flush on a slow first paint. */
export function useProvideAgentNav(build: AgentNavMenu | null,
                                   tooltip: AgentTooltipLookup | null = null): void {
  const reg = useContext(AgentNavCtx)
  if (reg) {
    reg.current = build
    reg.tooltip = tooltip
  }
}

/** Spread onto every agent link, including links whose surface owns its own
 *  context menu. Kept separate from `data-agent-nav`, which means only
 *  "borrow the shared menu". */
export function agentTooltipProps(id: string | null | undefined):
  { [AGENT_TOOLTIP_ATTR]?: string } {
  return id ? { [AGENT_TOOLTIP_ATTR]: id } : {}
}

interface ActiveTooltip {
  anchor: HTMLElement
  info: AgentTooltipInfo
  left: number
  top: number
}

/** One delegated tooltip per renderer document. Delegation covers names in
 *  memo'd rows and sibling surfaces without wrapping their layout elements. */
function AgentHoverTooltip() {
  const registry = useContext(AgentNavCtx)
  const [active, setActive] = useState<ActiveTooltip | null>(null)
  const activeRef = useRef<ActiveTooltip | null>(null)
  const show = (value: ActiveTooltip | null) => {
    activeRef.current = value
    setActive(value)
  }

  useEffect(() => {
    if (!registry) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let candidate: HTMLElement | null = null
    let shown: HTMLElement | null = null

    const cancel = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      candidate = null
      shown = null
      show(null)
    }
    const position = (anchor: HTMLElement, info: AgentTooltipInfo) => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(320, Math.max(0, window.innerWidth - 16))
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const below = rect.bottom + 8
      const top = below + 132 <= window.innerHeight
        ? below : Math.max(8, rect.top - 140)
      show({ anchor, info, left, top })
    }
    const schedule = (anchor: HTMLElement) => {
      if (candidate === anchor || shown === anchor) return
      const id = anchor.getAttribute(AGENT_TOOLTIP_ATTR)
      if (id && candidate?.getAttribute(AGENT_TOOLTIP_ATTR) === id
        && (candidate.contains(anchor) || anchor.contains(candidate))) return
      if (timer !== null) clearTimeout(timer)
      show(null)
      candidate = anchor
      if (!id) return
      timer = setTimeout(() => {
        timer = null
        if (candidate !== anchor || !anchor.isConnected) return
        const info = registry.tooltip?.(id)
        if (!info) return
        shown = anchor
        position(anchor, info)
      }, 500)
    }
    const leave = (event: Event) => {
      const target = event.target as Element | null
      const anchor = target?.closest?.('[' + AGENT_TOOLTIP_ATTR + ']') as HTMLElement | null
      if (!anchor) return
      const related = event.relatedTarget as Element | null
      const relatedAnchor = related?.closest?.('[' + AGENT_TOOLTIP_ATTR + ']') as HTMLElement | null
      if ((related instanceof Node && anchor.contains(related))
        || relatedAnchor?.getAttribute(AGENT_TOOLTIP_ATTR) === anchor.getAttribute(AGENT_TOOLTIP_ATTR)) return
      if (candidate === anchor || shown === anchor) cancel()
    }
    const over = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.(
        '[' + AGENT_TOOLTIP_ATTR + ']') as HTMLElement | null
      if (anchor) schedule(anchor)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    const reposition = () => {
      const visible = activeRef.current
      if (visible?.anchor.isConnected) position(visible.anchor, visible.info)
      else if (visible) cancel()
    }
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', leave, true)
    document.addEventListener('focusin', over, true)
    document.addEventListener('focusout', leave, true)
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', leave, true)
      document.removeEventListener('focusin', over, true)
      document.removeEventListener('focusout', leave, true)
      document.removeEventListener('keydown', keydown, true)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  // A tooltip reads the registry when the delay expires. The registry is a
  // stable ref; a new tree projection is therefore used without subscribing
  // every memo'd link to render-time state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry])

  if (!active) return null
  return createPortal(<div className="agent-hover-tooltip" role="tooltip"
    style={{ left: active.left, top: active.top }}>
    <strong>{active.info.name}</strong>
    <span><b>Provider:</b> {active.info.provider}</span>
    <span><b>Model:</b> {active.info.model}</span>
    <span><b>Effort:</b> {active.info.effort}</span>
    <span><b>Account:</b> {active.info.account}</span>
  </div>, active.anchor.ownerDocument.body)
}

/** Read the REGISTRY, not the builder. Callers must dereference `.current`
 *  at the moment the menu opens — returning the builder from here would be a
 *  render-time read, which is the mount-time capture this file exists to
 *  avoid: a `memo`'d row that never re-renders would hold the value from
 *  before OrgCanvas registered anything. The object identity is stable, so it
 *  is safe as a `useCallback` dependency. */
export function useAgentNavRegistry(): { readonly current: AgentNavMenu | null } | null {
  return useContext(AgentNavCtx)
}

/** The nearest navigation target at or above `target`, bounded by `within`
 *  exactly as `copyObjectAt` is — a press inside one surface must never find
 *  another surface's target through a portal.
 *
 *  Returned as the ELEMENT rather than only its id because the caller has to
 *  compare its position against the copy object's: whichever of the two is
 *  the OUTER one has to be the anchor, since the anchor bounds both lookups.
 *  Anchoring on the inner one leaves the outer unreachable, which is how a
 *  marker sitting above its copy object went silently inert.
 *
 *  ⚠ `within` IS ASSERTED, and it was not until 2026-09-20. Deleting it left
 *  the whole renderer suite green (textmenu's mutation N5), so the file stated
 *  a portal-safety rule nothing defended. agentnavmenu.test.tsx §13 now builds
 *  the crossing with a real `createPortal` — surface A handles the press,
 *  surface B holds the marker and hosts the portal — and fails when the bound
 *  is removed. HONEST LIMIT: no portal target in the app today lands inside a
 *  marked element, so the bound is load-bearing for a CONSTRUCTIBLE shape
 *  rather than for one the product currently produces. It matters more since
 *  the precedence ruling: this lookup used to run only for a surface that
 *  passed no entries, and now runs on every right-click every surface takes. */
export function agentNavElementAt(target: EventTarget | null, within?: Element): Element | null {
  const el = (target as Element | null)?.closest?.('[' + AGENT_NAV_ATTR + ']')
  if (!el || (within && !within.contains(el))) return null
  return el.getAttribute(AGENT_NAV_ATTR) ? el : null
}

export function agentNavAt(target: EventTarget | null, within?: Element): string | null {
  return agentNavElementAt(target, within)?.getAttribute(AGENT_NAV_ATTR) || null
}

/** Spread onto a navigating target to mark it. There is deliberately no
 *  `onContextMenu` here: the menu is raised by `useContextMenu().open`, which
 *  every surface already routes its right clicks through, so a target that is
 *  marked needs no handler of its own and cannot wire one up differently. */
export function agentNavProps(id: string | null | undefined):
  { [AGENT_NAV_ATTR]?: string; [AGENT_TOOLTIP_ATTR]?: string } {
  return id ? { [AGENT_NAV_ATTR]: id, [AGENT_TOOLTIP_ATTR]: id } : {}
}
