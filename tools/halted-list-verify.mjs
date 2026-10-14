// Invoke only inside rig-opus's shared lock and Job-contained batch.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {beforeHaltedList} from './halted-list-before.mjs';
const [phase,repo,out]=process.argv.slice(2);
if(!['focused','browser-build'].includes(phase)||!repo||!out)throw Error('args: focused|browser-build <combined-repo> <C-output>');
if(!path.resolve(out).replaceAll('\\','/').toLowerCase().startsWith('c:/orgtree-build/'))throw Error('Output must be in exact authorized C:/orgtree-build agent scope');
const deps=process.env.HALTED_LIST_DEPS||'D:/orgtree-work/worktrees/frozenlabel-sol/node_modules';
const require=createRequire(path.join(deps,'../package.json')),esbuild=require('esbuild');mkdirSync(out,{recursive:true});
const base={bundle:true,jsx:'automatic',nodePaths:[deps],alias:{react:deps+'/react','react-dom':deps+'/react-dom'}};
const red={name:'before-halted-list',setup(b){b.onLoad({filter:/[\\/](desk\.tsx|agenttray\.tsx|styles\.css)$/},a=>({contents:beforeHaltedList(a.path.replaceAll('\\','/'),readFileSync(a.path,'utf8').replaceAll('\r\n','\n')),loader:a.path.endsWith('.css')?'css':'tsx'}));}};
try{
  if(phase==='focused'){
    const tests=path.join(repo,'apps/desktop/renderer/tests');
    const runner=readFileSync(path.join(tests,'run.mjs'),'utf8').replace("from 'esbuild'",'from '+JSON.stringify(pathToFileURL(require.resolve('esbuild')).href))
      .replace('const HERE = path.dirname(fileURLToPath(import.meta.url))','const HERE = '+JSON.stringify(tests))
      .replaceAll('createRequire(import.meta.url)','createRequire('+JSON.stringify(pathToFileURL(path.join(deps,'../package.json')).href)+')');
    writeFileSync(path.join(out,'run-prebuilt.mjs'),runner);
    for(const colour of ['red','green']){
      const bundles=path.join(out,colour);mkdirSync(bundles,{recursive:true});
      const filters=colour==='red'?['halted-list.test']:['halted-list.test','haltcontrol.test','usagefreeze.test','agentstray.test'];
      await esbuild.build({...base,entryPoints:filters.map(f=>path.join(tests,f+'.tsx')),outdir:bundles,outExtension:{'.js':'.mjs'},platform:'node',format:'esm',target:'node22',external:['node:*'],
        define:{'process.env.NODE_ENV':'"development"',__SRC_DIR__:JSON.stringify(path.join(repo,'apps/desktop/renderer/src'))},plugins:[...(colour==='red'?[red]:[]),{name:'absolute-jsdom',setup(b){b.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}));}}]});
      const r=spawnSync(process.execPath,[path.join(out,'run-prebuilt.mjs'),'--prebuilt',bundles,...filters],{encoding:'utf8',timeout:90000});
      const log=(r.stdout||'')+(r.stderr||'');writeFileSync(path.join(out,colour+'.log'),log);process.stdout.write(log);
      if(r.error)throw r.error;
      if(colour==='green'&&r.status!==0)throw Error('Green focused/regression checks failed');
      if(colour==='red'&&(r.status===0||!/AssertionError/.test(log)||!/# tests 5/.test(log)||/ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError/.test(log)))throw Error('Red control must fail on halted-list assertions');
    }
    console.log('Halted-list red fails as expected; green focused/regressions pass.');
  }else{
    for(const colour of ['red','green'])await esbuild.build({...base,entryPoints:[path.join(repo,'apps/desktop/renderer/tests/halted-list-fixture.tsx')],outfile:path.join(out,colour+'.js'),platform:'browser',format:'iife',plugins:colour==='red'?[red]:[]});
    console.log('Real AgentTray red/green fixtures bundled.');
  }
}finally{await esbuild.stop();}
