/** Secret-only main-process broker. Never log requests, failures, stdout or env.
 * Nothing is persisted, exposed to renderer IPC, or looked up until requested. */
import { createServer, type Server } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { TOKEN_HEADER } from './policy'

const MAX = 65536
const safe = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
const hostOK = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9.:-]{0,252}$/i.test(value)

/** Do not inherit a bridge helper or askpass back into a credential lookup. */
function lookupEnv(): NodeJS.ProcessEnv {
  const env = {...process.env}
  for (const key of Object.keys(env)) {
    if (/^(ORGTREE_CREDENTIAL_|ORGTREE_REAL_GH$|ORGTREE_GH_LAUNCH_ACTIVE$|GIT_CONFIG_(COUNT|KEY_.*|VALUE_.*|PARAMETERS)$|GIT_ASKPASS$|SSH_ASKPASS$)/i.test(key)) delete env[key]
  }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  if (pathKey) env[pathKey] = (env[pathKey] || '').split(path.delimiter).filter(dir => !dir.split(/[\\/]/).some(part => part.toLowerCase() === 'credential-adapters')).join(path.delimiter)
  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'never'
  env.GH_PROMPT_DISABLED = '1'
  return env
}
function executable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  return search.split(path.delimiter).filter(dir => !dir.split(/[\\/]/).some(part => part.toLowerCase() === 'credential-adapters')).map(dir => path.join(dir, name + '.exe')).find(p => path.isAbsolute(p) && fs.existsSync(p))
}
/** Coarse, secret-free failure code. Never carries tool stdout/stderr. */
class LookupFailure extends Error { constructor(readonly code: string) { super(code) } }
function run(tool: string, exe: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, {cwd: os.homedir(), env, windowsHide: true, timeout: 6000, maxBuffer: MAX, encoding: 'utf8'},
      (error, stdout) => {
        if (!error) return resolve(stdout)
        const e = error as NodeJS.ErrnoException & {killed?: boolean; code?: string | number}
        reject(new LookupFailure(e.killed ? `${tool}-timeout`
          : e.code === 'ENOENT' ? `${tool}-missing`
          : typeof e.code === 'number' ? `${tool}-exit-${Math.max(-1, Math.min(255, e.code))}`
          : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? `${tool}-too-large` : `${tool}-failed`))
      })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}
async function lookup(value: Record<string, unknown>): Promise<string> {
  if (value.kind === 'ping') return 'ready'
  if (!hostOK(value.host) || !safe(value.path ?? '') || !safe(value.username ?? '')) throw new LookupFailure('invalid-request')
  const env = lookupEnv()
  if (value.kind === 'gh') {
    const gh = executable('gh', env); if (!gh) throw new LookupFailure('gh-missing')
    const token = (await run('gh', gh, ['auth', 'token', '--hostname', value.host], '', env)).trim()
    if (!token) throw new LookupFailure('gh-empty')
    if (!safe(token)) throw new LookupFailure('gh-malformed')
    return token
  }
  if (value.kind !== 'git') throw new LookupFailure('invalid-request')
  const git = executable('git', env); if (!git) throw new LookupFailure('git-missing')
  const input = `protocol=https\nhost=${value.host}\n${value.path ? `path=${value.path}\n` : ''}${value.username ? `username=${value.username}\n` : ''}\n`
  const answer = await run('git', git, ['credential', 'fill'], input, env)
  const fields = new Map(answer.trim().split(/\r?\n/).map(line => {const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]}))
  const username=fields.get('username'), password=fields.get('password')
  if (!password) throw new LookupFailure('git-empty')
  if (!safe(username) || !safe(password)) throw new LookupFailure('git-malformed')
  return `username=${username}\npassword=${password}\n\n`
}

export class CredentialBridge {
  private server?: Server
  private secret = randomBytes(32).toString('hex')
  private pipe = `\\\\.\\pipe\\orgtree-credentials-${process.pid}-${randomBytes(16).toString('hex')}`
  private ticking = false
  private active = 0
  private async start(): Promise<void> {
    if (this.server) return
    const server = createServer(socket => {
      socket.on('error', () => {})
      if (this.active >= 16) {socket.end("orgtree-credential-busy\n", () => socket.destroy());return}
      this.active++
      socket.on('close', () => {this.active--})
      socket.setTimeout(8000, () => socket.destroy())
      let raw=Buffer.alloc(0), handled=false
      socket.on('data', chunk => {
        if (handled) return
        raw=Buffer.concat([raw,chunk])
        if (raw.length>MAX) {socket.destroy();return}
        const end=raw.indexOf(10); if(end<0)return
        handled=true
        void (async()=>{
          let authorized=false, diagnostics=false
          try {
            const value=JSON.parse(raw.subarray(0,end).toString('utf8')) as Record<string,unknown>
            raw.fill(0)
            if(typeof value.secret!=='string')throw Error('unauthorized')
            const given=Buffer.from(value.secret), expected=Buffer.from(this.secret)
            if(given.length!==expected.length || !timingSafeEqual(given,expected))throw Error('unauthorized')
            authorized=true; diagnostics=value.diagnostics===1
            const result=await lookup(value)
            if(!socket.destroyed)socket.end(result)
          } catch (error) {
            // Only a fixed failure code goes back, and only to the authenticated
            // engine that asked for it. Tool output and messages never leave.
            if(authorized && diagnostics && !socket.destroyed)socket.end(`orgtree-credential-error ${error instanceof LookupFailure ? error.code : 'broker-failed'}
`)
            else socket.destroy()
          }
        })()
      })
    })
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.pipe,()=>{server.removeListener('error',reject);resolve()})})
    server.on('error',()=>{})
    this.server=server
  }
  async tick(origin: string, token: string): Promise<void> {
    if(process.platform!=='win32' || !origin || !token || this.ticking)return
    this.ticking=true
    try {
      const url=new URL(origin)
      if(url.protocol!=='http:' || url.hostname!=='127.0.0.1')return
      await this.start()
      // Existing authenticated engine attachment. The engine verifies our pipe
      // server PID, Windows SID and interactive logon before accepting a lease.
      await fetch(origin+'/api/desktop/credential-bridge',{method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),
        headers:{[TOKEN_HEADER]:token,'Content-Type':'application/json'},body:JSON.stringify({pipe:this.pipe,secret:this.secret,pid:process.pid})})
    } catch { /* next existing desktop poll retries; the engine lease expires */ }
    finally {this.ticking=false}
  }
}
