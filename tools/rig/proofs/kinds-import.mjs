// Proof (regression guard, identical at base and tip by design): a 2.x mail
// row whose kind is `status` still imports as a passive notice, and its
// stored kind string is preserved (import2x.rs:705, untouched by the
// 2026-10-15 kind reduction; stored rows are never rewritten).
// The fixture is the synthetic legacy2x store plus one status-kind pending
// mail appended to its doc 'mail' entry before first start.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/kinds-import.mjs

import fs from 'node:fs'
import path from 'node:path'

import { LEGACY_SLUG, writeLegacy2x } from '../legacy2x.mjs'
import { rigHome } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')

export async function setup() {
  const dir = path.join(rigHome(), 'legacy', `2x-kinds-${stamp()}`)
  const file = await writeLegacy2x(dir)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  const row = db.prepare("SELECT val FROM doc WHERE key = 'mail'").get()
  const mail = JSON.parse(row.val)
  mail.dev.push({ id: 'm-kinds-status', from: 'lead', kind: 'status', body: 'LEGACY status mail for dev', at: '2026-09-01T11:00:00.000Z' })
  db.prepare("UPDATE doc SET val = ? WHERE key = 'mail'").run(JSON.stringify(mail))
  db.close()
  return { legacy: dir, fixture: 'none', name: 'kindsimport' }
}

export default async function (rig) {
  const p = new Proof('kinds-import')
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${LEGACY_SLUG}'`)
  p.check('the 2.x org was imported', !!org, org)
  const row = org && rig.one(`SELECT kind, notice, state FROM ot.mail WHERE org_id = ${org.id} AND uid = 'm-kinds-status'`)
  p.check('2.x mail with kind status imports as a passive notice, kind string preserved', row?.notice === true && row?.state === 'pending' && row?.kind === 'status', row)
  const plain = org && rig.one(`SELECT kind, notice FROM ot.mail WHERE org_id = ${org.id} AND uid = 'm-legacy-pending'`)
  p.check('the ordinary pending mail still imports as a waking message', plain?.notice === false && plain?.kind === 'message', plain)
  return p.summary()
}
