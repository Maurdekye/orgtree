// Proof: the engine's first-start import of a 3.2 store (registry
// orgtree_app + orgtree_org_1, built with the 3.x engine's own migrations by
// tools/rig/legacy32.mjs), in three shapes:
//   1. current schema: every seeded section arrives;
//   2. the same store with one column dropped from two tables the importer
//      reads (events.detail, mail_log.relationship): what happens to those sections;
//   3. an older 3.2 database (org migrations up to 0015): what happens to the org.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/import-3x.mjs

import { SLUG32, prepare32 } from '../legacy32.mjs'
import { startRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: 'none', name: 'import3x', prepare: ctx => prepare32(ctx) }
}

const sections = rig => {
  const org = rig.sql(`SELECT id FROM ot.orgs WHERE slug = '${SLUG32}'`)[0]
  if (!org) return null
  const n = sql => rig.sql(sql)[0].n
  return {
    agents: n(`SELECT count(*)::int AS n FROM ot.agents WHERE org_id = ${org.id}`),
    turns: n(`SELECT count(*)::int AS n FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.org_id = ${org.id}`),
    pending: n(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id = ${org.id} AND uid = 'm32-pending'`),
    delivered: n(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id = ${org.id} AND uid = 'm32-done'`),
    userInbox: n(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id = ${org.id} AND uid = 'm32-user'`),
    events: n(`SELECT count(*)::int AS n FROM ot.events WHERE org_id = ${org.id} AND op = 'hire'`),
    documents: n(`SELECT count(*)::int AS n FROM ot.documents WHERE org_id = ${org.id}`),
  }
}
const marker = rig => rig.sql(`SELECT key FROM ot.meta WHERE key = 'import_v1'`).length === 1
const lines = rig => rig.engineLog().split(/\r?\n/)
// the importer's own warnings and errors (module prefix `importer:`), nothing else
const importLines = rig => lines(rig).filter(l => /^(WARNING|ERROR)\b/.test(l) && /\bimporter:/.test(l))

export default async function (rig) {
  const p = new Proof('import-3x')

  // 1. the current 3.2 schema
  const s1 = sections(rig)
  p.check('current schema: the org and every seeded section arrive',
    s1 && s1.agents === 2 && s1.turns === 1 && s1.pending === 1 && s1.delivered === 1 && s1.userInbox === 1 && s1.events === 1 && s1.documents === 1, s1)
  p.check('current schema: import marker set', marker(rig))

  // 2. a column missing from two tables the importer reads
  const r2 = await startRun({ name: 'import3x-damaged', prepare: ctx => prepare32({ ...ctx,
    damage: ['ALTER TABLE orgtree.events DROP COLUMN detail', 'ALTER TABLE orgtree.mail_log DROP COLUMN relationship'] }) })
  try {
    const s2 = sections(r2)
    p.note('damaged store: sections imported', s2)
    p.check('damaged store: the org itself still imports', !!s2 && s2.agents === 2, s2)
    const lost = s2 ? Object.entries({ events: s2.events, delivered: s2.delivered }).filter(([, v]) => v === 0).map(([k]) => k) : []
    const logged = importLines(r2)
    p.file('damaged-engine-log.txt', logged.join('\n'))
    p.note(`damaged store: sections lost: ${lost.join(', ') || 'none'}; importer warnings/errors in the engine log: ${logged.length}`)
    p.check('damaged store: a section the importer could not read is either imported or reported (never dropped in silence)',
      lost.length === 0 || logged.some(l => /events|mail_log|relationship|detail/i.test(l)), { lost, logged: logged.slice(0, 5) })
    p.check('damaged store: import marker set (the loss is final: no retry)', marker(r2))
  } finally { await r2.down() }

  // 3. an older 3.2 database
  const r3 = await startRun({ name: 'import3x-old', prepare: ctx => prepare32({ ...ctx, level: '0015' }) })
  try {
    const s3 = sections(r3)
    const failed = lines(r3).filter(l => /organization import failed/.test(l))
    p.file('old-schema-engine-log.txt', failed.join('\n'))
    p.note('older 3.2 database (org migrations up to 0015)', { imported: s3, marker: marker(r3), failed: failed.map(l => l.slice(0, 300)) })
    p.check('older database: the org is either imported or the failure is logged and retried',
      !!s3 || (failed.length >= 1 && !marker(r3)), { imported: !!s3, failed: failed.length, marker: marker(r3) })
  } finally { await r3.down() }
  return p.summary()
}
