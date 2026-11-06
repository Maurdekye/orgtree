/* attract/trace.ts - a trace of what attract mode does, so "it got stuck on the docket" is measurable
   (item attract-mode-gets-stuck-on-the-docket-and-doesn-t, coordinator go 2026-11-05 13:43Z). One record per step, per panel
   open/close, per hand-over and per stop, sent through the stall tooling's bridge (window.orgtreeDesktop.diagStall) and
   written by main to diagnostics/ui-stalls.jsonl with src `attract` (main/stall-log.ts allowlists the fields).
   THE USER STREAMS: a record carries kinds, enums and timings only - never an id, title, name or any text. */

export interface AttractTraceRecord {
  /** what happened: a cycle step, a panel opened/closed by attract, a panel handed to the user, the run ended */
  ev: 'step' | 'panel' | 'release' | 'stop' | 'skip' | 'touch' | 'adopt'
  /** step: the target kind (org, agent, mail, doc, ticket, attention) */
  kind?: string
  /** step: the least time the step needs (a scroll), and the dwell actually chosen, in ms; n = targets since the last fit-the-org */
  need_ms?: number
  dwell_ms?: number
  n?: number
  /** step: the docket's share of the last 5 minutes of this run, in percent (the share cap is 15) */
  docket_pct?: number
  /** panel: open or close, which shell panel, and whether attract owned it (false = the user's, never closed by attract) */
  action?: 'open' | 'close'
  panel?: 'inbox' | 'docket'
  owned?: boolean
  /** stop: canvas interaction, or anything else (disabled, unmount) */
  why?: 'canvas' | 'share' | 'docket' | 'takeover_stop' | 'other'
  /** release / touch: what the user did in a panel (or 'stop': the run ended and the panels became theirs); touch: false = a script-made event, ignored */
  via?: 'pointerdown' | 'wheel' | 'keydown' | 'touchstart' | 'stop'
  trusted?: boolean
}

type Sink = (record: Record<string, unknown>) => void

const bridgeSink: Sink = (record) => {
  try {
    const b = (typeof window === 'undefined' ? undefined : (window as unknown as { orgtreeDesktop?: { diagStall?: (r: unknown) => void } }).orgtreeDesktop)
    b?.diagStall?.({ src: 'attract', ...record })
  } catch { /* diagnostics only */ }
}
let sink: Sink = bridgeSink
/** true only while a run is going (the cycle sets it): outside a run nothing is traced (coordinator ruling 2026-11-05) */
let live = false
export function setAttractTraceLive(on: boolean): void { live = on }

/** tests capture the records; null restores the bridge */
export function setAttractTraceSink(next: Sink | null): void { sink = next ?? bridgeSink }

export function attractTrace(record: AttractTraceRecord): void {
  if (!live) return
  try { sink({ ...record }) } catch { /* diagnostics only */ }
}
