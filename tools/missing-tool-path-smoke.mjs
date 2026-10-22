// Focused proof; reuse provisioned dependencies without copying or linking them.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [deps,output,mode='red']=process.argv.slice(2)
if(!deps||!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(path.resolve(output)))throw Error('assigned output required')
const require=createRequire(path.resolve(deps,'package.json')), esbuild=require('esbuild')
const visual=mode==='visual'
const names=visual?['toolmissingpaths-visual']:mode==='red'?['toolmissingpaths.test']:['toolmissingpaths.test','toolfilelinks.test','windowslinks.test']
fs.mkdirSync(output,{recursive:true})
try {
 await esbuild.build({entryPoints:names.map(n=>path.join(repo,'apps/desktop/renderer/tests',n+(n==='windowslinks.test'?'.ts':'.tsx'))),
  outdir:output,outExtension:{'.js':'.mjs'},bundle:true,format:'esm',platform:visual?'browser':'node',target:'node22',jsx:'automatic',
  nodePaths:[path.resolve(deps,'node_modules')],external:['node:*'],loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},
  plugins:[{name:'external-jsdom',setup(build){build.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}))}}],
  define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(path.join(repo,'apps/desktop/renderer/src'))}})
} finally {esbuild.stop()}
const env={...process.env}
let exe=process.execPath,args=['--max-old-space-size=1024','--test','--test-reporter=tap','--test-force-exit','--test-concurrency=1',...names.map(n=>path.join(output,n+'.mjs'))]
if(visual){
 fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="toolmissingpaths-visual.css"></head><body><div id="root"></div><script type="module" src="toolmissingpaths-visual.mjs"></script></body></html>')
 exe=require('electron');args=[path.join(repo,'apps/desktop/renderer/tests/toolmissingpaths-capture.cjs')]
 delete env.ELECTRON_RUN_AS_NODE;env.MISSING_PATH_CAPTURE_ROOT=output
}
const r=spawnSync(exe,args,{cwd:repo,env,encoding:'utf8',windowsHide:true,maxBuffer:12e6})
fs.writeFileSync(path.join(output,'result.log'),(r.stdout??'')+(r.stderr??''))
fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null}))
console.log(r.stdout??'');console.error(r.stderr??'');process.exitCode=r.status??2
