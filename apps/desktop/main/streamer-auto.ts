// Streamer mode turns on by itself while a streaming app runs (USER 2026-11-03
// m66c298e7345c "can you detect when obs is running and automatically enable
// streamer mode"; m"discord seems to be able to do it": modelled on Discord's
// Streamer Mode auto-enable/disable; XSplit Broadcaster added by the liaison).
// Docket streamer-mode-turns-on-automatically-while-obs-i.
//
// Detection is one cheap `tasklist` image listing every five seconds (the same
// spawn the installer proof already uses; no native module, no PowerShell).
// The state machine below is pure apart from its injected list/prefs/apply, so
// every transition is tested with a faked process list.
import { execFile } from 'node:child_process'

/** Discord's own Streamer Mode list, read from its client by the liaison
 *  (docket item note, 2026-11-03 m3669936358cc): it matches the process path's
 *  last segment, case-insensitively, against these names, with no live check.
 *  `tasklist` already reports the bare image name, so equality is that match. */
export const STREAMING_APPS: readonly string[] = [
  'obs', 'obs.exe', 'obs32.exe', 'obs64.exe',
  'xsplit.gamecaster.exe', 'xsplit.core.exe', 'gamecaster.exe', 'bebo.exe',
  'streamlabs obs.exe', 'streamlabs desktop.exe', 'twitchstudio.exe',
]

/** Image names from `tasklist /NH /FO CSV`. null = unreadable: a successful
 *  listing always holds many processes, so an empty parse never means "none". */
export function parseTasklist(listing: string): Set<string> | null {
  const names = new Set<string>()
  for (const line of listing.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line)?.[1]
    if (name) names.add(name.toLowerCase())
  }
  return names.size ? names : null
}
export const streamingAppRunning = (names: ReadonlySet<string>) => STREAMING_APPS.some(n => names.has(n))

/** Non-Windows: `ps -A -o comm=` lines, reduced to their last path segment. */
export function parsePs(listing: string): Set<string> | null {
  const names = new Set<string>()
  for (const line of listing.split(/\r?\n/)) { const name = line.trim().split(/[\\/]/).pop(); if (name) names.add(name.toLowerCase()) }
  return names.size ? names : null
}
export function listProcessNames(): Promise<Set<string> | null> {
  const win = process.platform === 'win32'
  return new Promise(resolve => {
    execFile(win ? 'tasklist' : 'ps', win ? ['/NH', '/FO', 'CSV'] : ['-A', '-o', 'comm='], { windowsHide: true, timeout: 4000, maxBuffer: 8 << 20 },
      (error, stdout) => resolve(error ? null : (win ? parseTasklist : parsePs)(String(stdout))))
  })
}

export interface AutoPrefs { streamerMode?: boolean; streamerAuto?: boolean; streamerAutoActive?: boolean }
export interface StreamerAutoDeps {
  list: () => Promise<ReadonlySet<string> | null>
  prefs: () => AutoPrefs
  /** Writes through the one preference path (broadcast, native masking). */
  apply: (patch: { streamerMode?: boolean; streamerAutoActive?: boolean }) => void
}

/** Consecutive samples without a streaming app before it counts as exited: a
 *  restart of OBS must not flap the mode off and on. */
const EXIT_SAMPLES = 2

export class StreamerAuto {
  private seen = false
  private running = false
  private absent = 0
  private suppressed = false
  private lastMode: boolean | undefined
  private busy = false
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(private deps: StreamerAutoDeps) {}

  /** One transition for one observation. */
  step(running: boolean) {
    const p = this.deps.prefs()
    let mode = p.streamerMode === true
    const active = p.streamerAutoActive === true
    const enabled = p.streamerAuto !== false // default ON
    const write = (patch: { streamerMode?: boolean; streamerAutoActive?: boolean }) => {
      this.deps.apply(patch)
      if (patch.streamerMode !== undefined) mode = patch.streamerMode
    }
    if (!this.seen) {
      this.seen = true
      // Startup: the persisted auto flag outlives the app. If the streaming app
      // is gone, release what the automation turned on.
      if (!running && active) write({ ...(mode ? { streamerMode: false } : {}), streamerAutoActive: false })
    }
    if (running) {
      this.absent = 0
      if (!this.running) { this.running = true; this.suppressed = false } // a (re)start clears a manual off
      else if (this.lastMode === true && !mode) {
        // Turned off by hand while the app runs: stays off until it exits and starts again.
        this.suppressed = true
        if (active) write({ streamerAutoActive: false })
      }
      if (!this.suppressed && enabled && !mode) write({ streamerMode: true, streamerAutoActive: true })
    } else if (this.running) {
      if (++this.absent >= EXIT_SAMPLES) {
        this.running = false; this.absent = 0; this.suppressed = false
        const flag = this.deps.prefs().streamerAutoActive === true
        if (flag) write({ ...(mode ? { streamerMode: false } : {}), streamerAutoActive: false })
      }
    }
    this.lastMode = mode
  }

  async sample() {
    if (this.busy) return
    this.busy = true
    try {
      const names = await this.deps.list()
      if (names) this.step(streamingAppRunning(names)) // unreadable: no verdict
    } catch { /* a failed look changes nothing */ } finally { this.busy = false }
  }
  /** Before any window exists: the first verdict is in place before anything paints. */
  startup() { return this.sample() }
  start(everyMs = 5000) {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sample() }, everyMs)
    this.timer.unref?.()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}
