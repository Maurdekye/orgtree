// Proof: inputs from outside the engine that used to panic it.
//   1. a tool call whose arguments are not a JSON object (an MCP client other
//      than Claude Code may send one): refused with a message, the engine
//      keeps answering (orgtree_send_file used to panic writing into it);
//   2. a 3.2 store with a NULL folder path and NULL list entries (an item's
//      participants and dependencies, a question's docket links): it imports
//      with the NULLs dropped (reading them used to panic at every start);
//   3. a foreign file in diagnostics\logs whose name puts a multi-byte
//      character across the log file name's fixed offsets: the engine still
//      starts (the log sweep at start used to panic on it).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/input-panics.mjs

import fs from 'node:fs'
import path from 'node:path'

import { SLUG32, prepare32 } from '../legacy32.mjs'
import { startRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const alive = rig => rig.api('GET', '/api/app/records').then(() => true, () => false)

export default async function (rig) {
  const p = new Proof('input-panics')

  // 1. tool arguments that are not an object
  for (const [label, args] of [['an array', []], ['a string', 'x'], ['a number', 7]]) {
    const r = await rig.tool('alice', 'orgtree_send_file', args).then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }))
    p.check(`orgtree_send_file with ${label} for arguments: refused with a message`, r.ok && r.v.ok === false
      && /the arguments must be a JSON object/.test(r.v.text ?? ''), r.ok ? r.v : r.e)
  }
  p.check('the engine still answers after those calls', await alive(rig))
  const fine = await rig.tool('alice', 'orgtree_chart', {}).then(v => v.ok, () => false)
  p.check('an ordinary tool call still works', fine)

  // 2. a 3.2 store with NULLs where the importer read strings
  const nulls = [
    'UPDATE orgtree.org_dirs SET path = NULL',
    'INSERT INTO orgtree.work_item_participants (item_id, pos, value) VALUES (1, 1, NULL)',
    'INSERT INTO orgtree.work_item_dependencies (item_id, pos, value) VALUES (1, 1, NULL)',
    'INSERT INTO orgtree.ask_work_items (asks_id, pos, value) VALUES (1, 1, NULL)',
  ]
  let r2 = null
  try {
    r2 = await startRun({ name: 'input-nulls', prepare: ctx => prepare32({ ...ctx, damage: nulls }) })
  } catch (e) {
    p.check('a 3.2 store with NULL list entries: the engine starts', false, String(e?.message ?? e).slice(0, 400))
  }
  if (r2) {
    try {
      p.check('a 3.2 store with NULL list entries: the engine starts', !!r2.url)
      const org = r2.one(`SELECT id, settings FROM ot.orgs WHERE slug = '${SLUG32}'`)
      const item = org && r2.one(`SELECT participants, dependencies FROM ot.work_items WHERE org_id = ${org.id}`)
      const ask = org && r2.one(`SELECT work_items FROM ot.asks WHERE org_id = ${org.id}`)
      p.check('it imports, the NULL folder and list entries dropped', !!org && (org.settings?.dirs ?? []).length === 0
        && JSON.stringify(item?.participants) === '["lead"]' && JSON.stringify(item?.dependencies) === '["legacy32-other"]'
        && JSON.stringify(ask?.work_items) === '["legacy32-item"]', { dirs: org?.settings?.dirs, item, ask })
    } finally { await r2.down() }
  }

  // 3. a foreign file name in the log folder
  const odd = path.join(rig.data, 'diagnostics', 'logs', '2026-10-08_04-16-40.lo€')
  fs.writeFileSync(odd, 'not a log')
  const restarted = await rig.restart().then(() => true, e => { p.note('restart failed', String(e?.message ?? e).slice(0, 400)); return false })
  p.check('with a foreign file name in diagnostics\\logs, the engine still starts', restarted && await alive(rig))
  p.check('the foreign file was left alone', fs.existsSync(odd))
  return p.summary()
}
