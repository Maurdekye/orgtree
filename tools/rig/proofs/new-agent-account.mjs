// Proof: Org settings › Hire defaults › "account for NEW agents" keeps its
// layout when another account is chosen (docket org-settings-choosing-another-
// account-for-new-ag, user screenshots 2026-10-10 14:35Z). With a second Claude
// account (a long email), in the charcoal and light themes, at a normal, a
// narrow and a phone-narrow width:
//   - the picker keeps the same width whichever account is chosen, the long
//     label ellipsizing with the whole label as its tooltip;
//   - "Use machine default" appears whole, inside the row, and nothing in the
//     panel scrolls sideways;
//   - the row keeps a help line in both states;
//   - the neighbouring rows (permission mode, provider) stay inside the panel.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/new-agent-account.mjs [--ui <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const desk = fileURLToPath(new URL('../desktop/new-agent-account.cjs', import.meta.url))
const WIDTHS = ['1366x900', '760x900', '440x900']

export default async function (rig) {
  const p = new Proof('new-agent-account')
  // a second Claude sign-in with a long address, as the user's claude-5 is
  const home = path.join(rig.data, 'rig-home', 'claude-b')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a-rather-long-second-address@example.invalid' } }))
  const other = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported', path: home })).id

  for (const theme of ['charcoal', 'light']) {
    for (const size of WIDTHS) {
      const tag = `${theme}-${size}`
      const r = await runDesktop(rig, desk, { preset: size, out: path.join(p.dir, tag), timeout: 240000, args: { org: rig.org, theme, other, tag } })
      p.check(`${tag}: the desktop script ran`, r.ok, r.ok ? undefined : r.error ?? r)
      if (!r.ok) continue
      const { before: b, after: a } = r.value
      const inside = (x, row) => x && row && x.l >= row.l - 1 && x.r <= row.r + 1
      p.check(`${tag}: the picker keeps its width when another account is chosen (${b.select?.w} → ${a.select?.w}px)`,
        b.select && a.select && Math.abs(b.select.w - a.select.w) <= 1, { before: b.select, after: a.select })
      p.check(`${tag}: the chosen account is the second one, its whole label in the tooltip`,
        /a-rather-long-second-address@example\.invalid/.test(a.selectTitle ?? ''), { text: a.selectText, title: a.selectTitle })
      p.check(`${tag}: "Use machine default" is whole and inside the row; nothing scrolls sideways`,
        a.buttonText === 'Use machine default' && !a.buttonClipped && inside(a.button, a.row) && inside(a.select, a.row) && a.overflowX <= 0,
        { row: a.row, select: a.select, button: a.button, clipped: a.buttonClipped, overflowX: a.overflowX })
      p.check(`${tag}: the row keeps a help line in both states`, !!b.hint && !!a.hint, { before: b.hint, after: a.hint })
      p.check(`${tag}: the neighbouring rows stay inside the panel`,
        [...b.neighbours, ...a.neighbours].every((n) => inside(n.select, n.row)) && b.overflowX <= 0, { before: b.neighbours, after: a.neighbours })
    }
  }
  return p.summary()
}
