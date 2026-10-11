// Isolated production lifecycle/credential controller, without an Electron UI.
// No credential lookup is requested. The config and result belong to the rig.
import fs from 'node:fs'
import path from 'node:path'
import {CredentialBridge} from '../../apps/desktop/main/credential-bridge'
import {CoreLifecycle} from '../../apps/desktop/main/core-lifecycle'
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bridge = new CredentialBridge()
const endpoint = () => {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(cfg.root, 'engine-attach.json'), 'utf8'))
    return {origin: `http://127.0.0.1:${a.port}`, token: a.token}
  } catch { return {origin: '', token: ''} }
}
const core = new CoreLifecycle(cfg.engine, cfg.root, bridge, endpoint, () => {
  fs.writeFileSync(cfg.result, JSON.stringify({pid: process.pid, stopped: true}))
  core.stop(); process.exit(0)
})
fs.writeFileSync(cfg.result, JSON.stringify({pid: process.pid, started: true}))
core.start()
let busy = false
setInterval(() => {
  if (busy || !fs.existsSync(cfg.result + '.command')) return
  busy = true
  const {id, action} = JSON.parse(fs.readFileSync(cfg.result + '.command', 'utf8'))
  fs.unlinkSync(cfg.result + '.command')
  void (async () => {
    try {
      if (action === 'complete') await core.complete()
      else if (action === 'transition' || action === 'install') await core.transition(action === 'install')
      else throw new Error('unknown rig action')
      fs.writeFileSync(cfg.result + '.reply', JSON.stringify({id, ok:true}))
    } catch { fs.writeFileSync(cfg.result + '.reply', JSON.stringify({id, ok:false})) }
    finally { busy = false }
  })()
}, 500)
