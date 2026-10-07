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
function run(exe: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, {cwd: os.homedir(), env, windowsHide: true, timeout: 6000, maxBuffer: MAX, encoding: 'utf8'},
      (error, stdout) => error ? reject(new Error('credential lookup failed')) : resolve(stdout))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}
async function lookup(value: Record<string, unknown>): Promise<string> {
  if (value.kind === 'ping') return 'ready'
  if (!hostOK(value.host) || !safe(value.path ?? '') || !safe(value.username ?? '')) throw Error('invalid request')
  const env = lookupEnv()
  if (value.kind === 'gh') {
    const gh = executable('gh', env); if (!gh) throw Error('unavailable')
    const token = (await run(gh, ['auth', 'token', '--hostname', value.host], '', env)).trim()
    if (!token || !safe(token)) throw Error('unavailable')
    return token
  }
  if (value.kind !== 'git') throw Error('invalid request')
  const git = executable('git', env); if (!git) throw Error('unavailable')
  const input = `protocol=https\nhost=${value.host}\n${value.path ? `path=${value.path}\n` : ''}${value.username ? `username=${value.username}\n` : ''}\n`
  const answer = await run(git, ['credential', 'fill'], input, env)
  const fields = new Map(answer.trim().split(/\r?\n/).map(line => {const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]}))
  const username=fields.get('username'), password=fields.get('password')
  if (!safe(username) || !safe(password) || !password) throw Error('unavailable')
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
      if (this.active >= 16) {socket.destroy();return}
      this.active++
      socket.on('close', () => {this.active--})
      socket.on('error', () => {})
      socket.setTimeout(8000, () => socket.destroy())
      let raw=Buffer.alloc(0), handled=false
      socket.on('data', chunk => {
        if (handled) return
        raw=Buffer.concat([raw,chunk])
        if (raw.length>MAX) {socket.destroy();return}
        const end=raw.indexOf(10); if(end<0)return
        handled=true
        void (async()=>{
          try {
            const value=JSON.parse(raw.subarray(0,end).toString('utf8')) as Record<string,unknown>
            raw.fill(0)
            if(typeof value.secret!=='string')throw Error('unauthorized')
            const given=Buffer.from(value.secret), expected=Buffer.from(this.secret)
            if(given.length!==expected.length || !timingSafeEqual(given,expected))throw Error('unauthorized')
            const result=await lookup(value)
            if(!socket.destroyed)socket.end(result)
          } catch {socket.destroy()} // never echo lookup errors, which can contain secrets
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
