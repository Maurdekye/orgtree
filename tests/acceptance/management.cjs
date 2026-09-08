const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,BrowserWindow,dialog}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
app.setPath('userData',path.join(root,'profile'));app.setAppPath(target)
let ready,child,started=false,finished=false
const checks=[],screenshots=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),spawn=cp.spawn
cp.spawn=function(command,args,options){if(args?.some(a=>String(a).endsWith('launch.py'))){assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')));args=[path.join(__dirname,'management_engine.py'),...args.slice(1)]}const c=spawn.call(this,command,args,options);child=c;let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const r=JSON.parse(line);if(r.type==='ready')ready=r}catch{}}});c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b));return c}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)checks.push({name:'management-flow',status:'FAIL',reason:error.message});fs.writeFileSync(path.join(root,'management.json'),JSON.stringify({status:error?'FAIL':'PASS',checks,screenshots,childPids:child?[child.pid]:[],limits:['Real provider discovery and UI-created nodes; provider turns forbidden','Read-only existing harness sign-in used; provider send_message forbidden, no auth/config modification']},null,2));app.quit()}
const deadline=setTimeout(()=>finish(Error('Management deadline')),85000)
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return{response:0}}
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{
  const evaluate=code=>main.webContents.executeJavaScript(code,true)
  async function wait(code){for(let i=0;i<100;i++){if(await evaluate(`Promise.resolve(${code}).then(Boolean)`))return;await pause(100)}throw Error('Missing expected artifact control: '+code)}
  async function click(code){assert.equal(await evaluate(`(()=>{const b=${code};if(!b||b.disabled)return false;b.click();return true})()`),true,code)}
  async function capture(w,name){await pause(400);const file=path.join(root,name+'.png');try{const shot=await w.webContents.capturePage();assert.ok(!shot.isEmpty());fs.writeFileSync(file,shot.toPNG())}catch(error){if(error.message!=='UnknownVizError')throw error;const d=w.webContents.debugger;d.attach('1.3');try{const shot=await d.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false});assert.ok(shot.data.length>100);fs.writeFileSync(file,Buffer.from(shot.data,'base64'))}finally{d.detach()}}screenshots.push(file)}
  try{
    assert.ok(ready&&ready.port!==7360);assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    const providers=await evaluate("fetch('/api/providers').then(r=>r.json())")
    const visible=providers.providers.map(p=>({id:p.id,installed:p.status?.installed??p.installed,connected:p.status?.connected??p.connected,hire:p.hire,hire_enabled:p.hire_enabled,tiers:p.tiers.map(t=>({tier:t.tier,seat:t.seat}))}))
    fs.writeFileSync(path.join(root,'discovery.json'),JSON.stringify(visible,null,2))
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('new organization'))`)
    await wait(`document.querySelector('input[placeholder="organization name"]')`)
    await evaluate(`(()=>{const i=document.querySelector('input[placeholder="organization name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Management Acceptance');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await evaluate(`document.querySelector('input[placeholder="organization name"]').form.requestSubmit();true`)
    await wait(`location.pathname==='/o/management-acceptance'`)
    const state=()=>evaluate("fetch('/api/orgs/management-acceptance').then(r=>r.json())")
    function nodes(t){const out=[];function visit(n,parent=null){out.push({...n,parent});for(const c of n.children||[])visit(c,n.id)};for(const n of t.roots||[])visit(n);return out}
    assert.equal(nodes(await state()).length,0,'No synthetic agents pre-exist the UI hire')
    async function hire(name,parent){
      const selector=parent?`[...document.querySelectorAll('.sq')].find(e=>e.querySelector('.name')?.textContent==='${parent}')`:`document.querySelector('.sq.user')`
      await wait(selector)
      // The actual hidden hover chips still carry the real provider gating.
      await click(`(${selector}).querySelector('button.t-haiku:not(:disabled)')`)
      await wait(`document.querySelector('.draft .df-name')`)
      await evaluate(`(()=>{const i=document.querySelector('.draft .df-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${name}');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
      await capture(main,'hire-'+name+'-draft')
      await click(`document.querySelector('.draft .df-foot button.primary')`)
      await wait(`[...document.querySelectorAll('.sq .name')].some(e=>e.textContent==='${name}')`)
      const raw=await state();fs.writeFileSync(path.join(root,'debug-tree.json'),JSON.stringify(raw,null,2));const row=nodes(raw).find(n=>n.id===name);assert.ok(row);assert.ok(raw.dirs.every(d=>row.scope.effective_dirs?.some(e=>e.path===d.path)||row.scope.add_dirs?.some(e=>e.path===d.path)),'Actual UI hire inherits organization folders');assert.equal(row.tier,'haiku');assert.equal(row.state,'live');return row
    }
    const first=await hire('manager',null),second=await hire('worker','manager')
    assert.equal(second.parent,'manager')
    checks.push({name:'real-provider-discovery-ui-haiku-hire-two-durable-nodes',status:'PASS',provider:visible.find(p=>p.id==='claude'),nodes:['manager','worker']})
    async function settings(nid){
      await evaluate(`(()=>{const c=[...document.querySelectorAll('.sq')].find(e=>e.querySelector('.name')?.textContent==='${nid}'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+25,clientY:r.y+25}));return true})()`)
      await click(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='Settings')`)
      await wait(`document.querySelector('input[placeholder^="rename"]')`)
    }
    await settings('worker')
    await evaluate(`(()=>{const i=document.querySelector('input[placeholder^="rename"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'renamed');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='rename')`)
    await wait(`[...document.querySelectorAll('.sq .name')].some(e=>e.textContent==='renamed')`)
    let tree=await state();assert.ok(!nodes(tree).some(n=>n.id==='worker'));assert.ok(nodes(tree).some(n=>n.id==='renamed'))
    // Representative reparent uses the actual operator route; pointer drag is not claimed.
    const moved=await evaluate(`fetch('/api/orgs/management-acceptance/ops',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'move',node:'renamed',new_parent:null})}).then(async r=>({status:r.status,body:await r.json()}))`)
    assert.equal(moved.status,200);assert.ok([null,'@user'].includes(nodes(await state()).find(n=>n.id==='renamed').parent))
    await settings('renamed');await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('retire'))`)
    await wait(`document.querySelector('.confirm-box')`);await click(`document.querySelector('.confirm-box button.solid')`)
    await wait(`fetch('/api/orgs/management-acceptance').then(r=>r.json()).then(t=>t.roots.some(n=>n.id==='renamed'&&n.state==='archived'))`)
    await capture(main,'retired-node')
    // Rehire through the real retained node's Settings control.
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`)
    await settings('renamed');await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='rehire (context intact)')`)
    await wait(`fetch('/api/orgs/management-acceptance').then(r=>r.json()).then(t=>t.roots.some(n=>n.id==='renamed'&&n.state==='live'))`)
    await capture(main,'rehired-renamed-node')
    checks.push({name:'actual-ui-rename-retire-rehire-and-operator-reparent',status:'PASS',reparentPointerGesture:false})
    fs.writeFileSync(path.join(root,'management-durable.json'),JSON.stringify(nodes(await state()).map(n=>({id:n.id,parent:n.parent,tier:n.tier,state:n.state,generation:n.generation})),null,2))
    finish()
  }catch(error){fs.writeFileSync(path.join(root,'artifact-error-dom.txt'),await evaluate('document.body.innerText').catch(()=>''));await capture(main,'artifact-error').catch(()=>{});finish(error)}
})})
require(path.join(target,'dist/main/index.cjs'))
