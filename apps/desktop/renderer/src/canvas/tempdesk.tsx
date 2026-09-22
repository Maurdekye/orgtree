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
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { DeskChat } from './desk'
import type { DeskChatProps } from './desk'
import { useEsc } from './shared'
import type { CanvasNode } from './shared'
import { useOverlayRoot, useSurfaceDocument } from '../popout'

export interface TempDeskProps {
  node: CanvasNode
  close: () => void
  /** the canonical desk's own props, from the host — the same ones the canvas's
   *  desks get. This panel adds none of its own and stubs nothing. */
  desk: Omit<DeskChatProps, 'node' | 'borrow' | 'bare'>
}

/**
 * The modal. Backdrop, Escape, focus handling and sizing follow the app's
 * existing conventions rather than inventing any:
 *
 *  · `useEsc` — THE SHARED ESCAPE STACK, not a keydown listener of its own.
 *    One Escape closes one thing: with a context menu open over this modal the
 *    menu takes the key first, and this closes on the next one.
 *  · the backdrop swallows `pointerdown` so a click meant for "dismiss" cannot
 *    also reach the canvas underneath and start a pan — the same reason
 *    `ModalOverPins` and every in-card control stop that event.
 *  · portaled to the overlay root, so it is above the pin layer and lands in
 *    the right document when the canvas itself is inside a popped-out window.
 */
export function TempDeskModal({ node, close, desk }: TempDeskProps) {
  const doc = useSurfaceDocument()
  const overlayRoot = useOverlayRoot()
  const panel = useRef<HTMLDivElement | null>(null)
  const opener = useRef<Element | null>(null)
  useEsc(close)
  // FOCUS GOES IN, AND COMES BACK OUT WHERE IT WAS. The element that opened
  // this (a card, a tray row, a menu item) is remembered before focus moves,
  // because "closing puts everything back" includes the keyboard: landing the
  // user on `document.body` would leave the next keystroke going nowhere.
  useEffect(() => {
    opener.current = doc.activeElement
    panel.current?.focus?.()
    const trapTab = (event: KeyboardEvent) => {
      const root = panel.current
      if (event.key !== 'Tab' || event.defaultPrevented || !root) return
      // A Desk can open its own dialog or menu. Let its handler consume Tab
      // first, and leave focus alone while another modal owns it.
      const active = doc.activeElement
      const dialog = active?.closest('[role="dialog"][aria-modal="true"]')
      if (dialog && dialog !== root) return
      const targets = Array.from(root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]',
      )).filter(element => {
        if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false
        // The canonical Desk carries collapsed panes as well as visible ones.
        // Compute visibility in its own document, including hidden ancestors.
        for (let current: HTMLElement | null = element; current; current = current.parentElement) {
          const style = doc.defaultView?.getComputedStyle(current)
          if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
          if (current === root) break
        }
        return true
      })
      event.preventDefault()
      if (!targets.length) { root.focus(); return }
      const index = targets.findIndex(element => element === active)
      const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length
      targets[next].focus()
    }
    doc.addEventListener('keydown', trapTab)
    return () => {
      doc.removeEventListener('keydown', trapTab)
      const back = opener.current
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="tempdesk-over" onPointerDown={(e) => {
      // a press on the BACKDROP dismisses; a press inside the panel does not.
      // Checked against the press target rather than by putting a handler on
      // the panel, so a drag that starts inside and ends outside is not a
      // dismissal either.
      if (e.target === e.currentTarget) { e.stopPropagation(); close() }
      else e.stopPropagation()
    }}>
      <div className="tempdesk-panel" ref={panel} tabIndex={-1}
        role="dialog" aria-modal="true"
        aria-label={`${node.id} · desk, opened temporarily`}>
        <div className="tempdesk-head">
          <b data-copy-agent-name={node.id}>{node.id}</b>
          <span className="tempdesk-note">opened temporarily</span>
          <button className="tempdesk-close" onClick={close}
            aria-label="close">✕</button>
        </div>
        {/* ⚠ `borrow` IS THE WHOLE MECHANISM. It takes the canonical desk for
            this modal's lifetime and the registry returns it on unmount — see
            `Desks.endBorrow`. `bare` renders the desk 1:1 rather than
            counter-scaled into a canvas card, which is what a modal wants. */}
        <DeskChat {...desk} node={node} borrow bare />
      </div>
    </div>,
    overlayRoot)
}
