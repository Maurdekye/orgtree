import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
const repo=process.cwd(),out=process.env.MEDIA_OUT,require=createRequire(process.env.ORGTREE_TEST_DEPS);
if(process.env.MEDIA_JOB!=='1'||!/^C:[\\/]orgtree-build[\\/]hubchat-dm-sol[\\/]/i.test(out||''))throw Error('Assigned output/Job required');
const esbuild=require('esbuild');
fs.writeFileSync(out+'/verdict.json',JSON.stringify({passed:false,status:'not executed'}));
try{await esbuild.build({entryPoints:[repo+'/apps/desktop/renderer/tests/mediacards-visual.tsx'],outfile:out+'/visual.js',bundle:true,format:'iife',platform:'browser',jsx:'automatic',nodePaths:[path.dirname(process.env.ORGTREE_TEST_DEPS)+'/node_modules'],loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"development"'}});}finally{esbuild.stop();}
fs.writeFileSync(out+'/index.html','<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="visual.css"></head><body><div id="root"></div><script src="visual.js"></script></body></html>');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const p=spawnSync(require('electron'),[repo+'/apps/desktop/renderer/tests/mediacards-capture.cjs'],{env,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:3e6});
fs.writeFileSync(out+'/electron.log',(p.stdout||'')+(p.stderr||''));const verdict=JSON.parse(fs.readFileSync(out+'/verdict.json','utf8'));console.log(JSON.stringify({status:p.status,signal:p.signal,error:p.error?.message||null,verdict}));process.exitCode=p.status===0&&verdict.passed?0:p.status||2;
