// Run under the verification owner's shared lock/Job. Output must be its C scope.
// Exact base overlays only the changed production files into current fixtures.
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
const [sourceRoot,outputDir,dependencies,mode,...suites]=process.argv.slice(2)
if(!sourceRoot||!outputDir||!dependencies||!mode)throw new Error('root output dependencies mode [suites] required')
const root=path.resolve(sourceRoot),output=path.resolve(outputDir),deps=path.resolve(dependencies)
const scope=process.env.UI_REFRESH_SCOPE??'all'
if(!['all','muse'].includes(scope))throw new Error('UI_REFRESH_SCOPE must be all or muse')
const require=createRequire(path.join(deps,'../package.json'))
fs.mkdirSync(output,{recursive:true})
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.trim()
console.log(JSON.stringify({sourceRoot:root,head,dependencies:deps,base:process.env.UI_REFRESH_BASE??null,scope}))
if(mode==='typecheck'){
  const config=path.join(output,'tsconfig.json')
  fs.writeFileSync(config,JSON.stringify({extends:path.join(root,'tsconfig.json'),compilerOptions:{
    paths:{react:[deps+'/@types/react/index.d.ts'],'react/*':[deps+'/@types/react/*'],
      'react-dom':[deps+'/@types/react-dom/index.d.ts'],'react-dom/*':[deps+'/@types/react-dom/*'],
      '*':[deps+'/*',deps+'/@types/*']},typeRoots:[deps+'/@types'],types:['node',deps+'/vite/client']}}))
  const result=spawnSync(process.execPath,[deps+'/typescript/bin/tsc','-p',config,'--pretty','false'],{stdio:'inherit',windowsHide:true,timeout:120000})
  process.exitCode=result.status??1
}else if(mode==='tests'){
  if(!suites.length)throw new Error('explicit focused suites required')
  const esbuild=require('esbuild'),bundles=[]
  const baseline=process.env.UI_REFRESH_BASE
  for(const name of suites){
    const outfile=path.join(output,name+'.mjs')
    await esbuild.build({entryPoints:[root+'/apps/desktop/renderer/tests/'+name+'.test.tsx'],outfile,
      bundle:true,format:'esm',platform:'node',target:'node22',jsx:'automatic',nodePaths:[deps],external:['node:*'],
      define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(root+'/apps/desktop/renderer/src')},
      plugins:[...(baseline?[{name:'exact-refresh-base',setup(b){
        b.onLoad({filter:/[\\/]src[\\/]api\.ts$|[\\/]src[\\/]App\.tsx$|[\\/]src[\\/]accountusage\.tsx$|[\\/]src[\\/]canvas[\\/]accounts\.tsx$/},args=>{
          const file=args.path.endsWith('api.ts')?'apps/desktop/renderer/src/api.ts':args.path.endsWith('App.tsx')?
            'apps/desktop/renderer/src/App.tsx':args.path.endsWith('accountusage.tsx')?
              'apps/desktop/renderer/src/accountusage.tsx':'apps/desktop/renderer/src/canvas/accounts.tsx'
          if(scope==='muse'&&!['apps/desktop/renderer/src/App.tsx',
            'apps/desktop/renderer/src/accountusage.tsx'].includes(file))return
          const p=spawnSync('git',['show',baseline+':'+file],{cwd:root,encoding:'utf8',windowsHide:true})
          if(p.status!==0)throw new Error(p.stderr)
          console.log('EXACT_BASE_SOURCE '+baseline+' '+file)
          return {contents:p.stdout,loader:file.endsWith('.tsx')?'tsx':'ts'}
        })}}]:[]),{name:'real-jsdom',setup(b){b.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}))}}]})
    esbuild.stop();bundles.push(outfile)
  }
  const result=spawnSync(process.execPath,['--test','--test-force-exit','--test-timeout=10000','--test-concurrency=1',...bundles],
    {stdio:'inherit',windowsHide:true,timeout:120000})
  process.exitCode=result.status??1
}else throw new Error('mode must be typecheck or tests')
