import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { POWERSHELL, UAC_CANCELLED, run, type Runner } from './runasadmin'
import { startEngineTask } from './runonstartup'
import { validateDataRoot } from './policy'
import type { EngineOptions } from './engine'

export interface LaunchContext {
  session: number | null; console: number | null; ownsConsole: boolean; known: boolean
  operatorSid: string | null; elevated: boolean; parent?: {pid: number; created: string}
}
export const inConsole = (c: LaunchContext): boolean => c.known === true && Number.isInteger(c.session) && c.session! > 0 && c.session === c.console && c.ownsConsole && typeof c.operatorSid === 'string' && !!c.operatorSid

export async function launchContext(binary: string, runner: Runner = run): Promise<LaunchContext> {
  const r = await runner(binary, ['session-launch', 'inspect', String(process.pid)], 10000)
  if (r.code !== 0) throw new Error('Could not verify the current Windows session.')
  const c = JSON.parse(r.stdout.trim()) as LaunchContext
  if (!c || c.known !== true || typeof c.ownsConsole !== 'boolean' || typeof c.elevated !== 'boolean') throw new Error('Windows session could not be verified; no launch was attempted.')
  return c
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
/** No -Wait: the native host waits for a separate commit. The returned PID proves
 * ShellExecute accepted UAC, not that an engine has been stopped or started. */
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

export interface PreparedSessionLaunch { commit(): Promise<void>; cancel(): Promise<void> }
type Receipt = {nonce?: string; identity?: {pid?: number}; session?: number; admin?: boolean; error?: string}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function json(file: string): Promise<Receipt | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Receipt } catch { return null }
}

/** Readiness is checked before callers stop the old engine. Tests replace this
 * entire elevation seam, so no UAC prompt or real installed task can be invoked. */
export async function prepareSessionLaunch(options: EngineOptions, admin: boolean, runner: Runner = run): Promise<PreparedSessionLaunch> {
  const binary = options.binary
  if (!binary || !path.isAbsolute(binary)) throw new Error('The native engine is required for a session launch.')
  const here = await launchContext(binary, runner)
  if (!inConsole(here) || !here.parent) throw new Error('No signed-in console session is available.')
  const root = validateDataRoot(options.dataRoot, options.forbiddenRoot)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orgtree-session-launch-'))
  const file = path.join(dir, 'request.json'), nonce = randomBytes(32).toString('hex')
  let launched = false, committed = false, closed = false
  const clean = async () => { if (!closed) { await fs.rm(dir, {recursive:true, force:true}); closed = true } }
  const cancel = async () => {
    if (closed || committed) return
    if (!launched) { await clean(); return }
    await fs.writeFile(path.join(dir, 'cancel'), nonce)
    const until = Date.now() + 10000
    while (Date.now() < until) {
      if (await json(path.join(dir, 'done.json')) || await json(path.join(dir, 'error.json'))) { await clean(); return }
      await delay(50)
    }
    // Keep the cancel marker if receipt inspection failed. Native timeout/parent
    // death also closes the waiter; deleting early could erase its cancellation.
  }
  try {
    await fs.writeFile(file, JSON.stringify({nonce, session:here.session, operatorSid:here.operatorSid,
      parent:here.parent, dataRoot:root, uiDirectory:options.uiDirectory, admin}), {flag:'wx'})
    let pid: number
    if (admin) {
      const encoded = Buffer.from(elevationScript(binary, file), 'utf16le').toString('base64')
      const r = await runner(POWERSHELL, ['-NoProfile','-NonInteractive','-EncodedCommand',encoded], 5 * 60000)
      if (r.code === UAC_CANCELLED) throw new Error('Windows did not give permission; the running engine is unchanged.')
      if (r.code !== 0 || !/^\d+$/.test(r.stdout.trim())) throw new Error('The elevated launcher did not start; the running engine is unchanged.')
      pid = Number(r.stdout.trim()); launched = true
    } else {
      pid = await new Promise<number>((resolve,reject) => {
        const child = spawn(binary, ['session-launch','prepare',file], {cwd:path.dirname(binary),windowsHide:true,detached:true,stdio:'ignore'})
        child.once('error',reject)
        child.once('spawn', () => { child.unref(); resolve(child.pid!) })
      })
      launched = true
    }
    const until = Date.now() + 15000
    for (;;) {
      const failed = await json(path.join(dir, 'error.json'))
      if (failed) throw new Error(`Session launcher refused: ${failed.error || 'unknown error'}`)
      const ready = await json(path.join(dir, 'ready.json'))
      if (ready) {
        if (ready.nonce !== nonce || ready.identity?.pid !== pid || ready.session !== here.session || ready.admin !== admin) throw new Error('Session launcher identity did not match.')
        break
      }
      if (Date.now() >= until) throw new Error('Session launcher did not become ready; the running engine is unchanged.')
      await delay(50)
    }
    return { cancel, async commit() {
      if (closed || committed) throw new Error('Session launch already settled')
      await fs.writeFile(path.join(dir, 'commit'), nonce, {flag:'wx'})
      committed = true
      const until = Date.now() + 10000
      while (Date.now() < until) {
        const failed = await json(path.join(dir, 'error.json'))
        if (failed) { await clean(); throw new Error(`Session launch refused: ${failed.error}`) }
        if (await json(path.join(dir, 'done.json'))) { await clean(); return }
        await delay(50)
      }
      throw new Error('Session launch commit could not be confirmed; reconnect before retrying.')
    } }
  } catch (error) { await cancel(); throw error }
}

export async function launchBackground(options: EngineOptions): Promise<void> {
  const c = await launchContext(options.binary!)
  if (!inConsole(c)) { await startEngineTask(); return }
  const prepared = await prepareSessionLaunch(options, false)
  try { await prepared.commit() } finally { await prepared.cancel() }
}

/** The ordering is load-bearing: prompt/prepare first, then graceful stop, then
 * commit. Cancelling permission or preparation cannot touch the old engine. */
export async function replaceWithSessionAdmin(prepare: () => Promise<PreparedSessionLaunch>, stop: () => Promise<void>, attach: () => Promise<void>): Promise<void> {
  const prepared = await prepare()
  try { await stop(); await prepared.commit(); await attach() } finally { await prepared.cancel() }
}
