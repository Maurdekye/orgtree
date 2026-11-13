// canvas/tempdesk.tsx — read another agent's desk without rearranging anything.
//
// THE PROBLEM (docket `open-an-agent-desk-temporarily-as-a-modal`). Every way
// to look at another agent's desk changed the workspace to do it: focus the
// tree on that agent, pin its desk as a window, or pop it out into its own.
// Each is a deliberate placement, and each is far too much for "what is that
// one doing?". So this is the glance: a modal over the canvas, the agent's own
// desk inside it, and nothing left behind when it closes.
//
// ⚠ IT BORROWS THE CANONICAL DESK — IT DOES NOT DRAW A COPY. That is the whole
// design, and it is what the ticket asks for ("reuse the canonical desk
// rendering and permissions rather than creating a divergent read-only
// imitation"). A second desk for one agent would be a second live composer:
// two message boxes, two drafts, two things claiming to be the conversation.
// Instead the `borrow` slot takes the ONE desk for as long as this modal is
// mounted and the registry gives it back to the exact destination it came from
// — including re-opening a native window at the geometry it had. So actions
// inside it are the real actions with their real authorization, and the draft
// you were half-way through typing is still there afterwards.
//
// ⚠ AND IT LEAVES NO STATE OF ITS OWN. No pin, no popout, no saved layout row,
// no change to the focused agent. The modal is local component state in
// OrgCanvas and nothing else; closing it restores the prior view because
// nothing about the view was ever changed.
//
// IT IS ON THE SHARED MODAL FRAME (user 2026-11-13 mf430d688fdcb; the design
// chosen in m2672b93c2df8, "A + all 5"): `DeskModalShell`, the frame the
// project desk's modal already used, in its `glance` configuration. That gives
// it the shared backdrop, title bar, buttons, right-click menu and stacking,
// and three rules of its own:
//   · HAND-OVER. An agent's desk already has a pinned form and a popped-out
//     form. This is the third, centred one, and it is never itself pinned or
//     popped out: its pin and pop-out buttons hand the desk to the real pinned
//     window and the real desk window, and close this.
//   · ONE AT A TIME, per agent. The kind names the agent
//     (`agent-desk-glance:<id>`); the host holds one id, so opening a second
//     agent's replaces the first. Several centred desks would only stack.
//   · NOTHING SAVED, as above: the frame runs `transient`.
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { DeskChat } from './desk'
import { DeskModalShell } from './deskshell'
import type { DeskChatProps } from './desk'
import { useDeskActionsNow } from './deskhosts'
import { providerOf } from './shared'
import type { CanvasNode } from './shared'
import { useOverlayRoot } from '../popout'
import { instanceKind } from '../modalkinds'
import type { PinRect } from './pins'

/** the temporary desk's storage-shaped identity; nothing is stored under it */
export const DESK_GLANCE_KIND = 'agent-desk-glance'

export interface TempDeskProps {
  node: CanvasNode
  close: () => void
  /** pin this agent's desk as a window and close the modal — the host's own
   *  pin action. Absent, there is no Pin button (already pinned, or mobile). */
  onPin?: (rect: PinRect) => void
  /** the canonical desk's own props, from the host — the same ones the canvas's
   *  desks get. This panel adds none of its own and stubs nothing. */
  desk: Omit<DeskChatProps, 'node' | 'borrow' | 'bare'>
}

/**
 * The modal. Backdrop, Escape, the title bar and its menu are the shared
 * frame's; the focus handling is the frame's `focusTrap`, which is this
 * modal's old handling moved there.
 *
 *  · Escape goes through THE SHARED ESCAPE STACK (the frame's `useEsc`). One
 *    Escape closes one thing: with a context menu open over this modal the
 *    menu takes the key first, and this closes on the next one.
 *  · the backdrop swallows `pointerdown` so a click meant for "dismiss" cannot
 *    also reach the canvas underneath and start a pan.
 *  · portaled to the overlay root, so it lands in the right document when the
 *    canvas itself is inside a popped-out window.
 */
export function TempDeskModal({ node, close, onPin, desk }: TempDeskProps) {
  const overlayRoot = useOverlayRoot()
  const host = useRef<HTMLDivElement | null>(null)
  const actions = useDeskActionsNow(desk.slug)
  // the frame's panel, measured before the desk leaves it for a real window
  const sourceBox = (): PinRect | null => {
    const r = host.current?.closest('.tempdesk-panel')?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
  }
  if (typeof document === 'undefined') return null
  return createPortal(
    // THE FRAME (user 2026-09-29: the pinned-desk look): the provider accent
    // border and the tier + bold name in the bar. It closes by its X (USER
    // 2026-10-29 me188f67b3944), the backdrop or Escape; the desk's own header
    // does not repeat the name (styles.css) or the pop-out (`hidePopout`).
    <DeskModalShell kind={instanceKind(DESK_GLANCE_KIND, node.id)} title={`${node.id} · desk`}
      nodeId={node.id} generation={node.generation} tier={node.tier}
      panel={'tempdesk-panel tempdesk-glance prov-' + providerOf(node.tier ?? '')} close={close}
      pinElsewhere={onPin}
      glance={{
        label: `${node.id} · desk, opened temporarily`,
        // THE POP-OUT HANDS OVER: the borrowed desk's own surface opens the
        // real desk window from this panel's box, and `onPopout` below closes
        // this modal once that window exists. A blocked window changes nothing.
        popElsewhere: () => actions(node).requestPopout(),
      }}>
      <div ref={host} className="tempdesk-host">
        {/* ⚠ `borrow` IS THE WHOLE MECHANISM. It takes the canonical desk for
            this modal's lifetime and the registry returns it on unmount — see
            `Desks.endBorrow`. `bare` renders the desk 1:1 rather than
            counter-scaled into a canvas card, which is what a modal wants. */}
        <DeskChat {...desk} node={node} borrow bare hidePopout temporaryPlacement={{ sourceBox, onPopout: close }} />
      </div>
    </DeskModalShell>,
    overlayRoot)
}
