const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_FOLDER_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=win=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
const find=name=>`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim().replace(' ▸','')===${JSON.stringify(name)})`
app.whenReady().then(async()=>{
 const receipts=[]
 for(const mode of ['agent','project','switchboard']){
  const win=new BrowserWindow({width:1000,height:650,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}})
  try{
   win.webContents.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!/^(file:|data:)/.test(details.url)}))
   await win.loadFile(path.join(out,'index.html'),{query:{mode}});await wait(win)
   const target=mode==='switchboard'?'.eye-head':'#menu-target'
   await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(target)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:45,clientY:80}))`);await wait(win)
   const key=async name=>{await win.webContents.executeJavaScript(`${find(name)}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);await wait(win)}
   await key('Open');const folder=mode==='agent'?'Scratch folder':mode==='project'?'Team scratch folder':'Shared scratch folder';await key(folder)
   if(mode==='agent')await key('Team scratch folder')
   const state=await win.webContents.executeJavaScript(`(()=>{const branches=[...document.querySelectorAll('.ctxmenu-submenu')].filter(b=>b.getAttribute('aria-label')!=='Open').map(b=>({name:b.getAttribute('aria-label'),labels:[...b.querySelectorAll(':scope > .ctxmenu-branch > [role=menuitem]')].map(x=>x.textContent.trim().replace(' ▸',''))}));return {branches,openFolderCount:[...document.querySelectorAll('[role=menuitem]')].filter(x=>x.textContent.trim()==='Open folder').length}})()`)
   assert.equal(state.openFolderCount,0)
   assert.deepEqual(state.branches,mode==='agent'?[{name:'Scratch folder',labels:['Edit AGENTS.md','Team scratch folder']},{name:'Team scratch folder',labels:['Edit AGENTS.md']}]:[{name:folder,labels:['Edit AGENTS.md']}])
   fs.writeFileSync(path.join(out,mode+'.png'),(await win.webContents.capturePage()).toPNG());receipts.push({mode,...state})
  }finally{win.destroy()}
 }
 fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify({passed:true,receipts},null,2));console.log(JSON.stringify({passed:true,captures:3}))
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
