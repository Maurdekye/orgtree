const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,BrowserWindow,dialog}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP),phase=process.env.ORGTREE_ACCEPTANCE_PHASE
app.setPath('userData',path.join(root,'profile'));app.setAppPath(target)
let ready,child,started=false,finished=false
const checks=[],screenshots=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),spawn=cp.spawn
cp.spawn=function(command,args,options){if(args?.some(a=>String(a).endsWith('launch.py'))){assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')));args=[path.join(__dirname,'lifecycle_engine.py'),...args.slice(1)]}const c=spawn.call(this,command,args,options);child=c;let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const r=JSON.parse(line);if(r.type==='ready')ready=r}catch{}}});c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b));return c}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)checks.push({name:'lifecycle',status:'FAIL',reason:error.message});fs.writeFileSync(path.join(root,phase+'.json'),JSON.stringify({status:error?'FAIL':'PASS',checks,screenshots,engine:ready?{pid:ready.pid,port:ready.port}:null,childPids:child?[child.pid]:[],limits:['Synthetic persisted assistant journal; no provider execution','Actual UI draft and attachment, native windows, quiet restart and manual show']},null,2));app.quit()}
const deadline=setTimeout(()=>finish(Error('Lifecycle deadline')),95000)
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return{response:0}}
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{
  const evaluate=code=>main.webContents.executeJavaScript(code,true)
  async function wait(code,w=main){for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript(`Promise.resolve(${code}).then(Boolean)`))return;await pause(100)}throw Error('Missing lifecycle control: '+code)}
  async function click(code,w=main){assert.equal(await w.webContents.executeJavaScript(`(()=>{const b=${code};if(!b||b.disabled)return false;b.click();return true})()`,true),true,code)}
  async function capture(w,name){await pause(350);const file=path.join(root,phase+'-'+name+'.png');try{const shot=await w.webContents.capturePage();assert.ok(!shot.isEmpty());fs.writeFileSync(file,shot.toPNG())}catch(error){if(error.message!=='UnknownVizError')throw error;const d=w.webContents.debugger;d.attach('1.3');try{const shot=await d.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false});assert.ok(shot.data.length>100);fs.writeFileSync(file,Buffer.from(shot.data,'base64'))}finally{d.detach()}}screenshots.push(file)}
  const sourceText='Persistent synthetic source for a reply after restart.',draft='This unsent reply and its attachment must survive quiet startup.'
  try{
    assert.ok(ready&&ready.port!==7360);assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    if(phase==='quiet'){
      const prior=JSON.parse(fs.readFileSync(path.join(root,'initial.json'),'utf8'))
      assert.equal(ready.port,prior.engine.port);assert.notEqual(child.pid,prior.childPids[0])
      await wait('window.orgtreeDesktop')
      await pause(1800)
      assert.equal(main.isVisible(),false);assert.equal(BrowserWindow.getAllWindows().length,1)
      assert.deepEqual(await evaluate('window.orgtreeDesktop.getWindowState()'),{visible:false,restoreWindows:false})
      assert.equal(await evaluate("fetch('/api/desktop/status').then(r=>r.status)"),200)
      checks.push({name:'quiet-start-no-visible-or-restored-windows-engine-live',status:'PASS'})
      await evaluate('window.orgtreeDesktop.showMainWindow()')
      await wait('window.orgtreeDesktop.getWindowState().then(s=>s.visible&&s.restoreWindows)')
      let desk,settings
      for(let i=0;i<100;i++){for(const w of BrowserWindow.getAllWindows().filter(w=>w!==main)){const state=await w.webContents.executeJavaScript('({desk:!!document.querySelector(".cc-composer textarea"),settings:!!document.querySelector(".acct-panel")})').catch(()=>({}));if(state.desk)desk=w;if(state.settings)settings=w}if(desk&&settings)break;await pause(100)}
      assert.ok(desk&&settings,'Manual show must restore desk and global Settings native windows')
      const saved=JSON.parse(fs.readFileSync(path.join(root,'initial-draft.json'),'utf8'))
      await wait(`document.querySelector('.cc-composer textarea')?.value===${JSON.stringify(draft)}`,desk)
      assert.equal(await desk.webContents.executeJavaScript("document.querySelector('.reply-preview blockquote')?.textContent"),sourceText)
      assert.equal(await desk.webContents.executeJavaScript("document.querySelector('.attach-row').textContent.includes('restart-note.txt')"),true)
      const chat=await evaluate("fetch('/api/orgs/acceptance-runtime/nodes/planner/chat').then(r=>r.json())")
      assert.ok(chat.messages.some(m=>m.event_id===saved.source.id))
      const current=await evaluate('JSON.parse(localStorage.getItem("orgtree-desktop-windows-v1"))')
      assert.ok(current.some(r=>r.kind===saved.deskKind&&r.open))
      assert.deepEqual(desk.getBounds(),saved.deskBounds);assert.deepEqual(settings.getBounds(),saved.settingsBounds)
      await capture(desk,'restored-reply-attachment');await capture(settings,'restored-settings')
      checks.push({name:'manual-show-restores-native-desk-settings-bounds-source-draft-attachment',status:'PASS',sourceId:saved.source.id,deskBounds:desk.getBounds(),settingsBounds:settings.getBounds()})
      main.close();assert.equal(main.isVisible(),false);assert.equal(desk.isVisible(),true);assert.equal(settings.isVisible(),true)
      assert.equal(await evaluate("fetch('/api/desktop/status').then(r=>r.status)"),200)
      checks.push({name:'main-close-retains-popouts-and-engine',status:'PASS'});finish();return
    }
    await wait('document.querySelector(".org")');await click('document.querySelector(".org")')
    await wait(`[...document.querySelectorAll('.sq .name')].some(e=>e.textContent==='planner')`)
    assert.equal(await evaluate(`(()=>{const c=[...document.querySelectorAll('.sq')].find(e=>e.querySelector('.name')?.textContent==='planner');const r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+30,clientY:r.y+30}));return true})()`),true)
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Open desk')`)
    await wait(`document.querySelector('.desk-body')?.textContent.includes(${JSON.stringify(sourceText)})`)
    const source=await evaluate(`(()=>{const e=[...document.querySelectorAll('[data-reply-event]')].find(e=>e.textContent.trim()===${JSON.stringify(sourceText)});if(!e)return null;const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+15,clientY:r.y+8}));return{id:e.getAttribute('data-reply-event'),text:e.textContent.trim()}})()`)
    assert.ok(source?.id);await capture(main,'reply-context');await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Reply')`)
    await wait(`document.querySelector('.reply-preview blockquote')?.textContent===${JSON.stringify(sourceText)}`)
    await evaluate(`(()=>{const t=document.querySelector('.cc-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(draft)});t.dispatchEvent(new Event('input',{bubbles:true}));const d=new DataTransfer();d.items.add(new File(['Persistent synthetic attachment bytes.'],'restart-note.txt',{type:'text/plain'}));document.querySelector('.desk-body').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));return true})()`)
    await wait("document.querySelector('.attach-row')?.textContent.includes('restart-note.txt')")
    await capture(main,'unsent-reply-attachment')
    // Exercise actual Settings pin/context controls over a focused desk.
    await click("document.querySelector('header.orgbar button.iconbtn')")
    await wait(`document.querySelector('button[title="App settings"]')`);await click(`document.querySelector('button[title="App settings"]')`)
    await wait(`document.querySelector('.acct-panel')`)
    await click(`[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.startsWith('Display'))`)
    await click(`document.querySelector('.acct-panel button[aria-label="pin this to the window"]')`)
    await wait(`document.querySelector('.acct-panel.modalpin-win')`)
    await pause(500)
    const overlap=await evaluate(`(()=>{const p=document.querySelector('.acct-panel'),d=document.querySelector('.sq.desk'),a=p.getBoundingClientRect(),b=d.getBoundingClientRect();return{overlaps:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,opacity:getComputedStyle(p).opacity}})()`)
    assert.ok(overlap.overlaps,'Pinned Settings must overlap actual focused desk');assert.equal(Number(overlap.opacity),0.7)
    await capture(main,'overlap-default')
    await evaluate(`(()=>{const s=document.querySelector('input[aria-label="Overlap opacity"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'0.45');s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await wait(`getComputedStyle(document.querySelector('.acct-panel')).opacity==='0.45'`)
    await click(`document.querySelector('input[aria-label="fade pinned modals over the focused desk"]')`)
    await wait(`getComputedStyle(document.querySelector('.acct-panel')).opacity==='1'`)
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Overlap opacity"]').disabled`),true)
    await capture(main,'overlap-disabled')
    await click(`document.querySelector('input[aria-label="fade pinned modals over the focused desk"]')`)
    await wait(`getComputedStyle(document.querySelector('.acct-panel')).opacity==='0.45'`)
    checks.push({name:'actual-overlap-opacity-adjust-disable-reenable',status:'PASS'})
    await evaluate(`(()=>{const e=document.querySelector('.acct-panel .modalpin-bar'),r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+50,clientY:r.y+10}));return true})()`)
    await wait(`[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.textContent==='Unpin')`)
    await capture(main,'pinned-context-menu');await click(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='Unpin')`)
    await wait(`!document.querySelector('.acct-panel.modalpin-win')`)
    checks.push({name:'real-pinned-modal-default-overlap-and-context-unpin',status:'PASS',overlap})
    const before=new Set(BrowserWindow.getAllWindows().map(w=>w.id))
    await click(`document.querySelector('.acct-panel button[aria-label="Open in new window"]')`)
    const settings=BrowserWindow.getAllWindows().find(w=>!before.has(w.id));assert.ok(settings)
    await wait(`document.querySelector('.acct-panel')`,settings);settings.setBounds({x:80,y:90,width:840,height:680})
    await click(`document.querySelector('.desk-body button[aria-label="Open in new window"]')`)
    let desk;for(let i=0;i<60;i++){desk=BrowserWindow.getAllWindows().find(w=>w!==main&&w!==settings);if(desk)break;await pause(100)}assert.ok(desk)
    await wait(`document.querySelector('.cc-composer textarea')`,desk);desk.setBounds({x:130,y:110,width:950,height:750})
    await pause(700);await capture(desk,'native-unsent-reply')
    const layout=await evaluate('JSON.parse(localStorage.getItem("orgtree-desktop-windows-v1"))')
    const deskRow=layout.find(r=>r.kind.startsWith('desk:')&&r.open);assert.ok(deskRow)
    fs.writeFileSync(path.join(root,'initial-draft.json'),JSON.stringify({source,draft,deskKind:deskRow.kind,deskBounds:desk.getBounds(),settingsBounds:settings.getBounds(),layout},null,2))
    checks.push({name:'real-unsent-reply-and-upload-persist-before-quit',status:'PASS',sourceId:source.id})
    finish()
  }catch(error){fs.writeFileSync(path.join(root,phase+'-error-dom.txt'),await evaluate('document.body.innerText').catch(()=>''));await capture(main,'error').catch(()=>{});finish(error)}
})})
require(path.join(target,'dist/main/index.cjs'))
