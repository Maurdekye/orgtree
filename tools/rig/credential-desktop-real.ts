// Runs the unchanged production desktop credential broker, without a window.
// Its startup file belongs only to the isolated rig and is removed with that run.
import { CredentialBridge } from '../../apps/desktop/main/credential-bridge'
import fs from 'node:fs'
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bridge = new CredentialBridge()
void bridge.tick(cfg.origin, cfg.token)
setInterval(() => { void bridge.tick(cfg.origin, cfg.token) }, 5000)
fs.writeFileSync(process.argv[3], JSON.stringify({pid:process.pid}))
setTimeout(() => process.exit(0), 600000)
