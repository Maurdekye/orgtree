// canvas/registermenu.tsx — the Listeners tab header's "Register…" menu button
// (docket slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20
// 16:43Z: "make this one menu button in the same row as those buttons:
// "Register..." the modal that pops out will have three rows: one with a
// button for "Register one time event listener", a row for "Register
// continuous event listener", and "Register watcher for N listeners" with the
// same number input variadically updating. clicking any of the three buttons
// does the respective thing ... keep the helptext in the hover tooltips ...
// if listen watcher is already registered, grey it out, unless you changed the
// value; then change the text to read "Watch for N listeners". for the other
// two, leave the opposing button enabled saying "Switch to one-time event
// listener" or "Switch to continuous event listener"").
//
// One trigger, left of the tab's pin / pop-out / modal buttons, opens a small
// panel under it; each of its three buttons acts at once
// (`user_listener_register` once true / false, `user_watch_register` with the
// number) and closes it. Registered already, the engine changes the
// registration in place (domain/ops/user_regs.rs): the other listener kind
// switches the listener (the same dog), another number updates the watch's
// count. So the buttons read the user's own dogs: their kind's button is grey
// and the other kind says "Switch to …"; the watch's button is grey until the
// number differs and then reads "Watch for N listeners". The old dialogs' help
// text rides the tooltips. The panel lives in the surface's overlay root, so
// it paints above a pinned window and in a popped-out one (as the context menu
// does), and closes on a second press, Escape, a press or wheel outside it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn } from '../types'
import type { CanvasNode, OpFn } from './shared'
import type { ProjectListenerState } from './listeners'
import { isUserName } from './usermention'
import { MAX_WATCH_COUNT } from './userlimits'
import { DeskCount, bringCount, countOf } from './deskcount'
import { useOverlayRoot, useSurfaceDocument } from '../popout'

export interface RegisterOption { label: string; disabled: boolean }
export interface RegisterOptions { any: boolean; once: RegisterOption; continuous: RegisterOption; watch: RegisterOption }

const listenersWord = (n: number) => `${n} listener${n === 1 ? '' : 's'}`

/** What each of the three buttons says and whether it can be pressed, from the
 *  user's own registrations (`listener`: their listener's kind, `watch`: their
 *  watch's count) and the number in the input (`count`, null when it is not a
 *  whole number). `any`: at least one is possible, which is when the menu's
 *  trigger is enabled. */
export function registerOptions({ live, listener, watch, count }: {
  live: boolean; listener: 'once' | 'continuous' | null; watch: number | null; count: number | null
}): RegisterOptions {
  const once: RegisterOption = { disabled: !live || listener === 'once',
    label: listener === 'continuous' ? 'Switch to one-time event listener' : 'Register one time event listener' }
  const continuous: RegisterOption = { disabled: !live || listener === 'continuous',
    label: listener === 'once' ? 'Switch to continuous event listener' : 'Register continuous event listener' }
  const same = watch !== null && count === watch
  const watchOption: RegisterOption = { disabled: !live || count === null || same,
    label: count === null ? 'Register watcher' : `${watch !== null && !same ? 'Watch for' : 'Register watcher for'} ${listenersWord(count)}` }
  return { any: !once.disabled || !continuous.disabled || !watchOption.disabled, once, continuous, watch: watchOption }
}

export function RegisterMenu({ node, state, op, toast }: {
  node: CanvasNode; state: ProjectListenerState; op?: OpFn; toast?: ToastFn
}) {
  const doc = useSurfaceDocument()
  const overlay = useOverlayRoot()
  const myListener = state.listeners.find((w) => isUserName(w.owner))
  const myWatch = state.watches.find((w) => isUserName(w.owner))
  const listener = myListener ? (myListener.once ? 'once' as const : 'continuous' as const) : null
  const current = myWatch ? Math.min(Math.max(myWatch.count ?? 1, 1), MAX_WATCH_COUNT) : null
  const [open, setOpen] = useState(false)
  // null: follow the tree's count for the user's watch (1 before they have one);
  // a typed number stays until the tree reports another count, then follows it
  const [typed, setTyped] = useState<string | null>(null)
  useEffect(() => { setTyped(null) }, [current])
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => target instanceof Node
      && (!!panelRef.current?.contains(target) || !!triggerRef.current?.contains(target))
    const away = (e: Event) => { if (!inside(e.target)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    doc.addEventListener('pointerdown', away, true)
    doc.addEventListener('wheel', away, true)
    doc.addEventListener('keydown', key)
    return () => {
      doc.removeEventListener('pointerdown', away, true)
      doc.removeEventListener('wheel', away, true)
      doc.removeEventListener('keydown', key)
    }
  }, [open, doc])
  // under the trigger, right edges together, kept inside the window
  useLayoutEffect(() => {
    if (!open) { setAt(null); return }
    const r = triggerRef.current?.getBoundingClientRect()
    const width = doc.documentElement.clientWidth || doc.defaultView?.innerWidth || 0
    if (r) setAt({ top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(width - r.right)) })
  }, [open, doc])
  if (node.state !== 'live') return null
  const shown = typed === null ? String(current ?? 1) : typed
  const count = countOf(shown)
  const opts = registerOptions({ live: true, listener, watch: current, count })
  const run = (body: Parameters<OpFn>[0], done: string) => {
    setOpen(false)
    op?.(body).then(() => toast?.([done])).catch(() => {})
  }
  const id = node.id
  const inbox = 'arrives as normal mail in your inbox'
  const tips = {
    trigger: `register on project ${id}: a one-time or a continuous event listener, or a listener watch; what each hears ${inbox}`,
    once: listener === 'continuous'
      ? `switch the continuous event listener to hear only the next event fired on ${id}, in place: it keeps its place in the order, the next event ${inbox}, and then it removes itself`
      : listener === 'once' ? `already a one-time event listener of project ${id}: the next event fired on it ${inbox}, and then it removes itself`
      : `hear the next event fired on project ${id} only: it ${inbox}, and then the listener removes itself. It also counts toward listener watches`,
    continuous: listener === 'once'
      ? `switch the one-time event listener to hear every event fired on ${id}, in place: it keeps its place in the order, each event ${inbox}, and it stays until it is removed`
      : listener === 'continuous' ? `already a continuous event listener of project ${id}: every event fired on it ${inbox} until it is removed`
      : `hear every event fired on project ${id}: each ${inbox} until the listener is removed. It also counts toward listener watches`,
    watch: count === null ? `choose 1 to ${MAX_WATCH_COUNT} listeners`
      : `a one-time notification ${inbox} when ${listenersWord(count)} ${count === 1 ? 'is' : 'are'} armed on project ${id} `
        + `(an event listener of the user's counts); if that many are already armed it fires at once.`
        + (current === null ? '' : count === current ? ` Already watching for ${listenersWord(current)}: change the number to update the watch.`
          : ` The watch for ${listenersWord(current)} is updated in place.`),
    count: `how many armed event listeners on project ${id} fire the watch: 1 to ${MAX_WATCH_COUNT}`,
  }
  return (
    <span className="register-menu">
      <button type="button" ref={triggerRef} className="register-trigger" data-action="register-menu"
        aria-haspopup="true" aria-expanded={open} disabled={!opts.any} title={tips.trigger}
        onClick={() => setOpen((v) => !v)}>Register…</button>
      {open && at && createPortal(
        <div className="register-panel" ref={panelRef} role="group" aria-label={`Register on project ${id}`}
          style={{ top: at.top, right: at.right }}>
          <button type="button" className="register-row" data-action="register-once" disabled={opts.once.disabled} title={tips.once}
            onClick={() => run({ op: 'user_listener_register', node: id, once: true },
              listener === 'continuous' ? `event listener of project ${id} switched to the next event only`
                : `registered as a one-time event listener of project ${id}`)}>
            {opts.once.label}</button>
          <button type="button" className="register-row" data-action="register-continuous" disabled={opts.continuous.disabled} title={tips.continuous}
            onClick={() => run({ op: 'user_listener_register', node: id, once: false },
              listener === 'once' ? `event listener of project ${id} switched to every event`
                : `registered as a continuous event listener of project ${id}`)}>
            {opts.continuous.label}</button>
          <DeskCount className="register-watch-count" groupLabel="Register a listener watch"
            value={shown} min={1} max={MAX_WATCH_COUNT} onValue={(text) => setTyped(bringCount(text, 1, MAX_WATCH_COUNT))}
            inputLabel="Event listeners to watch for" inputTitle={tips.count}
            action="register-watch" disabled={opts.watch.disabled} label={opts.watch.label} title={tips.watch}
            onAct={() => { if (count !== null) run({ op: 'user_watch_register', node: id, count },
              current !== null ? `listener watch on project ${id} changed to ${listenersWord(count)}`
                : `registered a listener watch on project ${id} for ${listenersWord(count)}`) }} />
        </div>, overlay)}
    </span>)
}
