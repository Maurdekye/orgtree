import * as esbuild from 'esbuild'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
const out=path.resolve('node_modules/.orgtree-windowchrome'),mutation=process.argv[2]
if(mutation&&!['small-corners','flow-notice','clipped-frame','duplicate-header','leaked-notice-host'].includes(mutation))throw new Error('Unknown mutation')
const plugins=mutation?[{name:mutation,setup(build){build.onLoad({filter:/(styles\.css|popout\.tsx)$/},({path:file})=>{
 let s=readFileSync(file,'utf8'),before,after
 if(mutation==='leaked-notice-host'){
  if(!file.endsWith('popout.tsx'))return
  before='if (!target.childElementCount) target.remove()';after='void target'
  if(s.split(before).length!==2)throw new Error('INERT notice cleanup')
  return {contents:s.replace(before,after),loader:'tsx'}
 }
 if(!file.endsWith('styles.css'))return
 if(mutation==='small-corners'){for(const c of ['pinwin-rs','modalpin-rs']){before=`.${c}.ne, .${c}.nw, .${c}.se, .${c}.sw { width: 24px; height: 24px; }`;if(s.split(before).length!==2)throw new Error('INERT corners');s=s.replace(before,before.replaceAll('24px','12px'))}s=s.replaceAll('-16px','-2px')}
 if(mutation==='flow-notice'){before='.popout-notices { position: fixed; left: 12px; bottom: 12px;';after='.popout-notices { position: static; left: 12px; bottom: 12px;'}
 if(mutation==='clipped-frame'){before='.overlay.overlay-pinned > .modalpin-resize-frame { position: absolute; pointer-events: none; z-index: 7; }';after='.overlay.overlay-pinned > .modalpin-resize-frame { position: absolute; pointer-events: none; z-index: 7; overflow: hidden; }'}
 if(mutation==='duplicate-header'){before='.pinwin-body .cc-head-left > .tier, .pinwin-body .cc-head-left > .cc-name { display: none; }';after='.pinwin-body .cc-head-left > .tier, .pinwin-body .cc-head-left > .cc-name { display: initial; }'}
 if(mutation!=='small-corners'){if(s.split(before).length!==2)throw new Error('INERT '+mutation);s=s.replace(before,after)}
 return {contents:s,loader:'css'}
})}}]:[]
mkdirSync(out,{recursive:true})
await esbuild.build({entryPoints:['tests/windowchrome-fixture.tsx'],outdir:out,bundle:true,format:'esm',jsx:'automatic',plugins})
writeFileSync(path.join(out,'source.json'),JSON.stringify({mutation:mutation??null}))
