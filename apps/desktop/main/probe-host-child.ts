/** THE PROBE HOST, ITS OWN PROCESS (an Electron utilityProcess; main side and contract in probe-host.ts). The only
 *  module of the desktop main that runs bounded programs (tests/main-thread-guard.test.mjs). It answers each request
 *  with node's own execFile/spawn results: process creation, antivirus scanning included, costs this process's thread
 *  and never the desktop's main thread. Bundled to dist/main/probe-host.cjs (tools/build.mjs). */
import { execFile, spawn } from 'node:child_process'

export type Request = { id: number; op: 'exec' | 'launch'; file: string; args: string[];
  options: { timeout?: number; maxBuffer?: number; windowsHide?: boolean; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; killSignal?: NodeJS.Signals | number } }

interface Port { on(event: 'message', listener: (event: { data: unknown }) => void): unknown; postMessage(message: unknown): void }

const errorOf = (e: unknown) => {
  const x = e as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number }
  return { message: String(x?.message ?? x), code: x?.code, killed: !!x?.killed, signal: x?.signal ?? null }
}

/** Answers `request` exactly once through `reply`. */
export function handle(request: Request, send: (message: unknown) => void): void {
  let answered = false
  const reply = (message: unknown) => { if (!answered) { answered = true; send(message) } }
  const { id, op, file, args, options } = request
  if (op === 'launch') {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd: options.cwd, env: options.env })
      child.once('error', () => { /* reported through pid below when spawn fails synchronously; late errors are moot */ })
      const pid = child.pid
      child.unref()
      reply(pid ? { id, pid } : { id, error: { message: 'The program did not start', code: 'ENOSPAWN' } })
    } catch (e) { reply({ id, error: errorOf(e) }) }
    return
  }
  try {
    const { input, ...rest } = options
    const child = execFile(file, args, { ...rest, encoding: 'utf8' }, (error, stdout, stderr) =>
      reply({ id, error: error ? errorOf(error) : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
    child?.stdin?.on('error', () => {})
    if (input !== undefined) child?.stdin?.end(input)
  } catch (e) { reply({ id, error: errorOf(e), stdout: '', stderr: '' }) }
}

const port = (process as unknown as { parentPort?: Port }).parentPort
if (port) port.on('message', event => {
  const request = event?.data as Request
  if (!request || typeof request.id !== 'number' || typeof request.file !== 'string' || !Array.isArray(request.args)) return
  handle(request, message => { try { port.postMessage(message) } catch { /* main is gone */ } })
})
