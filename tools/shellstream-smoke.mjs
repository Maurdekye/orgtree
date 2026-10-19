import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url))),[deps,out,mode='focused']=process.argv.slice(2)
if(!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(out||'')||fs.existsSync(out))throw Error('Fresh owned output required')
fs.mkdirSync(out,{recursive:true});const require=createRequire(path.join(deps,'package.json')),esbuild=require('esbuild')
const suites=mode==='focused'?['shelloutput']:['shelloutput','tokencounts','toolclock-turn']
try{
 if(mode==='visual'){
  await esbuild.build({entryPoints:[repo+'/apps/desktop/renderer/tests/shellstream-visual.tsx'],outfile:out+'/fixture.js',bundle:true,format:'esm',platform:'browser',jsx:'automatic',nodePaths:[deps+'/node_modules'],define:{'process.env.NODE_ENV':'"development"'}})
  fs.copyFileSync(repo+'/apps/desktop/renderer/tests/shellstream-capture.cjs',out+'/capture.cjs')
 }else await esbuild.build({entryPoints:suites.map(s=>repo+'/apps/desktop/renderer/tests/'+s+'.test.tsx'),outdir:out,outExtension:{'.js':'.mjs'},bundle:true,format:'esm',platform:'node',target:'node22',jsx:'automatic',external:['node:*'],nodePaths:[deps+'/node_modules'],
  plugins:[{name:'jsdom-external',setup(b){b.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}))}}],define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(repo+'/apps/desktop/renderer/src')}})
}finally{esbuild.stop()}
const env={...process.env},exe=mode==='visual'?require('electron'):process.execPath
const args=mode==='visual'?[out+'/capture.cjs']:['--max-old-space-size=1024','--test','--test-reporter=tap','--test-force-exit','--test-concurrency=1',...suites.map(s=>out+'/'+s+'.test.mjs')]
if(mode==='visual'){delete env.ELECTRON_RUN_AS_NODE;env.SHELL_STREAM_OUT=out;env.SHELL_STREAM_STYLE=repo+'/apps/desktop/renderer/src/styles.css';env.SHELL_STREAM_KATEX=require.resolve('katex/dist/katex.min.css')}
const r=spawnSync(exe,args,{cwd:repo,env,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024}),log=(r.stdout||'')+(r.stderr||'')
fs.writeFileSync(out+'/result.log',log);fs.writeFileSync(out+'/process.json',JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null}));console.log(log);process.exitCode=r.status??2
