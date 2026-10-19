const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_PROJECT_META_CAPTURE_ROOT,red=process.env.ORGTREE_PROJECT_MAIL_RED==='1'
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=win=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,220))))')
app.whenReady().then(async()=>{
 const cases=[]
 for(const scenario of ['active','flight','queued','long']){
  const win=new BrowserWindow({width:1000,height:650,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}})
  try{
   win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
   await win.loadFile(path.join(out,'index.html'),{query:{scenario}})
   await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+5000;const ready=()=>{if(document.querySelector('#fixture-desk .project-queue-card'))return resolve();if(Date.now()>until)return reject(Error('project fixture not mounted'));setTimeout(ready,20)};ready()})`)
   for(const light of [false,true]){
    const name=scenario+'-'+(light?'light':'dark');await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light})`);await wait(win)
    const state=await win.webContents.executeJavaScript(`(()=>{const cards=[...document.querySelectorAll('.fixture-card .sq')].map(card=>{const q=card.querySelector('.project-queue-badge'),r=q.getBoundingClientRect(),c=card.getBoundingClientRect(),s=getComputedStyle(q);return{text:q.textContent,bright:q.classList.contains('bright'),background:s.backgroundColor,color:s.color,contained:r.left>=c.left&&r.right<=c.right+0.5,textFits:q.scrollWidth<=q.clientWidth+1,queueBottom:r.bottom,cardBottom:c.bottom}});const q=document.querySelector('#fixture-desk .project-queue-card'),s=getComputedStyle(q);return{cards,desk:{text:q.textContent,bright:q.classList.contains('bright'),background:s.backgroundColor,color:s.color}}})()`)
    try{
     const expected=scenario==='queued'?'3 q\'d':scenario==='flight'?'1 in flight':scenario==='long'?"128 listeners · 999999 q'd · 128 in flight":"2 listeners · 3 q'd · 1 in flight"
     for(const q of [...state.cards,state.desk]){assert.equal(q.text,expected);assert.equal(q.bright,scenario!=='queued');assert.equal(q.background==='rgba(0, 0, 0, 0)',scenario==='queued')}
     assert.ok(state.cards.every(q=>q.contained&&q.textFits&&q.queueBottom<=q.cardBottom),'all mail text stays within the near card horizontally and vertically')
     assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.fixture-card .project-slots-badge,.fixture-card .project-listeners-badge')).every(el=>{const r=el.getBoundingClientRect(),c=el.closest('.sq').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right&&r.bottom<=c.bottom})`),true,'slot and event status remain inside the card with long counts')
     cases.push({name,passed:true,state})
    }catch(error){cases.push({name,passed:false,state,error:error.message})}
    if(scenario!=='flight')fs.writeFileSync(path.join(out,'project-mail-'+name+'.png'),(await win.webContents.capturePage()).toPNG())
   }
  }finally{win.destroy()}
 }
 const failed=cases.filter(c=>!c.passed),receipt={cases,tests:cases.length,passed:cases.length-failed.length,failed:failed.length,expectedRed:red}
 fs.writeFileSync(path.join(out,'mail-state.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));assert.equal(cases.length,8);assert.equal(failed.length,red?6:0)
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
