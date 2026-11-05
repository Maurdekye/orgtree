// UI stall tooling (item ui-freezes-intermittently-for-several-seconds-at; spec ui-stall-tooling-spec rev 1.2).
// Shared by the renderer (rate cap before sending) and main (rate cap and the allowlist before writing).
// Pure: no DOM, no Node, no Electron.

/** the lines per minute one process may write or send; the overflow is counted in `dropped` */
export const STALL_RATE_PER_MIN = 30
/** a stall is a long animation frame (or a main-loop tick) of at least this many ms; shorter ones only count */
export const STALL_MIN_MS = 500

export const STALL_SRCS = ['renderer-loaf', 'renderer-ping', 'renderer-unresponsive', 'main-lag', 'sync-ipc', 'process-gone'] as const
export type StallSrc = typeof STALL_SRCS[number]

export const STALL_SCREENS = ['canvas', 'desk', 'homepage', 'create', 'settings', 'other'] as const
export const STALL_PANELS = ['mail', 'docket', 'files', 'apps', 'usage', 'hubchat', 'transcript', 'none'] as const
export type StallScreen = typeof STALL_SCREENS[number]
export type StallPanel = typeof STALL_PANELS[number]
/** What the app tells the stall recorder about the view: fixed enums only, never a name, id or title. */
export interface StallContext { screen: StallScreen; panel: StallPanel; popout: StallPanel | null }

/** Counts the app registers getters for (null when nothing registered one). */
export interface StallCountGetters { agents?: () => number; projects?: () => number; watchdogs?: () => number; open_panels?: () => number }

/** A sliding one-minute cap. `take` says whether this line may go, and how many were dropped since the last allowed one. */
export class RateCap {
  private times: number[] = []
  private lost = 0
  constructor(private readonly limit = STALL_RATE_PER_MIN, private readonly windowMs = 60_000) {}
  take(now: number): { ok: boolean; dropped: number } {
    this.times = this.times.filter(t => now - t < this.windowMs)
    if (this.times.length >= this.limit) { this.lost++; return { ok: false, dropped: 0 } }
    this.times.push(now)
    const dropped = this.lost
    this.lost = 0
    return { ok: true, dropped }
  }
}
