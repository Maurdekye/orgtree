// Execute the production opening SQL against a fresh synthetic PostgreSQL cluster.
// No engine/auth/live database is opened. The parent must hold a build permit.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const [repo,out,bin]=process.argv.slice(2);if(!repo||!out||!bin)throw Error('repo output pg-bin required');
const root='D:/orgtree-work/rig/uninit-model-sol/runs/presentation-opening-'+Date.now();fs.mkdirSync(root,{recursive:true});fs.mkdirSync(out,{recursive:true});
const data=path.join(root,'pg'),port=58463,exe=name=>path.join(bin,name+'.exe');
let command=0;
function run(name,args){
 // postgres inherits startup handles: a pipe would keep spawnSync waiting
 // until the server exits even after pg_ctl returned. File handles stay safe.
 const logFile=out+'/command-'+(++command)+'-'+name+'.log',fd=fs.openSync(logFile,'w');let r;
 try{r=spawnSync(exe(name),args,{windowsHide:true,stdio:['ignore',fd,fd],timeout:60000})}finally{fs.closeSync(fd)}
 const log=fs.readFileSync(logFile,'utf8');fs.appendFileSync(out+'/pg-processes.log',JSON.stringify({name,status:r.status,signal:r.signal,error:r.error?.message})+'\n'+log);
 if(r.status!==0||r.signal||r.error)throw Error(name+' failed');return log.replaceAll('\r\n','\n').trim();
}
function sql(text){const file=out+'/query.sql';fs.writeFileSync(file,text);return run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-f',file]);}
const source=fs.readFileSync(repo+'/engine/rs/orgtree-engine/src/http/docs.rs','utf8');
const query=name=>{const q=source.match(new RegExp('const '+name+': &str = "([\\s\\S]*?)";'));if(!q)throw Error('missing production SQL '+name);return q[1]};
let started=false;try{
 run('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--no-locale']);
 run('pg_ctl',['-D',data,'-l',out+'/postgres.log','-o','-h 127.0.0.1 -p '+port+' -c shared_buffers=16MB -c max_connections=8','-w','start']);started=true;
 sql(`CREATE SCHEMA ot;CREATE TABLE ot.agents(id bigint PRIMARY KEY,org_id bigint,name text,state text);INSERT INTO ot.agents VALUES(1,1,'renamed-agent','live'),(2,1,'project','live'),(3,1,'retired','archived');
 CREATE TABLE ot.documents(id bigint PRIMARY KEY,uid text UNIQUE,org_id bigint,agent_id bigint,node_name text,at timestamptz,viewed_at timestamptz,dismissed boolean DEFAULT false);
 CREATE INDEX documents_org ON ot.documents(org_id,id DESC);
 INSERT INTO ot.documents SELECT n,'doc-'||n,1,1,'old-agent-name','2026-10-01'::timestamptz+n*interval '1 minute','2026-10-01'::timestamptz+n*interval '1 minute',false FROM generate_series(1,120) n;
 UPDATE ot.documents SET viewed_at=NULL WHERE id=3;UPDATE ot.documents SET at='2026-10-20' WHERE id=4;
 INSERT INTO ot.documents VALUES(121,'dismissed',1,1,'old-agent-name','2026-01-01',NULL,true),(122,'retired',1,3,'retired','2026-01-01',NULL,false),(123,'other-org',2,1,'old-agent-name','2026-01-01',NULL,false),(124,'project-doc',1,2,'old-project-name','2026-10-15',NULL,false);
 ${fs.readFileSync(repo+'/engine/rs/orgtree-engine/migrations/0041_document_opening.sql','utf8')}`);
 sql('PREPARE unread(bigint,text,bigint[],boolean) AS '+query('OPENING_UNREAD_SQL')+'; PREPARE newest(bigint,text,bigint[],boolean) AS '+query('OPENING_NEWEST_SQL')+';');
 // PREPARE is per connection; every check below reuses the actual SQL with typed parameters.
 const execute=(name,types,args)=>sql('PREPARE probe('+types+') AS '+query(name)+';EXECUTE probe('+args+');').split('\n').pop();
 assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'',NULL,true"),'doc-3|3');
 const position=Number(execute('OPENING_POSITION_SQL','bigint,bigint,text,bigint[]',"1,3,'',NULL"));assert.equal(position,120);
 const page=sql('SELECT uid FROM ot.documents WHERE org_id=1 ORDER BY id DESC OFFSET '+Math.floor(position/40)*40+' LIMIT 40;').split('\n');assert.ok(page.includes('doc-3'));assert.ok(page.length<=40);assert.equal(page.length,3);
 assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'renamed-agent',ARRAY[1]::bigint[],false"),'doc-3|3','renamed agent read by id');
 assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'project',ARRAY[2]::bigint[],false"),'project-doc|124','project scope');
 assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'team',ARRAY[1,2]::bigint[],false"),'doc-3|3','team scope');
 assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'',NULL,false"),'retired|122','retired included only on explicit filter');
 sql("UPDATE ot.documents SET viewed_at=at WHERE id=3");assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'renamed-agent',ARRAY[1]::bigint[],false"),'doc-4|4','changed at replaces creation order');
 sql('UPDATE ot.documents SET viewed_at=at WHERE NOT dismissed');assert.equal(execute('OPENING_UNREAD_SQL','bigint,text,bigint[],boolean',"1,'',NULL,true"),'','no unread');
 assert.equal(execute('OPENING_NEWEST_SQL','bigint,text,bigint[],boolean',"1,'',NULL,true"),'doc-4|4','fallback newest modified, not greatest id');
 assert.equal(execute('OPENING_NEWEST_SQL','bigint,text,bigint[],boolean',"99,'',NULL,true"),'','empty org');
 const explain=sql('SET enable_seqscan=off; PREPARE probe(bigint,text,bigint[],boolean) AS '+query('OPENING_UNREAD_SQL')+";EXPLAIN EXECUTE probe(1,'',NULL,true);");assert.match(explain,/documents_opening_unread/);
 fs.writeFileSync(out+'/sql-result.json',JSON.stringify({root,position,pageRows:page.length,tests:12,pass:12,explain},null,2));console.log('Production PostgreSQL SQL checks passed:12; target position120, bounded page3.');
}finally{if(started)run('pg_ctl',['-D',data,'-m','fast','-w','stop']);}
