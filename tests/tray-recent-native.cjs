const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_TRAY_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
const {trayListHtml,sortTrayRows,popupBounds,trayNavigationSlug}=require(path.join(out,'traylist.cjs'))
const {OrgPlacement}=require(path.join(out,'org-placement.cjs'))
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=win=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
const measure=win=>win.webContents.executeJavaScript(`(()=>{const list=document.querySelector('.list'),box=list.getBoundingClientRect(),rows=[...list.querySelectorAll('.row')];return {count:rows.length,top:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,scrollbar:list.offsetWidth>list.clientWidth,focused:document.activeElement===list,visible:rows.filter(row=>{const r=row.getBoundingClientRect();return r.bottom>box.top+0.5&&r.top<box.bottom-0.5}).length,whole:rows.filter(row=>{const r=row.getBoundingClientRect();return r.top>=box.top-0.5&&r.bottom<=box.bottom+0.5}).length,slugs:rows.map(row=>row.getAttribute('href').split('/').at(-1)),rowHeights:rows.map(row=>row.getBoundingClientRect().height)}})()`)
app.whenReady().then(async()=>{
 const rows=Array.from({length:18},(_,i)=>({slug:'org-'+String(i+1).padStart(2,'0'),name:'Synthetic org '+String(i+1).padStart(2,'0'),working:i%3,live:20+i,attention:i===5?3:0}))
 const file=path.join(out,'window-state.json'),store=new OrgPlacement(file)
 for(const org of ['org-04','org-11','org-17'])store.recordOrgOpen(org)
 const recent=new OrgPlacement(file).recentOrgs(),sorted=sortTrayRows(rows,recent)
 assert.deepEqual(sorted.slice(0,3).map(row=>row.slug),['org-17','org-11','org-04'])
 const html=trayListHtml(sorted,'orgtree'),url='data:text/html;charset=utf-8,'+encodeURIComponent(html)
 const area={x:0,y:0,width:1000,height:650},anchor={x:900,y:650,width:24,height:24},bounds=popupBounds(anchor,area,rows.length)
 assert.equal(bounds.height,292)
 const create=()=>new BrowserWindow({...bounds,frame:false,show:false,useContentSize:true,skipTaskbar:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false}})
 let win=create();const receipt={bounds,recent,scriptless:!/<script/i.test(html)}
 try{
  await win.loadURL(url);await wait(win)
  receipt.initial=await measure(win);assert.equal(receipt.initial.count,18);assert.equal(receipt.initial.top,0);assert.equal(receipt.initial.whole,10);assert.equal(receipt.initial.visible,10);assert.equal(receipt.initial.scrollbar,true)
  assert.ok(receipt.initial.rowHeights.every(height=>height===28))
  fs.writeFileSync(path.join(out,'tray-recent-top.png'),(await win.webContents.capturePage()).toPNG())
  win.webContents.focus();await win.webContents.executeJavaScript('document.querySelector(".list").focus()')
  // Electron wheel deltas follow the wheel direction: negative moves down.
  win.webContents.sendInputEvent({type:'mouseWheel',x:90,y:100,deltaX:0,deltaY:-168,canScroll:true})
  await wait(win);receipt.wheel=await measure(win);assert.ok(receipt.wheel.top>0,'real wheel scroll reaches later orgs')
  await win.webContents.executeJavaScript('document.querySelector(".list").scrollTop=0;document.querySelector(".list").focus()');await wait(win)
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'PageDown'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'PageDown'})
  await wait(win);receipt.keyboard=await measure(win);assert.ok(receipt.keyboard.top>0,'real keyboard scroll reaches later orgs')
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'})
  await wait(win);receipt.end=await measure(win);assert.equal(receipt.end.top,receipt.end.scrollHeight-receipt.end.clientHeight)
  fs.writeFileSync(path.join(out,'tray-recent-bottom.png'),(await win.webContents.capturePage()).toPNG())
  const selected=[]
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,target)=>{event.preventDefault();const slug=trayNavigationSlug(target);if(slug)selected.push(slug)})
  await win.webContents.executeJavaScript('document.querySelector(".row:last-child").click()');await wait(win)
  assert.deepEqual(selected,[sorted.at(-1).slug]);assert.ok(win.webContents.getURL().startsWith('data:'))
  receipt.selected=selected
  win.destroy();win=create();await win.loadURL(url);await wait(win);receipt.reopened=await measure(win);assert.equal(receipt.reopened.top,0)
  const smallArea={x:-180,y:0,width:180,height:180},small=popupBounds({x:-30,y:180,width:24,height:24},smallArea,18)
  assert.ok(small.width<=smallArea.width&&small.height<=smallArea.height&&small.x>=smallArea.x&&small.x+small.width<=0)
  win.setContentSize(small.width,small.height);await win.loadURL(url);await wait(win);receipt.small=await measure(win);assert.ok(receipt.small.visible<=10)
  fs.writeFileSync(path.join(out,'tray-recent-short-area.png'),(await win.webContents.capturePage()).toPNG())
  fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify({passed:true,...receipt},null,2));console.log(JSON.stringify({passed:true,total:18,visible:receipt.initial.visible,wheelTop:receipt.wheel.top,keyboardTop:receipt.keyboard.top,reopenedTop:receipt.reopened.top}))
 }finally{if(!win.isDestroyed())win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
