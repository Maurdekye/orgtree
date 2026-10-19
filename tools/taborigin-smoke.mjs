import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [deps,output,mode='focused']=process.argv.slice(2)
if(!deps||!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(output||''))throw Error('Expected assigned output')
if(fs.existsSync(output))throw Error('Preserve prior output')
fs.mkdirSync(output,{recursive:true})
const require=createRequire(path.join(deps,'package.json')),esbuild=require('esbuild')
const suites=mode==='focused'?['taborigin']:['taborigin','panelcorner','popoutaspect']
try{
 if(mode==='geometry'){
  await esbuild.build({entryPoints:[path.join(repo,'apps/desktop/renderer/tests/taborigin-visual.tsx')],outfile:path.join(output,'fixture.js'),
   bundle:true,format:'esm',platform:'browser',jsx:'automatic',nodePaths:[path.join(deps,'node_modules')],define:{'process.env.NODE_ENV':'"development"'}})
  await esbuild.build({entryPoints:[path.join(repo,'apps/desktop/renderer/tests/taborigin-native.ts')],outfile:path.join(output,'capture.cjs'),
   bundle:true,format:'cjs',platform:'node',external:['electron'],nodePaths:[path.join(deps,'node_modules')]})
 }else{
  await esbuild.build({entryPoints:suites.map(s=>path.join(repo,'apps/desktop/renderer/tests/'+s+'.test.tsx')),outdir:output,outExtension:{'.js':'.mjs'},
   bundle:true,format:'esm',platform:'node',target:'node22',jsx:'automatic',external:['node:*'],nodePaths:[path.join(deps,'node_modules')],
   plugins:[{name:'jsdom-external',setup(b){b.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}))}}],
   define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(path.join(repo,'apps/desktop/renderer/src'))}})
 }
}finally{esbuild.stop()}
const env={...process.env};let command,args
if(mode==='geometry'){
 command=require('electron');args=[path.join(output,'capture.cjs')];delete env.ELECTRON_RUN_AS_NODE
 env.TAB_ORIGIN_OUTPUT=output;env.TAB_ORIGIN_STYLES=path.join(repo,'apps/desktop/renderer/src/styles.css');env.TAB_ORIGIN_KATEX=require.resolve('katex/dist/katex.min.css')
}else{
 command=process.execPath;args=['--max-old-space-size=1024','--test','--test-reporter=tap','--test-force-exit','--test-concurrency=1',...suites.map(s=>path.join(output,s+'.test.mjs'))]
}
const r=spawnSync(command,args,{cwd:repo,env,encoding:'utf8',windowsHide:true,maxBuffer:6*1024*1024})
const log=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(output,'result.log'),log);console.log(log)
fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null},null,2))
process.exitCode=r.status??2
