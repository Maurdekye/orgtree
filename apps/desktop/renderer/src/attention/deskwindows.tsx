// attention/deskwindows.tsx — ATTENTION DESKS IN WINDOWS OF THEIR OWN (4.6.1).
//
// USER 2026-11-15 10:34:16Z mbf1f1ca2cfe9, @item:orgtree/popped-out-desk-can-become-its-own-attention-des: "allow any
// popped out desk to be turned into a separate \"attention desk\", where it gains the agents list popout that can
// change the active agent viewed in it. it should look and function identically to the normal attention desk. this
// should allow the user to have multiple simultaneous attention desks open if they wish."
//
// A desk window's "Make attention desk" (desk header) turns it into one of these: a native window drawing the
// Attention view's own agent desk (`AgentDeskPanel`: the agents drawer and the desk), so it looks and works the same,
// with a SELECTION OF ITS OWN. Switching its agent never moves the main Attention desk (`layout.agent`). Any number
// can be open, several on one agent too: every place shows the live desk (deskhosts.tsx). The convert control is
// ONE header icon beside the pin and pop-out buttons, a toggle (USER 2026-11-15 m4492aff12953 "make it an icon next
// to the pin / pop buttons"): "Make attention desk" on a plain desk window, pressed "Make plain desk" here.
//
// Remembered per organization with its agent (localStorage `orgtree-attention-desk-windows`), and its window
// geometry is the ordinary saved row of its `MovableSurface`: at the next start a window that was open comes back
// as an attention desk on the same agent (design-461 question 6, provisional), or the default agent if that one is
// gone. The user approved design-461 questions 5-7 as recommended (m4492aff12953).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MovableSurface, useSurface } from '../popout'
import { restoredWindows, useRestoreWindows, windowExitStarted } from '../windowlayout'
import { AttentionWindowContext, useDeskActionsNow } from '../canvas/deskhosts'
import { USER } from '../canvas/shared'
import { AgentDeskPanel } from './AgentDeskPanel'
import type { AgentDeskPanelProps } from './AgentDeskPanel'

/** An agent link inside an attention-desk window switches THAT window's agent (design-461 question 5, approved
 *  m4492aff12953); false sends it to the canvas, as the canvas's own desks do. */
export const WINDOW_LINKS_STAY_IN_WINDOW = true

export interface AttentionDeskWindow { id: string; agent: string | null }
type Box = { x: number; y: number; w: number; h: number }

const KEY = 'orgtree-attention-desk-windows'
const NONE: AttentionDeskWindow[] = []
let cache: Record<string, AttentionDeskWindow[]> | null = null
const listeners = new Set<() => void>()
/** windows the user opened in this session, with the frame they first open over; one the last session left open
 *  is not here, and reopens from its saved row instead */
const fresh = new Map<string, Box | null>()

function stored(): Record<string, AttentionDeskWindow[]> {
  if (cache) return cache
  let raw: unknown = null
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { raw = null }
  const out: Record<string, AttentionDeskWindow[]> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [org, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const rows = list.filter((w): w is AttentionDeskWindow => !!w && typeof w === 'object'
        && typeof (w as AttentionDeskWindow).id === 'string'
        && ((w as AttentionDeskWindow).agent === null || typeof (w as AttentionDeskWindow).agent === 'string'))
      if (rows.length) out[org] = rows
    }
  }
  return cache = out
}
function write(org: string, list: AttentionDeskWindow[]) {
  const next = { ...stored() }
  if (list.length) next[org] = list
  else delete next[org]
  cache = next
  try {
    if (Object.keys(next).length) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch { /* best effort, like every layout row */ }
  for (const fn of [...listeners]) fn()
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** this organization's attention-desk windows */
export function attentionDeskWindows(slug: string): AttentionDeskWindow[] { return stored()[slug] ?? NONE }
let seq = 0
/** open a new attention-desk window on `agent`, first over `box` (main-window client coordinates) */
export function openAttentionDeskWindow(slug: string, agent: string | null, box: Box | null = null): string {
  const id = `${Date.now().toString(36)}-${(++seq).toString(36)}`
  fresh.set(id, box)
  write(slug, [...attentionDeskWindows(slug), { id, agent }])
  return id
}
export function setAttentionDeskWindowAgent(slug: string, id: string, agent: string): void {
  const list = attentionDeskWindows(slug)
  if (list.some((w) => w.id === id && w.agent !== agent)) write(slug, list.map((w) => w.id === id ? { id, agent } : w))
}
export function closeAttentionDeskWindow(slug: string, id: string): void {
  fresh.delete(id)
  const list = attentionDeskWindows(slug)
  if (list.some((w) => w.id === id)) write(slug, list.filter((w) => w.id !== id))
}
/** test seam, and a `storage` event from another window */
export function forgetAttentionDeskWindows(): void { cache = null; fresh.clear() }

/** where a native window is, in the main window's client coordinates: the frame a window opened from it starts at */
export function windowFrame(w: Window | null | undefined): Box | null {
  if (!w) return null
  return { x: w.screenX - window.screenX, y: w.screenY - window.screenY,
    w: w.innerWidth || w.outerWidth, h: w.innerHeight || w.outerHeight }
}

type PanelProps = Omit<AgentDeskPanelProps, 'eligible' | 'claim' | 'attentionDraft' | 'selection'>

/** every attention-desk window of this organization (rendered inside its `DeskHosts`, beside the canvas) */
export function AttentionDeskWindows(props: PanelProps) {
  const list = useSyncExternalStore(subscribe, () => attentionDeskWindows(props.slug))
  const restoreAllowed = useRestoreWindows()
  return <>{list.map((w) => <AttentionDeskWindowView key={w.id} win={w} restoreAllowed={restoreAllowed} panel={props} />)}</>
}

function AttentionDeskWindowView({ win, restoreAllowed, panel }: { win: AttentionDeskWindow; restoreAllowed: boolean; panel: PanelProps }) {
  const kind = `attention-desk-window:${win.id}`
  // one the last session left open comes back from its saved row; one with nothing to come back as is forgotten
  useEffect(() => {
    if (fresh.has(win.id) || !restoreAllowed) return
    if (!restoredWindows(panel.slug).some((r) => r.kind === kind)) closeAttentionDeskWindow(panel.slug, win.id)
  }, [win.id, kind, restoreAllowed, panel.slug])
  const [dock, setDock] = useState<HTMLElement | null>(null)
  return <div hidden ref={setDock}>
    {dock && <MovableSurface kind={kind} title="Agent desk" org={panel.slug} anchor={dock}
      sourceBox={() => fresh.get(win.id) ?? null} exactSourceBox
      // its window's Close ends it, saving where it was; at the app's exit it stays open for the next start
      onDismiss={() => closeAttentionDeskWindow(panel.slug, win.id)}
      onDetached={(v) => { if (!v && !windowExitStarted()) closeAttentionDeskWindow(panel.slug, win.id) }}>
      <AttentionDeskWindowBody win={win} panel={panel} />
    </MovableSurface>}
  </div>
}

function AttentionDeskWindowBody({ win, panel }: { win: AttentionDeskWindow; panel: PanelProps }) {
  const surface = useSurface()
  const opened = useRef(false)
  useLayoutEffect(() => {
    if (opened.current || !fresh.has(win.id) || !surface || surface.detached) return
    opened.current = true
    surface.open()
  }, [win.id, surface])
  useEffect(() => {
    if (!surface?.error) return
    panel.toast([surface.error])
    closeAttentionDeskWindow(panel.slug, win.id)
  }, [surface?.error, panel, win.id])
  const select = useCallback((id: string) => setAttentionDeskWindowAgent(panel.slug, win.id, id), [panel.slug, win.id])
  const selection = { agent: win.agent, select }
  const deskNow = useDeskActionsNow(panel.slug)
  // back to a plain desk window on the agent it shows, over the frame it is in now
  const makePlain = () => {
    const node = win.agent ? panel.map.get(win.agent) : undefined
    if (node && node.kind !== 'project') deskNow(node).requestPopout(windowFrame(surface?.document.defaultView))
    closeAttentionDeskWindow(panel.slug, win.id)
  }
  // an agent of this organization switches this window; anything else (the eye) goes where the canvas sends it
  const jump = panel.deskExtras?.onJump
  const onJump = (id: string) => { if (id !== USER && panel.map.has(id)) select(id); else jump?.(id) }
  const deskExtras = WINDOW_LINKS_STAY_IN_WINDOW ? { ...panel.deskExtras, onJump } : panel.deskExtras
  return <AttentionWindowContext.Provider value={{ makePlain }}>
    <AgentDeskPanel {...panel} deskExtras={deskExtras} selection={selection} />
  </AttentionWindowContext.Provider>
}
