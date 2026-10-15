// Focused mounted renderer verification. Run in Rig's shared-lock kernel Job;
// dependencies stay in their existing install, all generated output is on C:.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
for(const key of ['ORGTREE_LOGO_DEPENDENCIES','ORGTREE_LOGO_OUTPUT'])if(!process.env[key])throw Error('Missing '+key)
if(process.env.ORGTREE_LOGO_JOB_CONTAINED!=='1')throw Error('Existing shared lock and kernel Job required')
const repo=process.env.ORGTREE_LOGO_ROOT||process.cwd(),out=path.resolve(process.env.ORGTREE_LOGO_OUTPUT),base=process.env.ORGTREE_LOGO_BASE
const suite=process.env.ORGTREE_LOGO_SUITE||'scopebody'
if(!['scopebody','historyui'].includes(suite)||base&&suite!=='scopebody')throw Error('Use scopebody for matched red/green, or historyui for generic shortcut regression')
if(!/^c:\/orgtree-build\/(hubchat-dm-sol|rig-haiku)\//i.test(out.replaceAll('\\','/')))throw Error('Owned C output required')
const deps=createRequire(path.join(process.env.ORGTREE_LOGO_DEPENDENCIES,'package.json')),esbuild=deps('esbuild')
fs.mkdirSync(out,{recursive:true})
const file=path.join(out,suite+'.test.mjs')
try {
  await esbuild.build({entryPoints:[path.join(repo,'apps/desktop/renderer/tests/'+suite+'.test.tsx')],outfile:file,
    bundle:true,platform:'node',format:'esm',jsx:'automatic',target:'node22',
    nodePaths:[path.join(process.env.ORGTREE_LOGO_DEPENDENCIES,'node_modules')],external:['node:*'],
    define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(path.join(repo,'apps/desktop/renderer/src'))},
    plugins:[{name:'existing-dependencies-and-base-logo-control',setup(build) {
      build.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(deps.resolve('jsdom')).href,external:true}))
      if(base)build.onLoad({filter:/[/\\]canvas[/\\]modals\.tsx$/},args=>{
        const rel=path.relative(repo,args.path).replaceAll('\\','/')
        const old=spawnSync('git',['show',base+':'+rel],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:30000})
        if(old.status!==0)throw Error(old.stderr||String(old.error))
        return {contents:old.stdout,loader:'tsx',resolveDir:path.dirname(args.path)}
      })
    }}]})
} finally {await esbuild.stop()}
const run=spawnSync(process.execPath,['--max-old-space-size=512','--test','--test-reporter=tap','--test-force-exit',
  '--test-concurrency=1','--test-timeout=30000',file],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:8*1024*1024})
const log=(run.stdout||'')+(run.stderr||'')+(run.error?String(run.error):'')
fs.writeFileSync(path.join(out,'tests.log'),log)
const failed=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1])
const tests=Number(log.match(/^# tests (\d+)/m)?.[1]||0)
const expected=new Set(['settings retain configured rights while the current chain narrows the display',
  'Logo group defaults on and an explicit off is saved in the inherited tool grant','Logo group cannot exceed the superior grant'])
const passed=base?run.status===1&&tests===6&&failed.length===3&&failed.every(name=>expected.has(name))
  :run.status===0&&(suite==='scopebody'?tests===6:tests>0)&&failed.length===0
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed,tests,base:base||null,failed,status:run.status,
  error:run.error?String(run.error):null,suite,scope:'mounted NodeConfig / HistorySurface; red replaces base modals.tsx only; no native/live/device'},null,2))
console.log(log)
console.log(JSON.stringify({passed,tests,failed}))
process.exit(passed?0:1)
