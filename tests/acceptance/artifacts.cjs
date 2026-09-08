const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,BrowserWindow,dialog}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
app.setPath('userData',path.join(root,'profile'));app.setAppPath(target)
let ready,child,started=false,finished=false,resourceServer
const checks=[],screenshots=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),spawn=cp.spawn
cp.spawn=function(command,args,options){if(args?.some(a=>String(a).endsWith('launch.py'))){assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')));args=[path.join(__dirname,'artifacts_engine.py'),...args.slice(1)]}const c=spawn.call(this,command,args,options);child=c;let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const r=JSON.parse(line);if(r.type==='ready')ready=r}catch{}}});c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b));return c}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);resourceServer?.close();if(error)checks.push({name:'artifact-flow',status:'FAIL',reason:error.message});fs.writeFileSync(path.join(root,'artifacts.json'),JSON.stringify({status:error?'FAIL':'PASS',checks,screenshots,childPids:child?[child.pid]:[],limits:['Synthetic files/scoped actor; no provider turn','Actual snapshot API, native downloads and restricted artifact window','Internet-resource path uses a separate controlled loopback HTTP origin; no public service contacted']},null,2));app.quit()}
const deadline=setTimeout(()=>finish(Error('Artifact deadline')),85000)
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return{response:0}}
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{
  const evaluate=code=>main.webContents.executeJavaScript(code,true)
  async function wait(code){for(let i=0;i<100;i++){if(await evaluate(`Promise.resolve(${code}).then(Boolean)`))return;await pause(100)}throw Error('Missing expected artifact control: '+code)}
  async function click(code){assert.equal(await evaluate(`(()=>{const b=${code};if(!b||b.disabled)return false;b.click();return true})()`),true,code)}
  async function capture(w,name){await pause(400);const file=path.join(root,name+'.png');try{const shot=await w.webContents.capturePage();assert.ok(!shot.isEmpty());fs.writeFileSync(file,shot.toPNG())}catch(error){if(error.message!=='UnknownVizError')throw error;const d=w.webContents.debugger;d.attach('1.3');try{const shot=await d.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false});assert.ok(shot.data.length>100);fs.writeFileSync(file,Buffer.from(shot.data,'base64'))}finally{d.detach()}}screenshots.push(file)}
  try{
    assert.ok(ready&&ready.port!==7360);assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    const origin=new URL(main.webContents.getURL()).origin,token=fs.readFileSync(path.join(root,'private-agent-token'),'utf8'),fixture=JSON.parse(fs.readFileSync(path.join(root,'artifact-manifest.json'),'utf8'))
    const docs=[]
    for(const [file,title] of [['single.html','Standalone HTML'],['index.html','Bundled HTML']]){
      const r=await fetch(origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Orgtree-Agent-Token':token},body:JSON.stringify({org:'acceptance-runtime',node:'planner',tool:'orgtree_present',args:{path:path.join(fixture.folder,file),title}})})
      assert.equal(r.status,200);const body=await r.json();assert.ok(body.presented);docs.push({file,title,id:body.presented})
    }
    // Snapshot custody positive control: later source edits cannot change download bytes.
    fs.writeFileSync(path.join(fixture.folder,'single.html'),'changed after presentation')
    fs.writeFileSync(path.join(fixture.folder,'assets/site.css'),'changed after presentation')
    await wait('document.querySelector(".org")');await click('document.querySelector(".org")')
    await wait(`document.querySelector('button[title="Browse retained history"]')`);await click(`document.querySelector('button[title="Browse retained history"]')`)
    await wait(`document.querySelector('select[aria-label="History records"] option[value="documents"]')`)
    await evaluate(`(()=>{const s=document.querySelector('select[aria-label="History records"]');s.value='documents';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    await wait(`document.querySelector('details summary')?.textContent.includes('Bundled HTML')`)
    for(const doc of docs){
      await evaluate(`(()=>{const d=[...document.querySelectorAll('details')].find(d=>d.querySelector('summary strong')?.textContent===${JSON.stringify(doc.title)});d.open=true;return true})()`)
      const download=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Artifact native download missing')),12000);main.webContents.session.once('will-download',(_e,item)=>{item.setSavePath(path.join(root,item.getFilename()));item.once('done',(_e,state)=>{clearTimeout(timer);state==='completed'?resolve(item.getFilename()):reject(Error(state))})})})
      await click(`[...document.querySelectorAll('details')].find(d=>d.querySelector('summary strong')?.textContent===${JSON.stringify(doc.title)}).querySelector('.document-download')`)
      const filename=await download
      if(doc.file==='single.html'){assert.equal(filename,'Standalone-HTML.html');assert.equal(fs.readFileSync(path.join(root,filename),'utf8'),fixture.files['single.html'])}
      else{
        assert.equal(filename,'Bundled-HTML.zip')
        const script="import json,sys,zipfile; m=json.load(open(sys.argv[2],encoding='utf-8')); z=zipfile.ZipFile(sys.argv[1]); expected={k:v for k,v in m['files'].items() if k!='single.html'}; assert set(z.namelist())==set(expected),z.namelist(); assert all(z.read(k)==v.encode('utf-8') for k,v in expected.items()); print(json.dumps({'entries':z.namelist(),'originalBytes':True,'unreferencedExcluded':True}))"
        const proof=JSON.parse(cp.execFileSync(process.env.ORGTREE_V2_PYTHON,['-c',script,path.join(root,filename),path.join(root,'artifact-manifest.json')],{encoding:'utf8',windowsHide:true}))
        fs.writeFileSync(path.join(root,'zip-proof.json'),JSON.stringify(proof))
      }
      checks.push({name:doc.file==='single.html'?'actual-single-html-download':'actual-zip-original-assets',status:'PASS',filename})
    }
    await capture(main,'html-and-zip-history')
    const before=new Set(BrowserWindow.getAllWindows().map(w=>w.id))
    await click(`[...document.querySelectorAll('details')].find(d=>d.querySelector('summary strong')?.textContent==='Bundled HTML').querySelector('a:not(.document-download),button')`)
    let artifact;for(let i=0;i<60;i++){artifact=BrowserWindow.getAllWindows().find(w=>!before.has(w.id));if(artifact)break;await pause(100)}assert.ok(artifact)
    if(artifact.webContents.isLoading())await new Promise(resolve=>artifact.webContents.once('did-finish-load',resolve))
    assert.equal(await artifact.webContents.executeJavaScript('typeof window.orgtreeDesktop'),'undefined')
    assert.equal(await evaluate(`fetch('/api/desktop/status').then(r=>r.status)`),200,'Main-frame API positive control')
    const blocked=await artifact.webContents.executeJavaScript(`fetch(${JSON.stringify(origin+'/api/desktop/status')}).then(r=>({status:r.status})).catch(e=>({blocked:true,error:e.name}))`)
    assert.ok(blocked.status===401||blocked.blocked===true)
    const frames=artifact.webContents.mainFrame.frames;assert.ok(frames.length>0)
    const text=await frames[0].executeJavaScript('document.body.innerText');assert.ok(text.includes('Bundle HTML original'))
    assert.equal(await frames[0].executeJavaScript('typeof window.orgtreeDesktop'),'undefined')
    const localRendered=await frames[0].executeJavaScript(`({background:getComputedStyle(document.body).backgroundColor,image:document.querySelector('img').complete&&document.querySelector('img').naturalWidth===100})`)
    await capture(artifact,'restricted-html-viewer')
    assert.deepEqual(localRendered,{background:'rgb(25, 33, 45)',image:true},'Referenced original local CSS and SVG must render')
    checks.push({name:'real-artifact-viewer-local-assets-no-bridge-or-api-authority',status:'PASS',apiAttempt:blocked,localRendered})
    artifact.close()
    const requests=[]
    resourceServer=require('node:http').createServer((req,res)=>{
      requests.push({path:req.url,hasAuthority:Object.keys(req.headers).some(k=>/authorization|cookie|orgtree.*token/i.test(k))})
      res.setHeader('Access-Control-Allow-Origin','*')
      if(req.url==='/site.css'){res.setHeader('Content-Type','text/css');res.end('body{background:rgb(11,22,33);color:white}h1{color:rgb(44,155,222)}')}
      else if(req.url==='/code.js'){res.setHeader('Content-Type','text/javascript');res.end(`window.remoteScriptLoaded=true;fetch('${resourceOrigin}/data').then(r=>r.json()).then(d=>window.remoteData=d.value)`)}
      else if(req.url==='/mark.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="77" height="40"><rect width="77" height="40" fill="red"/></svg>')}
      else if(req.url==='/data'){res.setHeader('Content-Type','application/json');res.end('{"value":"controlled-network-success"}')}
      else{res.statusCode=404;res.end('missing')}
    })
    await new Promise(resolve=>resourceServer.listen(0,'127.0.0.1',resolve))
    const resourceOrigin='http://127.0.0.1:'+resourceServer.address().port
    assert.notEqual(resourceOrigin,origin)
    // Controlled server positive control distinguishes CSP rejection from an unavailable server.
    assert.equal(await fetch(resourceOrigin+'/data').then(r=>r.status),200);requests.length=0
    const networkFile=path.join(fixture.folder,'network.html')
    fs.writeFileSync(networkFile,`<!doctype html><title>Controlled network presentation</title><link rel="stylesheet" href="${resourceOrigin}/site.css"><h1>Network resources</h1><img src="${resourceOrigin}/mark.svg"><script src="${resourceOrigin}/code.js"></script>`)
    const published=await fetch(origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Orgtree-Agent-Token':token},body:JSON.stringify({org:'acceptance-runtime',node:'planner',tool:'orgtree_present',args:{path:networkFile,title:'Network resources'}})})
    assert.equal(published.status,200);const networkDoc=await published.json();assert.ok(networkDoc.presented)
    const previous=new Set(BrowserWindow.getAllWindows().map(w=>w.id))
    await evaluate(`window.open('/api/orgs/acceptance-runtime/documents/${networkDoc.presented}/mockup','_blank','noopener,noreferrer');true`)
    let networkWindow;for(let i=0;i<60;i++){networkWindow=BrowserWindow.getAllWindows().find(w=>!previous.has(w.id));if(networkWindow&&!networkWindow.webContents.isLoading())break;await pause(100)}assert.ok(networkWindow)
    let networkState
    for(let i=0;i<80;i++){const frame=networkWindow.webContents.mainFrame.frames[0];if(frame)networkState=await frame.executeJavaScript(`({script:window.remoteScriptLoaded===true,data:window.remoteData,background:getComputedStyle(document.body).backgroundColor,image:document.querySelector('img')?.naturalWidth,bridge:typeof window.orgtreeDesktop})`);if(networkState?.data==='controlled-network-success'&&networkState.image===77)break;await pause(100)}
    fs.writeFileSync(path.join(root,'network-resources.json'),JSON.stringify({requests,state:networkState},null,2))
    await capture(networkWindow,'network-resources-preview')
    assert.deepEqual(networkState,{script:true,data:'controlled-network-success',background:'rgb(11, 22, 33)',image:77,bridge:'undefined'})
    assert.deepEqual([...new Set(requests.map(r=>r.path))].sort(),['/code.js','/data','/mark.svg','/site.css'])
    assert.ok(requests.every(r=>!r.hasAuthority),'Remote resources must not receive engine authority')
    const networkDenied=await networkWindow.webContents.mainFrame.frames[0].executeJavaScript(`fetch(${JSON.stringify(origin+'/api/desktop/status')}).then(r=>({status:r.status})).catch(e=>({blocked:true,error:e.name}))`)
    assert.ok(networkDenied.status===401||networkDenied.blocked)
    checks.push({name:'real-network-css-script-image-fetch-without-engine-authority',status:'PASS',networkState,apiAttempt:networkDenied,requestPaths:requests.map(r=>r.path)})
    networkWindow.close();finish()
  }catch(error){fs.writeFileSync(path.join(root,'artifact-error-dom.txt'),await evaluate('document.body.innerText').catch(()=>''));await capture(main,'artifact-error').catch(()=>{});finish(error)}
})})
require(path.join(target,'dist/main/index.cjs'))
