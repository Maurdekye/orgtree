// canvas/registermenu.tsx — the Listeners tab header's "Register…" menu button
// (docket slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20
// 16:43Z: "make this one menu button in the same row as those buttons:
// "Register..." the modal that pops out will have three rows: one with a
// button for "Register one time event listener", a row for "Register
// continuous event listener", and "Register watcher for N listeners" with the
// same number input variadically updating. clicking any of the three buttons
// does the respective thing ... keep the helptext in the hover tooltips").
// One trigger opens a small panel; each of its three buttons acts at once
// (`user_listener_register` once true / false, `user_watch_register` with the
// number) and closes it. Registered already, the engine changes the
// registration in place: the other listener kind switches the listener (the
// same dog), another number updates the watch's count. So the buttons read the
// user's own dogs: their kind's button is grey and the other kind says "Switch
// to ...", the watch's button is grey until the number differs and then reads
// "Watch for N listeners". The old dialogs' help text rides the tooltips.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn } from '../types'
import type { CanvasNode, OpFn } from './shared'
import type { ProjectListenerState } from './listeners'
import { isUserName } from './usermention'
import { MAX_WATCH_COUNT } from './userlimits'

export interface RegisterOption { label: string; disabled: boolean }
export interface RegisterOptions { any: boolean; once: RegisterOption; continuous: RegisterOption; watch: RegisterOption }

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
  const listeners = (n: number) => `${n} listener${n === 1 ? '' : 's'}`
  const watchOption: RegisterOption = { disabled: !live || count === null || same,
    label: count === null ? 'Register watcher' : `${watch !== null && !same ? 'Watch for' : 'Register watcher for'} ${listeners(count)}` }
  return { any: !once.disabled || !continuous.disabled || !watchOption.disabled, once, continuous, watch: watchOption }
}

export function RegisterMenu({ node, state, op, toast }: {
  node: CanvasNode; state: ProjectListenerState; op?: OpFn; toast?: ToastFn
}) {
  const myListener = state.listeners.find((w) => isUserName(w.owner))
  const myWatch = state.watches.find((w) => isUserName(w.owner))
  const listener = myListener ? (myListener.once ? 'once' as const : 'continuous' as const) : null
  const current = myWatch ? Math.min(Math.max(myWatch.count ?? 1, 1), MAX_WATCH_COUNT) : null
  const [open, setOpen] = useState(false)
  // null: follow the tree's own count for the user's watch (1 before they have one)
  const [typed, setTyped] = useState<string | null>(null)
  const [at, setAt] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const doc = triggerRef.current?.ownerDocument ?? document
    const away = (e: Event) => {
      const target = e.target as Node | null
      if (target && (panelRef.current?.contains(target) || triggerRef.current?.contains(target))) return
      setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    doc.addEventListener('pointerdown', away)
    doc.addEventListener('keydown', key)
    return () => { doc.removeEventListener('pointerdown', away); doc.removeEventListener('keydown', key) }
  }, [open])
  if (node.state !== 'live') return null
  // a typed number is brought into 1..the engine's limit; an empty or fractional one stays as typed and sends nothing
  const bring = (text: string) => /^\d+$/.test(text.trim()) ? String(Math.min(Math.max(Number(text.trim()), 1), MAX_WATCH_COUNT)) : text
  const shown = typed === null ? String(current ?? 1) : bring(typed)
  const count = /^\d+$/.test(shown) ? Number(shown) : null
  const opts = registerOptions({ live: true, listener, watch: current, count })
  const toggle = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    const win = triggerRef.current?.ownerDocument.defaultView ?? window
    if (r) setAt({ top: r.bottom + 4, right: Math.max(0, win.innerWidth - r.right) })
    setOpen((v) => !v)
  }
  const run = (body: Parameters<OpFn>[0], done: string) => {
    setOpen(false)
    op?.(body).then(() => toast?.([done])).catch(() => {})
  }
  const id = node.id
  const tips = {
    trigger: `register as an event listener of project ${id}, or set a listener watch on it: each arrives as normal mail in your inbox`,
    once: listener === 'continuous'
      ? `switch the continuous event listener to hear only the next event, in place: it keeps its place, and removes itself after that event`
      : `hear the next event fired on project ${id} only: it arrives as normal mail in your inbox, then the listener removes itself. It also counts toward listener watches`,
    continuous: listener === 'once'
      ? `switch the one-time event listener to hear every event, in place: it keeps its place, and stays until it is removed`
      : `hear every event fired on project ${id}: each arrives as normal mail in your inbox until the listener is removed. It also counts toward listener watches`,
    watch: `a one-time notification arrives as normal mail in your inbox when ${count ?? 'N'} event listener${count === 1 ? ' is' : 's are'} armed on project ${id} `
      + `(the user's own counts); if that many are already armed it fires at once. `
      + (current !== null ? 'Change the number and press again to update the watch in place.' : 'It is the only one a project keeps for the user.'),
    count: `how many armed event listeners on project ${id} fire the watch: 1 to ${MAX_WATCH_COUNT}`,
  }
  const doc = triggerRef.current?.ownerDocument ?? document
  return (
    <span className="register-menu">
      <button type="button" ref={triggerRef} data-action="register-menu" aria-haspopup="true" aria-expanded={open}
        disabled={!opts.any} title={tips.trigger} onClick={toggle}>Register…</button>
      {open && createPortal(
        <div className="register-panel" ref={panelRef} role="group" aria-label="Register as a listener"
          style={{ position: 'fixed', top: at.top, right: at.right }}>
          <div className="register-row">
            <button type="button" data-action="register-once" disabled={opts.once.disabled} title={tips.once}
              onClick={() => run({ op: 'user_listener_register', node: id, once: true },
                listener === 'continuous' ? `event listener of project ${id} switched to the next event only` : `registered as an event listener of project ${id} (next event only)`)}>
              {opts.once.label}</button>
          </div>
          <div className="register-row">
            <button type="button" data-action="register-continuous" disabled={opts.continuous.disabled} title={tips.continuous}
              onClick={() => run({ op: 'user_listener_register', node: id, once: false },
                listener === 'once' ? `event listener of project ${id} switched to every event` : `registered as an event listener of project ${id}`)}>
              {opts.continuous.label}</button>
          </div>
          <div className="register-row">
            <input type="number" min={1} max={MAX_WATCH_COUNT} step={1} value={shown} aria-label="Event listeners to watch for"
              title={tips.count} onChange={(e) => setTyped(bring(e.target.value))} />
            <button type="button" data-action="register-watch" disabled={opts.watch.disabled} title={tips.watch}
              onClick={() => { if (count !== null) run({ op: 'user_watch_register', node: id, count },
                current !== null ? `listener watch on project ${id} changed to ${count} event listener${count === 1 ? '' : 's'}`
                  : `registered a listener watch on project ${id} for ${count} event listener${count === 1 ? '' : 's'}`) }}>
              {opts.watch.label}</button>
          </div>
        </div>, doc.body)}
    </span>)
}
