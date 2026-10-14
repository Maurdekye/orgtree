// Batch runner only: real installed dependency root, generated outputs in C, evidence in D.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
const [mode, depsArg, outputArg, evidenceArg, electronArg] = process.argv.slice(2)
if (!['audit-controls','red-writing','red-running','red-presentation','red-files','green','visual'].includes(mode) || (mode!=='audit-controls'&&(!depsArg || !outputArg))) throw new Error('Usage: mode DepsRoot COutputRoot [DEvidenceRoot ElectronExe]')
const source=process.cwd()
const snapshot=(ref,file)=>{
  const old=spawnSync('git',['show',ref+':apps/desktop/renderer/src/canvas/'+file],{cwd:source,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024})
  if(old.status!==0)throw new Error(old.stderr)
  return old.stdout.replaceAll('\r\n','\n')
}
const once=(text,from,to)=>{
  if(!from||text.split(from).length!==2)throw new Error('Display control needs one exact source match: '+from.slice(0,100))
  return text.replace(from,()=>to)
}
const between=(text,start,end)=>{
  if(text.split(start).length!==2)throw new Error('Display control needs one start: '+start)
  const a=text.indexOf(start),b=text.indexOf(end,a+start.length)
  if(b<0)throw new Error('Display control missing end: '+end)
  return text.slice(a,b)
}
// Reverse only the named display behavior in the composed source. Whole old
// files would erase the independent running-turn fix and its exported context.
const control=(text,file,changes)=>{
  text=text.replaceAll('\r\n','\n')
  if(file==='toolclock.tsx'&&changes.includes('writing'))text=once(text,
    between(text,'      : writing &&','    {ran ?'),
    between(snapshot('8508043^',file),'      : (writing || finished) &&','    {ran ?'))
  if(file==='desk.tsx'){
    if(changes.includes('running'))text=once(text,'<ArrowRightIcon fontSize="inherit" className="tooldot tool-running-status" />','<PlayIcon fontSize="inherit" className="tooldot tool-running-status" />')
    if(changes.includes('presentation'))text=once(text,
      between(text,'  const presentation = t.presentation','  // Sent files'),
      between(snapshot('1713b74^',file),'  if (t.presentation &&','  // orgtree_send_file')+'  const presentation = null\n')
    if(changes.includes('files'))text=once(text,
      between(text,'  let downloadCard: ReactNode = null','  return (\n    <><div'),
      between(snapshot('dd0b354^',file),'  if (t.file) {','  return (\n    <><div')+'  const downloadCard = null\n')
  }
  return text
}
if(mode==='audit-controls'){
  for(const change of ['writing','running','presentation','files','all']){
    const changes=change==='all'?['writing','running','presentation','files']:[change]
    for(const file of ['toolclock.tsx','desk.tsx']){
      const current=fs.readFileSync(path.join(source,'apps/desktop/renderer/src/canvas',file),'utf8').replaceAll('\r\n','\n')
      const before=control(current,file,changes)
      const sentinel=file==='toolclock.tsx'?'export const RunningTurnContext = createContext<string | null>(null)':'  const live = useLiveCall(t.started_at)'
      if(!before.includes(sentinel))throw new Error('Display control lost running-turn ownership: '+file)
      if(file==='toolclock.tsx'&&before.slice(0,before.indexOf('export function ToolTimes'))!==current.slice(0,current.indexOf('export function ToolTimes')))throw new Error('Display control changed shared clock helpers')
      process.stdout.write(JSON.stringify({change,file,changed:before!==current,runningTurnPreserved:true})+'\n')
    }
  }
  process.exit(0)
}
const deps=path.resolve(depsArg),out=path.resolve(outputArg)
if (!/^C:\\orgtree-build\\[^\\]+\\/i.test(out+'\\')) throw new Error('C build scope required')
fs.mkdirSync(out,{recursive:true})
const require=createRequire(path.join(deps,'package.json')), esbuild=require('esbuild')
const baseline = (files, changes) => [{name:'composed-tool-display-control',setup(build){build.onLoad({filter:/canvas[\\/]((toolclock)|(desk))\.tsx$/},args=>{
  if(!files.includes(path.basename(args.path)))return
  return {contents:control(fs.readFileSync(args.path,'utf8'),path.basename(args.path),changes),loader:'tsx',resolveDir:path.dirname(args.path)}
})}}]
if(mode==='visual'){
  if(!evidenceArg||!electronArg)throw new Error('visual requires evidence/electron')
  for(const version of ['before','after']){
    await esbuild.build({entryPoints:[path.join(source,'apps/desktop/renderer/tests/toolchip-display-visual.tsx')],
      outfile:path.join(out,version+'.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
      nodePaths:[path.join(deps,'node_modules')],plugins:version==='before'?baseline(['desk.tsx','toolclock.tsx'],['writing','running','presentation','files']):[],logLevel:'warning'})
    fs.writeFileSync(path.join(out,version+'.html'),`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${version}.css"><div id="root"></div><script src="${version}.js"></script>`)
  }
  esbuild.stop()
  // Loopback serves only generated fixture assets and one synthetic image,
  // so the real ToolChip file URL decodes without changing product code.
  const server=http.createServer((req,res)=>{
    if(req.url?.startsWith('/api/orgs/fixture/nodes/worker/file?path=shot.png')){
      res.writeHead(200,{'content-type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><rect width="320" height="100" fill="#517dab"/><rect x="20" y="20" width="80" height="60" fill="#b7d5ed"/><text x="120" y="56" fill="white" font-family="sans-serif" font-size="18">Synthetic image</text></svg>');return
    }
    const match=req.url?.match(/^\/(before|after)\.(html|js|css)$/)
    if(!match){res.writeHead(404);res.end();return}
    res.writeHead(200,{'content-type':{html:'text/html',js:'text/javascript',css:'text/css'}[match[2]]})
    res.end(fs.readFileSync(path.join(out,match[1]+'.'+match[2])))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const env={...process.env,CHIP_VISUAL_ROOT:out,CHIP_VISUAL_EVIDENCE:path.resolve(evidenceArg),CHIP_VISUAL_URL:'http://127.0.0.1:'+server.address().port}
    delete env.ELECTRON_RUN_AS_NODE
    const child=spawn(path.resolve(electronArg),[path.join(source,'apps/desktop/renderer/tests/toolchip-display-capture.cjs')],{cwd:source,env,stdio:'inherit',windowsHide:true})
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1))})
  }finally{await new Promise(resolve=>server.close(resolve))}
}else{
  const suites=mode==='red-writing'?['toolwriting-slot']:mode==='red-running'?['toolwriting']:mode==='red-presentation'?['presentation-toolrow']:mode==='red-files'?['sentfile-toolrow']
    :['toolwriting-slot','toolwriting','toolclock-live','workstatus','objectnav','shellerror','presentation-toolrow','presentation-routing','sentfile-toolrow']
  const plugins=mode==='red-writing'?baseline(['toolclock.tsx'],['writing']):mode==='red-running'?baseline(['desk.tsx'],['running']):mode==='red-presentation'?baseline(['desk.tsx'],['presentation']):mode==='red-files'?baseline(['desk.tsx'],['files']):[]
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
