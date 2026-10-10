// tools/rig/credential-desktop-stub.mjs <out.json>: the desktop's credential
// broker pipe, as apps/desktop/main/credential-bridge.ts serves it, for the
// credential-broker proof's handover checks. It answers only ping (never a
// credential), writes its pipe, test secret and pid to <out.json>, and exits
// after ten minutes. The proof registers it with the engine on its behalf.
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'

const secret = crypto.randomBytes(32).toString('hex')
const pipe = `\\\\.\\pipe\\orgtree-credentials-${process.pid}-${crypto.randomBytes(16).toString('hex')}`
net.createServer(s => {
  let raw = ''
  s.on('error', () => {})
  s.on('data', c => {
    raw += c
    const end = raw.indexOf('\n')
    if (end < 0) return
    let v = {}
    try { v = JSON.parse(raw.slice(0, end)) } catch {}
    if (v.secret !== secret) return s.destroy()
    s.end(v.kind === 'ping' ? 'ready' : 'orgtree-credential-error invalid-request\n')
  })
}).listen(pipe, () => fs.writeFileSync(process.argv[2], JSON.stringify({ pipe, secret, pid: process.pid })))
setTimeout(() => process.exit(0), 600000)
