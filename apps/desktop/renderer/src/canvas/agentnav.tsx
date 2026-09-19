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

import { createContext, useContext, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { MenuEntry } from './contextmenu'

/** the attribute that marks a navigation target as wanting the canonical menu.
 *  Its value is the agent id the primary click would navigate to. */
export const AGENT_NAV_ATTR = 'data-agent-nav'

/** Build the canonical menu for an arbitrary agent id, or return nothing when
 *  this window cannot (no registration, or no such agent in this tree). */
export type AgentNavMenu = (id: string) => MenuEntry[]

interface Registry { current: AgentNavMenu | null }

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
  const reg = useRef<AgentNavMenu | null>(null)
  // a stable identity: consumers read `reg.current` at open time, so a new
  // object here would churn every memo'd row for no change in behaviour
  const own = useMemo<Registry>(() => reg as Registry, [])
  return <AgentNavCtx.Provider value={inherited ?? own}>{children}</AgentNavCtx.Provider>
}

/** The surface that owns the handlers publishes its builder here. Called
 *  during render deliberately: registration must be in place for a right
 *  click that happens before effects flush on a slow first paint. */
export function useProvideAgentNav(build: AgentNavMenu | null): void {
  const reg = useContext(AgentNavCtx)
  if (reg) reg.current = build
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
 *  another surface's target through a portal. */
export function agentNavAt(target: EventTarget | null, within?: Element): string | null {
  const el = (target as Element | null)?.closest?.('[' + AGENT_NAV_ATTR + ']')
  if (!el || (within && !within.contains(el))) return null
  return el.getAttribute(AGENT_NAV_ATTR) || null
}

/** Spread onto a navigating target to mark it. There is deliberately no
 *  `onContextMenu` here: the menu is raised by `useContextMenu().open`, which
 *  every surface already routes its right clicks through, so a target that is
 *  marked needs no handler of its own and cannot wire one up differently. */
export function agentNavProps(id: string | null | undefined):
  { [AGENT_NAV_ATTR]?: string } {
  return id ? { [AGENT_NAV_ATTR]: id } : {}
}
