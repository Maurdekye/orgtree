/** A FAILED START LEAVES EVIDENCE AND STAYS FINDABLE (@coordinator-opus m1047f5ff5d1e, 2026-11-17).
 *
 *  The desktop's startup catch (main/index.ts) shows a parentless native error box and waits on it; a core member never
 *  quits there. On the 4.6.1-alpha.3 packaged smoke that box sat unseen in Session 0 for 150 s: a tray, no window,
 *  nothing written. Behind other windows or off-screen it is the same for a user. So, before the box: the error's
 *  message goes to the data folder's diagnostics (the same file the managed engine's exits use), and the tray says
 *  Orgtree could not start, with "show the error" in its menu.
 *
 *  The message is the startup error's own text (what the box shows), bounded; never a stack. Asynchronous, and waited
 *  for at most RECORD_WAIT_MS, so a slow disk never keeps the box from showing. */
import fs from 'node:fs'
import path from 'node:path'

export const STARTUP_FAILURE_LOG = path.join('diagnostics', 'desktop-engine-exits.jsonl')
export const STARTUP_FAILURE_MAX = 500
const RECORD_WAIT_MS = 2000

export function startupFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown startup error'
}

/** One JSON line {at, event: 'startup-failed', message}; never rejects. */
export async function recordStartupFailure(root: string, message: string, now: () => Date = () => new Date()): Promise<void> {
  try {
    const file = path.join(root, STARTUP_FAILURE_LOG)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.appendFile(file, JSON.stringify({ at: now().toISOString(), event: 'startup-failed', message: message.slice(0, STARTUP_FAILURE_MAX) }) + '\n')
  } catch { /* diagnosis never obstructs the report */ }
}

export interface StartupFailureReport {
  record(message: string): Promise<void>
  markTray(message: string): void
  show(message: string): Promise<unknown>
}

/** Record (bounded wait), mark the tray, then show the box and wait for it, as the catch always did. */
export async function reportStartupFailure(error: unknown, report: StartupFailureReport, recordWaitMs = RECORD_WAIT_MS): Promise<void> {
  const message = startupFailureMessage(error)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    report.record(message).catch(() => {}),
    new Promise<void>(resolve => { timer = setTimeout(resolve, recordWaitMs) }),
  ])
  if (timer) clearTimeout(timer)
  try { report.markTray(message) } catch { /* the box still shows */ }
  await report.show(message)
}
