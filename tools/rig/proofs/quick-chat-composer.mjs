// Proof: Quick chat as one composer row in the v3 header (docket
// quick-chat-the-superior-selector-looks-and-works, user 2026-10-10).
//   - one row: every control inside the one box, the box no taller than the
//     header, the pickers overlaid below the header;
//   - the model control is the model's id icon alone, then the icon plus the
//     name the agent will get, and that is the name it gets;
//   - the superior picker is the Agents List: the same rows in the same order
//     as the list on screen, with id icons, "top level" first; filter, arrow
//     and Enter pick;
//   - the model picker is the hire chips, the chosen one marked;
//   - two attached files show as a count badge with a pop-over list, and
//     arrive with the hired agent's first mail (uploaded, byte-identical).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/quick-chat-composer.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROMPT = 'Summarise the attached release notes'
const FILES = [{ name: 'notes-a.txt', text: 'first file' }, { name: 'notes-b.txt', text: 'second file' }]

export default async function (rig) {
  const p = new Proof('quick-chat-composer')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'zulu', parent: null, tier: 'haiku', grant: 0 })
  await rig.op({ op: 'hire', name: 'able', parent: 'boss', tier: 'haiku', grant: 0 })
  const r = await runDesktop(rig, path.join(here, '../desktop/quick-chat-composer.cjs'),
    { preset: '1600x900', out: path.join(p.dir, 'charcoal'), timeout: 240000,
      args: { org: rig.org, theme: 'charcoal', size: '1600x900', prompt: PROMPT, files: FILES } })
  p.check('the desktop script ran', r.ok, r.ok ? undefined : r)
  const v = r.value ?? {}
  for (const [when, l] of [['empty', v.empty?.layout], ['typed', v.typed?.layout], ['two files', v.withFiles]]) {
    p.check(`${when}: one row inside one box, no taller than the header`,
      l && l.insideBox && l.boxH <= l.headerH && new Set(l.parts.map(x => Math.round((x.top + x.bottom) / 2))).size <= 2, l)
  }
  p.check('empty prompt: the model control is the id icon alone', v.empty?.model?.icon && v.empty.model.name === null, v.empty?.model)
  p.check('typed prompt: the id icon plus the name preview', v.typed?.model?.icon && !!v.typed.model.name, v.typed?.model)
  const same = JSON.stringify(v.lists?.picker) === JSON.stringify(v.lists?.list)
  p.check('the superior picker lists the Agents List rows in its order', same && (v.lists?.picker?.length ?? 0) >= 3, v.lists)
  p.check('"top level" heads the picker; rows carry id icons', v.lists?.top?.startsWith('top level') && v.lists.icons === v.lists.picker.length, v.lists)
  p.check('the picker opens below the header', v.lists && v.lists.popTop >= v.lists.headerBottom, v.lists)
  p.check('filter + ArrowDown + Enter picked carol', v.picked === 'carol', v.picked)
  p.check('the model picker is the hire chips, the chosen tier marked',
    (v.chips?.length ?? 0) >= 3 && v.chips.filter(c => c.sel).length === 1, v.chips)
  p.check('a chip pick becomes the model (haiku)', v.afterModel?.icon === 't-haiku', v.afterModel)
  p.check('two files: a count badge of 2', v.count === '2', v.count)
  p.check('the attachments pop-over lists both files', JSON.stringify(v.fileList) === JSON.stringify(FILES.map(f => f.name)), v.fileList)
  p.check('after Enter the box and the files clear', v.after?.value === '' && v.after?.count === null, v.after)
  const name = v.name
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.agents WHERE name = '${name}'`).length === 1,
    { what: `${name} to be hired`, timeout: 30000 }).catch(() => {})
  const [agent] = rig.sql(`SELECT a.tier, b.name AS parent, a.scratch_dir FROM ot.agents a LEFT JOIN ot.agents b ON b.id = a.parent_id WHERE a.name = '${name}'`)
  p.check(`the agent is hired under the preview's name (${name}), haiku, under carol`,
    agent && agent.tier === 'haiku' && agent.parent === 'carol', agent)
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id WHERE a.name = '${name}'`).length >= 1,
    { what: 'its first mail', timeout: 30000 }).catch(() => {})
  const mail = rig.sql(`SELECT m.body, m.sender, m.attachments::text AS att FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                         WHERE a.name = '${name}' ORDER BY m.created_at`)
  p.check('its first mail is the prompt, from the user', mail[0]?.body === PROMPT && mail[0]?.sender === '@user', mail)
  let att = []
  try { att = JSON.parse(mail[0]?.att ?? '[]') } catch { /* checked below */ }
  p.check('the first mail carries both files', JSON.stringify(att.map(a => a.name)) === JSON.stringify(FILES.map(f => f.name)), att)
  // uploads land where the desk composer's do (data\uploads\<org>\<agent>)
  const found = FILES.map(f => {
    const a = att.find(x => x.name === f.name)
    try { return !!a && fs.readFileSync(a.path, 'utf8') === f.text } catch { return false }
  })
  p.check('both uploaded files are on disk, byte-identical', found.every(Boolean), { found, paths: att.map(a => a.path) })
  const errors = (v.errors ?? []).filter(e => !/Electron Security Warning/.test(String(e)))
  p.check('no console errors', !errors.length, errors)
  return p.summary()
}

