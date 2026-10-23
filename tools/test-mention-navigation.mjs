// Focused SQL unit fixture: fresh private cluster, no engine/rig/live settings.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [outArg, sourceArg] = process.argv.slice(2)
const out = path.resolve(outArg), source = path.resolve(sourceArg)
const owner=process.env.ORGTREE_AGENT
assert.match(owner ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'ORGTREE_AGENT required')
const ownerRoot=path.resolve('C:/orgtree-build',owner)
assert.ok(out.toLowerCase().startsWith(ownerRoot.toLowerCase()+path.sep), 'private owned output required')
for (let p=out; ; p=path.dirname(p)) {
  if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), 'linked output ancestor refused')
  if (p===path.dirname(p)) break
}
assert.ok(!fs.existsSync(out), 'SQL output must be fresh')
fs.mkdirSync(out, { recursive: true })
const pgEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('PG')))
const emptyProfile=path.join(out,'empty-pg-profile')
fs.writeFileSync(emptyProfile,'')
Object.assign(pgEnv,{PGPASSFILE:emptyProfile,PGSERVICEFILE:emptyProfile,PGSYSCONFDIR:out,
  PGSSLMODE:'disable',PGGSSENCMODE:'disable',PGHOSTADDR:'127.0.0.1',PGCONNECT_TIMEOUT:'5'})
const pg = path.join(out, 'postgresql'), data = path.join(out, 'data')
for (const sub of ['bin', 'lib', 'share']) fs.cpSync(path.join(source, sub), path.join(pg, sub), { recursive: true })
const reserve = net.createServer()
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
const port = String(reserve.address().port)
await new Promise(resolve => reserve.close(resolve))
const calls = [], checks = []
function run(exe, args) {
  const r = spawnSync(path.join(pg, 'bin', exe + '.exe'), args,
    { encoding: 'utf8', env:pgEnv, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      ...(exe === 'pg_ctl' && args.includes('start') ? { stdio: 'ignore' } : {}) })
  calls.push({ exe, status: r.status, signal: r.signal, error: r.error?.message })
  if (r.error || r.status !== 0) throw Error(`${exe}: ${r.status}\n${r.stderr}`)
  return r.stdout?.replace(/\r\n/g, '\n').trim() ?? ''
}
let serial = 0, started = false, error
function sql(text) {
  const file = path.join(out, `query-${serial++}.sql`)
  fs.writeFileSync(file, text)
  return run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', port, '-U', 'synthetic', '-d', 'postgres', '-f', file])
}
const bind = (q, args) => q.replace(/\$(\d+)/g, (_, n) => args[Number(n) - 1])
function check(name, fn) { fn(); checks.push(name) }
try {
  run('initdb', ['-D', data, '-U', 'synthetic', '-A', 'trust', '--encoding=UTF8', '--locale=C', '--no-instructions'])
  run('pg_ctl', ['-D', data, '-l', path.join(out, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c fsync=off -c shared_buffers=16MB`, '-w', 'start'])
  started = true
  assert.equal(path.resolve(sql('SHOW data_directory')).toLowerCase(),path.resolve(data).toLowerCase(), 'disposable server identity')
  sql(`CREATE SCHEMA ot;
    CREATE TABLE ot.orgs(id bigint PRIMARY KEY,slug text);
    CREATE TABLE ot.agents(id bigint PRIMARY KEY, org_id bigint, name text, state text, generation int DEFAULT 1, extra jsonb DEFAULT '{}');
    CREATE TABLE ot.work_items(id bigint PRIMARY KEY, org_id bigint, slug text, archived_at timestamptz, extra jsonb DEFAULT '{}');
    CREATE TABLE ot.mail(id bigserial PRIMARY KEY,org_id bigint,uid text,body text,urgent_reason text,sender_agent_id bigint,recipient_kind text,recipient_name text,state text,created_at timestamptz DEFAULT now());
    CREATE TABLE ot.org_inbox(id bigserial PRIMARY KEY,org_id bigint,uid text,body text,at timestamptz DEFAULT now());
    CREATE INDEX agents_live ON ot.agents(org_id,id) WHERE state='live';
    CREATE INDEX work_items_active ON ot.work_items(org_id,id) WHERE archived_at IS NULL;
    CREATE INDEX mail_user_unread ON ot.mail(org_id,id) WHERE recipient_kind='user' AND state='pending';
    INSERT INTO ot.orgs VALUES(1,'one'),(2,'two');
    INSERT INTO ot.agents(id,org_id,name,state,extra) VALUES(1,1,'worker','live','{"user_mention":{"id":"pending","event_id":"e7","at":"2026-10-22T21:00:00Z","blurb":"Pending @user"}}');
    INSERT INTO ot.work_items VALUES(1,1,'ticket',NULL,'{"user_mention":{"rev":1,"at":"2026-10-22T22:00:00Z","blurb":"Ticket @user"}}');`)
  sql(fs.readFileSync(path.join(repo, 'engine/rs/orgtree-engine/migrations/0053_mention_navigation.sql'), 'utf8'))
  const rust = fs.readFileSync(path.join(repo, 'engine/rs/orgtree-engine/src/domain/mention_navigation.rs'), 'utf8')
  const template = rust.match(/tx\.query\(&format!\("([\s\S]*?)"\),/)[1]
  const config = [...rust.matchAll(/\("([^"]*)", "([^"]*)", "([^"]*)", "([^"]*)",\s*"([^"]*)"\)/g)]
  assert.equal(config.length, 2, 'execute both actual pending-marker SQL templates')
  for (const [, table, predicate, kind, key, target] of config) {
    const variables = { table, predicate, kind, key, target }
    sql(bind(template.replace(/\{(\w+)\}/g, (_, k) => variables[k]), ['1', '2000']))
  }
  check('pending seed executes actual source SQL', () => assert.equal(sql('SELECT count(*) FROM ot.mention_navigation'), '2'))
  sql(`INSERT INTO ot.agents(id,org_id,name,state,extra) VALUES(2,1,'new','live','{"user_mention":{"id":"new","event_id":"e8","at":"2026-10-22T23:00:00Z","blurb":"New @user"}}');`)
  check('producer trigger inserts new marker', () => assert.equal(sql('SELECT count(*) FROM ot.mention_navigation'), '3'))
  sql(`UPDATE ot.agents SET extra='{}',name='renamed' WHERE id=2;`)
  check('seen survives and rename follows identity', () => assert.equal(sql("SELECT target->>'node' FROM ot.mention_navigation WHERE source_key='agent:2:new'"), 'renamed'))
  sql(`UPDATE ot.agents SET extra='{"user_mention":{"id":"new","event_id":"e8","at":"2026-10-23T00:00:00Z","blurb":"Updated @user"}}' WHERE id=2;`)
  check('same identity updates excerpt without reordering', () => assert.equal(sql("SELECT blurb||'|'||extract(hour FROM at AT TIME ZONE 'UTC') FROM ot.mention_navigation WHERE source_key='agent:2:new'"), 'Updated @user|23'))
  sql(`UPDATE ot.work_items SET extra=extra||'{"deleted":true}' WHERE id=1;`)
  check('soft deleted ticket removes retained excerpt', () => assert.equal(sql("SELECT count(*) FROM ot.mention_navigation WHERE source_key LIKE 'work:%'"), '0'))
  sql(`INSERT INTO ot.mail(org_id,uid,body,sender_agent_id,recipient_kind,recipient_name,state) VALUES(1,'m1','Mail @user',1,'user','@user','pending');`)
  const mail = rust.match(/client\.query\("([\s\S]*?)", &\[&org,&uid,&blurb\]/)[1]
  sql(bind(mail, ['1', "'m1'", "'Mail @user'"]))
  check('mail producer SQL records destination', () => assert.equal(sql("SELECT target->>'to' FROM ot.mention_navigation WHERE source_key='mail:m1'"), 'user_inbox'))
  sql("INSERT INTO ot.org_inbox(org_id,uid,body) VALUES(1,'x1','Outside @user')")
  const orgmail = rust.match(/client\.query\("(SELECT ot\.record_user_mention\(i\.org_id[\s\S]*?)", &\[&org,&uid,&clean\.as_ref\(\)\]/)[1]
  sql(bind(orgmail, ['1', "'x1'", "'Outside @user'"]))
  check('organization mail routes to its own inbox', () => assert.equal(sql("SELECT target->>'to' FROM ot.mention_navigation WHERE source_key='orgmail:x1'"), '@org:one'))
  sql("DELETE FROM ot.org_inbox WHERE uid='x1'")
  sql(`UPDATE ot.mail SET state='retracted' WHERE uid='m1';`)
  check('retraction removes navigation copy', () => assert.equal(sql("SELECT count(*) FROM ot.mention_navigation WHERE source_key='mail:m1'"), '0'))
  sql(`DELETE FROM ot.mail WHERE uid='m1'; DELETE FROM ot.agents WHERE id=2;`)
  check('source deletes remove navigation copies', () => assert.equal(sql('SELECT count(*) FROM ot.mention_navigation'), '1'))
  sql(`SELECT ot.record_user_mention(2,'agent:1:pending',now(),'{"kind":"work","item":"other"}','Other @user');
    SELECT ot.record_user_mention(1,'bulk:'||g,'2026-11-01T00:00:00Z'::timestamptz+g*interval '1 second','{"kind":"work","item":"ticket"}','Bounded @user') FROM generate_series(1,2001) g;`)
  check('retention is bounded independently per org', () => assert.equal(sql('SELECT org_id||\':\'||count(*) FROM ot.mention_navigation GROUP BY org_id ORDER BY org_id'), '1:2000\n2:1'))
  const cursorQuery = rust.match(/client\.query_opt\("(SELECT id,at,target,blurb[^"\n]*\(at,id\)[^"\n]*)"/)[1]
  const latestId = sql('SELECT id FROM ot.mention_navigation WHERE org_id=1 ORDER BY at DESC,id DESC LIMIT 1')
  const cursorArgs = ['1', "'2026-11-01T00:00:00Z'::timestamptz+2001*interval '1 second'", latestId]
  const page = sql(bind(cursorQuery, cursorArgs))
  check('indexed cursor returns one prior destination', () => {
    assert.equal(page.split('\n').length, 1)
    assert.equal(Number(page.split('|')[0]), Number(latestId) - 1)
  })
  const plan = sql('EXPLAIN ' + bind(cursorQuery, cursorArgs))
  fs.writeFileSync(path.join(out, 'cursor-plan.txt'), plan)
  check('cursor uses dedicated bounded index', () => assert.ok(plan.includes('mention_navigation_cursor')))
} catch (e) { error = e.stack }
finally {
  if (started) { try { run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']) } catch (e) { error = (error ?? '') + '\nSTOP: ' + e.stack } }
  const result = { pass: !error, checks, calls, error }
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, checks, error }, null, 2))
  process.exitCode = result.pass ? 0 : 1
}
