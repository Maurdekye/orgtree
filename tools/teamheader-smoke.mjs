import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [deps,output,mode='geometry']=process.argv.slice(2)
if(!deps||!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(output||''))throw Error('Expected assigned output')
const require=createRequire(path.join(path.resolve(deps),'package.json')),esbuild=require('esbuild')
fs.mkdirSync(output,{recursive:true})
const geometry=mode==='geometry'
try{
  await esbuild.build({entryPoints:[path.join(repo,'apps/desktop/renderer/tests',geometry?'teamheader-visual.tsx':'teamchrome.test.tsx')],
    outfile:path.join(output,geometry?'fixture.js':'test.mjs'),bundle:true,format:'esm',platform:geometry?'browser':'node',
    target:'node22',jsx:'automatic',nodePaths:[path.join(deps,'node_modules')],external:['node:*'],
    plugins:[{name:'jsdom-external',setup(build){build.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}))}}],
    define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(path.join(repo,'apps/desktop/renderer/src'))}})
}finally{esbuild.stop()}
let command,args,env={...process.env}
if(geometry){
  const css=pathToFileURL(path.join(repo,'apps/desktop/renderer/src/styles.css')).href
  fs.writeFileSync(path.join(output,'fixture.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font:14px system-ui}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`)
  command=require('electron');args=[path.join(repo,'apps/desktop/renderer/tests/teamheader-capture.cjs')]
  delete env.ELECTRON_RUN_AS_NODE;env.TEAM_HEADER_OUTPUT=output
  env.TEAM_HEADER_STYLES=path.join(repo,'apps/desktop/renderer/src/styles.css')
}else{
  command=process.execPath;args=['--max-old-space-size=1024','--test','--test-reporter=tap','--test-force-exit','--test-concurrency=1',path.join(output,'test.mjs')]
}
const r=spawnSync(command,args,{cwd:repo,env,encoding:'utf8',windowsHide:true})
const log=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(output,'result.log'),log);console.log(log)
fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null},null,2))
process.exitCode=r.status??2
