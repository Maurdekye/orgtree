// tools/rig/legacy2x.mjs: a small synthetic Orgtree 2.x data folder for
// importer runs (`rig up --legacy <dir>` copies it into a fresh data root
// before the engine's first start). The layout is what src/import2x.rs reads:
// <dir>/orgs/<slug>.db, SQLite tables meta, doc, nodes, log_d and log_l.
//
//   variant 'full'      everything the importer copies: a live chain, an
//                       archived agent, pending and delivered mail, the user's
//                       inbox, an open question, a docket item, a document,
//                       a watchdog and events
//   variant 'no-log_l'  the same store without the log_l table (an older or
//                       damaged file): the import must fail loudly, not drop it

import fs from 'node:fs'
import path from 'node:path'

const at = (min) => new Date(Date.parse('2026-09-01T10:00:00Z') + min * 60000).toISOString()

export const LEGACY_SLUG = 'legacy-org'

export function legacyStore() {
  const nodes = [
    ['lead', { state: 'live', model: 'opus', title: 'Legacy lead', charter: 'You lead the legacy org.', grant: 12, ui_order: 1,
      created: at(0), session_id: 'sess-legacy-lead', last_status: { status: 'working', summary: 'Leading the 2.x org', at: at(30) } }],
    ['dev', { state: 'live', model: 'sonnet', parent: 'lead', title: 'Developer', grant: 2, ui_order: 1, created: at(1),
      session_id: 'sess-legacy-dev', turns: [{ at: at(20), cost: 0.12, ms: 4200, toks: 900 }, { at: at(25), cost: 0.08, ms: 3100, toks: 600 }] }],
    ['retired', { state: 'archived', model: 'haiku', parent: 'lead', title: 'Old helper', ui_order: 2, created: at(2), archived_at: at(40) }],
  ]
  const doc = {
    name: 'Legacy Org', created: at(0), dirs: [],
    mail: { dev: [{ id: 'm-legacy-pending', from: 'lead', kind: 'message', body: 'LEGACY pending mail for dev', at: at(50) }] },
    user_inbox: [{ id: 'm-legacy-user', from: 'dev', kind: 'message', body: 'LEGACY note to the user', at: at(45) }],
    asks: [{ id: 'a-legacy-q', node: 'dev', status: 'open', question: 'LEGACY question: ship it?', header: 'Ship',
      options: [{ label: 'Yes' }, { label: 'No' }], at: at(46) }],
    work_items: [{ slug: 'legacy-item', title: 'LEGACY docket item', objective: 'Imported from 2.x.\n\nKeep it.', status: 'in_progress',
      kind: 'code', owner: 'dev', created_by: 'lead', at: at(10), updated_at: at(35), rev: 3,
      done_so_far: ['scoped'], working_on_next: ['build'], participants: [] }],
    watchdogs: [{ id: 'w-legacy', owner: 'dev', name: 'legacy-log-watch', kind: 'file', target: 'C:\\legacy\\build.log', pattern: 'ERROR',
      state: 'armed', at: at(12) }],
  }
  const mailLog = [1, 2, 3].map(n => ['dev', { id: `m-legacy-done-${n}`, from: 'lead', kind: 'message', body: `LEGACY delivered mail ${n}`, at: at(5 + n) }])
  const logs = {
    events: [{ op: 'hire', actor: '@user', at: at(1), detail: { node: 'dev', parent: 'lead', tier: 'sonnet' } },
             { op: 'retire', actor: '@user', at: at(40), detail: { node: 'retired' } }],
    documents: [{ id: 'd-legacy', node: 'lead', title: 'LEGACY plan', format: 'markdown', body: '# Plan\n\nFrom 2.x.', at: at(15) }],
  }
  return { nodes, doc, mailLog, logs }
}

/** Write the store under `dir` (a folder that becomes the data root's content). */
export async function writeLegacy2x(dir, { variant = 'full' } = {}) {
  const { DatabaseSync } = await import('node:sqlite')
  const orgs = path.join(dir, 'orgs')
  fs.mkdirSync(orgs, { recursive: true })
  const file = path.join(orgs, `${LEGACY_SLUG}.db`)
  fs.rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  const { nodes, doc, mailLog, logs } = legacyStore()
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, val TEXT);
           CREATE TABLE doc (key TEXT PRIMARY KEY, val TEXT);
           CREATE TABLE nodes (id TEXT PRIMARY KEY, ord INTEGER, val TEXT);
           CREATE TABLE log_d (seq INTEGER PRIMARY KEY AUTOINCREMENT, sect TEXT, owner TEXT, at TEXT, val TEXT);`)
  if (variant !== 'no-log_l') db.exec('CREATE TABLE log_l (seq INTEGER PRIMARY KEY AUTOINCREMENT, sect TEXT, at TEXT, val TEXT);')
  db.prepare('INSERT INTO meta (key, val) VALUES (?, ?)').run('schema_version', '1')
  const putDoc = db.prepare('INSERT INTO doc (key, val) VALUES (?, ?)')
  for (const [k, v] of Object.entries(doc)) putDoc.run(k, JSON.stringify(v))
  const putNode = db.prepare('INSERT INTO nodes (id, ord, val) VALUES (?, ?, ?)')
  nodes.forEach(([id, v], i) => putNode.run(id, i, JSON.stringify(v)))
  const putD = db.prepare('INSERT INTO log_d (sect, owner, at, val) VALUES (?, ?, ?, ?)')
  for (const [owner, v] of mailLog) putD.run('mail_log', owner, v.at, JSON.stringify(v))
  if (variant !== 'no-log_l') {
    const putL = db.prepare('INSERT INTO log_l (sect, at, val) VALUES (?, ?, ?)')
    for (const [sect, list] of Object.entries(logs)) for (const v of list) putL.run(sect, v.at, JSON.stringify(v))
  }
  db.close()
  return file
}
