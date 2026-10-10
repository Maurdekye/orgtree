// Proof: organization templates (docket create-organizations-from-agent-layout-templates).
// The two bundled templates create an org with their tree of agents in one
// step; a template whose tiers cannot run (the Codex lane turned off) is
// blocked in the preview and refused at create, leaving no org; a hire that
// fails mid-template rolls the whole org back; an org's layout saves as a
// template file and a new org is created from it; "restore default
// templates" writes back deleted built-ins. Screenshots: the picker (both
// templates, and the blocked case), Save as template (modal, saved, download)
// and the App settings controls.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-templates.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const desk = (name) => fileURLToPath(new URL(`../desktop/${name}`, import.meta.url))

export default async function (rig) {
  const p = new Proof('org-templates')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const tpDir = path.join(rig.data, 'rig-home', '.orgtree', 'templates')
  const presets = Object.fromEntries(['coordinator', 'implementer', 'redteam', 'curator'].map((n) =>
    [n, fs.readFileSync(fileURLToPath(new URL(`../../../engine/docs/charters/${n}.md`, import.meta.url)), 'utf8')]))
  const tree = (slug) => rig.sql(`SELECT a.name, a.tier, p.name AS parent, a.grant_credits::float8 AS grant, a.seat::float8 AS seat,
      a.account, left(a.charter, 60) AS charter_head, md5(a.charter) AS charter_md5
    FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id LEFT JOIN ot.agents p ON p.id = a.parent_id
    WHERE o.slug = '${slug}' AND o.state = 'active' AND a.state = 'live' ORDER BY a.id`)
  const orgRow = (slug) => rig.one(`SELECT id, state FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`)
  const attempt = (f) => f.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))

  // 1. the list
  const list = await rig.api('GET', '/api/templates')
  const ids = list.templates.map((t) => t.id)
  p.check('the two bundled templates are listed and usable', ['devteam-claude', 'devteam-codex'].every((id) => ids.includes(id))
    && list.templates.every((t) => t.problems.length === 0), list.templates.map((t) => ({ id: t.id, source: t.source, problems: t.problems })))

  // 2. devteam (claude): preview, then create
  const pc = await rig.api('POST', '/api/templates/resolve', { id: 'devteam-claude', name: 'Claude Team', dirs: [] })
  p.check('devteam (claude) previews as coordinator opus + implementer opus, redteam opus, curator sonnet; top grant 20',
    pc.ok && JSON.stringify(pc.agents.map((a) => [a.name, a.tier, a.parent])) === JSON.stringify([
      ['coordinator', 'opus', null], ['implementer', 'opus', 'coordinator'], ['redteam', 'opus', 'coordinator'], ['curator', 'sonnet', 'coordinator']])
      && pc.top_grant === 20, pc.agents.map((a) => `${a.name}:${a.tier}:${a.account}:${a.seat}+${a.grant}`))
  const expect = (plan) => Object.fromEntries(plan.agents.map((a) => [a.slot, a.tier]))
  const cc = await attempt(rig.api('POST', '/api/orgs', { name: 'Claude Team', dirs: [], template: { id: 'devteam-claude', expect: expect(pc) } }))
  const ct = tree('claude-team')
  p.check('creating from devteam (claude) hires the four agents in the new org, each with its charter preset (trimmed, as every hire stores a charter)',
    cc.ok && cc.r.hired?.length === 4 && ct.length === 4
      && ct.every((a) => a.charter_md5 === crypto.createHash('md5').update(presets[a.name].trim(), 'utf8').digest('hex')) && ct[0].grant === 20 && ct.slice(1).every((a) => a.grant === 0),
    { response: cc.r ?? cc, tree: ct })
  const kick1 = rig.one(`SELECT count(*)::int AS n FROM ot.mail m JOIN ot.orgs o ON o.id = m.org_id WHERE o.slug = 'claude-team' AND m.ev->>'variant' = 'lifecycle.kickoff'`)
  p.check('the first message is off by default: no kickoff mail in the new org', kick1.n === 0, kick1)

  // 3. devteam (codex) with the first message asked for
  const px = await rig.api('POST', '/api/templates/resolve', { id: 'devteam-codex', name: 'Codex Team', dirs: [] })
  p.check('devteam (codex) previews as coordinator sol + implementer astra, redteam sol, curator luna',
    px.ok && JSON.stringify(px.agents.map((a) => [a.name, a.tier])) === JSON.stringify([['coordinator', 'sol'], ['implementer', 'astra'], ['redteam', 'sol'], ['curator', 'luna']]),
    px.agents.map((a) => `${a.name}:${a.tier}:${a.account}:${a.seat}+${a.grant}`))
  const cx = await attempt(rig.api('POST', '/api/orgs', { name: 'Codex Team', dirs: [], template: { id: 'devteam-codex', expect: expect(px), kickoff: true } }))
  const xt = tree('codex-team')
  const kick2 = rig.sql(`SELECT m.recipient_name, left(m.body, 40) AS body FROM ot.mail m JOIN ot.orgs o ON o.id = m.org_id WHERE o.slug = 'codex-team' AND m.ev->>'variant' = 'lifecycle.kickoff'`)
  p.check('creating from devteam (codex) hires its four agents; the coordinator grant covers astra + sol + luna seats (10 + 12.1)',
    cx.ok && xt.length === 4 && xt[0].grant === 22.1, { response: cx.r ?? cx, tree: xt })
  p.check('with the first message ticked, the coordinator (only) gets it', kick2.length === 1 && kick2[0].recipient_name === 'coordinator', kick2)

  // screenshots of the picker while every lane is on
  const shotClaude = await runDesktop(rig, desk('org-templates-create.cjs'), { org: '', preset: 'tall', out: path.join(p.dir, 'desktop-claude'),
    args: { shot: 'picker-devteam-claude', name: 'Picked Claude', template: 'devteam (claude)' } })
  p.check('desktop: the picker previews devteam (claude) with Create enabled', shotClaude.ok && shotClaude.value?.before?.rows?.length === 4
    && shotClaude.value.before.createDisabled === false, shotClaude.value ?? shotClaude.error)
  const shotCodex = await runDesktop(rig, desk('org-templates-create.cjs'), { org: '', preset: 'tall', out: path.join(p.dir, 'desktop-codex'),
    args: { shot: 'picker-devteam-codex', name: 'Picked Codex', template: 'devteam (codex)' } })
  p.check('desktop: the picker previews devteam (codex) with Create enabled', shotCodex.ok && shotCodex.value?.before?.rows?.length === 4
    && shotCodex.value.before.createDisabled === false, shotCodex.value ?? shotCodex.error)

  // 4. the Codex lane unavailable: blocked
  await rig.api('PUT', '/api/providers/openai/enabled', { enabled: false })
  const pb = await rig.api('POST', '/api/templates/resolve', { id: 'devteam-codex', name: 'Blocked Team', dirs: [] })
  p.check('with the Codex lane off, devteam (codex) previews as blocked on all four agents', pb.ok === false && pb.blocked.length === 4
    && pb.agents.every((a) => a.blocked && a.tier === null), { blocked: pb.blocked, notes: pb.agents.map((a) => a.note) })
  const cb = await attempt(rig.api('POST', '/api/orgs', { name: 'Blocked Team', dirs: [], template: { id: 'devteam-codex' } }))
  p.check('creating it is refused (422) and no org is left behind', !cb.ok && cb.status === 422 && !orgRow('blocked-team'), cb)
  const stale = await attempt(rig.api('POST', '/api/orgs', { name: 'Stale Team', dirs: [], template: { id: 'devteam-claude',
    overrides: { coordinator: { tier: 'opus' } }, expect: { coordinator: 'sol', implementer: 'opus', redteam: 'opus', curator: 'sonnet' } } }))
  p.check('a create whose plan moved since the preview is refused (409), no org left', !stale.ok && stale.status === 409 && !orgRow('stale-team'), stale)
  const shotBlocked = await runDesktop(rig, desk('org-templates-create.cjs'), { org: '', preset: 'tall', out: path.join(p.dir, 'desktop-blocked'),
    args: { shot: 'picker-devteam-codex-blocked', name: 'Blocked Team', template: 'devteam (codex)' } })
  p.check('desktop: with Codex off the picker marks every agent "needs a sign-in" and Create is disabled', shotBlocked.ok
    && shotBlocked.value?.before?.rows?.every((r) => r.blocked) && shotBlocked.value.before.createDisabled === true,
    shotBlocked.value ?? shotBlocked.error)
  const shotFixed = await runDesktop(rig, desk('org-templates-create.cjs'), { org: '', preset: 'tall', out: path.join(p.dir, 'desktop-fixed'),
    args: { shot: 'picker-devteam-codex-picked-tiers', name: 'Picked Over', template: 'devteam (codex)', create: true,
      overrides: { coordinator: 'opus', implementer: 'opus', redteam: 'sonnet', curator: 'haiku' } } })
  const ft = tree('picked-over')
  p.check('desktop: picking a Claude tier for each blocked agent enables Create, and Create makes the org with those tiers', shotFixed.ok
    && shotFixed.value?.before?.createDisabled === false && JSON.stringify(ft.map((a) => a.tier)) === JSON.stringify(['opus', 'opus', 'sonnet', 'haiku']),
    { ui: shotFixed.value ?? shotFixed.error, tree: ft })
  await rig.api('PUT', '/api/providers/openai/enabled', { enabled: true })

  // 5. a hire refused mid-template rolls the org back
  fs.mkdirSync(tpDir, { recursive: true })
  fs.writeFileSync(path.join(tpDir, 'too-rich.json'), JSON.stringify({ id: 'too-rich', name: 'Too rich', agents: [
    { name: 'lead', tier: 'opus', spare: 5000, reports: [{ name: 'helper', tier: 'haiku' }] }] }))
  const rich = await attempt(rig.api('POST', '/api/orgs', { name: 'Rich Team', dirs: [], template: { id: 'too-rich' } }))
  const richAgents = rig.one(`SELECT count(*)::int AS n FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE o.slug = 'rich-team'`)
  p.check('a template whose hire is refused (grant over the top-level cap) leaves no org and no agents', !rich.ok && !orgRow('rich-team') && richAgents.n === 0,
    { rich, richAgents })
  fs.rmSync(path.join(tpDir, 'too-rich.json'))

  // 6. save the fixture org's layout, then create from it
  const src = tree(rig.org)
  const saved = await attempt(rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'Rig layout' }))
  const file = path.join(tpDir, 'rig-layout.json')
  const body = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  p.check('Save as template writes rig-layout.json into the templates folder, without accounts or folders by default',
    saved.ok && body && !JSON.stringify(body).includes('"account"') && !JSON.stringify(body).includes('"add_dirs"'),
    { saved: saved.ok ? { ...saved.r, content: undefined } : saved, body })
  const again = await attempt(rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'Rig layout' }))
  p.check('saving again under the same name is refused (409) unless replace is asked', !again.ok && again.status === 409, again)
  const listed = (await rig.api('GET', '/api/templates')).templates.find((t) => t.id === 'rig-layout')
  p.check('the saved template is listed from the folder and usable', listed?.source === 'folder' && listed.problems.length === 0, listed)
  const copy = await attempt(rig.api('POST', '/api/orgs', { name: 'Rig Copy', dirs: [], template: { id: 'rig-layout' } }))
  const ct2 = tree('rig-copy')
  const shape = (t) => JSON.stringify(t.map((a) => [a.name, a.tier, a.parent, a.grant]))
  p.check('an org created from the saved layout has the same names, tiers, superiors and grants', copy.ok && shape(ct2) === shape(src),
    { source: src, copy: ct2 })

  // 7. the desktop: Save as template modal + download, App settings controls
  const shotSave = await runDesktop(rig, desk('org-templates-save.cjs'), { preset: 'tall', out: path.join(p.dir, 'desktop-save'),
    args: { shot: 'save-as-template', name: 'Rig layout two' } })
  const dl = shotSave.value?.downloads ?? []
  p.check('desktop: Save as template saves the file and Download hands rig-layout-two.json to the browser download',
    shotSave.ok && fs.existsSync(path.join(tpDir, 'rig-layout-two.json')) && dl.some((d) => d.anchor === 'rig-layout-two.json')
      && dl.some((d) => d.size > 100), shotSave.value ?? shotSave.error)
  for (const f of ['devteam-claude.json', 'devteam-codex.json']) fs.rmSync(path.join(tpDir, f), { force: true })
  const shotApp = await runDesktop(rig, desk('org-templates-app.cjs'), { preset: 'tall', out: path.join(p.dir, 'desktop-app'), args: { shot: 'app-settings-templates' } })
  p.check('desktop: App settings → Runtime shows Organization templates beside Charter documents, and restore writes back the two deleted defaults',
    shotApp.ok && ['devteam-claude.json', 'devteam-codex.json'].every((f) => fs.existsSync(path.join(tpDir, f)))
      && /restored 2 templates/.test(shotApp.value?.snippet ?? ''), shotApp.value ?? shotApp.error)
  const pop = await rig.api('POST', '/api/templates/populate')
  p.check('restoring again changes nothing (both files already present)', pop.created.length === 0 && pop.existing.length === 2, pop)
  return p.summary()
}
