// Synthetic SQL-only proof; never starts an engine or reads live credentials.
// node tools/rig/check-dead-letter-indexes.mjs <output-C-agent-dir> <fresh-D-rig-dir> <pg-bin> <port>
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const [out,data,bin,port]=process.argv.slice(2)
const scope=(out??'').match(/^C:[\\/]orgtree-build[\\/]([^\\/]+)[\\/]/i)
const rigScope=(data??'').match(/^D:[\\/]orgtree-work[\\/]rig[\\/]([^\\/]+)[\\/]/i)
assert.ok(scope&&rigScope&&scope[1]===rigScope[1],'output and fresh cluster must be in matching owned build/rig scopes')
assert.match(port??'',/^\d{4,5}$/)
assert.ok(!fs.existsSync(data),'fresh isolated cluster required')
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(data,{recursive:true})
const calls=[],checks=[],plans=[]
function run(exe,args,options={}){
 const r=spawnSync(path.join(bin,exe+'.exe'),args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,...options})
 calls.push({exe,status:r.status,signal:r.signal,error:r.error?.message??null})
 if(r.error||r.status!==0)throw Error(exe+' '+r.status+' '+r.stderr)
 return r.stdout??''
}
let serial=0
function sql(text){
 const f=path.join(out,`sql-${serial++}.sql`);fs.writeFileSync(f,text)
 return run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','synthetic','-d','postgres','-f',f]).trim()
}
function json(sqlText){return JSON.parse(sql(sqlText))}
function check(name,fn){try{fn();checks.push({name,pass:true})}catch(e){checks.push({name,pass:false,error:e.message})}}
const dead=fs.readFileSync(path.join(repo,'engine/rs/orgtree-engine/src/domain/dead_letters.rs'),'utf8')
const feed=fs.readFileSync(path.join(repo,'engine/rs/orgtree-engine/src/feed/compute.rs'),'utf8')
const open=dead.match(/pub const OPEN: &str = "([^"]+)"/)[1]
const any=dead.match(/const ANY: &str = "([^"]+)"/)[1]
// Read the actual production SQL, so a changed reader cannot silently leave
// the proof measuring a hand-written approximation.
const counts=[...dead.matchAll(/\.query_one\((?:&format!\("([^"]+)"\)|"([^"]+)")/g)].map(x=>(x[1]??x[2]).replaceAll('{OPEN}',open).replaceAll('{ANY}',any))
assert.equal(counts.length,2,'production open and dropped count readers')
const page=dead.match(/&format!\("(SELECT m.uid,[\s\S]+?)"\),\s*&\[&project, &limit, &offset\]/)[1]
const unread=fs.readFileSync(path.join(repo,'engine/rs/orgtree-engine/src/domain/mail.rs'),'utf8').match(/pub const UNREAD_STATES: &str = "([^"]+)"/)[1]
const agent=feed.match(/const AGENT_SQL: &str = r#"([\s\S]+?)"#;/)[1].replaceAll('__UNREAD_STATES__',unread)
const bind=(q,id=1)=>q.replaceAll('$1',String(id)).replaceAll('$2','2').replaceAll('$3','0')
function queryPlan(name,q){
 const p=json('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q)[0]
 let examined=0;const indexes=[]
 const visit=n=>{if(n['Relation Name']==='mail')examined+=((n['Actual Rows']??0)+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*(n['Actual Loops']??1);if(n['Index Name'])indexes.push(n['Index Name']);for(const c of n.Plans??[])visit(c)}
 visit(p.Plan);const result={name,examined,indexes,plan:p};plans.push(result);return result
}
function snapshot(tag){
 const before=plans.length
 queryPlan(tag+'-feed',agent+' WHERE a.id=1')
 for(const [i,q]of counts.entries())queryPlan(tag+'-count-'+i,bind(q))
 queryPlan(tag+'-default-page',bind(page.replaceAll('{scope}',open)))
 queryPlan(tag+'-including-dropped-page',bind(page.replaceAll('{scope}',any)))
 for(const p of plans.slice(before))check(p.name+' bounds mail rows',()=>assert.ok(p.examined<=16,`${p.name} examined ${p.examined} mail rows`))
}
function totals(){return {open:Number(sql(bind(counts[0]))),dropped:Number(sql(bind(counts[1])))}}
let started=false,error=null
try{
 run('initdb',['-D',data,'-U','synthetic','-A','trust','--encoding=UTF8','--locale=C','--no-instructions'])
 const start=spawnSync(path.join(bin,'pg_ctl.exe'),['-D',data,'-l',path.join(out,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c fsync=off`,'-w','start'],{stdio:'ignore',windowsHide:true})
 calls.push({exe:'pg_ctl start',status:start.status,signal:start.signal,error:start.error?.message??null});assert.equal(start.status,0);started=true
 // Upgrade control: install the actual embedded pre-0051 migrations, seed
 // history, then install 0051 in one transaction just like migrate::run.
 const migrations=[...fs.readFileSync(path.join(repo,'engine/rs/orgtree-engine/src/migrate.rs'),'utf8').matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map(x=>x[1])
 for(const f of migrations.filter(f=>!f.startsWith('0051_')))sql('BEGIN;'+fs.readFileSync(path.join(repo,'engine/rs/orgtree-engine/migrations',f),'utf8')+'COMMIT;')
 sql(`INSERT INTO ot.orgs(uuid,slug,name) VALUES('00000000-0000-0000-0000-000000000001','synthetic','synthetic');
 INSERT INTO ot.agents(org_id,name,state,tier,born,kind) VALUES(1,'project','live','project','synthetic','project'),(1,'other','live','project','synthetic','project');
 INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
 SELECT 'history-'||n,1,'@user','agent',1,'project','synthetic','read',CASE WHEN n%2=0 THEN '{"dead_letter":null,"dead_letter_dropped":null}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1,10000)n;
 INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
 SELECT 'open-'||n,1,'@user','agent',1,'project','synthetic','read','{"dead_letter":{"attempts":2},"attempt_log":[{"n":2}]}' FROM generate_series(1,3)n;`)
 const before=json("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ot.mail m WHERE uid LIKE 'open-%'")
 for(const f of migrations.filter(f=>f.startsWith('0051_')))sql('BEGIN;'+fs.readFileSync(path.join(repo,'engine/rs/orgtree-engine/migrations',f),'utf8')+'COMMIT;')
 check('upgrade keeps exact open/dropped totals',()=>assert.deepEqual(totals(),{open:3,dropped:5000}))
 check('upgrade preserves existing mail and attempt history',()=>assert.deepEqual(json("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ot.mail m WHERE uid LIKE 'open-%'"),before))
 sql('VACUUM ANALYZE ot.mail;');snapshot('10k')
 sql(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
 SELECT 'later-'||n,1,'@user','agent',1,'project','synthetic','read',CASE WHEN n%2=0 THEN '{"dead_letter":{},"dead_letter_dropped":{}}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1,10000)n; VACUUM ANALYZE ot.mail;`)
  check('more inactive history leaves open count fixed',()=>assert.deepEqual(totals(),{open:3,dropped:10000}));snapshot('20k')
 sql(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state)
 SELECT 'answered-tail-'||n,1,'@user','agent',1,'project','synthetic','read' FROM generate_series(1,10000)n; VACUUM ANALYZE ot.mail;`)
 check('answered tail preserves both totals',()=>assert.deepEqual(totals(),{open:3,dropped:10000}));snapshot('30k-answered-tail')
 // Membership transitions: pending -> read -> open -> dropped -> retry,
 // recipient changes, delete, and rolled-back writes must all stay exact.
 const equal=tag=>check(tag,()=>{
  const expected=json(`SELECT jsonb_build_object('open',count(*)FILTER(WHERE ${open}),'dropped',count(*)FILTER(WHERE ${any} AND m.extra?'dead_letter_dropped')) FROM ot.mail m WHERE recipient_agent_id=1`)
  assert.deepEqual(totals(),expected)
 })
 for(const [tag,statement]of [
  ['drop',"UPDATE ot.mail SET extra=extra||'{\"dead_letter_dropped\":{\"reason\":\"synthetic\"}}' WHERE uid='open-1'"],
  ['retry',"UPDATE ot.mail SET state='pending',extra=extra-'dead_letter' WHERE uid='open-2'"],
  ['move recipient',"UPDATE ot.mail SET recipient_agent_id=2 WHERE uid='open-3'"],
  ['metadata-only write',"UPDATE ot.mail SET extra=extra||'{\"note\":1}' WHERE uid='open-1'"],
  ['return open',"UPDATE ot.mail SET state='read',extra=extra||'{\"dead_letter\":{}}' WHERE uid='open-2'"],
  ['rollback',"BEGIN; UPDATE ot.mail SET extra=extra||'{\"dead_letter_dropped\":{}}' WHERE uid='open-2'; ROLLBACK"],
  ['delete',"DELETE FROM ot.mail WHERE uid='open-2'"],
  ['leave read',"UPDATE ot.mail SET state='retracted' WHERE uid='open-1'"],
 ]){sql(statement);equal(tag)}
 sql('DELETE FROM ot.mail WHERE recipient_agent_id=2;')
  check('empty recipient has zero counts',()=>assert.deepEqual({open:Number(sql(bind(counts[0],2))),dropped:Number(sql(bind(counts[1],2)))},{open:0,dropped:0}))
 // Two writers creating the same previously absent counter must not lose an
 // increment. Await BOTH children even if one fails, before stopping the DB.
 const writers=await Promise.all([1,2].map(n=>new Promise(resolve=>{
  const f=path.join(out,`concurrent-${n}.sql`)
  fs.writeFileSync(f,`BEGIN; INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
    VALUES('concurrent-${n}',1,'@user','agent',2,'other','synthetic','read','{"dead_letter":{}}'); SELECT pg_sleep(0.05); COMMIT;`)
  const p=spawn(path.join(bin,'psql.exe'),['-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','synthetic','-d','postgres','-f',f],{stdio:'ignore',windowsHide:true})
  let spawnError=null;p.on('error',e=>{spawnError=e.message});p.on('close',(status,signal)=>resolve({exe:'concurrent psql',status,signal,error:spawnError}))
 })))
 calls.push(...writers);check('both concurrent writers commit',()=>assert.ok(writers.every(r=>r.status===0&&!r.error)))
 check('concurrent first-counter creation retains both increments',()=>assert.equal(Number(sql(bind(counts[0],2))),2))
 equal('concurrent writes keep other recipient exact')
 sql('TRUNCATE ot.mail;')
 check('truncate resets totals',()=>assert.deepEqual(totals(),{open:0,dropped:0}))
 if(migrations.some(f=>f.startsWith('0051_')))check('truncate clears materialized membership',()=>assert.equal(Number(sql('SELECT count(*) FROM ot.project_dead_letter_counts')),0))
}catch(e){error=e.stack}
finally{
 if(started){const r=spawnSync(path.join(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop'],{encoding:'utf8',windowsHide:true});calls.push({exe:'pg_ctl stop',status:r.status,signal:r.signal,error:r.error?.message??null});if(r.status!==0)error=(error??'')+' PG STOP FAILED '+r.stderr}
 const receipt={sha:spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim(),checks,plans,calls,error,pass:!error&&checks.every(c=>c.pass)}
 fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2))
 console.log(JSON.stringify({...receipt,calls:{total:calls.length,failed:calls.filter(c=>c.status!==0)},plans:plans.map(({plan,...p})=>p)},null,2));process.exitCode=receipt.pass?0:1
}
