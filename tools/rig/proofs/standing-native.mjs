import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {startFakeLlm} from '../fakellm.mjs'
import {cleanEnv} from '../lib.mjs'
import {Proof} from '../proof.mjs'
export async function setup(){return {name:'standing-native', 'real-cli':true,fixture:'none'}}
export default async function(rig){
 const p=new Proof('standing-native'); const llm=await startFakeLlm({bodies:path.join(p.dir,'bodies'),models:[{name:'fake-model:latest',context:131072,running:65536}],rules:[]});
 try {for(const mode of ['agents','both','import','parentlegacy','parentagents','configlegacy','locallegacy','parentonlyagents','emptylegacy']){
 const root=path.join(p.dir,mode);for(const d of ['home','cfg','work','grant'])fs.mkdirSync(path.join(root,d),{recursive:true});
 const markers={agents:'NATIVE_AGENTS_'+mode,legacy:'NATIVE_LEGACY_'+mode,grantAgents:'NATIVE_GRANTED_AGENTS_'+mode,grantLegacy:'NATIVE_GRANTED_LEGACY_'+mode,parent:'NATIVE_PARENT_'+mode};
 fs.writeFileSync(path.join(root,'work','AGENTS.md'),markers.agents);
 if(!['agents','parentlegacy','configlegacy','locallegacy','parentonlyagents'].includes(mode))fs.writeFileSync(path.join(root,'work','CLAUDE.md'),markers.legacy+(mode==='import'?'\n@AGENTS.md':''));
 fs.writeFileSync(path.join(root,'grant','AGENTS.md'),markers.grantAgents);fs.writeFileSync(path.join(root,'grant','CLAUDE.md'),markers.grantLegacy);
 const env={...cleanEnv()};for(const k of Object.keys(env))if(/^(ORGTREE_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|OPENROUTER_)/i.test(k))delete env[k];
 Object.assign(env,{USERPROFILE:path.join(root,'home'),HOME:path.join(root,'home'),CLAUDE_CONFIG_DIR:path.join(root,'cfg'),ANTHROPIC_BASE_URL:llm.url,ANTHROPIC_AUTH_TOKEN:'orgtree-local',ANTHROPIC_API_KEY:'',ANTHROPIC_MODEL:'fake-model:latest',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',CLAUDE_CODE_ATTRIBUTION_HEADER:'0'});
 if(mode==='parentlegacy')fs.writeFileSync(path.join(root,'CLAUDE.md'),markers.parent);
 if(['parentagents','parentonlyagents'].includes(mode))fs.writeFileSync(path.join(root,'AGENTS.md'),markers.parent);
 if(mode==='configlegacy')fs.writeFileSync(path.join(root,'cfg','CLAUDE.md'),markers.parent);
 if(mode==='locallegacy')fs.writeFileSync(path.join(root,'work','CLAUDE.local.md'),markers.parent);
 if(mode==='emptylegacy')fs.writeFileSync(path.join(root,'work','CLAUDE.md'),'');
 const token='PROOF-NATIVE-'+mode;let err='';const child=spawn(path.join(rig.run.dir,'bin','claude.exe'),['-p',token+': answer OK','--output-format','json','--tools','','--add-dir',path.join(root,'grant')],{cwd:path.join(root,'work'),env,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',d=>{err+=d});
 try{const seen=await rig.waitFor(()=>llm.requests.find(r=>r.last_user?.includes(token)&&r.body_file),{what:token,timeout:60000});const raw=fs.readFileSync(path.join(p.dir,'bodies',seen.body_file),'utf8');const counts=Object.fromEntries(Object.entries(markers).map(([k,v])=>[k,raw.split(v).length-1]));p.note(mode,{counts,body:seen.body_file});
 const expected={agents:mode==='agents'||mode==='import'||mode==='configlegacy'||mode==='parentonlyagents'||mode==='emptylegacy'?1:0,legacy:['both','import','parentagents'].includes(mode)?1:0,grantAgents:0,grantLegacy:0,parent:['parentlegacy','configlegacy','locallegacy','parentonlyagents'].includes(mode)?1:0};
 p.check(mode+' native loading matches delivery policy',Object.entries(expected).every(([k,v])=>counts[k]===v),{counts,expected})}catch(e){p.check(mode+' captured',false,{error:String(e),stderr:err.slice(0,1000)})}finally{child.kill();}
 }}finally{await llm.close()}return p.summary()
}
