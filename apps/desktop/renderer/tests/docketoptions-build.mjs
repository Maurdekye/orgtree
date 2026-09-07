import * as esbuild from 'esbuild'
import {mkdirSync,readFileSync} from 'node:fs'
import path from 'node:path'
const out=path.resolve('node_modules/.orgtree-docketoptions'),mutation=process.argv[2]
if(mutation && !['viewport-query','hidden-wide','dead-toggle'].includes(mutation))throw Error('Unknown mutation')
const plugins=mutation?[{name:mutation,setup(build){build.onLoad({filter:/\.(css|tsx)$/},({path:file})=>{if(!file.endsWith(mutation==='dead-toggle'?'docket.tsx':'styles.css'))return;let s=readFileSync(file,'utf8');const [a,b]=mutation==='viewport-query'?['@container docket (max-width: 760px)','@media (max-width: 760px)']:mutation==='hidden-wide'?['.docket-options { display: contents; }','.docket-options { display: none; }']:['onClick={() => setOptionsOpen(open => !open)}','onClick={() => setOptionsOpen(false)}'];if(s.split(a).length!==2)throw Error('INERT '+mutation);return {contents:s.replace(a,b),loader:file.endsWith('.css')?'css':'tsx'}})}}]:[]
mkdirSync(out,{recursive:true});await esbuild.build({entryPoints:['tests/docketoptions-fixture.tsx'],outdir:out,bundle:true,format:'esm',jsx:'automatic',plugins})
