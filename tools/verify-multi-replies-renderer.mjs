// Run only in Rig's shared-lock kernel Job; no dependency copies or junctions.
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
for(const k of ['ORGTREE_MULTI_DEPENDENCIES','ORGTREE_MULTI_OUTPUT']) if(!process.env[k]) throw Error('Missing '+k);
if(process.env.ORGTREE_MULTI_JOB_CONTAINED!=='1') throw Error('Existing Rig lock and kernel Job required');
const repo=process.env.ORGTREE_MULTI_ROOT||process.cwd(),out=path.resolve(process.env.ORGTREE_MULTI_OUTPUT),base=process.env.ORGTREE_MULTI_BASE;
if(!/^c:\/orgtree-build\/(hubchat-dm-sol|rig-opus|rig-sol|rig-sol-b)\//i.test(out.replaceAll('\\','/'))) throw Error('Owned C output required');
const deps=createRequire(path.join(process.env.ORGTREE_MULTI_DEPENDENCIES,'package.json')),esbuild=deps('esbuild');fs.mkdirSync(out,{recursive:true});
const file=path.join(out,'multireply.test.mjs');
// Match the standard runner's package resolution; only jsdom stays external.
// nodePaths searches dependencies in place, without changing import conditions.
try {await esbuild.build({entryPoints:[path.join(repo,'apps/desktop/renderer/tests/multireply.test.tsx')],outfile:file,bundle:true,platform:'node',format:'esm',jsx:'automatic',target:'node22',nodePaths:[path.join(process.env.ORGTREE_MULTI_DEPENDENCIES,'node_modules')],external:['node:*'],define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(path.join(repo,'apps/desktop/renderer/src'))},plugins:[{name:'existing-dependencies-and-base-collectors',setup(b){
  b.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(deps.resolve('jsdom')).href,external:true}));
  if(base)b.onLoad({filter:/(?:[/\\]canvas[/\\](desk|mail)\.tsx|[/\\]eventReply\.ts)$/},a=>{
    const rel=path.relative(repo,a.path).replaceAll('\\','/');const old=spawnSync('git',['show',base+':'+rel],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:30000});
    if(old.status!==0)throw Error(old.stderr||String(old.error));return {contents:old.stdout,loader:'tsx',resolveDir:path.dirname(a.path)};
  });
}}]});}finally{await esbuild.stop();}
const run=spawnSync(process.execPath,['--max-old-space-size=512','--test','--test-reporter=tap','--test-force-exit','--test-concurrency=1','--test-timeout=30000',file],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:8*1024*1024});
const log=(run.stdout||'')+(run.stderr||'')+(run.error?String(run.error):'');fs.writeFileSync(path.join(out,'tests.log'),log);
const failed=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);
const targets=new Set(['desk mixed senders append and one send carries both durable targets after reload','collector accepts different authors only within one transcript identity','inbox collects different authors within one conversation and sends together','individual delivered mail cards retain their sender and separate target identities']);
const tests=Number(log.match(/^# tests (\d+)/m)?.[1]||0);
const passed=base?run.status===1 && tests===6 && failed.length===targets.size && failed.every(n=>targets.has(n)):run.status===0 && tests===6 && failed.length===0;
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed,tests,base:base||null,failed,status:run.status,error:run.error?String(run.error):null,scope:'actual mounted desk/inbox; red replaces base desk/mail and eventReply collector; no native/live/device'},null,2));
console.log(log);console.log(JSON.stringify({passed,tests,failed}));process.exit(passed?0:1);
