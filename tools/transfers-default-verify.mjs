// Run inside rig-opus's shared lock/contained batch. No installed app or server.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const [phase,repo,hubrepo,out]=process.argv.slice(2);
if(!['focused','browser-build'].includes(phase)||!repo||!hubrepo||!out)throw Error('args: focused|browser-build <orgtree-repo> <hubchat-repo> <C-output>');
if(!path.resolve(out).replaceAll('\\','/').toLowerCase().startsWith('c:/orgtree-build/'))throw Error('Output must be in exact authorized C:/orgtree-build agent scope');
const deps=process.env.TRANSFERS_ORGTREE_DEPS||'D:/orgtree-work/worktrees/frozenlabel-sol/node_modules';
const hubdeps=process.env.TRANSFERS_HUBCHAT_DEPS||'E:/Libraries/Desktop/orgtree/.worktrees/orgtree-hubchat/node_modules';
const require=createRequire(path.join(deps,'../package.json'));
const esbuild=require('esbuild');mkdirSync(out,{recursive:true});
const base={bundle:true,jsx:'automatic',nodePaths:[deps],alias:{react:deps+'/react','react-dom':deps+'/react-dom'}};
const red={name:'baseline-default',setup(b){b.onLoad({filter:/[\\/]canvas[\\/]transfers\.tsx$/},a=>{
  let source=readFileSync(a.path,'utf8');
  const needle='const [expanded, setExpanded] = useState(false)';
  if(!source.includes(needle))throw Error('Red control must reverse the exact default fix');
  source=source.replace(needle,'const [expanded, setExpanded] = useState(true)').replace('; setExpanded(false) }, [slug, agent])',' }, [slug, agent])');
  return {contents:source,loader:'tsx'};
});}};
try{
  if(phase==='focused'){
    const tests=path.join(repo,'apps/desktop/renderer/tests');
    let runner=readFileSync(path.join(tests,'run.mjs'),'utf8')
      .replace("from 'esbuild'",'from '+JSON.stringify(pathToFileURL(require.resolve('esbuild')).href))
      .replace('const HERE = path.dirname(fileURLToPath(import.meta.url))','const HERE = '+JSON.stringify(tests))
      .replaceAll('createRequire(import.meta.url)','createRequire('+JSON.stringify(pathToFileURL(path.join(deps,'../package.json')).href)+')');
    writeFileSync(path.join(out,'run-prebuilt.mjs'),runner);
    for(const colour of ['red','green']){
      const bundles=path.join(out,colour);mkdirSync(bundles,{recursive:true});
      await esbuild.build({...base,entryPoints:[path.join(tests,'transfers-default.test.tsx')],outfile:path.join(bundles,'transfers-default.test.mjs'),
        platform:'node',format:'esm',target:'node22',external:['node:*'],define:{'process.env.NODE_ENV':'"development"'},
        plugins:[...(colour==='red'?[red]:[]),{name:'absolute-jsdom',setup(b){b.onResolve({filter:/^jsdom$/},()=>({path:pathToFileURL(require.resolve('jsdom')).href,external:true}));}}]});
      const result=spawnSync(process.execPath,[path.join(out,'run-prebuilt.mjs'),'--prebuilt',bundles,'transfers-default.test'],{encoding:'utf8',timeout:60000});
      const log=(result.stdout||'')+(result.stderr||'');writeFileSync(path.join(out,colour+'.log'),log);process.stdout.write(log);
      if(result.error)throw result.error;
      if(colour==='green'&&result.status!==0)throw Error('Green focused checks failed');
      if(colour==='red'&&(result.status===0||!/expected|AssertionError/.test(log)||!/^(?:#|\u2139) tests 6\s*$/m.test(log)||/ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError/.test(log)))throw Error('Red control did not fail on collapse assertions');
    }
    console.log('Focused red fails as expected; green 6/6 passes.');
  }else{
    for(const colour of ['red','green'])await esbuild.build({...base,entryPoints:[path.join(repo,'apps/desktop/renderer/tests/transfers-default-fixture.tsx')],outfile:path.join(out,'org-'+colour+'.js'),platform:'browser',format:'iife',plugins:colour==='red'?[red]:[]});
    await esbuild.build({...base,nodePaths:[hubdeps],alias:{react:hubdeps+'/react','react-dom':hubdeps+'/react-dom'},entryPoints:[path.join(hubrepo,'tools/transfers-default-fixture.tsx')],outfile:path.join(out,'hub.js'),platform:'browser',format:'iife'});
    for(const platform of ['desktop','android'])writeFileSync(path.join(out,'hub-'+platform+'.css'),['tokens.css','base.css','app.css',platform==='desktop'?'desktop.css':'mobile.css',platform==='desktop'?'app-desktop.css':'app-mobile.css'].map(f=>readFileSync(path.join(hubrepo,'src/styles',f),'utf8')).join('\n'));
    console.log('Real Orgtree red/green and unchanged Hubchat desktop/Android fixtures bundled.');
  }
}finally{await esbuild.stop();}
