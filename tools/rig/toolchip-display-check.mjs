// Batch runner only: real installed dependency root, generated outputs in C, evidence in D.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const [mode, depsArg, outputArg, evidenceArg, electronArg] = process.argv.slice(2)
if (!['red-writing','red-running','red-presentation','green','visual'].includes(mode) || !depsArg || !outputArg) throw new Error('Usage: mode DepsRoot COutputRoot [DEvidenceRoot ElectronExe]')
const source=process.cwd(),deps=path.resolve(depsArg),out=path.resolve(outputArg)
if (!/^C:\\orgtree-build\\[^\\]+\\/i.test(out+'\\')) throw new Error('C build scope required')
fs.mkdirSync(out,{recursive:true})
const require=createRequire(path.join(deps,'package.json')), esbuild=require('esbuild')
const baseline = files => [{name:'integrated-tool-display-baseline',setup(build){build.onLoad({filter:/canvas[\\/]((toolclock)|(desk))\.tsx$/},args=>{
  if(!files.includes(path.basename(args.path)))return
  const rel=path.relative(source,args.path).replaceAll('\\','/')
  const old=spawnSync('git',['show','0f8638f:'+rel],{cwd:source,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024})
  if(old.status!==0)throw new Error(old.stderr)
  return {contents:old.stdout,loader:'tsx',resolveDir:path.dirname(args.path)}
})}}]
if(mode==='visual'){
  if(!evidenceArg||!electronArg)throw new Error('visual requires evidence/electron')
  for(const version of ['before','after']){
    await esbuild.build({entryPoints:[path.join(source,'apps/desktop/renderer/tests/toolchip-display-visual.tsx')],
      outfile:path.join(out,version+'.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
      nodePaths:[path.join(deps,'node_modules')],plugins:version==='before'?baseline(['desk.tsx','toolclock.tsx']):[],logLevel:'warning'})
    fs.writeFileSync(path.join(out,version+'.html'),`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${version}.css"><div id="root"></div><script src="${version}.js"></script>`)
  }
  esbuild.stop()
  const env={...process.env,CHIP_VISUAL_ROOT:out,CHIP_VISUAL_EVIDENCE:path.resolve(evidenceArg)}
  delete env.ELECTRON_RUN_AS_NODE
  const result=spawnSync(path.resolve(electronArg),[path.join(source,'apps/desktop/renderer/tests/toolchip-display-capture.cjs')],{cwd:source,env,stdio:'inherit',windowsHide:true})
  process.exitCode=result.status??1
}else{
  const suites=mode==='red-writing'?['toolwriting-slot']:mode==='red-running'?['toolwriting']:mode==='red-presentation'?['presentation-toolrow']
    :['toolwriting-slot','toolwriting','toolclock-live','workstatus','objectnav','shellerror','presentation-toolrow','presentation-routing']
  const plugins=mode==='red-writing'?baseline(['toolclock.tsx']):['red-running','red-presentation'].includes(mode)?baseline(['desk.tsx']):[]
  for(const suite of suites)await esbuild.build({entryPoints:[path.join(source,'apps/desktop/renderer/tests/'+suite+'.test.tsx')],
    outfile:path.join(out,suite+'.test.mjs'),bundle:true,platform:'node',format:'esm',jsx:'automatic',nodePaths:[path.join(deps,'node_modules')],
    external:['jsdom','react','react-dom','react-dom/*','react/*'],plugins,
    banner:{js:`import {createRequire as __createRequire} from 'node:module';const require=__createRequire(${JSON.stringify(path.join(deps,'package.json'))});`},
    define:{__SRC_DIR__:JSON.stringify(path.join(source,'apps/desktop/renderer/src'))},logLevel:'warning'})
  esbuild.stop()
  const loader=path.join(out,'resolve.mjs')
  fs.writeFileSync(loader,`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(process.env.SCRATCH_UI_DEPS+'/package.json');const prefix=pathToFileURL(process.env.SCRATCH_UI_BUILD+'/').href;
export async function resolve(s,c,n){if(c.parentURL?.startsWith(prefix)&&!s.startsWith('.')&&!s.startsWith('/')&&!s.includes(':'))return {url:pathToFileURL(require.resolve(s)).href,shortCircuit:true};return n(s,c)}\n`)
  const result=spawnSync(process.execPath,['--max-old-space-size=768','--experimental-loader',pathToFileURL(loader).href,'--test','--test-concurrency=1',
    ...suites.map(suite=>path.join(out,suite+'.test.mjs'))],{cwd:source,stdio:'inherit',windowsHide:true,env:{...process.env,SCRATCH_UI_DEPS:deps,SCRATCH_UI_BUILD:out}})
  process.exitCode=result.status??1
}
