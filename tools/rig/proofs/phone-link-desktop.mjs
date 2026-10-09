// "Chat from your phone" in the real renderer (docket
// orgtree-4-1-chat-from-your-phone-linking-flow-or), against a rig run that
// hosts its own hub and serves this worktree's renderer. The page script
// (desktop/phone-link.cjs) walks the card → panel → link → Unlink and takes
// the screenshots; this proof prepares the engine and checks what the
// clicks did on disk.
// Run: node tools/rig/build-ui.mjs, then
//      node tools/rig/rig.mjs run tools/rig/proofs/phone-link-desktop.mjs --hub <orgtree-mailhub.exe> --ui <bundle>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export async function setup(flags) {
  return { hub: flags.hub ?? true, fixture: { org: { name: 'My Org' },
    agents: [{ name: 'lead', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('phone-link-desktop')
  if (!rig.run.ui) throw Error('run with --ui <bundle> (tools/rig/build-ui.mjs)')
  const org = rig.org
  const home = path.join(rig.data, 'rig-home')
  const tsDir = path.join(home, 'rig-tailscale'), fwDir = path.join(home, 'rig-firewall')
  for (const d of [tsDir, fwDir, path.join(home, 'rig-power')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(home, 'rig-power', 'ac-sleep-seconds'), '1800')
  fs.writeFileSync(path.join(tsDir, 'prefs.json'), JSON.stringify({ ForceDaemon: true }))
  // Tailscale is not installed yet
  fs.rmSync(path.join(rig.dir, 'bin', 'tailscale.cmd'))
  const running = {
    BackendState: 'Running',
    Self: { HostName: 'home-pc', DNSName: 'home-pc.tail1234.ts.net.', UserID: 7, TailscaleIPs: ['127.0.0.2'], KeyExpiry: '2027-04-07T10:00:00Z' },
    User: { 7: { LoginName: 'alex@gmail.com' } }, CurrentTailnet: { Name: 'alex@gmail.com' },
  }
  // the bar: the org on this computer's hub, and the user's first message to lead
  await rig.api('POST', `/api/orgs/${org}/settings`, { net_autoconnect: true })
  await rig.waitFor(() => rig.api('GET', `/api/orgs/${org}`).then(t => (t.net?.hubs ?? []).find(h => h.connected)), { what: 'the org on the rig hub', timeout: 90000 })
  const original = '# My Org\nWe research and summarize papers for Alex.\n'
  await rig.api('PUT', `/api/orgs/${org}/orgmd`, { content: original })
  await rig.userMail('lead', 'hello lead')
  await rig.waitFor(async () => (await rig.api('GET', `/api/desktop/phone?org=${org}`)).card?.show, { what: 'the card bar', timeout: 90000 })
  // the smoke "installs" Tailscale (puts the fake CLI back) and signs it in
  const { RIG_DIR } = await import('../lib.mjs')
  const cliSrc = path.join(RIG_DIR, 'fake-tailscale.cmd'), cliDst = path.join(rig.dir, 'bin', 'tailscale.cmd')

  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/phone-link.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), preset: 'wide', timeout: 300000, args: { tsDir, fwDir, running, cliSrc, cliDst } })
  p.check('the page walked card → panel → linked → Unlink without an error', ui.ok, ui.error || ui.value)
  const v = ui.value || {}
  p.check('the org window\'s card names the flow and offers Connect', /Chat from your phone/.test(v.card || '') && /Connect your phone/.test(v.card || ''), v.card)
  p.check('the prompt was asked twice (No, then Yes), for the Tailscale scope', JSON.stringify(v.fw) === '["tailnet","tailnet"]', v.fw)
  p.check('the setup QR carried the door, the org and the account', /^hubchat:\/\/setup\?v=1&hub=http%3A%2F%2F127%2E0%2E0%2E2%3A7371&/.test(v.url || '') && /ts=alex%40gmail%2Ecom/.test(v.url || ''), v.url)
  p.check('the card is gone once linked', v.cardAfterLink === false)
  const md = fs.readFileSync(path.join(rig.data, 'workspaces', org, 'org.md'), 'utf8')
  const settings = JSON.parse(fs.readFileSync(path.join(rig.data, 'phone.json'), 'utf8'))
  p.check('after Unlink, org.md is as it was and no link is recorded', md === original && !settings.link, { md, settings })
  for (const s of ui.shots ?? []) p.note(`screenshot ${s.name}`, s.file)
  if (ui.consoleErrors?.length) p.note('console errors', ui.consoleErrors)
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
