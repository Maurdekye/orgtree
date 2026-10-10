// Proof: the organization templates ARE the templates folder (user
// 2026-10-10 08:55Z; plan and ruling on create-organizations-from-agent-
// layout-templates):
//   1. a fresh data folder: the engine start writes both built-ins into
//      ~/.orgtree/templates as real files, with a .seeded note; the list is
//      exactly the folder's files, each with its description;
//   2. a file dropped into the folder (no description) is listed on the next
//      call, with no restart, and with no description;
//   3. an edited built-in survives an engine restart byte for byte, and a
//      deleted one is not written again (it stays deleted) — until "Restore
//      default templates" brings it back;
//   4. Save as template: with a description it lands in the file; blank, the
//      file has none;
//   5. the desktop: the Create window's picker is a list of the folder's
//      templates, name with the description under it (screenshot).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/templates-folder.mjs [--ui <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const desk = (name) => fileURLToPath(new URL(`../desktop/${name}`, import.meta.url))
const BUILTINS = ['devteam-claude.json', 'devteam-codex.json']

export default async function (rig) {
  const p = new Proof('templates-folder')
  const tpDir = path.join(rig.data, 'rig-home', '.orgtree', 'templates')
  const files = () => (fs.existsSync(tpDir) ? fs.readdirSync(tpDir).sort() : [])
  const list = async () => (await rig.api('GET', '/api/templates'))
  const attempt = (f) => f.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))

  // 1. seeded at engine start (no listing has happened yet)
  await rig.waitFor(() => BUILTINS.every((f) => fs.existsSync(path.join(tpDir, f))) || null,
    { what: 'the engine start to seed the templates folder', timeout: 30000 }).catch(() => null)
  const atStart = files()
  p.check('1 a fresh data folder: the engine start wrote both built-ins as files, with the .seeded note',
    BUILTINS.every((f) => atStart.includes(f)) && atStart.includes('.seeded'), { dir: tpDir, files: atStart })
  const l1 = await list()
  p.check('1 the list is exactly the folder\'s .json files, each from the folder', l1.templates.length === 2
    && l1.templates.every((t) => t.source === 'folder' && path.dirname(t.path) === tpDir) && !l1.folder_error,
  l1.templates.map((t) => ({ id: t.id, source: t.source, path: t.path })))
  p.check('1 the built-ins carry their descriptions, readable in the files', l1.templates.every((t) => (t.description ?? '').length > 40)
    && BUILTINS.every((f) => JSON.parse(fs.readFileSync(path.join(tpDir, f), 'utf8')).description?.length > 40),
  l1.templates.map((t) => ({ id: t.id, description: t.description })))

  // 2. a dropped-in file shows on the next listing
  fs.writeFileSync(path.join(tpDir, 'dropped.json'), JSON.stringify({ id: 'dropped', name: 'Dropped in', agents: [{ name: 'solo', tier: 'haiku' }] }, null, 2))
  const l2 = await list()
  const dropped = l2.templates.find((t) => t.id === 'dropped')
  p.check('2 a file dropped into the folder is listed at once, usable, with no description', !!dropped && dropped.problems.length === 0
    && !dropped.description, dropped)

  // 3. an edited built-in survives a restart; a deleted one stays deleted
  const claudeFile = path.join(tpDir, BUILTINS[0])
  const edited = fs.readFileSync(claudeFile, 'utf8').replace('"devteam (claude)"', '"my devteam"')
  fs.writeFileSync(claudeFile, edited)
  fs.rmSync(path.join(tpDir, BUILTINS[1]))
  await rig.restart()
  await new Promise((r) => setTimeout(r, 3000))
  const l3 = await list()
  p.check('3 after a restart the edited built-in is unchanged byte for byte', fs.readFileSync(claudeFile, 'utf8') === edited
    && l3.templates.some((t) => t.id === 'devteam-claude' && t.name === 'my devteam'), l3.templates.map((t) => ({ id: t.id, name: t.name })))
  p.check('3 the deleted built-in was not written again and is not listed', !fs.existsSync(path.join(tpDir, BUILTINS[1]))
    && !l3.templates.some((t) => t.id === 'devteam-codex'), files())
  const restored = await rig.api('POST', '/api/templates/populate')
  p.check('3 Restore default templates writes back only the deleted one', restored.created.join() === BUILTINS[1]
    && fs.readFileSync(claudeFile, 'utf8') === edited && fs.existsSync(path.join(tpDir, BUILTINS[1])), restored)

  // 4. Save as template, with and without a description
  const withDesc = await attempt(rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'Described layout', description: '  Our usual team.  ' }))
  const noDesc = await attempt(rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'Plain layout', description: '   ' }))
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(tpDir, f), 'utf8')) } catch { return null } }
  p.check('4 Save as template writes the description as a top-level field', withDesc.ok && read('described-layout.json')?.description === 'Our usual team.',
    { saved: withDesc.ok ? withDesc.r.file : withDesc, file: read('described-layout.json')?.description })
  p.check('4 a blank description is left out of the file, and the template still lists', noDesc.ok && read('plain-layout.json')
    && !('description' in read('plain-layout.json')) && (await list()).templates.some((t) => t.id === 'plain-layout' && !t.description && t.problems.length === 0),
  { saved: noDesc.ok ? noDesc.r.file : noDesc })

  // 5. the picker list in the Create window
  const shot = await runDesktop(rig, desk('org-templates-create.cjs'), { org: '', preset: 'tall', out: path.join(p.dir, 'desktop-list'),
    args: { shot: 'picker-list', name: 'Listed Team', template: 'my devteam' } })
  const rows = shot.value?.before?.list ?? shot.value?.list ?? []
  const names = rows.map((r) => r.name)
  p.check('5 desktop: the picker lists Empty and each folder template by name, with its description under it when it has one',
    shot.ok && names[0] === 'Empty' && ['my devteam', 'devteam (codex)', 'Dropped in', 'Described layout', 'Plain layout'].every((n) => names.includes(n))
      && rows.find((r) => r.name === 'Described layout')?.desc === 'Our usual team.' && rows.find((r) => r.name === 'Dropped in')?.desc === null
      && rows.find((r) => r.name === 'my devteam')?.selected === true,
    shot.value ?? shot.error)
  return p.summary()
}
