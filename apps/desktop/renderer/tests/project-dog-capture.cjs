const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_PROJECT_DOG_CAPTURE_ROOT,red=process.env.ORGTREE_PROJECT_DOG_RED==='1'
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=win=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,220))))')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}}),cases=[]
 const check=(name,fn,state)=>{try{fn();cases.push({name,passed:true,state})}catch(e){cases.push({name,passed:false,error:e.message,state})}}
 try{
  win.webContents.on('console-message',(_event,_level,message)=>console.log('[fixture]',message))
  win.webContents.on('preload-error',(_event,_path,error)=>console.error(error))
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(path.join(out,'index.html'))
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+8000;const ready=()=>{if(document.querySelectorAll('.outline-sample').length===10)return resolve();if(Date.now()>until)return reject(Error('fixture not ready'));setTimeout(ready,20)};ready()})`)
  for(const light of [false,true]){
   const theme=light?'light':'dark';await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light})`);await wait(win)
   const styles=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.outline-sample')).map(row=>{const el=row.querySelector('.wd-chip'),s=getComputedStyle(el),d=getComputedStyle(row.querySelector('.desk-dog-chip')),kind=row.dataset.kind,once=row.dataset.once==='true',token=kind==='slot'?'--slot':kind==='fair_queue'?'--fq-line':kind==='command'?'--line':'--listener',probe=document.createElement('span');probe.style.borderColor='var('+token+')';row.appendChild(probe);const expected=getComputedStyle(probe).borderColor;probe.remove();return{kind,once,border:s.borderColor,style:s.borderStyle,width:s.borderTopWidth,shadow:s.boxShadow,desk:{border:d.borderColor,style:d.borderStyle,width:d.borderTopWidth,shadow:d.boxShadow},expected}})`)
   for(const s of styles)check(theme+'-'+s.kind+'-'+s.once,()=>{
    assert.equal(s.border,s.expected);assert.equal(s.style,s.once?'dashed':s.kind==='listener_watch'?'double':'solid')
    if(s.kind==='listener_watch')for(const b of [s,s.desk]){assert.equal(b.border,s.expected);assert.equal(b.style,s.once?'dashed':'double');assert.equal(b.width,s.once?'1px':'3px');if(s.once){assert.match(b.shadow,/inset/);assert.ok(b.shadow.includes(s.expected),'solid cyan inner line accompanies dashed outer line')}}
   },s)
   await win.webContents.executeJavaScript(`document.querySelector('#slot-chips .slot-hold').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:570,clientY:145}))`);await wait(win)
   const row=await win.webContents.executeJavaScript(`(()=>{const row=Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent==='Project… ▸');if(!row)return false;row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true})()`);await wait(win)
   const labels=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ctxmenu-submenu [role=menuitem]')).map(e=>e.textContent)`)
   check(theme+'-slot-project-menu',()=>{assert.equal(row,true);assert.ok(labels.includes('Copy mention'));assert.ok(labels.includes('Focus'));assert.ok(labels.includes('Open ▸'))},labels)
   fs.writeFileSync(path.join(out,'project-dogs-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
   await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('#slot-chips .slot-hold').click()`);await wait(win)
  }
  const opened=await win.webContents.executeJavaScript('window.fixtureOpened')
  check('left-click-slots',()=>assert.deepEqual(opened,['project-slots:synthetic-build','project-slots:synthetic-build']),opened)
  console.log('[capture] loading semantic table scene')
  await win.loadFile(path.join(out,'index.html'),{query:{scene:'slots'}})
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+8000;const ready=()=>{if(document.querySelector('#slot-menu-fixture .slots-line .slot-row'))return resolve();if(Date.now()>until)return reject(Error('table fixture not ready'));setTimeout(ready,20)};ready()})`)
  for(const light of [false,true]){
   const theme=light?'light':'dark';console.log('[capture] semantic table '+theme);await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light});document.querySelector('#slot-menu-fixture .slots-line .slot-rest').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:570,clientY:330}))`);await wait(win)
   const state=await win.webContents.executeJavaScript(`(()=>{const row=document.querySelector('#slot-menu-fixture .slots-line .slot-row'),p=Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent==='Project… ▸');if(p){p.focus();p.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))}return{tag:row.tagName,cells:row.children.length,position:row.firstElementChild.textContent,time:row.querySelector('.slot-time')?.getAttribute('style'),headers:Array.from(document.querySelectorAll('#slot-menu-fixture thead th')).map(e=>e.textContent),project:!!p}})()`);await wait(win)
   check(theme+'-semantic-slot-row',()=>{assert.equal(state.tag,'TR');assert.equal(state.cells,7);assert.equal(state.position,'1st');assert.ok(state.time);assert.equal(state.project,true);assert.deepEqual(state.headers,['Position','Agent','Waited','Held','Ended','Claim / lease','Action'])},state)
   fs.writeFileSync(path.join(out,'project-dog-table-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
   await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await wait(win)
  }
 }finally{win.destroy()}
 const failed=cases.filter(c=>!c.passed),receipt={tests:cases.length,passed:cases.length-failed.length,failed:failed.length,cases,expectedRed:red};fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));assert.equal(cases.length,25);assert.equal(failed.length,red?4:0)
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
