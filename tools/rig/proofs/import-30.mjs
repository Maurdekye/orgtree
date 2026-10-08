// Proof: the engine's first-start import of a 3.0/3.1 store, the layout the
// released 3.0.9 and 3.1.0 leave (tools/rig/legacy30.mjs: one `orgtree`
// database built with the v3.1.0 migrations from git, orgs in org_<id>
// schemas, 3.x's .pg markers and its accounts registry):
//   1. a full store: the marked org arrives section by section, the unmarked
//      one stays out (3.x had left it out), its agent keeps its account;
//   2. the same store without the org's log_l table: nothing of the org is
//      kept, the failure names its table in the log, in ot.kv, in the app
//      feed and in the org list; the user removes the account the org's agent
//      used; the next start retries without bringing that account back; and
//      once the store is repaired the org imports in full, its agent on the
//      default account, and the line goes.
// The org-list checks need a renderer with the import line: build one with
// `node tools/rig/rig.mjs build-ui` and pass it with ORGTREE_RIG_UI=<dir>.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/import-30.mjs

import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { ACCOUNT30, ORPHAN30, SLUG30, prepare30, repairLogL } from '../legacy30.mjs'
import { RIG_DIR, startRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: 'none', name: 'import30', prepare: ctx => prepare30(ctx) }
}

const ORG = `(SELECT id FROM ot.orgs WHERE slug = '${SLUG30}' AND state = 'active')`
const marker = rig => rig.sql(`SELECT key FROM ot.meta WHERE key = 'import_v1'`).length === 1
const failures = rig => rig.one(`SELECT value FROM ot.kv WHERE key = 'import_failures'`)?.value ?? null
const feedFailures = async rig => (await rig.api('GET', '/api/app/records'))?.runtime?.values?.import_failures?.value ?? null
const failedLines = rig => rig.engineLog().split(/\r?\n/).filter(l => /3\.0\/3\.1 organization import failed/.test(l))
const accounts = rig => ({
  present: rig.sql(`SELECT 1 FROM ot.accounts WHERE id = '${ACCOUNT30}'`).length === 1,
  removed: rig.sql(`SELECT 1 FROM ot.removed_accounts WHERE id = '${ACCOUNT30}'`).length === 1,
})
const source = rig => rig.sql(`SELECT (SELECT count(*) FROM org_1.doc)::int AS doc, (SELECT count(*) FROM org_1.nodes)::int AS nodes,
                                      (SELECT count(*) FROM org_1.log_d)::int AS log_d, (SELECT count(*) FROM public.orgs)::int AS orgs`, { db: 'orgtree' })[0]
const orgList = (rig, p, shot) => runDesktop(rig, path.join(RIG_DIR, 'desktop', 'org-list.cjs'),
  { preset: 'short', org: '', args: { shot }, out: path.join(p.dir, shot) })

/** The org's sections, checked as import-2x checks the same copy. */
function checkOrg(p, label, rig, { account }) {
  const q = sql => rig.sql(sql)
  const c = (what, ok, detail) => p.check(`${label}: ${what}`, !!ok, detail)
  const org = q(`SELECT id, name, created_at FROM ot.orgs WHERE slug = '${SLUG30}' AND state = 'active'`)[0]
  c('the org was imported (name, creation time)', org && org.name === 'Legacy 3.1 Org' && /^2026-09-01/.test(org.created_at), org)
  if (!org) return
  const agents = Object.fromEntries(q(`SELECT a.name, a.state, a.tier, a.account, p.name AS parent, a.session_id FROM ot.agents a
                                         LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.org_id = ${org.id}`).map(a => [a.name, a]))
  c('agents, chain and sessions (lead and dev live, retired archived)', agents.lead?.state === 'live' && agents.dev?.state === 'live'
    && agents.retired?.state === 'archived' && agents.dev?.parent === 'lead' && agents.lead?.session_id === 'sess-legacy-lead', Object.values(agents))
  c(account ? `dev keeps its account (${account})` : 'dev runs on the default account (its account was removed)',
    (agents.dev?.account ?? null) === account, agents.dev?.account ?? null)
  const turns = q(`SELECT count(*)::int AS n FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.org_id = ${org.id} AND a.name = 'dev'`)[0].n
  const mail = Object.fromEntries(q(`SELECT uid, state, recipient_kind FROM ot.mail WHERE org_id = ${org.id}`).map(m => [m.uid, m]))
  c("turns, pending and delivered mail, the user's inbox", turns === 2 && mail['m-legacy-pending']?.state === 'pending'
    && [1, 2, 3].every(n => mail[`m-legacy-done-${n}`]?.state === 'delivered') && mail['m-legacy-user']?.recipient_kind === 'user', { turns, mail: Object.keys(mail) })
  const n = sql => q(`SELECT count(*)::int AS n FROM (${sql}) x`)[0].n
  c('question, docket item, document, watchdog and events', n(`SELECT 1 FROM ot.asks WHERE org_id = ${org.id} AND status = 'open'`) === 1
    && n(`SELECT 1 FROM ot.work_items WHERE org_id = ${org.id} AND slug = 'legacy-item'`) === 1 && n(`SELECT 1 FROM ot.documents WHERE org_id = ${org.id}`) === 1
    && n(`SELECT 1 FROM ot.watchdogs WHERE org_id = ${org.id}`) === 1
    && q(`SELECT op FROM ot.events WHERE org_id = ${org.id} AND op IN ('hire', 'retire') ORDER BY id`).map(e => e.op).join(',') === 'hire,retire')
}

export default async function (rig) {
  const p = new Proof('import-30')

  // 1. the full 3.1.0 store
  checkOrg(p, 'full store', rig, { account: ACCOUNT30 })
  p.check('full store: the org without a 3.x marker stays out', rig.sql(`SELECT 1 FROM ot.orgs WHERE slug = '${ORPHAN30}'`).length === 0)
  p.check('full store: the registry account was imported', accounts(rig).present, accounts(rig))
  p.check('full store: import marker set, nothing recorded as failed', marker(rig) && failures(rig) === null, { marker: marker(rig), failures: failures(rig) })

  // 2. the org's log_l table is gone
  const r2 = await startRun({ name: 'import30-broken', prepare: ctx => prepare30({ ...ctx, variant: 'no-log_l' }) })
  try {
    const before = source(r2)
    p.check('broken store: nothing of the org was kept', r2.sql(`SELECT 1 FROM ot.orgs WHERE slug = '${SLUG30}'`).length === 0)
    p.check('broken store: import marker unset (the next start retries)', !marker(r2))
    const failed = failedLines(r2)
    p.file('broken-engine-log.txt', failed.join('\n'))
    p.check('broken store: the engine log names the org and the table', failed.some(l => new RegExp(`org=${SLUG30}\\b`).test(l) && /table=log_l\b/.test(l)), failed.map(l => l.slice(0, 400)))
    const rec = failures(r2)?.[`3.0/3.1:${SLUG30}`]
    p.check('broken store: the failure is recorded (source 3.0/3.1, org name, table log_l, tries 1)', rec?.source === '3.0/3.1' && rec?.name === 'Legacy 3.1 Org'
      && rec?.table === 'log_l' && rec?.tries === 1, rec)
    const feed = await feedFailures(r2)
    p.check('broken store: the app feed carries it to the org list', Array.isArray(feed) && feed.some(f => f.org === SLUG30 && f.table === 'log_l'), feed)
    const seen = await orgList(r2, p, 'broken-org-list')
    const line = seen.ok ? seen.value.failures.map(f => f.text).join(' | ') : ''
    p.check('broken store: the org list shows "Import from 3.0/3.1 failed (log_l)" with the org name',
      seen.ok && /Legacy 3\.1 Org/.test(line) && /Import from 3\.0\/3\.1 failed \(log_l\)\. Your 3\.0\/3\.1 data is untouched; Orgtree retries at every start\./.test(line), seen.ok ? seen.value : seen.error)

    // the user removes the account the failed org's agent used
    p.check('broken store: the registry account arrived on its own (it is app-wide)', accounts(r2).present, accounts(r2))
    const removed = await r2.api('DELETE', `/api/accounts/${ACCOUNT30}`).then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }))
    p.check('the user removes that account in 4.0', removed.ok && accounts(r2).removed && !accounts(r2).present, removed)

    // the next start retries; the store is still broken
    await r2.restart()
    const rec2 = failures(r2)?.[`3.0/3.1:${SLUG30}`]
    p.check('broken store, next start: retried, still nothing kept, tries 2', r2.sql(`SELECT 1 FROM ot.orgs WHERE slug = '${SLUG30}'`).length === 0
      && !marker(r2) && rec2?.tries === 2, rec2)
    p.check('broken store, next start: the removed account did not come back', !accounts(r2).present && accounts(r2).removed, accounts(r2))
    p.check('broken store: the source database was not changed by either attempt', JSON.stringify(before) === JSON.stringify(source(r2)), { before, after: source(r2) })

    // repaired, the next start imports it in full; the removed account stays removed
    r2.exec(repairLogL(), { db: 'orgtree' })
    await r2.restart()
    checkOrg(p, 'repaired store', r2, { account: null })
    p.check('repaired store: the removed account is still removed', !accounts(r2).present && accounts(r2).removed, accounts(r2))
    p.check('repaired store: marker set, the failure record and the feed line are gone', marker(r2) && failures(r2) === null
      && JSON.stringify(await feedFailures(r2)) === '[]', { marker: marker(r2), kv: failures(r2), feed: await feedFailures(r2) })
    const seen2 = await orgList(r2, p, 'repaired-org-list')
    p.check('repaired store: the org list shows the org and no import line', seen2.ok && seen2.value.failures.length === 0
      && seen2.value.rows.some(r => /Legacy 3\.1 Org/.test(r.text)), seen2.ok ? seen2.value : seen2.error)
    p.check('repaired store: the unmarked org still stays out', r2.sql(`SELECT 1 FROM ot.orgs WHERE slug = '${ORPHAN30}'`).length === 0)
  } finally { await r2.down() }
  return p.summary()
}
