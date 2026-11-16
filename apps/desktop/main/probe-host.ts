/** THE PROBE HOST, MAIN SIDE (@item:orgtree/nick-pc-4-6-0-desktop-main-process-stalls-input-f, USER 2026-11-16
 *  m8fe70e62fc2c "Full scope + guard"). Every bounded program run of the desktop main process (the 2 s core-control
 *  status, the streamer tasklist, credential helpers, registry and PowerShell queries, taskkill, detached launches) goes
 *  through ONE utilityProcess (probe-host-child.ts). Even an asynchronous execFile blocks the calling thread for the
 *  whole CreateProcess call, antivirus image scanning included: on Nick-PC that froze input for 0.5-30 s from timers.
 *  In the host the same cost lands on the host's thread, never on main.
 *
 *  `execFile` keeps node's callback shape (error with code/killed/signal/message, stdout, stderr as strings), so every
 *  caller keeps its own error mapping and timeout. Requests made before the host is configured wait for it; a host
 *  that exits fails its pending requests the way a failed execFile would (code 'EPROBEHOST') and the next request
 *  forks a new one, at most once a second. A request with a timeout is also bounded here (timeout + 2 s), so a hung
 *  host never hangs a caller. tests/main-thread-guard.test.mjs keeps child_process out of every other module.
 *
 *  Outside the Electron main process (plain node: unit tests, the CI boot smoke, tools that load these modules) there is
 *  no utilityProcess and no input to freeze, so a request runs in this process through the host's own handler. In the
 *  Electron main process a request NEVER runs in process: before configureProbeHost it waits. */

import { handle } from './probe-host-child'

export interface ProbeChild {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}
export interface ExecOptions {
  timeout?: number
  maxBuffer?: number
  windowsHide?: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** written to the program's stdin, which is then closed */
  input?: string
  killSignal?: NodeJS.Signals | number
}
export interface ExecError extends Error { code?: string | number; killed?: boolean; signal?: NodeJS.Signals | null }
export type ExecCallback = (error: ExecError | null, stdout: string, stderr: string) => void
export interface LaunchOptions { cwd?: string; env?: NodeJS.ProcessEnv }

/** the host's extra allowance over a request's own timeout before the request fails here */
export const HOST_GRACE_MS = 2000
/** shortest gap between two forks of the host */
export const REFORK_MS = 1000

type Request = { id: number; op: 'exec'; file: string; args: string[]; options: ExecOptions }
  | { id: number; op: 'launch'; file: string; args: string[]; options: LaunchOptions }
type Reply = { id: number; error?: { message: string; code?: string | number; killed?: boolean; signal?: NodeJS.Signals | null } | null;
  stdout?: string; stderr?: string; pid?: number }
interface Pending { request: Request; settle: (reply: Reply) => void; timer?: ReturnType<typeof setTimeout>; sent: boolean }

let forker: (() => ProbeChild) | null = null
let host: ProbeChild | null = null
let lastFork = -Infinity
let reforkTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let nextId = 1
const pending = new Map<number, Pending>()

const hostError = (message: string): Reply['error'] => ({ message, code: 'EPROBEHOST', killed: false, signal: null })

/** Called once main can fork a utilityProcess (app ready). Requests made earlier are sent now. */
export function configureProbeHost(fork: () => ProbeChild): void {
  forker = fork; stopped = false
  pump()
}

/** At quit: the host ends; its pending requests fail; later requests fail at once. Detached launches live on. */
export function stopProbeHost(): void {
  stopped = true
  if (reforkTimer) { clearTimeout(reforkTimer); reforkTimer = null }
  const h = host; host = null
  for (const p of [...pending.values()]) p.settle({ id: p.request.id, error: hostError('The probe host has stopped') })
  try { h?.kill() } catch { /* already gone */ }
}

function ensureHost(): ProbeChild | null {
  if (host || stopped || !forker) return host
  const wait = lastFork + REFORK_MS - Date.now()
  if (wait > 0) {
    reforkTimer ??= setTimeout(() => { reforkTimer = null; pump() }, wait)
    return null
  }
  lastFork = Date.now()
  let child: ProbeChild
  try { child = forker() } catch {
    reforkTimer ??= setTimeout(() => { reforkTimer = null; pump() }, REFORK_MS)
    return null
  }
  host = child
  child.on('message', (message: unknown) => {
    const reply = message as Reply
    if (reply && typeof reply.id === 'number') pending.get(reply.id)?.settle(reply)
  })
  child.on('exit', () => {
    if (host !== child) return
    host = null
    for (const p of [...pending.values()]) if (p.sent) p.settle({ id: p.request.id, error: hostError('The probe host exited') })
    if ([...pending.values()].length) pump()
  })
  return child
}

function pump(): void {
  const h = ensureHost()
  if (!h) return
  for (const p of pending.values()) {
    if (p.sent) continue
    try { h.postMessage(p.request); p.sent = true } catch { p.settle({ id: p.request.id, error: hostError('The probe host did not take the request') }) }
  }
}

/** Electron's main process; not plain node, and not Electron run as node */
const electronMain = (): boolean => (process as { type?: string }).type === 'browser'

function submit(request: Request, bound: number | undefined, done: (reply: Reply) => void): void {
  if (!forker && !electronMain()) { handle(request, message => done(message as Reply)); return }
  if (stopped) { queueMicrotask(() => done({ id: request.id, error: hostError('The probe host has stopped') })); return }
  const p: Pending = { request, sent: false, settle: reply => {
    if (!pending.delete(request.id)) return
    if (p.timer) clearTimeout(p.timer)
    done(reply)
  } }
  if (bound !== undefined) {
    p.timer = setTimeout(() => p.settle({ id: request.id, error: { message: 'The probe host did not answer in time', code: 'EPROBEHOST', killed: true, signal: null } }), bound)
    ;(p.timer as { unref?: () => void }).unref?.()
  }
  pending.set(request.id, p)
  pump()
}

/** node's execFile, run in the probe host: same callback, stdout/stderr always strings (utf8). */
export function execFile(file: string, args: readonly string[], options: ExecOptions, callback: ExecCallback): void {
  const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : undefined
  submit({ id: nextId++, op: 'exec', file, args: [...args], options: { ...options } },
    timeout === undefined ? undefined : timeout + HOST_GRACE_MS, reply => {
      const e = reply.error
      const error = e ? Object.assign(new Error(e.message), { code: e.code, killed: e.killed ?? false, signal: e.signal ?? null }) as ExecError : null
      callback(error, reply.stdout ?? '', reply.stderr ?? '')
    })
}

/** execFile as a promise of stdout; rejects with the ExecError (its `stderr` attached). */
export function execFileText(file: string, args: readonly string[], options: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve(stdout)
  }))
}

/** A detached program with no stdio, started by the host and not waited on (spawn detached + unref). Resolves its pid,
 *  or undefined when it could not start. */
export function launchDetached(file: string, args: readonly string[], options: LaunchOptions = {}): Promise<number | undefined> {
  return new Promise(resolve => submit({ id: nextId++, op: 'launch', file, args: [...args], options: { ...options } }, 10_000 + HOST_GRACE_MS,
    reply => resolve(reply.error ? undefined : reply.pid)))
}

/** test seam: forget every request and the host, as at a fresh start */
export function resetProbeHostForTests(): void {
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer)
  pending.clear()
  if (reforkTimer) clearTimeout(reforkTimer)
  forker = null; host = null; lastFork = -Infinity; reforkTimer = null; stopped = false; nextId = 1
}
