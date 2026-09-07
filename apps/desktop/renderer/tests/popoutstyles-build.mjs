import * as esbuild from 'esbuild'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
const out=path.resolve('node_modules/.orgtree-popoutstyles'),mutation=process.argv[2]
if(mutation && !['no-style-retry','ignore-user-input','lost-pending-return'].includes(mutation))throw new Error('Unknown mutation')
const plugins=mutation?[{name:mutation,setup(build){build.onLoad({filter:/popout\.tsx$/},({path:file})=>{
 let s=readFileSync(file,'utf8');const [before,after]=mutation==='no-style-retry'?['if (untouched) restore(); settled()','void untouched; settled()']:mutation==='ignore-user-input'?['untouched = false; settled()','void untouched']:['pendingRestore.current ?? preservePosition(parts.container)','preservePosition(parts.container)']
 if(s.split(before).length!==2)throw new Error('INERT '+mutation)
 return {contents:s.replace(before,after),loader:'tsx'}
})}}]:[]
mkdirSync(out,{recursive:true})
await esbuild.build({entryPoints:['tests/popoutstyles-fixture.tsx'],outdir:out,bundle:true,format:'esm',jsx:'automatic',plugins})
writeFileSync(path.join(out,'source.json'),JSON.stringify({mutation:mutation??null}))
