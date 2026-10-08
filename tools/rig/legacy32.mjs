// tools/rig/legacy32.mjs: a synthetic Orgtree 3.2 store inside a rig run's
// own cluster, built with the 3.x engine's real migrations
// (engine/backend/orgtree/pg_migrations/app and org): the registry database
// orgtree_app and one org database orgtree_org_1, seeded with a small org.
// Used as startRun's `prepare` hook, so it runs on the run's cluster before
// the engine's first start (which then imports it). Never touches any other
// cluster.
//
//   level   the last org migration applied ('0015' = an older 3.2 database;
//           default: all of them)
//   damage  SQL run on orgtree_org_1 after seeding (e.g. a dropped column)
//
// Applying the migrations takes minutes on this machine, so the migrated (empty)
// cluster is cached per level under <rig home>\pg\template32-<level> and
// copied into each run.

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { PG_VERSION, REPO, rigHome } from './lib.mjs'

export const SLUG32 = 'legacy32'
const MIGRATIONS = path.join(REPO, 'engine', 'backend', 'orgtree', 'pg_migrations')

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

/** Run `body(psql)` against a temporarily started postgres on `cluster`. */
export async function withPostgres(cluster, pgBin, body) {
  const pgdata = path.join(cluster, 'data')
  const password = JSON.parse(fs.readFileSync(path.join(cluster, 'secrets', 'credentials.json'), 'utf8')).orgtree_admin
  const port = await freePort()
  const env = { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8' }
  const run = (exe, args, what) => {
    const r = spawnSync(path.join(pgBin, exe), args, { encoding: 'utf8', windowsHide: true, timeout: 600000, env })
    if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || String(r.error)).trim().split('\n').slice(-3).join(' | ')}`)
    return r.stdout
  }
  const psql = (db, args, what) => run('psql.exe', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'orgtree_admin', '-d', db, ...args], what)
  // no pipes for pg_ctl start: the server it leaves running inherits them and
  // spawnSync would wait for their EOF forever (seen); its log says what went wrong
  const log = path.join(cluster, 'legacy32.log')
  const started = spawnSync(path.join(pgBin, 'pg_ctl.exe'), ['-D', pgdata, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', '-t', '120', '-l', log, 'start'],
    { stdio: 'ignore', windowsHide: true, timeout: 180000, env })
  if (started.status !== 0) throw new Error(`start postgres failed (${started.status ?? started.error}); see ${log}`)
  try { return await body(psql) } finally { run('pg_ctl.exe', ['-D', pgdata, '-m', 'fast', '-w', '-t', '60', 'stop'], 'stop postgres') }
}

/** The migrated, empty 3.2 cluster for `level` (cached). */
export async function template32(base, pgBin, level) {
  const dir = path.join(rigHome(), 'pg', `template32-${PG_VERSION}-${level ?? 'all'}`)
  if (fs.existsSync(path.join(dir, 'data', 'PG_VERSION'))) return dir
  const staging = dir + '.partial'
  fs.rmSync(staging, { recursive: true, force: true })
  fs.cpSync(base, staging, { recursive: true })
  await withPostgres(staging, pgBin, async psql => {
    for (const db of ['orgtree_app', 'orgtree_org_1']) {
      psql('postgres', ['-c', `CREATE DATABASE ${db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`], `create ${db}`)
      psql(db, ['-c', 'CREATE SCHEMA orgtree'], `schema in ${db}`)   // the 3.x runner creates it first (orgdb/migrate.py)
    }
    const files = d => fs.readdirSync(d).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()
    for (const f of files(path.join(MIGRATIONS, 'app'))) psql('orgtree_app', ['-1', '-f', path.join(MIGRATIONS, 'app', f)], `app migration ${f}`)
    for (const f of files(path.join(MIGRATIONS, 'org'))) {
      if (level && f.slice(0, 4) > level) break
      psql('orgtree_org_1', ['-1', '-f', path.join(MIGRATIONS, 'org', f)], `org migration ${f}`)
    }
  })
  fs.rmSync(path.join(staging, 'data', 'postmaster.pid'), { force: true })
  fs.renameSync(staging, dir)
  return dir
}

export async function prepare32({ data, pgBin, level, damage = [] }) {
  const cluster = path.join(data, 'pg', 'cluster')
  const tpl = await template32(cluster, pgBin, level)
  fs.rmSync(cluster, { recursive: true, force: true })
  fs.cpSync(tpl, cluster, { recursive: true })
  await withPostgres(cluster, pgBin, async psql => {
    const uuid = crypto.randomUUID()
    psql('orgtree_app', ['-c', `INSERT INTO orgtree.orgs (org_id, slug, org_uuid, database, state) OVERRIDING SYSTEM VALUE
                                VALUES (1, '${SLUG32}', '${uuid}', 'orgtree_org_1', 'active')`], 'registry row')
    const at = m => `'${new Date(Date.parse('2026-09-20T10:00:00Z') + m * 60000).toISOString()}'`
    psql('orgtree_org_1', ['-c', `
      INSERT INTO orgtree.org_settings (name, created) VALUES ('Legacy 3.2 Org', ${at(0)});
      INSERT INTO orgtree.agents (id, name, ord, state, title, model, credit_grant, generation, created, session_id, lineage_born)
        OVERRIDING SYSTEM VALUE VALUES
        (1, 'lead', 1, 'live', 'Legacy 3.2 lead', 'opus', 10, 1, ${at(0)}, 'sess-32-lead', 'born-32-lead');
      INSERT INTO orgtree.agents (id, name, ord, parent_id, state, title, model, credit_grant, generation, created, session_id, lineage_born)
        OVERRIDING SYSTEM VALUE VALUES
        (2, 'dev', 2, 1, 'live', 'Legacy 3.2 dev', 'sonnet', 2, 1, ${at(1)}, 'sess-32-dev', 'born-32-dev');
      INSERT INTO orgtree.agent_turns (id, agent_id, idx, at, cost, ms, toks) OVERRIDING SYSTEM VALUE VALUES (1, 2, 0, ${at(5)}, 0.2, 3000, 500);
      INSERT INTO orgtree.mail (id, agent_id, idx, public_id, "from", kind, body, at) OVERRIDING SYSTEM VALUE
        VALUES (1, 2, 0, 'm32-pending', 'lead', 'message', 'LEGACY32 pending mail for dev', ${at(9)});
      INSERT INTO orgtree.mail_log (id, agent_id, idx, public_id, "from", kind, body, at) OVERRIDING SYSTEM VALUE
        VALUES (1, 2, 0, 'm32-done', 'lead', 'message', 'LEGACY32 delivered mail', ${at(6)});
      INSERT INTO orgtree.user_inbox (id, ord, public_id, "from", kind, body, at) OVERRIDING SYSTEM VALUE
        VALUES (1, 0, 'm32-user', 'dev', 'message', 'LEGACY32 note to the user', ${at(7)});
      INSERT INTO orgtree.events (id, ord, op, actor, at, detail) OVERRIDING SYSTEM VALUE
        VALUES (1, 0, 'hire', '@user', ${at(1)}, '{"node":"dev","parent":"lead"}');
      INSERT INTO orgtree.documents (id, ord, public_id, node, title, body, at, format) OVERRIDING SYSTEM VALUE
        VALUES (1, 0, 'd32', 'lead', 'LEGACY32 plan', '# Plan', ${at(8)}, 'markdown');`], 'seed org')
    // one row in every other section the importer reads, so every typed
    // column read of the import runs (a type mismatch there would stop the
    // engine at every start)
    psql('orgtree_org_1', ['-c', `
      INSERT INTO orgtree.org_dirs (ord, path, mode) VALUES (0, 'E:/work/legacy32', 'ro');
      INSERT INTO orgtree.net_hubs (ord, public_id, address, enabled, name) VALUES (0, 'h32', 'hub.example.invalid:443', false, 'LEGACY32 hub');
      INSERT INTO orgtree.org_tier_prices (ord, key, value) VALUES (0, 'opus', 3.5);
      INSERT INTO orgtree.agent_texts (agent_id, charter, team_charter) VALUES (2, 'LEGACY32 charter of dev', 'LEGACY32 team charter');
      INSERT INTO orgtree.agent_dir_grants (agent_id, pos, path, mode) VALUES (2, 0, 'E:/work/legacy32/dev', 'rw');
      INSERT INTO orgtree.agent_mcp_servers (agent_id, pos, value) VALUES (2, 0, 'legacy-mcp');
      INSERT INTO orgtree.user_mail_log (ord, public_id, "from", kind, body, at, urgent, urgent_reason)
        VALUES (0, 'm32-read', 'lead', 'message', 'LEGACY32 mail the user read', ${at(10)}, true, 'LEGACY32 urgent');
      INSERT INTO orgtree.user_outbox (ord, public_id, "from", kind, body, at, "to")
        VALUES (0, 'm32-sent', 'user', 'message', 'LEGACY32 mail the user sent', ${at(11)}, 'dev');
      INSERT INTO orgtree.asks (id, ord, public_id, node, kind, question, at, status, rev) OVERRIDING SYSTEM VALUE
        VALUES (1, 0, 'q32', 'dev', 'question', 'LEGACY32 open question?', ${at(12)}, 'open', 1);
      INSERT INTO orgtree.ask_options (asks_id, pos, label, description) VALUES (1, 0, 'Yes', 'LEGACY32 option'), (1, 1, 'No', NULL);
      INSERT INTO orgtree.ask_work_items (asks_id, pos, value) VALUES (1, 0, 'legacy32-item');
      INSERT INTO orgtree.work_items (id, ord, list_key, docket_manual, docket_order, slug, rev, kind, title, objective, status,
                                      owner_node, owner_generation, created_by_node, created_by_generation, at, updated_at, docket_at, status_at)
        OVERRIDING SYSTEM VALUE
        VALUES (1, 0, 'active', false, '0', 'legacy32-item', 3, 'code', 'LEGACY32 item', 'LEGACY32 objective', 'in_progress',
                'dev', 1, 'lead', 1, ${at(2)}, ${at(13)}, ${at(13)}, ${at(13)});
      INSERT INTO orgtree.work_item_done (item_id, pos, value) VALUES (1, 0, 'LEGACY32 done one');
      INSERT INTO orgtree.work_item_next (item_id, pos, value) VALUES (1, 0, 'LEGACY32 next one');
      INSERT INTO orgtree.work_item_participants (item_id, pos, value) VALUES (1, 0, 'lead');
      INSERT INTO orgtree.work_item_dependencies (item_id, pos, value) VALUES (1, 0, 'legacy32-other');
      -- per-item history came with org migration 0010
      DO $$ BEGIN IF to_regclass('orgtree.work_item_events') IS NOT NULL THEN
        INSERT INTO orgtree.work_item_events (item_id, seq, source, kind, status_change, at, by_node, by_generation, content,
                                              history_op, history_status_from, history_status_to, history_note)
          VALUES (1, 1, 'history', 'history', true, ${at(13)}, 'dev', 1, 'LEGACY32 history', 'update', 'open', 'in_progress', 'LEGACY32 note');
      END IF; END $$;
      -- the attention columns came with org migration 0016
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'orgtree'
                               AND table_name = 'work_items' AND column_name = 'attention_reason') THEN
        UPDATE orgtree.work_items SET attention_reason = 'LEGACY32 attention', attention_at = ${at(14)}, attention_by_name = 'lead',
                                      attention_by_generation = 1, attention_set_rev = 2 WHERE id = 1;
      END IF; END $$;
      INSERT INTO orgtree.watchdogs (ord, public_id, owner, name, kind, target, pattern, interval_s, state, at, fired, once, shell, fire_mode)
        VALUES (0, 'w32', 'dev', 'LEGACY32 dog', 'file', 'E:/work/legacy32/log.txt', 'ERROR', 60, 'armed', ${at(3)}, 0, false, 'native', 'event');
      INSERT INTO orgtree.audience_grants (ord, grantee, grantor, granted_at, reason) VALUES (0, 'dev', 'lead', ${at(4)}, 'LEGACY32 grant');
      INSERT INTO orgtree.audience_requests (ord, node, target, reason, at, status) VALUES (0, 'dev', 'user', 'LEGACY32 request', ${at(4)}, 'pending');
      INSERT INTO orgtree.org_inbox (ord, public_id, dir, peer, body, at) VALUES (0, 'x32', 'in', '@org:other', 'LEGACY32 org mail', ${at(15)});`],
    'seed every section')
    for (const sql of damage) psql('orgtree_org_1', ['-c', sql], `damage: ${sql}`)
  })
  fs.rmSync(path.join(cluster, 'data', 'postmaster.pid'), { force: true })
}
