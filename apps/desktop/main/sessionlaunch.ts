import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { INTERACTIVE_TASK, POWERSHELL, UAC_CANCELLED, run, startTask, type Runner } from './runasadmin'
import { readStartupTasks, startEngineTask, startupOn, type StartupTasks } from './runonstartup'
import { validateDataRoot } from './policy'
import type { EngineOptions } from './engine'

/** Where the background engine starts (docket
 *  after-an-update-or-engine-restart-while-the-user; user and coordinator
 *  rulings 2026-10-21). While the operator is signed in at the console, a
 *  restart, a recovery or the first start runs the installer's "Orgtree User
 *  Session Engine" task: Windows starts it in their session at the task's run
 *  level (the highest while "Run as admin" is on, so no prompt), and its
 *  launcher hands the running engine over itself (engine src/session_launch.rs).
 *  Elsewhere the boot task starts it as before (its host decides, src/
 *  boot_supervisor.rs), and an installation without owned tasks keeps the
 *  desktop's own engine. */
export type Route = 'session' | 'boot' | 'managed'

export interface LaunchContext {
  session: number | null; console: number | null; ownsConsole: boolean; known: boolean
  operatorSid: string | null; elevated: boolean; parent?: {pid: number; created: string}
}
export const inConsole = (c: LaunchContext): boolean => c.known === true && Number.isInteger(c.session) && c.session! > 0 && c.session === c.console && c.ownsConsole && typeof c.operatorSid === 'string' && !!c.operatorSid

export function route(tasks: StartupTasks | null, here: LaunchContext | null): Route {
  if (tasks?.interactive != null && here && inConsole(here)) return 'session'
  if (tasks && tasks.boot !== null && startupOn(tasks)) return 'boot'
  return 'managed'
}

export async function launchContext(binary: string, runner: Runner = run): Promise<LaunchContext> {
  const r = await runner(binary, ['session-launch', 'inspect', String(process.pid)], 10000)
  if (r.code !== 0) throw new Error('Could not verify the current Windows session.')
  const c = JSON.parse(r.stdout.trim()) as LaunchContext
  if (!c || c.known !== true || typeof c.ownsConsole !== 'boolean' || typeof c.elevated !== 'boolean') throw new Error('Windows session could not be verified; no launch was attempted.')
  return c
}

/** The launcher's durable record of its last attempt (core-handover.json),
 *  as far as the app needs it: fixed words only. */
export interface Attempt { id: string; phase: 'begun' | 'stopping' | 'starting' | 'ready' | 'failed'; by: string; atMs: number
  stoppedOld: boolean; error: string | null; rollback: 'done' | 'failed' | null }

export function parseAttempt(text: string): Attempt | null {
  try {
    const r = JSON.parse(text) as Record<string, unknown>
    const phases = ['begun', 'stopping', 'starting', 'ready', 'failed']
    if (typeof r.id !== 'string' || !phases.includes(r.phase as string) || typeof r.at_ms !== 'number') return null
    return { id: r.id, phase: r.phase as Attempt['phase'], by: typeof r.by === 'string' ? r.by : '', atMs: r.at_ms,
      stoppedOld: r.stopped_old === true, error: typeof r.error === 'string' ? r.error : null,
      rollback: r.rollback === 'done' || r.rollback === 'failed' ? r.rollback : null }
  } catch { return null }
}

export async function readAttempt(dataRoot: string): Promise<Attempt | null> {
  try { return parseAttempt(await fs.readFile(path.join(dataRoot, 'core-handover.json'), 'utf8')) } catch { return null }
}

/** The failure message of an attempt that began at or after `since`, if one failed. */
export async function lastFailure(dataRoot: string, since: number): Promise<string | null> {
  const a = await readAttempt(dataRoot)
  return a && a.phase === 'failed' && a.atMs >= since - 1000 ? failureMessage(a) : null
}

/** What the user is told about a failed attempt: the reason, and what runs now. */
export function failureMessage(a: Attempt): string {
  const why = a.error ?? 'the reason was not recorded'
  if (a.rollback === 'done') return `Orgtree could not start the engine in your session (${why}), so it started the engine in Session 0 instead.`
  if (a.rollback === 'failed') return `Orgtree could not start the engine in your session (${why}), and it did not start in Session 0 either. Use Start engine in the tray to try again.`
  if (!a.stoppedOld) return `Orgtree could not start the engine in your session (${why}). The running engine is unchanged.`
  return `Orgtree could not start the engine in your session (${why}). It is starting the engine in Session 0 instead.`
}

/** The ask the next `session-launch signin` reads once: who asks and whether
 *  an engine already in place restarts. Fixed words; no path. */
export async function writeAsk(dataRoot: string, restart: boolean, atMs = Date.now()): Promise<void> {
  const file = path.join(dataRoot, 'session-launch-request.json')
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(temp, JSON.stringify({ by: 'desktop', restart, atMs }))
  await fs.rename(temp, file)
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Run the user-session task. A restart then waits for its launcher's answer:
 *  ready, or a failure (which throws its message); no answer within
 *  `deadlineMs` leaves the caller to attach to whatever runs. */
export async function startInSession(dataRoot: string, restart: boolean, deadlineMs = 300_000, runner: Runner = run): Promise<void> {
  const askedAt = Date.now()
  await writeAsk(dataRoot, restart, askedAt)
  await startTask(INTERACTIVE_TASK, runner)
  // A start or recovery is done once any engine attaches (the caller's wait):
  // an attempt already running may serve it. Only a restart waits for its own.
  if (!restart) return
  const until = askedAt + deadlineMs
  while (Date.now() < until) {
    const a = await readAttempt(dataRoot)
    if (a && a.atMs >= askedAt - 1000) {
      if (a.phase === 'ready') return
      if (a.phase === 'failed') throw new Error(failureMessage(a))
    }
    await delay(500)
  }
}

/** Start (or restart) the background engine where it belongs; 'managed' when
 *  this desktop is to start its own. The caller attaches afterwards. */
export async function launchBackground(options: EngineOptions, restart = false, runner: Runner = run): Promise<Route> {
  const tasks = await readStartupTasks(runner).catch(() => null)
  const here = options.binary ? await launchContext(options.binary, runner).catch(() => null) : null
  const where = route(tasks, here)
  if (where === 'session') await startInSession(validateDataRoot(options.dataRoot, options.forbiddenRoot), restart, 300_000, runner)
  else if (where === 'boot') await startEngineTask(runner)
  return where
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
/** No -Wait: the elevated launcher hands the engine over itself. The returned
 * PID proves ShellExecute accepted UAC, not that anything has changed. */
export function elevationScript(binary: string, request: string): string {
  // PowerShell joins ArgumentList into a command line; quote the file explicitly.
  if (request.includes('"')) throw new Error('Invalid launch request path')
  return [
    "$ErrorActionPreference='Stop'",
    'try {',
    ` $p=Start-Process -FilePath ${quote(binary)} -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList ${quote(`session-launch prepare "${request}"`)}`,
    ' Write-Output $p.Id; exit 0',
    '} catch {',
    ' $e=$_.Exception; while ($e -and -not ($e -is [ComponentModel.Win32Exception])) { $e=$e.InnerException }',
    ` if ($e -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }; exit 2`,
    '}',
  ].join('\n')
}

type Receipt = {nonce?: string; identity?: {pid?: number}; session?: number; admin?: boolean; error?: string; stoppedOld?: boolean; unchanged?: boolean; enginePid?: number}
async function json(file: string): Promise<Receipt | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Receipt } catch { return null }
}

/** "Run this session as admin": ONE UAC prompt, then the elevated launcher
 *  checks this desktop's session, operator and data folder and hands the
 *  engine over itself. A declined prompt or a refusal before the stop leaves
 *  the running engine untouched. The stored setting never changes. Tests
 *  replace the runner, so no prompt or real task is reached. */
export async function runSessionAsAdmin(options: EngineOptions, runner: Runner = run): Promise<void> {
  const binary = options.binary
  if (!binary || !path.isAbsolute(binary)) throw new Error('The native engine is required for a session launch.')
  const here = await launchContext(binary, runner)
  if (!inConsole(here) || !here.parent) throw new Error('No signed-in console session is available.')
  const root = validateDataRoot(options.dataRoot, options.forbiddenRoot)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orgtree-session-launch-'))
  const file = path.join(dir, 'request.json'), nonce = randomBytes(32).toString('hex')
  try {
    await fs.writeFile(file, JSON.stringify({nonce, session: here.session, operatorSid: here.operatorSid,
      parent: here.parent, dataRoot: root, uiDirectory: options.uiDirectory, admin: true}), {flag: 'wx'})
    const encoded = Buffer.from(elevationScript(binary, file), 'utf16le').toString('base64')
    const r = await runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 5 * 60_000)
    if (r.code === UAC_CANCELLED) throw new Error('Windows did not give permission; the running engine is unchanged.')
    if (r.code !== 0 || !/^\d+$/.test(r.stdout.trim())) throw new Error('The elevated launcher did not start; the running engine is unchanged.')
    const pid = Number(r.stdout.trim())
    // validated first (ready), then the handover's own outcome (done or error)
    let ready = false
    const until = Date.now() + 300_000
    while (Date.now() < until) {
      const failed = await json(path.join(dir, 'error.json'))
      if (failed) throw new Error(failed.stoppedOld
        ? `The engine could not start in this session as administrator (${failed.error || 'unknown error'}); Orgtree starts it in Session 0 instead.`
        : `The engine was not restarted as administrator: ${failed.error || 'unknown error'}. The running engine is unchanged.`)
      if (!ready) {
        const r2 = await json(path.join(dir, 'ready.json'))
        if (r2) {
          if (r2.nonce !== nonce || r2.identity?.pid !== pid || r2.session !== here.session || r2.admin !== true) throw new Error('Session launcher identity did not match.')
          ready = true
        } else if (Date.now() > until - 285_000) throw new Error('Session launcher did not become ready; the running engine is unchanged.')
      }
      if (ready && await json(path.join(dir, 'done.json'))) return
      await delay(200)
    }
    throw new Error('The engine did not restart in this session in time.')
  } finally {
    await fs.rm(dir, {recursive: true, force: true}).catch(() => {})
  }
}
