// canvas/panelcorner.tsx — PIN · POP OUT · OPEN AS A MODAL, in the corner of an
// agent desk tab (user request 2026-09-16, extended the same day to "the same
// featureset for the docket and inbox tabs of the agent desk view").
//
// ⚠ ONE CONTROL, THREE TABS — and the reason is not tidiness. Each of these
// three buttons is a door to something that ALREADY EXISTS somewhere else: the
// push-pin in a pinned window's title bar, PopoutButton, and the agent's own
// right-click entry. Written three times, the three copies would be three
// chances for one tab to gain a raise-instead-of-close rule, or a different
// pinned state, or a modal route that is not the menu's. So the buttons are
// written once and parameterised by WHICH surface they act on, and every one of
// them delegates rather than reimplements:
//
//   pin      → the surface's own `toggle` (canvas/modalpin.tsx), reached through
//              `requestSurfaceAction`, because pinning MEASURES the panel and
//              the panel is not on screen when the button is pressed
//   pop out  → the surface's own `MovableSurface.open` (popout.tsx), the very
//              call PopoutButton makes, reached the same way
//   modal    → the SAME callback the agent's context menu entry is given, handed
//              down whole from the shell (see AgentSurfaceRoutes)
//
// WHAT THE TAB SUPPLIES is only its identity: which of the three surfaces it is
// and whose agent it belongs to. Everything else is looked up from that.

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { DocIcon, DocketIcon, MailIcon, PinIcon } from '../icons'
import { isMobile } from '../mobile'
import { openSurfaces, revealSurface, subscribeWindows, windowRevision } from '../windowlife'
import {
  forgetModalOpen, modalPinsAvailable, requestSurfaceAction, unpinModal,
  useModalPin,
} from './modalpin'

/** The agent-scoped surfaces that have BOTH a desk tab and a modal of their
 *  own. The string is the modal's PinFrame `kind` — the same identity its pin
 *  geometry, its open marker and its saved window are all stored under, so
 *  there is no second name for a surface anywhere in this file. */
export type AgentPanelKind = 'agent-gallery' | 'agent-docket' | 'node-inbox'

/** How the shell opens each of these surfaces. The desk cannot open any of them
 *  itself — the modals are owned by App/OrgCanvas — and it must not invent a
 *  route of its own, because "the same as right-clicking the agent" is the
 *  requirement. So the shell hands its EXISTING openers down. */
export interface AgentSurfaceRoutes {
  /** exactly what the agent's right-click entry for this surface invokes,
   *  toggle-off rule and all */
  open: (kind: AgentPanelKind, agentId: string) => void
  /** the same destination WITHOUT the entry's toggle-off. Pin and pop out both
   *  need a surface to act on, so they may not use an opener that can close the
   *  very thing they are about to move. */
  show: (kind: AgentPanelKind, agentId: string) => void
}

const Routes = createContext<AgentSurfaceRoutes | null>(null)
export const AgentSurfaceRoutesProvider = Routes.Provider
export const useAgentSurfaceRoutes = (): AgentSurfaceRoutes | null => useContext(Routes)

/** What each surface is CALLED and what it is drawn with.
 *
 *  ⚠ THE MODAL BUTTON WEARS THE SURFACE'S OWN ICON, which is not a new idea
 *  invented here: the card's `presentedbtn` opens the presentations modal with
 *  DocIcon (canvas/cards.tsx), and every one of these three modals already
 *  heads itself with the same glyph — `<DocIcon/> Presented documents`,
 *  `<DocketIcon/> … · Docket`, `<MailIcon/> … · inbox`. So the button shows the
 *  reader the thing it is about to open. Pin and pop out, being the same action
 *  on every surface, keep the one glyph each already has elsewhere. */
const PANELS: Record<AgentPanelKind, { noun: string; icon: ReactNode }> = {
  'agent-gallery': { noun: 'presented documents', icon: <DocIcon fontSize="inherit" /> },
  'agent-docket': { noun: 'docket', icon: <DocketIcon fontSize="inherit" /> },
  'node-inbox': { noun: 'inbox', icon: <MailIcon fontSize="inherit" /> },
}

/** the popped-out window this surface is in, if it is in one */
const windowFor = (kind: AgentPanelKind, org: string | null) =>
  openSurfaces().find((s) => s.kind === kind && s.org === org)

/**
 * The three corner buttons for one desk tab.
 *
 * Renders nothing when the shell supplied no routes (the component tests, and
 * any surface mounted outside OrgCanvas) — a dead button is worse than no
 * button. Pin and pop out additionally need a window system to act in, so both
 * stand down on mobile, where `modalPinsAvailable` is already false and the
 * same surfaces are full-screen sheets.
 */
export function PanelCorner({ kind, slug, nid }: {
  kind: AgentPanelKind
  slug: string
  /** the agent whose tab this is — every route is scoped to it */
  nid: string
}) {
  const routes = useAgentSurfaceRoutes()
  // LIVE state, not a snapshot: both of these change from the surface itself
  // (its title bar, its window's close box) while this button is on screen, and
  // a push-pin that says "pin" over a pinned window is the exact dead-click the
  // 2026-09-10 raise-instead-of-close ruling was about.
  const pinned = useModalPin(kind, slug) !== null
  useSyncExternalStore(subscribeWindows, windowRevision)
  const detached = !!windowFor(kind, slug)
  if (!routes || isMobile) return null
  const { noun, icon } = PANELS[kind]
  const windows = modalPinsAvailable()

  const pin = () => {
    // ⚠ UNPINNING IS THE TITLE BAR'S OWN TWO CALLS, not a third spelling of
    // them: `toggle` in modalpin.tsx does exactly `unpinModal` then
    // `forgetModalOpen`. It is done here rather than through the request
    // channel because it needs no measurement and no mounted panel — a pin
    // outlives a closed surface, and this is the one press that must still
    // work when the window it describes is not on screen.
    if (pinned) { unpinModal(kind, slug); forgetModalOpen(kind, slug); return }
    // PINNING does need the panel: the rect a fresh pin takes is the panel's
    // own box, so the surface has to exist and measure itself. Open it, then
    // ask it to pin itself.
    routes.show(kind, nid)
    requestSurfaceAction(kind, slug, 'pin')
  }

  const popout = () => {
    // Already in a window of its own: raise that window rather than open a
    // second one — the same answer "Show desk window" gives in the agent menu.
    // Redocking is deliberately NOT offered from out here: the title bar's ↙ is
    // in the window, where the reader can see what they are returning.
    const open = windowFor(kind, slug)
    if (open) { revealSurface(open); return }
    routes.show(kind, nid)
    requestSurfaceAction(kind, slug, 'popout')
  }

  return (
    <span className="panel-corner" role="group"
      aria-label={`${noun} window actions`}>
      {windows && <button type="button" className="panel-corner-btn"
        aria-pressed={pinned}
        aria-label={pinned
          ? `unpin ${nid}'s ${noun} window`
          : `pin ${nid}'s ${noun} as a window`}
        title={pinned
          ? 'unpin — put this back in the middle of the screen'
          : `pin ${nid}'s ${noun} to the window, so it stays put and can be dragged around`}
        onClick={pin}>
        <PinIcon fontSize="inherit" />
      </button>}
      {windows && <button type="button" className="panel-corner-btn"
        aria-label={detached
          ? `show ${nid}'s ${noun} window`
          : `open ${nid}'s ${noun} in a new window`}
        title={detached
          ? 'show the window this is already open in'
          : `open ${nid}'s ${noun} in a new window`}
        onClick={popout}>
        {/* the arrow PopoutButton draws, so the two read as one control in two
            places rather than two controls */}
        <span aria-hidden="true">{detached ? '⇱' : '↗'}</span>
      </button>}
      <button type="button" className="panel-corner-btn"
        aria-label={`open ${nid}'s ${noun} as a standalone modal`}
        title={`open ${nid}'s ${noun} as a standalone modal`}
        onClick={() => routes.open(kind, nid)}>
        {icon}
      </button>
    </span>
  )
}
