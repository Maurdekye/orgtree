// "Chat from your phone" (docket orgtree-4-1-chat-from-your-phone-linking-flow-or),
// engine side, through the real engine and the rig's fake Tailscale CLI
// (bin\tailscale.cmd, scripted through rig-home\rig-tailscale).
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { RIG_DIR } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'My Org' },
    agents: [{ name: 'lead', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

export default async function (rig) {
  const p = new Proof('phone-link')
  const tsDir = path.join(rig.data, 'rig-home', 'rig-tailscale')
  const cli = path.join(rig.dir, 'bin', 'tailscale.cmd')
  fs.mkdirSync(tsDir, { recursive: true })
  const status = v => {
    const f = path.join(tsDir, 'status.json')
    if (v === null) fs.rmSync(f, { force: true })
    else fs.writeFileSync(f, JSON.stringify(v))
  }
  // the engine reuses one reading for 2 s
  const phone = async () => { await sleep(2200); return rig.api('GET', '/api/desktop/phone') }
  const running = (extra = {}) => ({
    BackendState: 'Running',
    Self: { HostName: 'home-pc', DNSName: 'home-pc.tail1234.ts.net.', UserID: 7, TailscaleIPs: ['127.0.0.2', 'fd7a:115c:a1e0::2'],
            KeyExpiry: '2027-04-07T10:00:00Z', ...extra },
    User: { 7: { LoginName: 'alex@gmail.com' } },
    CurrentTailnet: { Name: 'alex@gmail.com' },
  })

  // ---- T: Tailscale on this PC
  fs.rmSync(cli)
  let s = await phone()
  p.check('T0: no Tailscale CLI → not installed', s.tailscale?.state === 'T0', s.tailscale)
  fs.copyFileSync(path.join(RIG_DIR, 'fake-tailscale.cmd'), cli)
  status(null)
  s = await phone()
  p.check('T1: CLI installed, its service not answering', s.tailscale?.state === 'T1' && s.tailscale.backend === 'NoDaemon' && /daemon/.test(s.tailscale.error || ''), s.tailscale)
  status({ BackendState: 'NeedsLogin', Self: { HostName: 'home-pc', TailscaleIPs: [] } })
  s = await phone()
  p.check('T1: signed out (NeedsLogin)', s.tailscale?.state === 'T1' && s.tailscale.backend === 'NeedsLogin' && !s.tailscale.account && !s.tailscale.ipv4, s.tailscale)
  status({ BackendState: 'Stopped', Self: { HostName: 'home-pc', TailscaleIPs: ['127.0.0.2'] } })
  s = await phone()
  p.check('T1: switched off (Stopped)', s.tailscale?.state === 'T1' && s.tailscale.backend === 'Stopped' && !s.tailscale.ipv4, s.tailscale)
  status(running())
  s = await phone()
  const t = s.tailscale || {}
  p.check('T2: signed in: account, PC name, address, key expiry', t.state === 'T2' && t.account === 'alex@gmail.com' && t.pc === 'home-pc'
    && t.ipv4 === '127.0.0.2' && t.dns === 'home-pc.tail1234.ts.net' && t.key_expiry === '2027-04-07T10:00:00Z', t)
  const calls = fs.readFileSync(path.join(tsDir, 'calls.log'), 'utf8').trim().split(/\r?\n/)
  p.check('only `tailscale status --json` was run', calls.length >= 4 && calls.every(c => c.trim() === 'status --json'), calls)

  p.note('Tailscale is the rig fake (bin\\tailscale.cmd); the engine ran it through its real process path. The real Tailscale CLI was never run.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
