// Run under the shared rig kernel Job/lock. Generated assets stay in C;
// retained screenshots/JSON stay in D. No dependency copies or junctions.
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {spawn,spawnSync} from 'node:child_process'
const [version,depsArg,outArg,evidenceArg,electronArg]=process.argv.slice(2)
if(!['red','green'].includes(version)||!depsArg||!outArg||!evidenceArg||!electronArg)
  throw Error('Usage: red|green DepsRoot COutputRoot DEvidenceRoot ElectronExe')
const source=process.cwd(),deps=path.resolve(depsArg),out=path.resolve(outArg),evidence=path.resolve(evidenceArg)
if(!/^C:\\orgtree-build\\[^\\]+\\/i.test(out+'\\')||!/^D:\\orgtree-work\\/i.test(evidence+'\\'))throw Error('Expected authorized C build / D evidence scope')
fs.mkdirSync(out,{recursive:true})
const require=createRequire(path.join(deps,'package.json')),esbuild=require('esbuild')
const plugins=[{name:'private-thought-components-for-visual-test',setup(build){
  build.onLoad({filter:/canvas[\\/]desk\.tsx$/},args=>({
    contents:fs.readFileSync(args.path,'utf8')+'\nexport {ThoughtBody,ThoughtLine}\n',loader:'tsx',resolveDir:path.dirname(args.path)}))
  if(version==='red')build.onLoad({filter:/[\\/]src[\\/]styles\.css$/},args=>{
    const base=spawnSync('git',['show','b77512f:apps/desktop/renderer/src/styles.css'],{cwd:source,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024})
    if(base.status!==0)throw Error(base.stderr)
    return {contents:base.stdout,loader:'css',resolveDir:path.dirname(args.path)}
  })
}}]
try{await esbuild.build({entryPoints:[path.join(source,'apps/desktop/renderer/tests/streaming-thought-visual.tsx')],
  outfile:path.join(out,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  nodePaths:[path.join(deps,'node_modules')],plugins,logLevel:'warning'})}finally{esbuild.stop()}
fs.writeFileSync(path.join(out,'fixture.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
const env={...process.env,THOUGHT_BUILD:out,THOUGHT_EVIDENCE:evidence,THOUGHT_VERSION:version}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(path.resolve(electronArg),[path.join(source,'apps/desktop/renderer/tests/streaming-thought-capture.cjs')],
  {cwd:source,env,stdio:'inherit',windowsHide:true})
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1))})
