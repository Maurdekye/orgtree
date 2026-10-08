// Proof: the engine's first-start import of a 3.2 store (registry
// orgtree_app + orgtree_org_1, built with the 3.x engine's own migrations by
// tools/rig/legacy32.mjs, one row in every section the importer reads):
//   1. the current schema: every section arrives, with its values;
//   2. a database from an earlier 3.2 alpha (org migrations up to 0015, before
//      the docket attention columns): it imports in full too (finding F3);
//   3. a broken store (a column the import needs dropped from two tables):
//      nothing of the org is kept, the failure names its table in the log, in
//      ot.kv and in the app feed, the org list shows it, the next start
//      retries it, and once the store is repaired it imports in full and the
//      line goes (finding F2: it used to import without those sections and
//      set the marker, with nothing said);
//   4. a registry (orgtree_app) the import cannot read: the engine still
//      starts, says so in the org list, retries, and imports once repaired.
// The org-list check needs a renderer with the import line: build one with
// `node tools/rig/rig.mjs build-ui` and pass it with ORGTREE_RIG_UI=<dir>.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/import-3x.mjs

import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { unreadableRegistry } from '../importcheck.mjs'
import { SLUG32, prepare32 } from '../legacy32.mjs'
import { RIG_DIR, startRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: 'none', name: 'import3x', prepare: ctx => prepare32(ctx) }
}

const ORG = `(SELECT id FROM ot.orgs WHERE slug = '${SLUG32}' AND state = 'active')`

/** What of the 3.2 org arrived, section by section (null: no org at all). */
function arrived(rig) {
  const org = rig.one(`SELECT id, name, settings, net FROM ot.orgs WHERE slug = '${SLUG32}' AND state = 'active'`)
  if (!org) return null
  const n = sql => rig.sql(`SELECT count(*)::int AS n FROM (${sql}) x`)[0].n
  const dev = rig.one(`SELECT charter, team_charter, scope, parent_id IS NOT NULL AS has_parent FROM ot.agents WHERE org_id = ${ORG} AND name = 'dev'`)
  const item = rig.one(`SELECT id, rev, status, done_so_far, working_on_next, participants, dependencies, manual_attention, owner
                          FROM ot.work_items WHERE org_id = ${ORG} AND slug = 'legacy32-item'`)
  const ask = rig.one(`SELECT status, body, work_items FROM ot.asks WHERE org_id = ${ORG}`)
  const mail = uid => rig.one(`SELECT state, sender, recipient_kind, recipient_name, urgent FROM ot.mail WHERE org_id = ${ORG} AND uid = '${uid}'`)
  return {
    name: org.name,
    dirs: (org.settings?.dirs ?? []).map(d => `${d.path}:${d.mode}`),
    hubs: (org.net?.hubs ?? []).map(h => h.id),
    agents: n(`SELECT 1 FROM ot.agents WHERE org_id = ${ORG}`),
    dev: dev && { charter: dev.charter, team: dev.team_charter, hasParent: dev.has_parent,
                  dirs: (dev.scope?.add_dirs ?? []).map(d => d.path), mcp: dev.scope?.tools?.mcp ?? [] },
    turns: n(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.org_id = ${ORG}`),
    pending: mail('m32-pending'), delivered: mail('m32-done'), userInbox: mail('m32-user'),
    userRead: mail('m32-read'), userSent: mail('m32-sent'),
    ask: ask && { status: ask.status, options: (ask.body?.options ?? []).map(o => o.label), work: ask.work_items },
    item: item && { rev: item.rev, status: item.status, done: item.done_so_far, next: item.working_on_next,
                    participants: item.participants, deps: item.dependencies, attention: item.manual_attention?.reason ?? null,
                    owner: item.owner?.node ?? null },
    history: item ? n(`SELECT 1 FROM ot.work_events WHERE work_id = ${item.id}`) : 0,
    documents: n(`SELECT 1 FROM ot.documents WHERE org_id = ${ORG}`),
    watchdogs: rig.sql(`SELECT name FROM ot.watchdogs WHERE org_id = ${ORG}`).map(w => w.name),
    audiences: n(`SELECT 1 FROM ot.audiences WHERE org_id = ${ORG}`),
    audienceRequests: n(`SELECT 1 FROM ot.audience_requests WHERE org_id = ${ORG}`),
    events: n(`SELECT 1 FROM ot.events WHERE org_id = ${ORG} AND op = 'hire'`),
    orgInbox: n(`SELECT 1 FROM ot.org_inbox WHERE org_id = ${ORG}`),
  }
}

/** One check per section: everything the seed put in arrived. */
function checkAll(p, label, a, { attention }) {
  const c = (what, ok, detail) => p.check(`${label}: ${what}`, !!ok, detail)
  c('the org (name, folders, hubs)', a && a.name === 'Legacy 3.2 Org' && a.dirs.includes('E:/work/legacy32:ro') && a.hubs.includes('h32'), a && { name: a.name, dirs: a.dirs, hubs: a.hubs })
  if (!a) return
  c('agents with charter, team charter, folders, MCP and manager', a.agents === 2 && a.dev?.charter === 'LEGACY32 charter of dev'
    && a.dev?.team === 'LEGACY32 team charter' && a.dev?.dirs.includes('E:/work/legacy32/dev') && a.dev?.mcp.includes('legacy-mcp') && a.dev?.hasParent, { agents: a.agents, dev: a.dev })
  c('recent turns', a.turns === 1, a.turns)
  c('agent mail: pending stays pending, the log is delivered', a.pending?.state === 'pending' && a.delivered?.state === 'delivered', { pending: a.pending, delivered: a.delivered })
  c("the user's inbox, read log (urgent kept) and sent mail", a.userInbox?.state === 'pending' && a.userRead?.state === 'read' && a.userRead?.urgent === true
    && a.userSent?.sender === '@user' && a.userSent?.recipient_name === 'dev', { inbox: a.userInbox, read: a.userRead, sent: a.userSent })
  c('the open question with its options and docket link', a.ask?.status === 'open' && a.ask.options.join(',') === 'Yes,No' && a.ask.work?.includes('legacy32-item'), a.ask)
  c('the docket item with its lists, owner and rev', a.item?.status === 'in_progress' && a.item.rev === 3 && a.item.owner === 'dev'
    && JSON.stringify(a.item.done) === '["LEGACY32 done one"]' && JSON.stringify(a.item.next) === '["LEGACY32 next one"]'
    && a.item.participants?.includes('lead') && a.item.deps?.includes('legacy32-other'), a.item)
  c(attention ? 'the item\'s attention flag' : 'no attention flag (this database predates the column)',
    attention ? a.item?.attention === 'LEGACY32 attention' : a.item?.attention === null, a.item?.attention)
  c("the item's history", a.history === 1, a.history)
  c('documents, watchdogs, audiences, events and org inbox', a.documents === 1 && a.watchdogs.includes('LEGACY32 dog') && a.audiences === 1
    && a.audienceRequests === 1 && a.events === 1 && a.orgInbox === 1,
    { documents: a.documents, watchdogs: a.watchdogs, audiences: a.audiences, requests: a.audienceRequests, events: a.events, orgInbox: a.orgInbox })
}

const marker = rig => rig.sql(`SELECT key FROM ot.meta WHERE key = 'import_v1'`).length === 1
const failures = rig => rig.one(`SELECT value FROM ot.kv WHERE key = 'import_failures'`)?.value ?? null
const feedFailures = async rig => (await rig.api('GET', '/api/app/records'))?.runtime?.values?.import_failures?.value ?? null
const failedLines = rig => rig.engineLog().split(/\r?\n/).filter(l => /organization import failed/.test(l))
const sourceCounts = rig => rig.sql(`SELECT (SELECT count(*) FROM orgtree.mail_log)::int AS mail_log, (SELECT count(*) FROM orgtree.events)::int AS events,
                                            (SELECT count(*) FROM orgtree.agents)::int AS agents, (SELECT count(*) FROM orgtree.work_items)::int AS work_items`, { db: 'orgtree_org_1' })[0]
const orgList = (rig, p, shot) => runDesktop(rig, path.join(RIG_DIR, 'desktop', 'org-list.cjs'),
  { preset: 'short', org: '', args: { shot }, out: path.join(p.dir, shot) })

export default async function (rig) {
  const p = new Proof('import-3x')

  // 1. the current 3.2 schema
  checkAll(p, 'current schema', arrived(rig), { attention: true })
  p.check('current schema: import marker set, nothing recorded as failed', marker(rig) && failures(rig) === null, { marker: marker(rig), failures: failures(rig) })

  // 2. a database from an earlier 3.2 alpha (before org migration 0016)
  const r2 = await startRun({ name: 'import3x-old', prepare: ctx => prepare32({ ...ctx, level: '0015' }) })
  try {
    const failed = failedLines(r2)
    p.file('old-schema-engine-log.txt', failed.join('\n'))
    checkAll(p, 'older 3.2 database (org migrations up to 0015)', arrived(r2), { attention: false })
    p.check('older 3.2 database: import marker set, no failure logged', marker(r2) && failed.length === 0, { marker: marker(r2), failed: failed.map(l => l.slice(0, 300)) })
  } finally { await r2.down() }

  // 3. a broken store: two columns the import needs are gone
  const damage = ['ALTER TABLE orgtree.mail_log DROP COLUMN relationship', 'ALTER TABLE orgtree.events DROP COLUMN detail']
  const r3 = await startRun({ name: 'import3x-broken', prepare: ctx => prepare32({ ...ctx, damage }) })
  try {
    const before = sourceCounts(r3)
    p.check('broken store: nothing of the org was kept (no org row, no agents)', arrived(r3) === null
      && r3.sql(`SELECT 1 FROM ot.agents WHERE extra->'imported_from'->>'database' = 'orgtree_org_1'`).length === 0)
    p.check('broken store: import marker unset (the next start retries)', !marker(r3))
    const failed = failedLines(r3)
    p.file('broken-engine-log.txt', failed.join('\n'))
    p.check('broken store: the engine log names the org and the table', failed.some(l => /org=legacy32\b/.test(l) && /table=mail_log\b/.test(l)), failed.map(l => l.slice(0, 400)))
    const rec = failures(r3)?.[`3.2:${SLUG32}`]
    p.check('broken store: the failure is recorded (source, org name, table, error, tries 1)', rec?.source === '3.2' && rec?.name === 'Legacy 3.2 Org'
      && rec?.table === 'mail_log' && /relationship/.test(rec?.error ?? '') && rec?.tries === 1, rec)
    const feed = await feedFailures(r3)
    p.check('broken store: the app feed carries it to the org list', Array.isArray(feed) && feed.some(f => f.org === SLUG32 && f.table === 'mail_log'), feed)
    const seen = await orgList(r3, p, 'broken-org-list')
    const line = seen.ok ? seen.value.failures.map(f => f.text).join(' | ') : ''
    p.check('broken store: the org list shows "Import from 3.2 failed (mail_log)" with the org name', seen.ok
      && /Legacy 3\.2 Org/.test(line) && /Import from 3\.2 failed \(mail_log\)\. Your 3\.2 data is untouched; Orgtree retries at every start\./.test(line),
      seen.ok ? seen.value : seen.error)

    // the next start retries it (the store is still broken)
    await r3.restart()
    const rec2 = failures(r3)?.[`3.2:${SLUG32}`]
    p.check('broken store, next start: retried, still nothing kept, tries 2', arrived(r3) === null && !marker(r3) && rec2?.tries === 2
      && rec2?.first_at === rec?.first_at, { tries: rec2?.tries, first_at: [rec?.first_at, rec2?.first_at] })

    // the source is only ever read
    const after = sourceCounts(r3)
    p.check('broken store: the source database was not changed by either attempt', JSON.stringify(before) === JSON.stringify(after), { before, after })

    // repaired, the next start imports it in full and the line goes
    r3.exec('ALTER TABLE orgtree.mail_log ADD COLUMN relationship text; ALTER TABLE orgtree.events ADD COLUMN detail json;', { db: 'orgtree_org_1' })
    await r3.restart()
    checkAll(p, 'repaired store', arrived(r3), { attention: true })
    p.check('repaired store: marker set, the failure record and the feed line are gone', marker(r3) && failures(r3) === null
      && JSON.stringify(await feedFailures(r3)) === '[]', { marker: marker(r3), kv: failures(r3), feed: await feedFailures(r3) })
    const seen2 = await orgList(r3, p, 'repaired-org-list')
    p.check('repaired store: the org list shows the org and no import line', seen2.ok && seen2.value.failures.length === 0
      && seen2.value.rows.some(r => /Legacy 3\.2 Org/.test(r.text)), seen2.ok ? seen2.value : seen2.error)
    p.check('repaired store: imported once (one org row, two agents)', r3.sql(`SELECT 1 FROM ot.orgs WHERE slug = '${SLUG32}'`).length === 1
      && r3.sql(`SELECT 1 FROM ot.agents WHERE org_id = ${ORG}`).length === 2)
  } finally { await r3.down() }

  // 4. the registry itself cannot be read: the engine starts anyway
  await unreadableRegistry(p, {
    label: 'unreadable 3.2 registry', source: '3.2', name: 'Your 3.2 organizations', table: 'orgs',
    start: () => startRun({ name: 'import3x-registry', prepare: ctx => prepare32({ ...ctx, appDamage: ['ALTER TABLE orgtree.orgs RENAME COLUMN slug TO slug_unreadable'] }) }),
    repair: r => r.exec('ALTER TABLE orgtree.orgs RENAME COLUMN slug_unreadable TO slug', { db: 'orgtree_app' }),
    imported: r => r.sql(`SELECT 1 FROM ot.orgs WHERE slug = '${SLUG32}'`).length === 1,
  })
  return p.summary()
}
