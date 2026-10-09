// "Chat from your phone" (docket orgtree-4-1-chat-from-your-phone-linking-flow-or),
// engine side, through the real engine and the rig's fake Tailscale CLI
// (bin\tailscale.cmd, scripted through rig-home\rig-tailscale).
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { RIG_DIR } from '../lib.mjs'

export async function setup() {
  return { hub: true, fixture: { org: { name: 'My Org' },
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

  // ---- A: phone access (the hub's relay-only door) and the firewall rule
  const elevDir = path.join(rig.data, 'rig-home', 'rig-elevate')
  fs.mkdirSync(elevDir, { recursive: true })
  const answer = a => fs.writeFileSync(path.join(elevDir, 'answer'), a)
  const turnOn = (body) => rig.api('POST', '/api/desktop/phone/access', body).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e.message || e) }))
  const doorAnswers = async (host) => {
    try { const r = await fetch(`http://${host}:7371/healthz`, { signal: AbortSignal.timeout(3000) }); return r.status } catch { return 0 }
  }
  s = await phone()
  p.check('A0 at first: the door is closed, no firewall rule', s.access?.state === 'A0' && !s.access.door && !s.access.firewall && s.keep_awake === true, s.access)

  status({ BackendState: 'NeedsLogin', Self: { HostName: 'home-pc', TailscaleIPs: [] } })
  await sleep(2200)
  let r = await turnOn({ scope: 'tailnet' })
  p.check('Turn on is refused while Tailscale is not connected', !r.ok && /not connected/.test(r.e), r)

  status(running())
  await sleep(2200)
  answer('no')
  r = await turnOn({ scope: 'tailnet', keep_awake: false })
  s = await phone()
  p.check('No at the administrator prompt: nothing changed', !r.ok && /Nothing changed: phone access stays as it was\./.test(r.e)
    && s.access.state === 'A0' && !s.access.firewall && s.keep_awake === true, { r, access: s.access })

  answer('yes')
  r = await turnOn({ scope: 'tailnet', keep_awake: false })
  s = r.v || {}
  const hosting = JSON.parse(fs.readFileSync(path.join(rig.data, 'mailhub-hosting.json'), 'utf8'))
  p.check('Yes: A1 for the Tailscale network, the door bound to the 100.x address only', r.ok && s.access?.state === 'A1'
    && s.access.scope === 'tailnet' && s.access.door === '127.0.0.2' && hosting.public_listener === true && hosting.public_scope === 'tailnet', { r, hosting })
  p.check('the firewall rule admits Tailscale addresses only', s.access?.firewall === '100.64.0.0/10,fd7a:115c:a1e0::/48', s.access)
  const elev = fs.readFileSync(path.join(elevDir, 'calls.log'), 'utf8')
  p.check('one prompt per attempt, and the script adds an inbound rule for port 7371', (elev.match(/^--- /gm) || []).length === 2
    && /New-NetFirewallRule -DisplayName 'Orgtree phone access'/.test(elev) && /-LocalPort 7371 -RemoteAddress 100\.64\.0\.0\/10,fd7a:115c:a1e0::\/48 -Profile Any/.test(elev), elev)
  p.check('keep-awake saved as chosen', JSON.parse(fs.readFileSync(path.join(rig.data, 'phone.json'), 'utf8')).keep_awake === false)
  p.check('the door answers on the Tailscale address and not on 127.0.0.1', (await doorAnswers('127.0.0.2')) > 0 && (await doorAnswers('127.0.0.1')) === 0)

  status(running({ TailscaleIPs: ['127.0.0.3'] }))
  s = await phone()
  s = await phone()
  p.check('Tailscale address moved: the hub restarts and the door follows it', s.access.door === '127.0.0.3' && (await doorAnswers('127.0.0.3')) > 0
    && (await doorAnswers('127.0.0.2')) === 0, s.access)

  status({ BackendState: 'NeedsLogin', Self: { HostName: 'home-pc', TailscaleIPs: [] } })
  s = await phone()
  s = await phone()
  p.check('Tailscale signed out: the door closes, waiting; the hub keeps running', !s.access.door && s.access.door_waiting === true
    && s.hub.running === true && (await doorAnswers('127.0.0.3')) === 0, s)

  status(running())
  s = await phone()
  s = await phone()
  p.check('Tailscale back: the door opens again', s.access.door === '127.0.0.2' && !s.access.door_waiting, s.access)

  await rig.api('PUT', '/api/desktop/hub', { public_scope: 'all' })
  s = await phone()
  p.check('A2: on for every network (the hub settings switch)', s.access.state === 'A2' && s.access.door === '127.0.0.1', s.access)
  r = await turnOn({ scope: 'tailnet' })
  p.check('Limit it to Tailscale: A2 → A1', r.ok && r.v.access.state === 'A1' && r.v.access.scope === 'tailnet' && r.v.access.door === '127.0.0.2', r)

  r = await turnOn({ scope: 'lan' })
  p.check('Use my home Wi-Fi instead: A1 for the home network, rule limited to the local subnet', r.ok && r.v.access.scope === 'lan'
    && r.v.access.firewall === 'LocalSubnet' && r.v.access.state === 'A1', r)
  r = await turnOn({ scope: 'everyone' })
  p.check('an unknown scope is refused', !r.ok && /scope must be tailnet or lan/.test(r.e), r)
  await turnOn({ scope: 'tailnet' })

  p.note('Tailscale is the rig fake (bin\\tailscale.cmd); the engine ran it through its real process path. The real Tailscale CLI was never run.')
  p.note('The administrator prompt and the firewall are mocks in rig mode (rig-home\\rig-elevate, rig-home\\rig-firewall); the real elevation path (Start-Process -Verb RunAs, New-NetFirewallRule) is not exercised here. The 100.x address is played by 127.0.0.2/127.0.0.3, and a rig hub never binds 0.0.0.0.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
