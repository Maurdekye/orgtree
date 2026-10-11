import fs from 'node:fs'
import path from 'node:path'
import {startFakeLlm} from '../fakellm.mjs'
import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'
export async function setup(){return {name:'standing-notes','real-cli':true,fixture:'none'}}
export default async function(rig){
 const p=new Proof('standing-notes');const llm=await startFakeLlm({bodies:path.join(p.dir,'bodies'),models:[{name:'fake-model:latest',context:131072,running:65536}],rules:[]});
 try {
 const tiers={};for(const [h,harness]of [['cc','claude-code'],['cx','codex-cli']]){const r=await rig.api('POST','/api/langservers',{preset:'llamacpp',address:llm.url,harness,label:'Standing '+h,models:[{id:'fake-model:latest',context:65536}]});tiers[h]=Object.values(r.server.models)[0].tier}
 const grantRoot=path.join(rig.data,'notes-grants');fs.mkdirSync(grantRoot,{recursive:true});
 await seed(rig,{org:{name:'Standing Notes Proof',dirs:[grantRoot]},agents:[{name:'lead',tier:tiers.cc,grant:20,charter:'You lead a scratch proof.'}]});
 for(const [h,tier]of Object.entries(tiers))for(const mode of ['agents','both','legacy',...(h==='cc'?['import']:['override'])]){
 const name=h+mode,token='PROOF-NOTES-'+name;const grant=path.join(rig.data,'notes-grants',name);fs.mkdirSync(grant,{recursive:true});
 await rig.op({op:'hire',name,parent:'lead',tier,grant:0,charter:'Read your standing notes and answer OK.',add_dirs:[{path:grant,mode:'rw'}],permission_mode:'bypassPermissions'});
 const own=path.join(rig.data,'scratch',rig.org,name);fs.mkdirSync(own,{recursive:true});
 const values={};const write=(dir,file,marker)=>{fs.writeFileSync(path.join(dir,file),marker);values[marker]=1};
 if(mode!=='legacy')write(own,'AGENTS.md','NOTES_CANONICAL_'+name);
 if(mode!=='agents')write(own,'CLAUDE.md','NOTES_LEGACY_'+name);
 if(mode==='import')fs.appendFileSync(path.join(own,'CLAUDE.md'),'\n@AGENTS.md');
 if(mode==='override')write(own,'AGENTS.override.md','NOTES_OVERRIDE_'+name);
 write(grant,'AGENTS.md','NOTES_GRANTED_CANONICAL_'+name);write(grant,'CLAUDE.md','NOTES_GRANTED_LEGACY_'+name);
 await rig.userMail(name,token+': answer OK.');
 const seen=await rig.waitFor(()=>llm.requests.find(r=>r.last_user?.includes(token)&&r.body_file),{what:token,timeout:90000});const raw=fs.readFileSync(path.join(p.dir,'bodies',seen.body_file),'utf8');
 const counts=Object.fromEntries(Object.keys(values).map(v=>[v,raw.split(v).length-1]));p.check(name+': every standing note delivered exactly once',Object.values(counts).every(c=>c===1),counts);
 const identityFile=path.join(own,'.orgtree-identity.md');const identity=fs.existsSync(identityFile)?fs.readFileSync(identityFile,'utf8'):String(JSON.parse(raw).instructions??raw);p.check(name+': new writes use AGENTS.md',identity.includes('keep an AGENTS.md there as standing memories'));
 p.check(name+': source files retained',Object.keys(values).every(v=>[own,grant].some(d=>fs.readdirSync(d).filter(f=>f.endsWith('.md')).some(f=>fs.readFileSync(path.join(d,f),'utf8').includes(v)))));
 await rig.waitFor(()=>rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id=t.agent_id WHERE a.name='${name}' AND t.ended_at IS NULL`).length===0,{what:name+' settles',timeout:60000});
 }
 }finally{await llm.close()}return p.summary()
}

