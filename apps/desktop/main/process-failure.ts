// process-failure.ts — what happens when a Chromium process under this app
// goes away, and how anybody ever finds out about it.
//
// ⚠ THE WHOLE POINT OF THIS FILE IS THAT THE OLD PATH RAN IN THE DARK. A
// renderer killed for running out of memory produced: no minidump (Electron's
// crash reporter was never started), no Windows event (an OOM kill raises no
// fault), no application log line, and no crash report from our own in-renderer
// reporter — which cannot fire, because a process killed for OOM cannot POST
// its own obituary. The single handler that DID know threw the information
// away: it took no argument, so Electron's `details.reason` and
// `details.exitCode` — the two values that identify the failure — went nowhere.
// The failure on the reporting machine was diagnosed only because an agent
// happened to be sampling the process table every 12 seconds when it died.
//
// So everything here writes to the durable log first and acts second, and the
// decisions are pure functions so the behaviour can be tested without a
// process actually dying.

/** How the log names these events. Kept as literals rather than reusing the
 *  updater's stage union so a reader of update-log.json can see at a glance
 *  which lines describe an update and which describe a process dying. */
export type ProcessFailureStage =
  | 'renderer-gone'                /* the window's render process went away */
  | 'renderer-recovered'           /* ...and was reloaded automatically */
  | 'renderer-recovery-exhausted'  /* ...too often; the user was told instead */
  | 'renderer-unresponsive'        /* the render process is alive but wedged */
  | 'renderer-responsive'          /* ...and came back on its own */
  | 'child-process-gone'           /* a GPU/utility/zygote process went away */
  | 'crash-reporter'               /* where minidumps go, and whether they leave */

/** Electron's RenderProcessGoneDetails, structurally. Declared here rather than
 *  imported so this module — and its tests — need no Electron at all. */
export interface RendererGoneDetails { reason: string; exitCode: number }

/** Electron's child-process-gone Details, structurally. */
export interface ChildGoneDetails { type: string; reason: string; exitCode: number; serviceName?: string; name?: string }

/** Reasons that describe an ORDINARY teardown rather than a failure. A window
 *  being closed, or the app quitting, ends its renderer with `clean-exit`, and
 *  reloading in response to that would fight the shutdown it is reacting to. */
export const ORDINARY_EXIT_REASONS = new Set(['clean-exit'])

/** One line that says what happened, in the order a reader needs it. `reason`
 *  first because it is the diagnosis ('oom', 'crashed', 'killed',
 *  'launch-failed'); `exitCode` second because it is what distinguishes two
 *  failures that share a reason. */
export function describeRendererFailure(details: RendererGoneDetails): string {
  return `reason=${details.reason} exitCode=${details.exitCode}`
}

export function describeChildFailure(details: ChildGoneDetails): string {
  const named = details.name ?? details.serviceName
  return `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    + (named ? ` name=${named}` : '')
}

/** How many automatic reloads are allowed inside RECOVERY_WINDOW_MS.
 *
 *  ⚠ AUTOMATIC RECOVERY IS GOOD FOR THE USER RIGHT UP UNTIL IT LOOPS. A
 *  renderer that dies on load — a bad build, a page that allocates itself to
 *  death during boot — would otherwise reload, die, reload, die, forever, and
 *  the user would see a window flickering with no way to read what is wrong.
 *  Three is enough to ride out a transient kill (the failure this ticket comes
 *  from was transient: the engine, the main process and the GPU process all
 *  survived it) and few enough that a deterministic crash gives up in seconds
 *  and says so. */
export const RECOVERY_LIMIT = 3
/** The window the limit is counted over. Rolling rather than per-session: a
 *  machine that kills the renderer once a fortnight must never exhaust its
 *  budget, and one killing it every thirty seconds must stop being reloaded. */
export const RECOVERY_WINDOW_MS = 10 * 60 * 1000

/** The bounded automatic-recovery decision, as a value rather than a side
 *  effect, so "does the fourth crash in ten minutes stop reloading?" is a test
 *  that needs no renderer, no window and no clock. */
export class RecoveryBudget {
  private attempts: number[] = []
  constructor(private readonly limit = RECOVERY_LIMIT, private readonly windowMs = RECOVERY_WINDOW_MS) {}

  /** Records a failure at `now` and says whether it may be recovered.
   *  `attempt` counts from 1 and is what the user and the log are told. */
  consider(now: number): { recover: boolean; attempt: number; limit: number } {
    this.attempts = this.attempts.filter(at => now - at < this.windowMs)
    this.attempts.push(now)
    return { recover: this.attempts.length <= this.limit, attempt: this.attempts.length, limit: this.limit }
  }

  /** Failures still inside the window. Exposed for the log line, so a reader
   *  can see the budget being spent rather than only its exhaustion. */
  recent(now: number): number { return this.attempts.filter(at => now - at < this.windowMs).length }
}

/** What the recovery needs from the application, named so this module can be
 *  driven by a test with a real BrowserWindow and no application at all. */
export interface FailureHooks {
  /** The durable record. Called BEFORE anything is attempted, always. */
  record(stage: ProcessFailureStage, detail: string): void
  /** Reload the window. Only called when the budget allows it. */
  reload(): void
  /** Tell the user, out of band, that their window died and came back. It has
   *  to be out of band: the surface that would normally say so is the renderer,
   *  and the renderer is the thing that just died. */
  announce(title: string, body: string): void
  /** The end of the line: the failure the user must read and act on. */
  giveUp(detail: string): void
  /** True when the app is shutting down and nothing should be recovered. */
  suspended?(): boolean
  now?(): number
}

/** Anything that emits the two webContents events we care about. Structural so
 *  a real Electron WebContents satisfies it without this module importing
 *  Electron. */
export interface FailureEmitter {
  on(event: 'render-process-gone', listener: (event: unknown, details: RendererGoneDetails) => void): unknown
  on(event: 'unresponsive', listener: () => void): unknown
  on(event: 'responsive', listener: () => void): unknown
}

/** Attaches the renderer half: the process going away, and the process wedging.
 *  Returns the budget so a caller (or a test) can inspect it. */
export function attachRendererFailureHandlers(contents: FailureEmitter, hooks: FailureHooks, budget = new RecoveryBudget()): RecoveryBudget {
  const now = hooks.now ?? Date.now
  contents.on('render-process-gone', (_event, details) => {
    const described = describeRendererFailure(details)
    // ⚠ RECORD FIRST, UNCONDITIONALLY. Everything below can be skipped for a
    // clean exit, a shutdown or an exhausted budget; the line never is. This
    // is the defect being fixed — not the dialog, not the reload.
    hooks.record('renderer-gone', described)
    if (ORDINARY_EXIT_REASONS.has(details.reason)) return
    if (hooks.suspended?.()) return
    const { recover, attempt, limit } = budget.consider(now())
    if (recover) {
      hooks.record('renderer-recovered', `${described} attempt=${attempt}/${limit}`)
      hooks.reload()
      hooks.announce('Orgtree recovered its window',
        `The window stopped responding (${details.reason}) and was reloaded. Your agents kept running.`)
      return
    }
    // The budget is spent: stop reloading and say so, with the diagnosis the
    // old dialog never had and a pointer to where the rest of it is written.
    hooks.record('renderer-recovery-exhausted', `${described} attempt=${attempt}/${limit}`)
    hooks.giveUp(described)
  })
  // Wedged is not dead. Chromium usually recovers a busy renderer on its own,
  // and killing one that is merely slow would throw away work nothing else has
  // a copy of — so this records, and only records. The pair of lines is what
  // makes the record useful: a 'renderer-unresponsive' with no
  // 'renderer-responsive' after it is a hang that never ended.
  contents.on('unresponsive', () => hooks.record('renderer-unresponsive', 'the render process stopped answering'))
  contents.on('responsive', () => hooks.record('renderer-responsive', 'the render process answered again'))
  return budget
}

export interface ChildFailureEmitter {
  on(event: 'child-process-gone', listener: (event: unknown, details: ChildGoneDetails) => void): unknown
}

/** Attaches the app half: GPU, utility and zygote processes. Chromium restarts
 *  these itself, so there is nothing to recover here — but they died silently
 *  too, and a GPU process dying repeatedly is exactly the sort of thing that is
 *  invisible until someone thinks to look for it. */
export function attachChildProcessFailureHandler(source: ChildFailureEmitter, hooks: Pick<FailureHooks, 'record'>): void {
  source.on('child-process-gone', (_event, details) => {
    if (ORDINARY_EXIT_REASONS.has(details.reason)) return
    hooks.record('child-process-gone', describeChildFailure(details))
  })
}

/** The crash reporter's settings, in one place, because the interesting part of
 *  them is a product decision rather than a configuration detail.
 *
 *  ⚠ NOTHING LEAVES THE MACHINE. `uploadToServer: false` is what makes that
 *  true: Crashpad writes minidumps into the app's own crashDumps directory
 *  (userData\Crashpad on Windows) and never opens a network connection to send
 *  them. There is no submitURL, so there is nowhere for a dump to go even if
 *  the flag were wrong. Orgtree is a local-first product and a crash reporter
 *  that quietly shipped a memory image off a user's machine would be a worse
 *  defect than the silence it was added to fix. A dump is collected so that a
 *  user who WANTS to send one can find it; sending it is their act, not ours.
 *
 *  ⚠ AND IT MUST START BEFORE app.whenReady(). Crashpad has to be running
 *  before the processes it is meant to catch exist; started later it would miss
 *  exactly the early failures that are hardest to reproduce. */
export const CRASH_REPORTER_OPTIONS = {
  uploadToServer: false,
  /** Compression only matters for upload, and there is no upload. Off, so a
   *  dump found on disk can be read with ordinary tools. */
  compress: false,
  ignoreSystemCrashHandler: false,
} as const

// ------------------------------------------------------- reaching the dumps
// ⚠ COLLECTED IS NOT THE SAME AS REACHABLE. A dump nobody can find is a dump
// nobody can send, and `userData\Crashpad\reports\<uuid>.dmp` is not a path
// anyone guesses. So there is one deliberate, user-pressed way to get at them
// — and deliberately no automatic one: nothing here runs on a schedule, on a
// crash, or on any event at all, so there is no hook a later change could
// quietly point at a network.

/** Said to the user's face before they hand a dump to anybody, because a
 *  person sending one deserves to know what it is. Their own working material
 *  is in there — it is a memory snapshot, not a log. */
export const CRASH_REPORT_DISCLOSURE =
  'A crash report is a snapshot of what was in Orgtree\'s memory when it failed, so it can contain agent names, message text and file paths.'

/** Crashpad writes the dumps into a `reports` subdirectory of the crashDumps
 *  path and its own bookkeeping alongside. Open the one with the dumps in it
 *  when it exists, and the parent when it does not, so the folder that opens
 *  is never empty-looking for the wrong reason. */
export function crashReportFolder(crashDumps: string, join: (a: string, b: string) => string, exists: (path: string) => boolean): string {
  const reports = join(crashDumps, 'reports')
  return exists(reports) ? reports : crashDumps
}

/** What the tray entry puts on screen. Pure, so the sentence a user reads
 *  before handing over their memory contents is covered by a test rather than
 *  by whoever last edited the menu. */
export function crashReportDialog(folder: string, dumps: number): { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number } {
  return {
    message: dumps === 0 ? 'Orgtree has recorded no crash reports on this computer.'
      : `Orgtree has ${dumps} crash report${dumps === 1 ? '' : 's'} on this computer.`,
    detail: `${CRASH_REPORT_DISCLOSURE}\n\nOrgtree never sends one anywhere. They stay in this folder until you delete them, and sending one to anybody is something you do yourself.\n\n${folder}`,
    buttons: ['Open folder', 'Close'],
    defaultId: 0,
    cancelId: 1,
  }
}
