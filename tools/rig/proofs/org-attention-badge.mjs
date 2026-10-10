// Proof: the org switcher list shows, per org, how many things wait on the user
//   (open question cards + unread urgent mail + attention-flagged tickets): the
//   row lit and the number in place of the spinner; an org with none looks as
//   before. Two orgs: the rig org (a question from alice, urgent mail from boss,
//   an attention ticket) and "Calm Org" (nothing). The engine's own numbers are
//   checked first; then the dropdown, in dark and light; then clearing one item
//   lowers the number live. Needs --ui.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-attention-badge.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('org-attention-badge')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  const calm = (await rig.api('POST', '/api/orgs', { name: 'Calm Org', dirs: [], net_autoconnect: false })).slug
  const counts = async () => Object.fromEntries((await rig.api('GET', '/api/orgs')).map(o => [o.slug, o.attention]))
  const before = await counts()
  p.check('no attention yet in either org', before[rig.org] === 0 && before[calm] === 0, before)

  const ask = await rig.tool('boss', 'orgtree_ask', { question: 'Which colour?', header: 'Colour' })
  await rig.tool('boss', 'orgtree_message', { to: 'user', body: 'PROOF urgent', urgent: true, urgent_reason: 'proof' })
  await rig.tool('alice', 'orgtree_work', { action: 'create', title: 'Attention ticket', objective: 'proof.\n\nbody', kind: 'non-code', owner: 'alice' })
  await rig.tool('alice', 'orgtree_work', { action: 'update', slug: 'attention-ticket', done_so_far: ['x'], working_on_next: ['y'], attention: true, attention_reason: 'proof' })
  const after = await counts()
  p.check('the engine counts 3 for the rig org (question + urgent mail + ticket) and 0 for the calm one',
    after[rig.org] === 3 && after[calm] === 0, { after, ask: JSON.stringify(ask).slice(0, 160) })

  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/org-attention-badge.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), args: { calm, org: rig.org }, timeout: 400000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) {
    for (const k of ['rigRowLit', 'rigBadge3', 'rigNoSpinner', 'calmRowPlain', 'calmNoBadge', 'lightThemeBadge', 'liveDrop2'])
      p.check(k, ui.value[k] === true, ui.value.detail)
  }
  // the restart entries' styling (same session): red, reddish border, --bad contrast
  const rr = await runDesktop(rig, fileURLToPath(new URL('../desktop/restart-red.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop-restart-red'), timeout: 400000 })
  p.check('restart-red desktop script ran', rr.ok, rr.error)
  if (rr.ok) {
    for (const k of ['sameRedDark', 'sameRedLight', 'borderDark', 'borderLight']) p.check(k, rr.value[k] === true, rr.value)
    p.check('--bad contrast on the page background >= 4.5 (dark / light)',
      rr.value.dark.contrastBadOnBg >= 4.5 && rr.value.light.contrastBadOnBg >= 4.5,
      { dark: rr.value.dark.contrastBadOnBg, light: rr.value.light.contrastBadOnBg })
  }
  p.keep(rig, { agents: ['alice'] })
  return p.summary()
}
