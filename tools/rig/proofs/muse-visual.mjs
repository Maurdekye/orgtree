// Proof: Muse's colours where people see them (user 2026-10-12 20:09Z: the
// official baby-blue cyan, readable in every theme; lead 2026-10-13: check in
// the rendered views that letters, rails and icons, not colour alone, tell a
// Muse card from a Flash card and from a frozen one).
//   wanda wonder, fiona wonder-full, sami spark: idle Muse cards, one a tier.
//   hilde spark: a Muse quota wall, so frozen.
//   fred flash: an Antigravity Flash card beside them.
// In charcoal and light: every Muse card wears the Muse accent (#afe5ff dark,
// #0077b0 light) and its own tier letter; the Flash card the Antigravity
// blue and its F; the frozen card says Frozen with the snowflake up close and
// the frozen icon far out; the Providers row and the Usage card are Muse's.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-visual.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { RIG_DIR } from '../lib.mjs'

const CARDS = [['wanda', 'wonder', 'W'], ['fiona', 'wonder-full', 'F'], ['sami', 'spark', 'S'], ['hilde', 'spark', 'S'],
  ['fred', 'flash', 'F']]
const MUSE = ['wanda', 'fiona', 'sami', 'hilde']
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const ROW = (modelId, isDefault, variants) => ({ modelId, profileId: 'tbh', isDefault, variants,
  defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })

export default async function (rig) {
  const p = new Proof('muse-visual')
  rig.scenario({ agents: {
    hilde: { turns: [{ name: 'limited', match: 'PROOF-LIMIT', once: true, steps: [{ text: 'Trying.' },
      { quota: { resetsAtMs: Date.now() + 2 * 3600 * 1000 } }] }] },
  }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  // the account's own catalog offers all three Muse tiers
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), JSON.stringify({ source: 'providerCatalog', models: [
    ROW('muse-wonder-1.0', true, levels), ROW('muse-wonder-full-1.0', false, levels), ROW('muse-spark-1.3', false, levels)] }))
  await rig.api('GET', '/api/muse/usage?force=true')
  for (const [name, tier] of CARDS) {
    await rig.op({ op: 'hire', parent: 'boss', name, tier, title: `${tier} card` })
  }
  await rig.userMail('hilde', 'PROOF-LIMIT: please try.')
  await rig.waitFor(() => rig.agentRow('hilde')?.frozen, { what: 'hilde frozen', timeout: 30000 })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'turns to settle', timeout: 60000 })

  for (const theme of ['charcoal', 'light']) {
    const r = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'muse-visual.cjs'),
      { preset: '1600x1200', args: { org: rig.org, theme, agents: CARDS.map((c) => c[0]) },
        out: path.join(p.dir, 'desktop-' + theme), timeout: 150000 })
    p.file(`desktop-${theme}.json`, r)
    p.check(`${theme}: the desktop stage ran (screenshots in ${path.join(p.dir, 'desktop-' + theme)})`, r.ok, r.error)
    if (!r.ok) continue
    const { near, far, providers, usage } = r.value
    const accent = theme === 'light' ? '#0077b0' : '#afe5ff'
    p.check(`${theme}: every Muse card wears the Muse accent ${accent}`, MUSE.every((n) =>
      near[n]?.cls.includes('prov-muse') && near[n].providerAccent.toLowerCase() === accent),
    Object.fromEntries(MUSE.map((n) => [n, near[n]?.providerAccent])))
    p.check(`${theme}: the Flash card wears the Antigravity accent, not Muse's`, near.fred?.cls.includes('prov-google')
      && near.fred.providerAccent.toLowerCase() !== accent, near.fred)
    p.check(`${theme}: each card carries its own tier letter (W, F, S; F for Flash)`, CARDS.every(([n, , letter]) =>
      near[n]?.chip?.text === letter || near[n]?.text.includes(letter)), Object.fromEntries(CARDS.map(([n]) => [n, near[n]?.chip])))
    p.check(`${theme}: the frozen Muse card says Frozen and shows the snowflake`, /^Frozen/.test(near.hilde?.state ?? '')
      && near.hilde.snowflake, near.hilde)
    p.check(`${theme}: far out, the Muse rail is the Muse accent and the Flash rail is not`, MUSE.every((n) =>
      far[n]?.rail === rgbOf(accent)) && far.fred?.rail && far.fred.rail !== rgbOf(accent),
    Object.fromEntries(CARDS.map(([n]) => [n, far[n]?.rail])))
    p.check(`${theme}: far out, only the frozen card has the frozen icon`, far.hilde?.farIcons.some((c) => /frozen/.test(c))
      && ['wanda', 'fiona', 'sami', 'fred'].every((n) => !far[n]?.farIcons.some((c) => /frozen/.test(c))),
    Object.fromEntries(CARDS.map(([n]) => [n, far[n]?.farIcons])))
    p.check(`${theme}: the Providers row is Muse's, with its W/F/S tiers`, /Muse/.test(providers.head)
      && ['t-wonder', 't-wonder-full', 't-spark'].every((c) => providers.tiers.some((t) => t.cls.split(' ').includes(c))), providers)
    p.check(`${theme}: the Usage window has a Muse Code card`, usage.some((c) => c.label === 'Muse Code'), usage)
  }

  // the desk's effort control offers each tier's own level names
  const effort = {}
  for (const agent of ['wanda', 'alice']) {
    const r = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'muse-effort.cjs'),
      { args: { agent }, out: path.join(p.dir, 'effort-' + agent), timeout: 90000 })
    p.file(`effort-${agent}.json`, r)
    effort[agent] = r.ok ? r.value : { error: r.error }
  }
  p.check('effort: a Muse Wonder desk offers Muse\'s six names (minimal..max)',
    JSON.stringify(effort.wanda?.levels) === JSON.stringify(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']), effort.wanda)
  p.check('effort: a Claude Sonnet desk keeps Claude Code\'s five (low..max)',
    JSON.stringify(effort.alice?.levels) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']), effort.alice)
  p.keep(rig, { agents: ['hilde'], grep: /muse|quota|frozen/i })
  return p.summary()
}
