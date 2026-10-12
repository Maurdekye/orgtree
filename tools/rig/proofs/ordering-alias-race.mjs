import path from 'node:path';
import { spawn } from 'node:child_process';
import { Proof } from '../proof.mjs';
export function setup() { return { fixture: 'ordering-alias-race' }; }
export default async function(rig) {
  const p = new Proof('ordering-alias-race');
  const conn = rig.pgConn();
  const args = ['-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(conn.port),'-U','orgtree_admin','-d','orgtree_engine'];
  const blocker = spawn(path.join(rig.run.pgBin,'psql.exe'),args,{windowsHide:true,env:{...process.env,PGPASSWORD:conn.password,PGAPPNAME:'ordering-review-barrier'}});
  let output = ''; let errs = ''; blocker.stdout.on('data',d=>output+=d); blocker.stderr.on('data',d=>errs+=d);
  const x = rig.one("SELECT id FROM ot.agents WHERE name='x'").id;
  const origin = rig.one("SELECT id FROM ot.agents WHERE name='origin'").id;
  const dest = rig.one("SELECT id FROM ot.agents WHERE name='dest'").id;
  const a = rig.one("SELECT id FROM ot.agents WHERE name='a'").id;
  p.check('fixture makes the arriving seat win an equal-order id tie', x < a, {x,a});
  const roots = () => rig.sql(`SELECT name,sibling_order FROM ot.agents WHERE parent_id=${dest} AND state='live' ORDER BY sibling_order,id`);
  rig.exec(`CREATE FUNCTION public.review_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${x} AND NEW.parent_id=${dest} AND OLD.parent_id<>${dest} THEN PERFORM pg_advisory_xact_lock(9081201); END IF; RETURN NEW; END $$;
    CREATE TRIGGER review_barrier BEFORE UPDATE OF parent_id ON ot.agents FOR EACH ROW EXECUTE FUNCTION public.review_barrier()`);
  try {
    for (const op of ['demote','promote','move']) {
      rig.exec(`UPDATE ot.agents SET parent_id=${origin},sibling_order=1 WHERE id=${x}; UPDATE ot.agents SET sibling_order=CASE name WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE sibling_order END WHERE parent_id=${dest}`);
      const logStart = rig.engineLog().length;
      output=''; blocker.stdin.write("SELECT pg_advisory_lock(9081201); SELECT 'READY';\n");
      await rig.waitFor(()=>output.includes('READY'),{what:'barrier acquired',timeout:10000});
      const moving = rig.op({op,node:'x',new_parent:'dest'});
      await rig.waitFor(()=>rig.one("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event='advisory' AND application_name<>'ordering-review-barrier'").n>0,{what:'move paused after its root max read',timeout:15000});
      const ordered = await rig.tool('dest','orgtree_reorder',{node:'a',index:1});
      const beforeRelease=roots();
      blocker.stdin.write("SELECT pg_advisory_unlock(9081201);\n");
      const moved=await moving;
      const final=roots();
      const ok = ordered.ok && moved.node==='x' && beforeRelease.map(a=>a.name).join(',')==='b,a'
        && final.map(a=>a.name).join(',')==='b,a,x' && final.map(a=>a.sibling_order).join(',')==='2,3,4';
      p.check(`${op} is serializable with final-index placement`,ok,{ordered,moved,beforeRelease,final});
      const retries = rig.engineLog().slice(logStart).split(/\r?\n/)
        .filter(line=>line.includes(`op conflicted with another write; retrying op=${op} attempt=1`));
      p.check(`${op} retries the controlled conflict retaining its request label`, retries.length===1, {retries});
    }
    p.keep(rig,{grep:/op conflicted|promote|demote|reorder/});
    return p.summary();
  } finally {
    blocker.stdin.end("SELECT pg_advisory_unlock_all();\n\\q\n");
    await new Promise(resolve=>{blocker.once('exit',resolve);setTimeout(()=>{blocker.kill();resolve();},3000)});
    if (errs) p.note('barrier stderr',errs);
  }
}
