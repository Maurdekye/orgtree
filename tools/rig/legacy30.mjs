// tools/rig/legacy30.mjs: a synthetic Orgtree 3.0/3.1 store inside a rig
// run's own cluster, as the released 3.0.9 and 3.1.0 left it: ONE database,
// `orgtree`, made by the 3.1.0 engine's own migrations (read from git at the
// v3.1.0 tag, applied and recorded as its pgstore.migrate did), the org
// registry `public.orgs`, and each org's rows in schema `org_<id>` (the 2.x
// seam's five tables: meta, doc, nodes, log_d, log_l). It holds:
//   - `legacy-30` (org 1): the legacy2x content, with its active marker
//     <data>/orgs/legacy-30.pg; its dev agent runs on a secondary account;
//   - `orphan-30` (org 2): no marker, so 3.x itself left it out (never imported);
//   - <data>/accounts-registry.json with that secondary account.
// Used as startRun's `prepare` hook (it runs on the run's cluster before the
// engine's first start, which then imports it). Never touches another cluster.
//
//   variant 'full'      everything above
//   variant 'no-log_l'  org 1 without its log_l table: the import must keep
//                       nothing of the org and say so
//
// The migrated (empty) cluster is cached under <rig home>\pg\template30-*.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { legacyStore } from './legacy2x.mjs'
import { withPostgres } from './legacy32.mjs'
import { PG_VERSION, REPO, rigHome } from './lib.mjs'

export const SLUG30 = 'legacy-30'
export const ORPHAN30 = 'orphan-30'
export const ACCOUNT30 = 'acct-30'
const TAG = 'v3.1.0'
const DIR = 'engine/backend/orgtree/pg_migrations'

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.error || '').toString().trim()}`)
  return r.stdout
}

/** The 3.1.0 `orgtree` database, migrated and empty (cached). */
export async function template30(base, pgBin) {
  const dir = path.join(rigHome(), 'pg', `template30-${PG_VERSION}-${TAG}`)
  if (fs.existsSync(path.join(dir, 'data', 'PG_VERSION'))) return dir
  const staging = dir + '.partial'
  fs.rmSync(staging, { recursive: true, force: true })
  fs.cpSync(base, staging, { recursive: true })
  const sqlDir = path.join(staging, 'migrations-3.1.0')
  fs.mkdirSync(sqlDir, { recursive: true })
  const files = git('ls-tree', '--name-only', `${TAG}:${DIR}`).split(/\r?\n/).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()
  if (!files.length) throw new Error(`no migrations at ${TAG}:${DIR}`)
  await withPostgres(staging, pgBin, async psql => {
    psql('postgres', ['-c', `CREATE DATABASE orgtree TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`], 'create orgtree')
    psql('orgtree', ['-c', `CREATE TABLE public.schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`], 'schema_migrations')
    for (const f of files) {
      const text = git('show', `${TAG}:${DIR}/${f}`)
      const file = path.join(sqlDir, f)
      fs.writeFileSync(file, text)
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      psql('orgtree', ['-1', '-f', file, '-c', `INSERT INTO public.schema_migrations (name, sha256) VALUES ('${f}', '${sha}')`], `3.1.0 migration ${f}`)
    }
  })
  fs.rmSync(sqlDir, { recursive: true, force: true })
  fs.rmSync(path.join(staging, 'data', 'postmaster.pid'), { force: true })
  fs.renameSync(staging, dir)
  return dir
}

/** A text literal no seeded value can end early. */
const lit = s => {
  if (s.includes('$v$')) throw new Error('seed value holds the quote tag')
  return `$v$${s}$v$`
}
/** A JSON value as the seam stored it (text). */
const json = v => lit(JSON.stringify(v))

/** The five tables' rows for one org, as 3.0/3.1 wrote them. */
function orgRows(schema, { nodes, doc, mailLog, logs }, { logL = true } = {}) {
  const out = [`INSERT INTO ${schema}.meta (key, val) VALUES ('schema_version', '1');`]
  for (const [k, v] of Object.entries(doc)) out.push(`INSERT INTO ${schema}.doc (key, val) VALUES (${lit(k)}, ${json(v)});`)
  nodes.forEach(([id, v], i) => out.push(`INSERT INTO ${schema}.nodes (id, ord, val) VALUES (${lit(id)}, ${i}, ${json(v)});`))
  for (const [owner, v] of mailLog) out.push(`INSERT INTO ${schema}.log_d (sect, owner, at, val) VALUES ('mail_log', ${lit(owner)}, ${lit(v.at)}, ${json(v)});`)
  if (logL) for (const [sect, list] of Object.entries(logs)) for (const v of list) out.push(`INSERT INTO ${schema}.log_l (sect, at, val) VALUES (${lit(sect)}, ${lit(v.at)}, ${json(v)});`)
  return out
}

/** legacy-30's content: the 2.x store's, named for 3.1, its dev on the secondary account. */
export function store30() {
  const s = legacyStore()
  s.doc = { ...s.doc, name: 'Legacy 3.1 Org' }
  s.nodes = s.nodes.map(([id, v]) => [id, id === 'dev' ? { ...v, account: ACCOUNT30 } : v])
  return s
}

/** The statements that give org 1 its log_l back (a repaired store). */
export function repairLogL() {
  const { logs } = store30()
  const rows = []
  for (const [sect, list] of Object.entries(logs)) for (const v of list) rows.push(`INSERT INTO org_1.log_l (sect, at, val) VALUES (${lit(sect)}, ${lit(v.at)}, ${json(v)});`)
  return [`CREATE TABLE org_1.log_l (seq bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, sect text NOT NULL, at text, val text NOT NULL);`,
    `CREATE INDEX ix_log_l ON org_1.log_l (sect, seq);`, ...rows].join('\n')
}

export async function prepare30({ data, pgBin, variant = 'full' }) {
  const cluster = path.join(data, 'pg', 'cluster')
  const tpl = await template30(cluster, pgBin)
  fs.rmSync(cluster, { recursive: true, force: true })
  fs.cpSync(tpl, cluster, { recursive: true })
  const created = '2026-09-01T10:00:00Z'
  await withPostgres(cluster, pgBin, async psql => {
    const orphan = { nodes: [['solo', { state: 'live', model: 'haiku', title: 'Orphan', created }]], doc: { name: 'Orphan 3.1 Org', created }, mailLog: [], logs: {} }
    const sql = [
      `INSERT INTO public.orgs (slug, created_at) VALUES ('${SLUG30}', '${created}'), ('${ORPHAN30}', '${created}');`,
      `SELECT orgtree_create_org_schema(1); SELECT orgtree_create_org_schema(2);`,
      ...orgRows('org_1', store30(), { logL: variant !== 'no-log_l' }),
      ...orgRows('org_2', orphan),
    ].join('\n')
    const file = path.join(cluster, 'seed30.sql')
    fs.writeFileSync(file, sql)
    psql('orgtree', ['-1', '-f', file], 'seed 3.1 orgs')
    fs.rmSync(file, { force: true })
    // on its own: the seed's deferred triggers have fired by now
    if (variant === 'no-log_l') psql('orgtree', ['-c', 'DROP TABLE org_1.log_l'], 'drop log_l')
  })
  fs.rmSync(path.join(cluster, 'data', 'postmaster.pid'), { force: true })
  // 3.x's own rule: an org is active when its marker names its org_id
  fs.mkdirSync(path.join(data, 'orgs'), { recursive: true })
  fs.writeFileSync(path.join(data, 'orgs', `${SLUG30}.pg`), JSON.stringify({ org_id: 1, slug: SLUG30 }))
  fs.writeFileSync(path.join(data, 'accounts-registry.json'), JSON.stringify({ accounts: [{
    id: ACCOUNT30, provider: 'claude', label: 'Legacy 3.1 second account', auth: 'unobserved', enabled: true,
    credential: { kind: 'managed', path: path.join(data, 'legacy-accounts', ACCOUNT30) },
  }] }, null, 2))
}
