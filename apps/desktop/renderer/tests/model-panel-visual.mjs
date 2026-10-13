import {createRequire} from 'node:module'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createServer} from 'node:http'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {runDesktop} from '../../../../tools/rig/desktop.mjs'
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../../..')
const [output,evidence,deps]=process.argv.slice(2).map(p=>path.resolve(p))
const base=process.env.UI_PANEL_BASE
const gitSource=file=>{
  const p=spawnSync('git',['show',base+':'+file],{cwd:root,encoding:'utf8',windowsHide:true})
  if(p.status!==0)throw new Error(p.stderr);return p.stdout
}
const require=createRequire(path.join(deps,'../package.json')),esbuild=require('esbuild')
mkdirSync(output,{recursive:true});mkdirSync(evidence,{recursive:true})
await esbuild.build({entryPoints:[path.join(here,'model-panel-probe.tsx')],outfile:path.join(output,'probe.js'),
  nodePaths:[deps],bundle:true,platform:'browser',format:'iife',jsx:'automatic',logLevel:'warning',
  plugins:base?[{name:'exact-base-model-panel',setup(b){b.onLoad({filter:/[\\/]src[\\/]canvas[\\/]modelbrowser\.tsx$/},()=>({
    contents:gitSource('apps/desktop/renderer/src/canvas/modelbrowser.tsx'),loader:'tsx'}))}}]:[]})
esbuild.stop()
writeFileSync(path.join(output,'probe.css'),base?gitSource('apps/desktop/renderer/src/styles.css'):readFileSync(path.join(here,'../src/styles.css')))
const server=createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><div id="root"></div><script src="/probe.js"></script>');return}
  if(['/probe.js','/probe.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('css')?'text/css':'text/javascript');res.end(readFileSync(path.join(output,req.url.slice(1))));return}
  res.writeHead(404);res.end()
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
try{
  const result=await runDesktop({dir:evidence,url:`http://127.0.0.1:${server.address().port}`,token:'',org:''},
    path.join(here,'model-panel-visual.cjs'),{out:path.join(evidence,'desktop'),timeout:100000,args:{baseline:!!base}})
  writeFileSync(path.join(evidence,'result.json'),JSON.stringify({base:base??null,...result},null,2))
  console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1
}finally{server.close()}
