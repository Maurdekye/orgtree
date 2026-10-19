const {app,BrowserWindow,nativeTheme}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_TRAY_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
const {trayListHtml,popupBounds}=require(path.join(out,'traylist.cjs'))
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=w=>w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))')
const measure=w=>w.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.list'),box=el.getBoundingClientRect(),rows=Array.from(el.querySelectorAll('.row')),style=getComputedStyle(el);return{count:rows.length,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,gutter:el.offsetWidth-el.clientWidth,policy:style.scrollbarGutter,top:el.scrollTop,left:box.left,right:innerWidth-box.right,counts:rows.map(r=>{const n=r.querySelector('.ct').getBoundingClientRect();return{left:n.left,right:n.right}}),whole:rows.filter(r=>{const b=r.getBoundingClientRect();return b.top>=box.top-0.5&&b.bottom<=box.bottom+0.5}).length,palette:getComputedStyle(document.body).backgroundColor}})()`)
const names=['Atlas Workshop','Orchard','Nebula Lab','Sandbox']
const rows=n=>Array.from({length:n},(_,i)=>({slug:'org-'+i,name:n===4?names[i]:'Synthetic org '+String(i+1).padStart(2,'0'),working:i%3?0:i+2,live:i===2?0:i+12,attention:0}))
app.whenReady().then(async()=>{
 const cases=[]
 const check=(name,fn,state)=>{try{fn();cases.push({name,passed:true,state})}catch(e){cases.push({name,passed:false,error:e.message,state})}}
 for(const mode of ['dark','light']){
  nativeTheme.themeSource=mode
  for(const count of [4,10,11]){
   const data=rows(count),bounds=popupBounds({x:900,y:650,width:24,height:24},{x:0,y:0,width:1000,height:650},count)
   const win=new BrowserWindow({...bounds,frame:false,show:false,useContentSize:true,skipTaskbar:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false}})
   try{
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault())
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(trayListHtml(data,mode==='dark'?'claude':'orgtree')));await wait(win)
    const state=await measure(win)
    check(mode+'-'+count+'-geometry',()=>{
     assert.equal(state.count,count);assert.equal(state.top,0);assert.equal(state.whole,Math.min(count,10));assert.equal(state.left,state.right)
     assert.ok(state.counts.every(n=>Math.abs(n.left-state.counts[0].left)<0.01&&Math.abs(n.right-state.counts[0].right)<0.01))
     if(count<=10){assert.equal(state.policy,'auto');assert.equal(state.gutter,0);assert.equal(state.scrollHeight,state.clientHeight);assert.equal(bounds.width-state.counts[0].right,state.left)}
     else{assert.equal(state.policy,'stable');assert.ok(state.gutter>0);assert.ok(state.scrollHeight>state.clientHeight)}
    },{nativeTheme:mode,bounds,...state})
    fs.writeFileSync(path.join(out,`tray-gutter-${count}-${mode}.png`),(await win.webContents.capturePage()).toPNG())
    if(count>10){
     win.webContents.focus();win.webContents.sendInputEvent({type:'mouseWheel',x:90,y:100,deltaX:0,deltaY:-112,canScroll:true});await wait(win)
     const scrolled=await measure(win);check(mode+'-11-wheel',()=>assert.ok(scrolled.top>0),scrolled)
    }
   }finally{win.destroy()}
  }
 }
 const receipt={tests:cases.length,passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases,paletteNote:'Production tray document has a fixed dark palette. Both native dark/light settings and Claude/Orgtree accents are exercised.'}
 fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));assert.equal(receipt.tests,8);assert.equal(receipt.failed,0)
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
