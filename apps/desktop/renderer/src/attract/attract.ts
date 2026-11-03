/* attract/attract.ts — ATTRACT MODE: the org operates its own UI.

   USER 2026-11-02 08:51:23Z m79cb0cf57f61: "the org operates it's ui
   autonomously, randomly cycling between focusing agents with new activity in
   their transcripts, focusing the whole org, focusing new unread user mail,
   focusing unread and edited presentations and scrolling through them, and
   focusing updated tickets. it does not focus any agent desks that are already
   pinned or open elsewhere, and it does not focus anything but fitting the
   whole org if there is nothing new to show at any agent or in any panel."
   Answers 09:18:31Z mc8e118c58de9: an App menu toggle that activates after
   more than five minutes without input; dwell about 8-15 s, longer while
   scrolling a presentation; showing something marks it read; no forced
   streamer mode and no hint.

   GAP-FILLS (@coordinator-opus m082646bad468, for the user to confirm; each is
   one named rule here so it stays easy to change):
   - "NEW" = changed after this window's last user input (the moment the user
     stopped watching) and not yet shown in this run. An agent counts while it
     is mid-turn or once its last turn moved; a ticket once its updated_at
     moved. Agents and tickets get a window-memory "shown" mark only; mail and
     presentations get their real read marks, through the paths that already
     set them.
   - Every target reuses an existing route (go-to-agent, the inbox jump, the
     reader, the docket jump, Fit). A panel attract opened closes when it moves
     on; canvas interaction (and only that, USER 2026-11-03 m6b0b27e6288f) stops the
     cycle and leaves the screen as it is.
   - One app-wide toggle (pref.ts); each organization window runs its own idle
     timer and cycle.

   This file is the pure part (what counts, which one next, how long) plus the
   idle tracker and the cycle hook; the canvas supplies the data and routes. */
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_ATTRACT_IDLE_SECONDS, useAttractIdleSeconds } from './pref'

/** "activates if no input for >5 minutes": the default; the user's setting
 *  (App settings > Display, pref.ts) replaces it and may be 0 */
export const ATTRACT_IDLE_MS = DEFAULT_ATTRACT_IDLE_SECONDS * 1000
/** setTimeout holds at most 2^31-1 ms; a longer delay re-checks after this */
const TIMER_MAX_MS = 2_147_483_647
/** "2 good": about 8-15 s on each target */
export const DWELL_MIN_MS = 8_000
export const DWELL_MAX_MS = 15_000

export type AttractTarget =
  | { kind: 'org' }
  | { kind: 'agent'; id: string; mark: string }
  | { kind: 'mail'; id: string; urgent?: boolean }
  | { kind: 'doc'; id: string; node: string | null }
  | { kind: 'ticket'; slug: string; mark: string }

/** The identity "shown this run" is kept by. An agent's and a ticket's carry
 *  the activity they were shown for, so a LATER turn or update is new again. */
export const targetKey = (t: AttractTarget): string => {
  switch (t.kind) {
    case 'org': return 'org'
    case 'agent': return `agent:${t.id}:${t.mark}`
    case 'mail': return `mail:${t.id}`
    case 'doc': return `doc:${t.id}`
    case 'ticket': return `ticket:${t.slug}:${t.mark}`
  }
}

export interface AttractAgent {
  id: string
  /** mid-turn now: its transcript is growing */
  busy: boolean
  /** the latest activity time it carries (turn start or last status), ISO */
  activityAt: string | null
  /** its desk is pinned to the screen, or open in another window */
  deskTaken: boolean
}
export interface AttractInput {
  /** ms epoch: the window's last user input — "new" means after this */
  since: number
  agents: AttractAgent[]
  /** unread user mail, oldest first */
  mail: { id: string; urgent?: boolean }[]
  /** presentations whose docviewed state is new or updated */
  docs: { id: string; node: string | null }[]
  tickets: { slug: string; updatedAt: string | null }[]
}

const after = (iso: string | null, since: number): boolean => {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t > since
}

/** Everything new there is to show, minus what this run already showed. */
export function attractCandidates(input: AttractInput, shown: ReadonlySet<string>): AttractTarget[] {
  const out: AttractTarget[] = []
  const add = (t: AttractTarget) => { if (!shown.has(targetKey(t))) out.push(t) }
  for (const a of input.agents) {
    // "it does not focus any agent desks that are already pinned or open elsewhere"
    if (a.deskTaken) continue
    if (a.busy || after(a.activityAt, input.since)) add({ kind: 'agent', id: a.id, mark: a.activityAt ?? 'busy' })
  }
  // one mail at a time, the oldest: showing it reads it, so the next is next
  const mail = input.mail.find(m => !shown.has(`mail:${m.id}`))
  if (mail) out.push({ kind: 'mail', id: mail.id, ...(mail.urgent ? { urgent: true } : {}) })
  for (const d of input.docs) add({ kind: 'doc', id: d.id, node: d.node })
  for (const t of input.tickets)
    if (after(t.updatedAt, input.since)) add({ kind: 'ticket', slug: t.slug, mark: t.updatedAt! })
  return out
}

/** The next target. Nothing new: fit the whole org and nothing else. With
 *  something new, the whole org is one more choice among them, picked at
 *  random like the rest, never the same target twice in a row. */
export function pickAttract(candidates: AttractTarget[], rng: () => number,
  last: AttractTarget | null): AttractTarget {
  if (!candidates.length) return { kind: 'org' }
  let pool: AttractTarget[] = [...candidates, { kind: 'org' }]
  if (last) {
    const lastKey = targetKey(last)
    const rest = pool.filter(t => targetKey(t) !== lastKey)
    if (rest.length) pool = rest
  }
  const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length))
  return pool[i]!
}

/** 8-15 s, uniformly; a presentation stays at least as long as its scroll. */
export const attractDwell = (rng: () => number, atLeast = 0): number =>
  Math.max(atLeast, DWELL_MIN_MS + Math.floor(rng() * (DWELL_MAX_MS - DWELL_MIN_MS + 1)))

// ---------------------------------------------------------------- input
/* Two questions about an input event.
   1. Is it INPUT? Then it restarts the five quiet minutes before a run may
      start ("never while the user is working in a panel"). Any of these is
      input; attract mode's own camera moves, panel opens and scrolls are none
      of them. A pointermove counts only when the pointer really moved:
      Chromium sends a mousemove at an unmoved cursor when the content under it
      changes, which every glide does.
   2. Is it CANVAS INTERACTION? Only that stops a run (USER 2026-11-03
      m6b0b27e6288f "only interacting with the canvas should interrupt attract
      mode"): a press (pointerdown or touchstart, which starts every click and
      drag), a wheel (scroll or zoom), or a key while focus is on the canvas.
      Moving the mouse never does. Input in a desk, panel, menu, settings or
      field, or in another window, never does. */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
const RELEASE_EVENTS = ['pointerup', 'pointercancel'] as const
/** a canvas press is down: a drag or pan in progress, so the interaction has not ended */
let held = false
/** what sits inside the canvas viewport but is not the canvas: the same list
 *  OrgCanvas's wheel handler and the .viewport text-selection rule carve out,
 *  plus every text field */
const NOT_CANVAS = '.overlay, .desk-over, .tray, .tray-wrap, .pinwin, .custom-app-window, .eff-pop, '
  + 'input, textarea, select, [contenteditable]'
let lastInput = Date.now()
let lastPointer: { x: number; y: number } | null = null
let installed = false
const inputSubs = new Set<(canvas: boolean) => void>()

/** An event aimed at the org canvas itself (its background, nodes and
 *  controls), not at a panel that merely sits inside it. */
export function isCanvasEvent(e: Event): boolean {
  const t = e.target as Element | null
  if (e.type === 'pointermove' || !t || typeof t.closest !== 'function') return false
  return !!t.closest('.viewport') && !t.closest(NOT_CANVAS)
}

function onInput(e: Event): void {
  if (e.type === 'pointermove') {
    const p = e as PointerEvent
    // a move with no button down means the press ended without a pointerup
    // reaching us (released outside the window, say): never stay held
    if (held && p.buttons === 0) onRelease()
    const at = { x: p.screenX, y: p.screenY }
    const moved = !lastPointer || lastPointer.x !== at.x || lastPointer.y !== at.y
    lastPointer = at
    if (!moved) return
  }
  lastInput = Date.now()
  const canvas = isCanvasEvent(e)
  if (canvas && (e.type === 'pointerdown' || e.type === 'touchstart')) held = true
  for (const fn of [...inputSubs]) fn(canvas)
}
/** The press ended: the interaction is over, so the quiet time counts from now.
 *  (Only a press the canvas took; a release elsewhere is not input.) */
function onRelease(): void {
  if (!held) return
  held = false
  lastInput = Date.now()
  for (const fn of [...inputSubs]) fn(false)
}

/** Follow user input in this window (`canvas`: it was canvas interaction);
 *  also starts the window's tracker. */
export function watchInput(fn: (canvas: boolean) => void): () => void {
  if (!installed && typeof window !== 'undefined') {
    installed = true
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true })
    for (const type of RELEASE_EVENTS) window.addEventListener(type, onRelease, { capture: true, passive: true })
    window.addEventListener('blur', onRelease)
  }
  inputSubs.add(fn)
  return () => { inputSubs.delete(fn) }
}
export const lastInputAt = (): number => lastInput

// ---------------------------------------------------------------- cycle
export interface AttractRoutes {
  /** everything new right now, for a run whose "new" starts at `since` */
  collect: (since: number) => Promise<Omit<AttractInput, 'since'>>
  /** put it on screen; resolves to the least time it needs (a scroll), in ms */
  show: (t: AttractTarget) => number | void | Promise<number | void>
  /** take down what `show` opened for it (a panel), when the cycle moves on */
  hide: (t: AttractTarget) => void
  /** canvas interaction ended the run: stop anything still moving, leave the rest on screen */
  stop?: () => void
}

/** Runs the cycle while `enabled` and the window has had no input for more
 *  than the Start-after delay (default ATTRACT_IDLE_MS; any input counts). Only canvas interaction ends the run
 *  at once, input in a panel does not; the next run starts
 *  after the next five quiet minutes, with a fresh "new" and a fresh "shown".
 *  Returns whether a run is going. */
export function useAttractCycle(enabled: boolean, routes: AttractRoutes,
  rng: () => number = Math.random, idleOverride?: number): boolean {
  // the user's "Start after" setting, read live; tests pass the delay in ms
  const storedIdle = useAttractIdleSeconds()
  const idleMs = idleOverride ?? storedIdle * 1000
  const [running, setRunning] = useState(false)
  const routesRef = useRef(routes)
  routesRef.current = routes
  const rngRef = useRef(rng)
  rngRef.current = rng

  // idle → run; input → stop
  useEffect(() => {
    if (!enabled) { setRunning(false); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      const wait = Math.min(TIMER_MAX_MS, Math.max(0, lastInputAt() + idleMs - Date.now()) + 1)
      timer = setTimeout(() => {
        // a held canvas press is an interaction still going: its release re-arms
        if (!held && Date.now() - lastInputAt() > idleMs) setRunning(true)
        else if (!held) arm()
      }, wait)
    }
    const stop = watchInput(canvas => { if (canvas) setRunning(false); arm() })
    arm()
    return () => { clearTimeout(timer); stop() }
  }, [enabled, idleMs])

  // the run itself
  useEffect(() => {
    if (!running || !enabled) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const since = lastInputAt()
    const shown = new Set<string>()
    let current: AttractTarget | null = null
    const step = async () => {
      if (!alive) return
      let input: Omit<AttractInput, 'since'>
      try { input = await routesRef.current.collect(since) }
      catch { input = { agents: [], mail: [], docs: [], tickets: [] } }
      if (!alive) return
      const next = pickAttract(attractCandidates({ ...input, since }, shown), rngRef.current, current)
      if (current) routesRef.current.hide(current)
      current = next
      shown.add(targetKey(next))
      let need = 0
      try { need = Number(await routesRef.current.show(next)) || 0 } catch { need = 0 }
      if (!alive) return
      timer = setTimeout(() => { void step() }, attractDwell(rngRef.current, need))
    }
    void step()
    return () => {
      alive = false
      clearTimeout(timer)
      routesRef.current.stop?.()
    }
  }, [running, enabled])

  return running && enabled
}
