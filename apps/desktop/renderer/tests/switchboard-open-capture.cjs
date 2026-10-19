const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_SWITCHBOARD_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
 const receipts=[]
 for(const [name,width,light,focused] of [['overview-dark',1000,false,false],['header-light-narrow',390,true,true]]){
  const win=new BrowserWindow({width,height:650,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}})
  try{
   win.webContents.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!/^(file:|data:)/.test(details.url)}))
   await win.loadFile(path.join(out,'index.html'),{query:{focused:String(focused)}})
   await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const ready=()=>{const surface=document.querySelector(${JSON.stringify(focused?'.eye-head':'.sq.user')});if(surface){surface.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:65,clientY:95}));return resolve(true)}if(Date.now()>deadline)return reject(Error('fixture did not mount'));setTimeout(ready,20)};ready()})`)
   await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light});new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const ready=()=>{const parent=[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.trim().replace(' ▸','')==='Open');if(parent){parent.focus();parent.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));return resolve(true)}if(Date.now()>deadline)return reject(Error('Open branch missing'));setTimeout(ready,20)};ready()})`)
   await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
   const state=await win.webContents.executeJavaScript(`(()=>{const root=document.querySelector('.ctxmenu:not(.ctxmenu-submenu)'),sub=document.querySelector('.ctxmenu-submenu[aria-label="Open"]');if(!root||!sub)throw Error('actual Open submenu missing');const labels=[...sub.querySelectorAll(':scope > .ctxmenu-branch > [role="menuitem"]')].map(b=>b.textContent.trim().replace(' ▸',''));const boxes=[root,sub].map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,visible:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}});return {labels,boxes}})()`)
   assert.deepEqual(state.labels,['Inbox','Global docket','Presentations','Shared scratch folder']);assert.ok(state.boxes.every(box=>box.visible))
   fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG())
   await win.webContents.executeJavaScript(`(()=>{const folder=[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.trim().replace(' ▸','')==='Shared scratch folder');if(!folder)throw Error('folder missing');folder.focus();folder.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))})()`)
   await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
   const nested=await win.webContents.executeJavaScript(`(()=>{const sub=document.querySelector('.ctxmenu-submenu[aria-label="Shared scratch folder"]');if(!sub)throw Error('nested folder missing');const r=sub.getBoundingClientRect();return {labels:[...sub.querySelectorAll('[role="menuitem"]')].map(b=>b.textContent.trim()),visible:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}})()`)
   assert.deepEqual(nested.labels,['Edit AGENTS.md']);assert.equal(nested.visible,true)
   fs.writeFileSync(path.join(out,name+'-nested.png'),(await win.webContents.capturePage()).toPNG())
   receipts.push({name,focused,light,width,state,nested})
  }finally{win.destroy()}
 }
 fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify({passed:true,receipts},null,2));console.log(JSON.stringify({passed:true,captures:receipts.length*2}))
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
