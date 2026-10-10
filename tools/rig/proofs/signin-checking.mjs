// Proof: before the engine's first sign-in check lands, staffing surfaces say
// "checking sign-ins", never "not signed in" (docket before-the-first-sign-in-
// check-staffing-surfaces, coordinator 2026-10-10 12:13Z).
//   A. the engine restarted with its first check held open (the fake CLI's
//      `--version` waits): at start +0-3 s `/api/providers` says checking,
//      staffing-options says loading and offers no Claude/Codex tier, the
//      devteam previews say "checking the … sign-in" (not "not signed in")
//      and ask to be asked again, and a create from a template is refused
//      with no org left behind;
//   B. once the check lands: the same preview plans opus/sol with no note,
//      staffing-options is no longer loading, and the create hires;
//   C. the desktop: a Create window opened during the check shows "Checking
//      the sign-ins…" with "checking…" in each tier and Create disabled, then
//      fills in the tiers by itself when the check lands.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/signin-checking.mjs [--ui <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const desk = (name) => fileURLToPath(new URL(`../desktop/${name}`, import.meta.url))

export default async function (rig) {
  const p = new Proof('signin-checking')
  const attempt = (f) => f.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const options = () => rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)
  const preview = (id, name) => rig.api('POST', '/api/templates/resolve', { id, name, dirs: [] })
  const notes = (plan) => plan.agents.map((a) => `${a.name}:${a.tier}:${a.note}`)
  const orgCount = (slug) => rig.one(`SELECT count(*)::int AS n FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`).n
  const delayFile = path.join(rig.fakeDir, 'version-delay-ms')
  const checked = () => rig.waitFor(async () => !(await options()).loading, { what: 'the first sign-in check to land', timeout: 60000 })

  // A. restart with the first check held open for 8 s
  await checked()
  fs.writeFileSync(delayFile, '8000')
  await rig.restart()
  const t0 = Date.now()
  const prov = await rig.api('GET', '/api/providers')
  const opts = await options()
  const pc = await preview('devteam-claude', 'Early Claude')
  const px = await preview('devteam-codex', 'Early Codex')
  const early = await attempt(rig.api('POST', '/api/orgs', { name: 'Early Team', dirs: [],
    template: { id: 'devteam-claude', expect: Object.fromEntries(pc.agents.map((a) => [a.slot, a.tier ?? 'opus'])) } }))
  const elapsed = Date.now() - t0
  p.check(`A every read below ran within 3 s of the engine answering (${elapsed} ms)`, elapsed < 3000, { elapsed })
  p.check('A /api/providers says it is still checking', prov.checking === true, { checking: prov.checking, providers: prov.providers.map((x) => x.id) })
  const tiers = opts.tiers.map((t) => t.tier)
  p.check('A staffing-options says loading and offers no Claude or Codex tier yet', opts.loading === true
    && !['opus', 'sonnet', 'sol', 'astra'].some((t) => tiers.includes(t)), { loading: opts.loading, tiers })
  p.check('A devteam (claude) previews as checking the Claude sign-in, never "not signed in", and asks to be asked again',
    pc.loading === true && pc.agents.every((a) => a.tier === null && /checking the Claude sign-in/.test(a.note ?? '') && !/not signed in/.test(a.note ?? '')),
    { loading: pc.loading, agents: notes(pc) })
  p.check('A devteam (codex) previews as checking the Codex sign-in', px.loading === true
    && px.agents.every((a) => /checking the Codex sign-in/.test(a.note ?? '') && !/not signed in/.test(a.note ?? '')), { loading: px.loading, agents: notes(px) })
  p.check('A a create from a template is refused while checking (409), and no org is left behind',
    !early.ok && early.status === 409 && /checking the sign-ins/.test(early.detail) && orgCount('early-team') === 0, early)

  // B. the check lands
  await checked()
  const landed = Date.now() - t0
  const pc2 = await preview('devteam-claude', 'Late Claude')
  const px2 = await preview('devteam-codex', 'Late Codex')
  p.check(`B after the check lands (${landed} ms after start) devteam (claude) plans opus, opus, opus, sonnet with no note and no loading`,
    !pc2.loading && pc2.ok && JSON.stringify(pc2.agents.map((a) => a.tier)) === '["opus","opus","opus","sonnet"]' && pc2.agents.every((a) => !a.note),
    { loading: pc2.loading, agents: notes(pc2), landed })
  p.check('B devteam (codex) plans sol, astra, sol, luna', !px2.loading && px2.ok
    && JSON.stringify(px2.agents.map((a) => a.tier)) === '["sol","astra","sol","luna"]', notes(px2))
  const late = await attempt(rig.api('POST', '/api/orgs', { name: 'Late Team', dirs: [],
    template: { id: 'devteam-claude', expect: Object.fromEntries(pc2.agents.map((a) => [a.slot, a.tier])) } }))
  p.check('B the same create now hires the four agents', late.ok && late.r.hired?.length === 4, late.ok ? late.r : late)
  p.check('B /api/providers no longer says checking', (await rig.api('GET', '/api/providers')).checking === false)

  // C. the desktop, opened during a longer check (the engine gives --version 20 s)
  fs.writeFileSync(delayFile, '18000')
  await rig.restart()
  const ui = await runDesktop(rig, desk('signin-checking.cjs'), { org: '', preset: 'tall', out: path.join(p.dir, 'desktop'),
    args: { shot: 'checking', name: 'Checking Team', template: 'devteam (claude)' } })
  fs.rmSync(delayFile, { force: true })
  const during = ui.value?.during
  const after = ui.value?.after
  p.check('C desktop: during the check the picker says it is checking, each tier reads "checking…", no "cannot run" warning, Create disabled',
    ui.ok && /Checking the sign-ins/.test(during?.checking ?? '') && during.rows.length === 4
      && during.rows.every((r) => r.placeholder === 'checking…' && !/not signed in/.test(r.text)) && during.warn.length === 0 && during.createDisabled === true,
    ui.value ?? ui.error)
  p.check('C desktop: when the check lands the picker fills in opus, opus, opus, sonnet by itself and Create is enabled',
    ui.ok && after?.checking === null && JSON.stringify(after.rows.map((r) => r.tier)) === '["opus","opus","opus","sonnet"]' && after.createDisabled === false,
    after ?? ui.error)
  return p.summary()
}
