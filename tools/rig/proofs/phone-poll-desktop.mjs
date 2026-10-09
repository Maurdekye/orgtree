// "Chat from your phone": the org window's requests about the phone while the
// panel is closed (coordinator review point 3), counted in the real renderer.
// Run once with the UI bundle before the fix and once after; the counts are
// the before/after.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/phone-poll-desktop.mjs --hub <orgtree-mailhub.exe> --ui <bundle>
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
  const p = new Proof('phone-poll-desktop')
  if (!rig.run.ui) throw Error('run with --ui <bundle> (tools/rig/build-ui.mjs)')
  const org = rig.org
  // the bar: the org on this computer's hub, and the user's first message to lead
  await rig.api('POST', `/api/orgs/${org}/settings`, { net_autoconnect: true })
  await rig.waitFor(() => rig.api('GET', `/api/orgs/${org}`).then(t => (t.net?.hubs ?? []).find(h => h.connected)), { what: 'the org on the rig hub', timeout: 90000 })
  await rig.userMail('lead', 'hello lead')
  await rig.waitFor(async () => (await rig.api('GET', `/api/desktop/phone?org=${org}`)).card?.show, { what: 'the card bar', timeout: 90000 })
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/phone-poll.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), preset: 'wide', timeout: 300000, args: { seconds: 60 } })
  p.check('the page counted its phone requests for a minute, card showing and dismissed', ui.ok, ui.error || ui.value)
  const v = ui.value || {}
  p.note('requests in 60 s with the card showing (panel closed)', v.showing)
  p.note('requests in 60 s after the card was dismissed', v.dismissed)
  const result = p.summary()
  result.counts = v
  return result
}
