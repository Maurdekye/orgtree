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
import { attractTrace, setAttractTraceLive } from './trace'

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
  | AttentionTarget

/** Something that needs the user (USER 2026-11-03 m0962694602bd "if anything needing attention appears, it is
 *  immediately focused with zero delay"), from the sources the Attention view already lists (attention/feed.ts):
 *  an open question, a docket item with a raised flag, urgent mail, an @user mention. Never picked at random:
 *  it arrives (routes.watch) and is shown at once. `key` is the feed row's key, `id` the slug, mail id, ask id or
 *  mention id, `agent` the node it is about. */
export interface AttentionTarget {
  kind: 'attention'
  key: string
  what: 'ticket' | 'mail' | 'question' | 'mention'
  agent: string | null
  id: string
  urgent?: boolean
}

/** The identity "shown this run" is kept by. An agent's and a ticket's carry
 *  the activity they were shown for, so a LATER turn or update is new again. */
export const targetKey = (t: AttractTarget): string => {
  switch (t.kind) {
    case 'org': return 'org'
    case 'agent': return `agent:${t.id}:${t.mark}`
    case 'mail': return `mail:${t.id}`
    case 'doc': return `doc:${t.id}`
    case 'ticket': return `ticket:${t.slug}:${t.mark}`
    case 'attention': return `attn:${t.key}`
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

/** USER 2026-11-03 m0dc876241ee7 "attract mode should still return to fitting the org at some regular, above
 *  average portion of the time, even if there's new activity", REPLACED m6802501d1f0c (13:08:49Z): "one in three on
 *  average, varies depending on activity. if there's only a single agent working, then it would go back and forth between
 *  that agent and the org. 2-3 agents and a new mail, every third change. 10+ agents, 5 changed tickets, 4 updated
 *  presentations, and 30 new mails, and the org only gets fit every 10-15th transition".
 *  The targets shown between two fit-the-whole-org steps: round(1 + N/4 x jitter), jitter 0.8-1.2 drawn once per cycle,
 *  at least 1, at most FIT_GAP_CAP, N = the new targets waiting at that moment (recomputed every step). N=1 gives 1
 *  (alternate), N=4 gives 2 (every third), N=49 gives 11-15. */
export const FIT_GAP_CAP = 15
export const fitGap = (n: number, jitter: number): number =>
  Math.min(FIT_GAP_CAP, Math.max(1, Math.round(1 + (n / 4) * jitter)))

/** The next target. Nothing new: fit the whole org and nothing else. With something new, the whole org comes after
 *  `fitGap` targets (`run` of them so far; `jitter` is this cycle's draw), never twice in a row, and the other steps
 *  pick at random among the new things, never the same one twice in a row (the only new thing just shown: the org). */
export const TICKET_EVERY = 4
/** USER 2026-11-05 m68460e1a8f36 "like 70% of the screen time is the docket, that's way too often": over any rolling
 *  5 minutes the docket gets at most 15% of the screen time (a visit is only started while the time used plus the longest dwell
 *  still fits), and an attention ticket gets at most ONE docket visit per window (its exemption from the every-4th-step rule is
 *  no exemption from the share). A refused attention ticket is dropped (the Attention view still lists it) and traced as a skip. */
export const DOCKET_SHARE = 0.15
export const DOCKET_WINDOW_MS = 300_000
export function pickAttract(candidates: AttractTarget[], rng: () => number,
  last: AttractTarget | null, run = 0, jitter = 1, sinceTicket = TICKET_EVERY, docketOk = true): AttractTarget {
  if (!candidates.length) return { kind: 'org' }
  if (last?.kind !== 'org' && run >= fitGap(candidates.length, jitter)) return { kind: 'org' }
  const lastKey = last ? targetKey(last) : null
  // USER 2026-11-05 m207f9caba2e3 (less docket, more canvas and desks): a ticket at most every fourth step
  const pool = candidates.filter(t => targetKey(t) !== lastKey && (t.kind !== 'ticket' || (docketOk && sinceTicket >= TICKET_EVERY - 1)))
  if (!pool.length) return { kind: 'org' }
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
const inputSubs = new Set<(canvas: boolean, panel: boolean) => void>()

/** the panels attract mode can have open (the shell's inbox and docket, readers): a press,
 *  wheel or key in one hands it to the user. The agents tray is not one. */
const PANEL_AREA = '.overlay, .pinwin, .custom-app-window'
/** an event aimed at a panel attract may have opened */
export function isPanelEvent(e: Event): boolean {
  const t = e.target as Element | null
  if (e.type === 'pointermove' || !t || typeof t.closest !== 'function') return false
  return !!t.closest(PANEL_AREA)
}

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
  const panel = !canvas && isPanelEvent(e)
  for (const fn of [...inputSubs]) fn(canvas, panel)
}
/** The press ended: the interaction is over, so the quiet time counts from now.
 *  (Only a press the canvas took; a release elsewhere is not input.) */
function onRelease(): void {
  if (!held) return
  held = false
  lastInput = Date.now()
  for (const fn of [...inputSubs]) fn(false, false)
}

/** Follow user input in this window (`canvas`: it was canvas interaction);
 *  also starts the window's tracker. */
export function watchInput(fn: (canvas: boolean, panel: boolean) => void): () => void {
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
  /** Listen for things needing attention for as long as the run lasts; `arrive` takes the NEW ones, in arrival order.
   *  What was already waiting when the listener started is not an arrival. Returns the stop function. */
  watch?: (arrive: (items: AttentionTarget[]) => void) => () => void
  /** look for arrivals now (the canvas calls it whenever the tree changes); a no-op when nobody watches */
  poll?: () => Promise<void>
  /** the user touched a panel attract opened (a press, wheel or key in it): it is theirs now,
   *  and the run goes on without closing it */
  release?: () => void
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
  /** why the run ended, for the trace: set by the canvas-interaction stop, otherwise disabled/unmounted */
  const stopWhy = useRef<'canvas' | 'other'>('other')
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
    const stop = watchInput((canvas, panel) => {
      if (canvas) { stopWhy.current = 'canvas'; setRunning(false) }
      else if (panel) routesRef.current.release?.()
      arm()
    })
    arm()
    return () => { clearTimeout(timer); stop() }
  }, [enabled, idleMs])

  // the run itself
  useEffect(() => {
    if (!running || !enabled) return
    let alive = true
    setAttractTraceLive(true)   // the trace exists only while a run is going
    let timer: ReturnType<typeof setTimeout> | undefined
    const since = lastInputAt()
    const shown = new Set<string>()
    let current: AttractTarget | null = null
    /** targets since the last fit-the-whole-org step, and this cycle's gap jitter (fitGap) */
    let run = 0
    /** steps since a ticket was last shown (the docket comes at most every TICKET_EVERY-th step) */
    let sinceTicket = TICKET_EVERY
    /** the docket visits of this run (start, end or null while open), for the rolling 5-minute share */
    const docketVisits: { at: number; end: number | null; attn: boolean }[] = []
    const isAttnTicket = (t: AttractTarget) => t.kind === 'attention' && t.what === 'ticket'
    const docketMs = (now: number) => docketVisits.reduce((n, v) => n + Math.max(0, Math.min(v.end ?? now, now) - Math.max(v.at, now - DOCKET_WINDOW_MS)), 0)
    const docketOk = (now: number) => docketMs(now) + DWELL_MAX_MS <= DOCKET_SHARE * DOCKET_WINDOW_MS
    const attnTicketOk = (now: number) => docketOk(now) && !docketVisits.some(v => v.attn && v.at > now - DOCKET_WINDOW_MS)
    const closeVisit = () => { const v = docketVisits.at(-1); if (v && v.end === null) v.end = Date.now() }
    let jitter = 0.8 + 0.4 * rngRef.current()
    /** things needing attention that have arrived and are waiting their step, in arrival order */
    const queue: AttentionTarget[] = []
    let busy = false
    const step = async () => {
      if (!alive) return
      busy = true
      let next: AttractTarget
      for (let i = 0; i < queue.length;) {
        if (isAttnTicket(queue[i]!) && !attnTicketOk(Date.now())) { queue.splice(i, 1); attractTrace({ ev: 'skip', kind: 'attention', why: 'share' }) } else i++
      }
      if (queue.length) next = queue.shift()!    // attention first, whatever the cadence says
      else {
        let input: Omit<AttractInput, 'since'>
        try { input = await routesRef.current.collect(since) }
        catch { input = { agents: [], mail: [], docs: [], tickets: [] } }
        if (!alive) return
        next = pickAttract(attractCandidates({ ...input, since }, shown), rngRef.current, current, run, jitter, sinceTicket, docketOk(Date.now()))
      }
      sinceTicket = next.kind === 'ticket' || (next.kind === 'attention' && next.what === 'ticket') ? 0 : sinceTicket + 1
      if (next.kind === 'org') { run = 0; jitter = 0.8 + 0.4 * rngRef.current() } else run++
      closeVisit()
      if (current) routesRef.current.hide(current)
      current = next
      shown.add(targetKey(next))
      if (next.kind === 'ticket' || isAttnTicket(next)) docketVisits.push({ at: Date.now(), end: null, attn: next.kind === 'attention' })
      let need = 0
      try { need = Number(await routesRef.current.show(next)) || 0 } catch { need = 0 }
      busy = false
      if (!alive) return
      const dwell = attractDwell(rngRef.current, need)
      attractTrace({ ev: 'step', kind: next.kind, need_ms: need, dwell_ms: dwell, n: run, docket_pct: Math.round(100 * docketMs(Date.now()) / DOCKET_WINDOW_MS) })
      // an arrival that came in while this step was starting does not wait out a dwell
      if (queue.length && next.kind !== 'attention') { void step(); return }
      timer = setTimeout(() => { void step() }, dwell)
    }
    // anything needing attention: queued in arrival order; it interrupts an ordinary dwell at once, and waits behind
    // an attention item that is on screen (which gets its dwell)
    const stopWatching = routesRef.current.watch?.((items) => {
      if (!alive || !items.length) return
      queue.push(...items)
      if (!busy && current?.kind !== 'attention') { clearTimeout(timer); void step() }
    })
    void step()
    return () => {
      alive = false
      clearTimeout(timer)
      stopWatching?.()
      closeVisit()
      routesRef.current.stop?.()
      attractTrace({ ev: 'stop', why: stopWhy.current })
      stopWhy.current = 'other'
      setAttractTraceLive(false)
    }
  }, [running, enabled])

  return running && enabled
}
