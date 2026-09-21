// window-load-recovery.ts — what happens when the MAIN WINDOW'S DOCUMENT fails
// to load, and how the window ever comes back on its own.
//
// ⚠ THE WINDOW'S DOCUMENT IS SERVED BY THE ENGINE. `index.ts` does
// `main.loadURL(engine.origin + '/')`, and the engine mounts the built UI with
// StaticFiles. The interface is not a local file — it is a page fetched over
// HTTP from the Python engine. So the engine being down is not merely "the data
// is stale": it is "there is nothing to render, and nothing to re-render from".
//
// ⚠ THE FAILURE THIS FILE EXISTS FOR, measured on the reporting machine on
// 2026-09-18 (times UTC, from update-log.json and the Windows Application log):
//
//   20:22:34  Windows announces virtual-memory exhaustion.
//   20:22:47.843  renderer-gone reason=oom — the render process is OOM-killed.
//   20:22:47.845  renderer-recovered attempt=1/3 — 2 ms later the desktop calls
//                 webContents.reload(), which is the correct response.
//   20:22:49.202  the ENGINE dies (fastfail inside pydantic_core) — 1.4 s into
//                 that reload, so the reload had no server to answer it.
//   20:25:33      the user quit and relaunched. There was no other way out.
//
// The reload failed, and A FAILED LOAD WAS TERMINAL: nothing observed
// `did-fail-load`, nothing retried, and nothing re-navigated the window when a
// healthy engine was listening again. The window stayed white until the
// application was killed — so one transient engine fault cost the whole app.
//
// ⚠ THE CONTROL IS IN THE SAME LOG, AND IT IS WHY THIS IS THE RIGHT FIX. At
// 18:43:13 the same day, the same OOM kill of the same renderer recovered
// perfectly (`renderer-recovered attempt=1/3`) and the user never noticed —
// because the engine was alive and the reload landed. The renderer dying is
// survivable and already handled. What is not survivable is the reload finding
// nothing there. That is the gap this closes, and nothing else here changes.
//
// Everything below records first and acts second, and the decisions are pure
// functions so "does a superseded navigation count as a failure?" is a test
// that needs no window, no engine and no clock.

/** How the log names these events, alongside the `renderer-*` stages that
 *  describe a PROCESS dying. These describe a NAVIGATION failing, which is a
 *  different thing: the render process is alive and healthy throughout. */
export type WindowLoadStage =
  | 'window-load-failed'     /* the window's document could not be loaded */
  | 'window-load-retry'      /* ...and loading it is being tried again */
  | 'window-load-recovered'  /* ...and it loaded; the interface is back */
  | 'window-load-stranded'   /* ...and the engine moved; a restart is needed */

/** Electron's `did-fail-load` payload, structurally. Declared here rather than
 *  imported so this module — and its tests — need no Electron at all. */
export interface LoadFailure {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}

/** ERR_ABORTED.
 *
 *  ⚠ CHROMIUM REPORTS AN ABORTED NAVIGATION AS A FAILED ONE, and starting a
 *  navigation aborts whatever was already in flight — including the one OUR
 *  OWN retry issues. Treating ERR_ABORTED as a failure would make every retry
 *  manufacture the failure that schedules the next retry, and the backoff would
 *  never reach its steady interval. It is also what an ordinary in-app
 *  navigation looks like, so this is not only a loop guard. */
export const ERR_ABORTED = -3

/** A subframe failing is not the window going blank — an image, an iframe or a
 *  fetch can fail while the interface is perfectly usable. Only the main frame
 *  losing its document is the failure this file is about. */
export function isTerminalLoadFailure(failure: LoadFailure): boolean {
  return failure.isMainFrame && failure.errorCode !== ERR_ABORTED
}

/** Backoff for the retry.
 *
 *  Fast at first because the common case is a restart that is already finishing
 *  — the engine was back within three minutes on the reporting machine, and a
 *  user watching a blank window counts every second of it. Then a STEADY
 *  interval that never stops, because the alternative is exactly the defect
 *  being fixed: a window that has given up is a window that stays white
 *  forever. Re-navigating a window costs one HTTP request to loopback, so there
 *  is no budget worth spending to stop doing it. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]
export const RETRY_STEADY_MS = 30_000

export function retryDelayMs(attempt: number): number {
  return attempt < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempt] : RETRY_STEADY_MS
}

/** The log gets one line per retry at first and then only every tenth, so a
 *  window left blank overnight leaves a readable trail instead of 2,880 lines
 *  that bury the failure they follow. */
export function shouldRecordRetry(attempt: number): boolean {
  return attempt < RETRY_DELAYS_MS.length || attempt % 10 === 0
}

/** The page shown while there is nothing to render.
 *
 *  ⚠ THE POINT OF THIS IS THAT THE WINDOW IS NEVER WHITE. A blank window tells
 *  the user their application is destroyed; this tells them it is coming back,
 *  which is both truer and the difference between quitting and waiting.
 *
 *  Deliberately dependency-free and self-contained: it is displayed precisely
 *  when the engine that serves every stylesheet, font and script is not
 *  answering, so it can reference nothing it does not carry inline. Same
 *  palette as CrashBoundary so the two read as one product. */
export function holdingPageHtml(detail: string, stranded = false): string {
  const message = stranded
    ? 'Orgtree lost its engine and could not reattach automatically.'
    : 'Orgtree lost its connection to the engine.'
  const sub = stranded
    ? 'Your agents and their work are safe on disk. Refresh app view restarts Orgtree to rebuild the interface.'
    : 'Reconnecting automatically — your agents keep running while this window is away.'
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>Orgtree — reconnecting</title><style>`
    + `body{margin:0;background:#1a1a1a;color:#eee;font-family:monospace;`
    + `min-height:100vh;display:flex;flex-direction:column;box-sizing:border-box}`
    + `.orgbar{display:flex;align-items:flex-start;justify-content:space-between;`
    + `padding:0 0 6px 14px;border-bottom:1px solid rgba(255,255,255,0.08);`
    + `-webkit-app-region:drag;box-sizing:border-box;width:100%}`
    + `.orgbar h2{margin:6px 0;font-size:15px;font-weight:600;color:#eee;-webkit-app-region:drag}`
    + `.window-controls{display:flex;flex:0 0 auto;flex-wrap:nowrap;height:32px;margin:0;-webkit-app-region:no-drag}`
    + `.window-control{flex:0 0 46px;width:46px;height:100%;padding:0;border:0;border-radius:0;`
    + `background:transparent;color:#999;display:grid;place-items:center;font-size:15px;cursor:pointer;-webkit-app-region:no-drag}`
    + `.window-control:hover{background:rgba(255,255,255,0.08);color:#eee}`
    + `.window-control:active{background:rgba(255,255,255,0.16);color:#eee}`
    + `.window-control.close:hover{background:#c42b1c;color:#fff}`
    + `.window-control.close:active{background:#b02619;color:#fff}`
    + `.window-control svg{width:1em;height:1em;fill:currentColor}`
    + `main{margin:auto;padding:32px;max-width:560px;-webkit-app-region:no-drag}`
    + `main h2{color:#f66;margin:0 0 12px;font-size:18px}`
    + `p{margin:0 0 8px;line-height:1.5}`
    + `.d{opacity:.6;font-size:13px;white-space:pre-wrap}`
    + `${stranded ? '' : '.s{margin-top:16px;opacity:.6;font-size:13px}'
      + '.s::after{content:"";animation:dots 1.5s steps(4,end) infinite}'
      + '@keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}'}`
    + `</style></head><body>`
    + `<header class="orgbar fallback-orgbar native-header">`
    + `<h2>Orgtree</h2>`
    + `<div class="window-controls" role="group" aria-label="Window controls">`
    + `<button type="button" class="window-control" aria-label="Refresh app view" title="Refresh app view"><svg viewBox="0 0 24 24"><path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"/></svg></button>`
    + `<button type="button" class="window-control" aria-label="Minimize window" title="Minimize window"><svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg></button>`
    + `<button type="button" class="window-control" aria-label="Maximize window" title="Maximize window"><svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg></button>`
    + `<button type="button" class="window-control close" aria-label="Close window" title="Close window"><svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>`
    + `</div>`
    + `</header>`
    + `<main>`
    + `<h2>${escapeHtml(message)}</h2>`
    + `<p>${escapeHtml(sub)}</p>`
    + `<p class="d">${escapeHtml(detail)}</p>`
    + (stranded ? '' : `<p class="s">Reconnecting</p>`)
    + `</main></body></html>`
}

/** Minimal, because `detail` carries an Electron error description and a URL,
 *  and neither is under this process's control. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;'
      : ch === '"' ? '&quot;' : '&#39;'))
}

/** What the recovery needs from the application, named so a test can drive it
 *  with no Electron, no engine and no real clock. */
export interface WindowLoadHooks {
  /** The durable record. Called BEFORE anything is attempted, always. */
  record(stage: WindowLoadStage, detail: string): void
  /** ⚠ READ LIVE, NEVER CAPTURED. The engine picks its port at startup and
   *  persists it, so a restart normally comes back on the same origin — but
   *  `_fresh_port` falls back to an OS-assigned port when the stored one
   *  cannot be bound, and a retry aimed at a remembered origin would then be
   *  retrying against nothing for as long as the app ran. */
  target(): string
  /** The origin the window was BUILT for. The preload is given
   *  `--orgtree-ui-origin=<origin>` as a fixed launch argument, so a window
   *  cannot be re-pointed at a different origin by navigating it. */
  builtFor(): string
  /** Navigate the window. Rejects like Electron's `loadURL`. */
  load(url: string): Promise<void>
  /** Show the holding page. Never rejects in practice — it is a data: URL. */
  showHolding(html: string): Promise<void>
  /** True while the app is shutting down; nothing is recovered then, because
   *  re-navigating a window would fight the teardown it is reacting to. */
  suspended?(): boolean
  /** ⚠ THE DOCUMENT THAT WAS SHOWING IS GONE, replaced by an error page.
   *
   *  A terminal load failure swaps the document for Chromium's error page and
   *  does NOT fire `did-navigate` - measured against real Electron, a
   *  connection refusal fires `did-start-navigation` then `did-fail-load` and
   *  never commits. Anything keyed to commit therefore does not run, while the
   *  document it was about has already been destroyed.
   *
   *  That matters to whoever is holding events for this window: the error page
   *  carries no preload and no bridge, so it can never say it is listening,
   *  and anything sent to it is gone. This is the hook that lets a caller stop
   *  delivering BEFORE the retry is scheduled.
   *
   *  Called only for a failure that is terminal by `isTerminalLoadFailure` AND
   *  that describes the document currently showing - see attachWindowLoadRecovery. */
  documentLost?(): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** Keeps the main window's document loaded, or keeps trying.
 *
 *  The invariant, and the whole of the fix: AFTER A FAILED LOAD THE WINDOW IS
 *  EITHER SHOWING THE INTERFACE OR SHOWING THE HOLDING PAGE, and a retry is
 *  always scheduled. There is no state in which it is blank and nothing is
 *  going to happen. */
export class WindowLoadRecovery {
  /** The window is not showing the interface. */
  private failed = false
  /** A retry navigation is in flight.
   *
   *  ⚠ Electron signals ONE failed navigation TWICE — `did-fail-load` fires and
   *  `loadURL` rejects — so without this, a single failed retry would run the
   *  whole failure path twice: two holding-page renders and two trips through
   *  the scheduler. It does NOT prevent a doubled timer (mutation testing
   *  established that: `schedule()` clears before it sets, so it is idempotent
   *  and the timer count is right either way). What it prevents is the
   *  duplicated work and the duplicated re-render, which is a real cost on the
   *  path taken every 30 s during a long outage but is not a correctness bug. */
  private inFlight = false
  private attempt = 0
  private timer: unknown = null
  /** Set once the engine has moved to an origin this window cannot be pointed
   *  at. Retrying is pointless from then on and the holding page says so. */
  private stranded = false

  constructor(private readonly hooks: WindowLoadHooks) {}

  /** Wire this to the webContents' `did-fail-load`. */
  onLoadFailure(failure: LoadFailure): void {
    if (!isTerminalLoadFailure(failure)) return
    if (this.hooks.suspended?.()) return
    const detail = `errorCode=${failure.errorCode} ${failure.errorDescription} url=${failure.validatedURL}`
    // ⚠ RECORD FIRST, UNCONDITIONALLY — the line is the defect being fixed as
    // much as the retry is. A white window that left no trace is how this cost
    // an application before anyone could see what had happened.
    this.hooks.record('window-load-failed', detail)
    if (this.inFlight) return   // the retry's own rejection owns this one
    void this.enterFailed(detail)
  }

  /** Wire this to the engine's status event, for `ready`.
   *
   *  ⚠ THIS IS THE HALF THAT MAKES A RESTART WORK. The timer alone recovers the
   *  window eventually; this recovers it AS SOON AS there is something to
   *  recover to, which is what the user experiences as the restart having
   *  worked. It applies to MANAGED engines too — the pre-existing reload on
   *  engine recovery (`index.ts`) is gated on `!engine.managed`, so the
   *  desktop-spawned engine that every normal installation runs never reached
   *  it. That gate is the reason restarting the engine did not fix the window. */
  onEngineReady(): void {
    if (!this.failed || this.stranded) return
    if (this.hooks.suspended?.()) return
    this.clear()
    this.attempt = 0
    void this.retry('engine reported ready')
  }

  /** Trigger an immediate retry, e.g. from user clicking refresh on the holding page. */
  async retryNow(why = 'user refresh'): Promise<void> {
    if (!this.failed || this.stranded) return
    if (this.hooks.suspended?.()) return
    this.clear()
    this.attempt = 0
    await this.retry(why)
  }

  /** Wire this to the webContents' `did-finish-load`, which is the only thing
   *  that proves a document is actually up. */
  onLoadFinished(url: string): void {
    if (!this.failed) return
    if (url.startsWith('data:')) return   // the holding page is not recovery
    this.recovered()
  }

  /** Released on shutdown so a pending retry cannot outlive the window. */
  dispose(): void { this.clear(); this.failed = false }

  /** Test seam: true while the window is known not to be showing the UI. */
  get isFailed(): boolean { return this.failed }
  get retryAttempt(): number { return this.attempt }
  /** True once the engine moved to an origin this window cannot be pointed
   *  at. `retryNow` deliberately refuses to act then — so the refresh route
   *  must branch on THIS and rebuild the window instead (review W1,
   *  2026-09-20): an enabled control that silently does nothing is the
   *  defect, not a policy. */
  get isStranded(): boolean { return this.stranded }

  private async enterFailed(detail: string): Promise<void> {
    this.failed = true
    // The holding page goes up BEFORE the first retry is even scheduled, so
    // there is no window of time in which the user is looking at nothing.
    await this.showHolding(detail)
    this.schedule()
  }

  private async showHolding(detail: string): Promise<void> {
    try { await this.hooks.showHolding(holdingPageHtml(detail, this.stranded)) }
    catch { /* a missing holding page must not stop the retry that fixes it */ }
  }

  private schedule(): void {
    if (this.stranded) return
    this.clear()
    const delay = retryDelayMs(this.attempt)
    this.timer = this.hooks.setTimer(() => { this.timer = null; void this.retry('scheduled') }, delay)
  }

  private clear(): void {
    if (this.timer !== null) { this.hooks.clearTimer(this.timer); this.timer = null }
  }

  private async retry(why: string): Promise<void> {
    if (!this.failed || this.inFlight || this.stranded) return
    if (this.hooks.suspended?.()) return
    const origin = this.hooks.target()
    // ⚠ A MOVED ENGINE CANNOT BE RECOVERED BY NAVIGATING. The preload origin is
    // baked into the window's launch arguments, so a window pointed at a new
    // origin would load a UI whose bridge is signed for the old one. Say so and
    // stop, rather than retrying forever against a page that can never work.
    if (origin && origin !== this.hooks.builtFor()) {
      this.stranded = true
      this.clear()
      this.hooks.record('window-load-stranded',
        `engine moved from ${this.hooks.builtFor()} to ${origin}; this window cannot be re-pointed`)
      await this.showHolding(`The engine restarted on a different port (${origin}).`)
      return
    }
    if (!origin) { this.attempt += 1; this.schedule(); return }
    this.inFlight = true
    const attempt = this.attempt
    if (shouldRecordRetry(attempt)) {
      this.hooks.record('window-load-retry', `attempt=${attempt + 1} ${why} target=${origin}`)
    }
    try {
      await this.hooks.load(origin + '/')
      // `did-finish-load` normally gets here first; this covers the case where
      // the caller's emitter is not wired, and is idempotent either way.
      if (this.failed) this.recovered()
    } catch (error) {
      this.attempt += 1
      const detail = error instanceof Error ? error.message : String(error)
      await this.showHolding(detail)
      this.schedule()
    } finally {
      this.inFlight = false
    }
  }

  private recovered(): void {
    const attempts = this.attempt + 1
    this.failed = false
    this.attempt = 0
    this.clear()
    this.hooks.record('window-load-recovered', `the window loaded again after ${attempts} attempt(s)`)
  }
}

/** Anything that emits the two webContents events we care about. Structural so
 *  a real Electron WebContents satisfies it without this module importing
 *  Electron. */
export interface LoadFailureEmitter {
  on(event: 'did-fail-load', listener: (event: unknown, errorCode: number, errorDescription: string,
    validatedURL: string, isMainFrame: boolean) => void): unknown
  on(event: 'did-finish-load', listener: () => void): unknown
}

/** Attaches the navigation half of window recovery. Returns the recovery so a
 *  caller (or a test) can drive `onEngineReady` and inspect it. */
export function attachWindowLoadRecovery(
  contents: LoadFailureEmitter, hooks: WindowLoadHooks, currentUrl: () => string,
): WindowLoadRecovery {
  const recovery = new WindowLoadRecovery(hooks)
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const failure = { errorCode, errorDescription, validatedURL, isMainFrame }
    // ⚠ BEFORE THE RETRY IS SCHEDULED, and CLASSIFICATION ONLY.
    //
    // The same rule the retry uses, so a subframe failure or an ERR_ABORTED
    // cannot be terminal for one of them and not the other.
    //
    // WHETHER THIS FAILURE IS STILL RELEVANT IS NOT DECIDED HERE. A failure
    // for a navigation that has since been overtaken must not discard a
    // document that is alive and already listening - but "which document" is a
    // question this file cannot answer, because it does not know what a
    // document IS. Comparing `validatedURL` to the current URL was tried and
    // is NOT sufficient: the recovery retries the SAME url, so a stale failure
    // and a live one are indistinguishable by URL at exactly the moment it
    // matters. The caller owns document identity and makes that call. */
    if (isTerminalLoadFailure(failure)) hooks.documentLost?.()
    recovery.onLoadFailure(failure)
  })
  contents.on('did-finish-load', () => recovery.onLoadFinished(currentUrl()))
  return recovery
}
