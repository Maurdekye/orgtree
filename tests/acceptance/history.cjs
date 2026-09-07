const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,BrowserWindow,dialog}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
const seed=JSON.parse(fs.readFileSync(path.join(root,'history-manifest.json'),'utf8'))
assert.ok(root.includes('orgtree-v2-acceptance-'));assert.equal(seed.org,'history-acceptance')
app.setPath('userData',path.join(root,'profile'));app.setAppPath(target)
let ready,child,started=false,finished=false
const checks=[],screenshots=[],spawn=cp.spawn,pause=ms=>new Promise(r=>setTimeout(r,ms))
cp.spawn=function(command,args,options){
  if(args?.some(a=>String(a).endsWith('launch.py'))){assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')));args=[path.join(__dirname,'visual_engine.py'),...args.slice(1)]}
  const c=spawn.call(this,command,args,options);child=c
  c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b))
  let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const row=JSON.parse(line);if(row.type==='ready')ready=row}catch{}}})
  return c
}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)checks.push({name:'history-flow',status:'FAIL',reason:error.message});fs.writeFileSync(path.join(root,'history.json'),JSON.stringify({status:error?'FAIL':'PASS',checks,screenshots,childPids:child?[child.pid]:[],limits:['Synthetic retained data; provider processes disabled','Actual launcher, API, renderer and native windows','No provider/session-continuity claim']},null,2));app.quit()}
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return{response:0}}
const deadline=setTimeout(()=>finish(Error('History acceptance deadline')),85000)
async function capture(w,name){await pause(400);const file=path.join(root,name+'.png');try{const shot=await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});assert.ok(!shot.isEmpty());fs.writeFileSync(file,shot.toPNG())}catch(e){if(e.message!=='UnknownVizError')throw e;const d=w.webContents.debugger;d.attach('1.3');try{const shot=await d.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false});assert.ok(shot.data.length>100);fs.writeFileSync(file,Buffer.from(shot.data,'base64'))}finally{d.detach()}}screenshots.push(file)}
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{
  const evaluate=async code=>{try{return await main.webContents.executeJavaScript(code)}catch(error){throw Error(code+': '+error.message)}}
  async function wait(code){for(let i=0;i<60;i++){if(await evaluate(`Boolean(${code})`))return;await pause(100)}throw Error('Missing expected history DOM: '+code)}
  const click=async code=>assert.equal(await evaluate(`(()=>{const b=${code};if(!b||b.disabled)return false;b.click();return true})()`),true,'Enabled click target: '+code)
  const select=async(label,value)=>{await evaluate(`(()=>{const s=document.querySelector('select[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)}
  try{
    assert.ok(ready&&ready.port!==7360);assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    const origin=new URL(main.webContents.getURL()).origin
    assert.equal((await fetch(origin+'/api/desktop/status')).status,401)
    assert.equal(await evaluate(`fetch('/api/desktop/status').then(r=>r.json()).then(s=>typeof s.idle)`),'boolean')
    await wait('document.querySelector(".org")');await click('document.querySelector(".org")')
    await wait(`document.querySelector('button[title="Browse retained history"]')`);await click(`document.querySelector('button[title="Browse retained history"]')`)
    async function pages(prefix,total){
      const found=[]
      for(let page=0;page<3;page++){
        const start=total-1-page*50,end=Math.max(0,start-49),first=prefix+'-'+String(start).padStart(3,'0')
        await wait(`document.querySelector('details summary')?.textContent.includes(${JSON.stringify(first)})`)
        const rows=await evaluate(`[...document.querySelectorAll('details summary')].map(e=>e.textContent)`)
        assert.equal(rows.length,start-end+1)
        for(let i=0;i<rows.length;i++)assert.ok(rows[i].includes(prefix+'-'+String(start-i).padStart(3,'0')))
        found.push([first,prefix+'-'+String(end).padStart(3,'0')])
        await capture(main,`${prefix}-page-${page+1}`)
        const older=await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Older').disabled`)
        assert.equal(older,page===2)
        if(page<2)await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Older')`)
      }
      checks.push({name:prefix+'-three-exact-pages',status:'PASS',boundaries:found})
    }
    await pages('READ-MAIL',115)
    await select('History records','chat');await wait(`document.querySelector('select[aria-label="History agent"]')`)
    for(const [node,prefix] of Object.entries(seed.chat_sources)){await select('History agent',node);await pages(prefix,105)}
    await select('History records','documents');await pages('DOC',105)
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Newer')`)
    await wait(`document.querySelector('details summary')?.textContent.includes('DOC-054')`)
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Newer')`)
    await wait(`document.querySelector('details summary')?.textContent.includes('DOC-104')`)
    const before=new Set(BrowserWindow.getAllWindows().map(w=>w.id))
    await click(`document.querySelector('button[aria-label="Open in new window"]')`)
    const native=BrowserWindow.getAllWindows().find(w=>!before.has(w.id));assert.ok(native)
    await pause(400);await native.webContents.executeJavaScript('document.querySelector("details").open=true;true')
    const downloaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('History native download missing')),10000);main.webContents.session.once('will-download',(_e,item)=>{item.setSavePath(path.join(root,item.getFilename()));item.once('done',(_e,state)=>{clearTimeout(timer);state==='completed'?resolve(item.getFilename()):reject(Error(state))})})})
    await native.webContents.executeJavaScript('document.querySelector(".document-download").click();true')
    const filename=await downloaded,expected=seed.documents.find(d=>d.title==='DOC-104')
    assert.equal(fs.readFileSync(path.join(root,filename),'utf8'),expected.body)
    await capture(native,'history-native-document-download');checks.push({name:'actual-history-popout-source-download',status:'PASS',filename})
    native.close();await pause(300);await click(`document.querySelector('button[aria-label="Close history"]')`)
    await click(`[...document.querySelectorAll('header button')].find(b=>b.title.startsWith('presented documents'))`)
    await wait('document.querySelectorAll(".doc-gallery-row").length===100')
    await capture(main,'gallery-first-100')
    await click(`[...document.querySelectorAll('.gallery-modal button')].find(b=>b.textContent==='Older')`)
    await wait('document.querySelectorAll(".doc-gallery-row").length===5')
    const rows=await evaluate(`[...document.querySelectorAll('.doc-gallery-row')].map(e=>e.textContent)`)
    for(let i=0;i<5;i++)assert.ok(rows[i].includes('DOC-'+String(4-i).padStart(3,'0')))
    assert.equal(await evaluate(`[...document.querySelectorAll('.gallery-modal button')].find(b=>b.textContent==='Older').disabled`),true)
    await capture(main,'gallery-older-five');checks.push({name:'gallery-100-then-five',status:'PASS'})
    finish()
  }catch(error){finish(error)}
})})
require(path.join(target,'dist/main/index.cjs'))
