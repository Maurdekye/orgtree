const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_PROJECT_META_CAPTURE_ROOT,red=process.env.ORGTREE_PROJECT_META_RED==='1'
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=win=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,220))))')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:650,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}}),cases=[]
 const check=(name,fn,state)=>{try{fn();cases.push({name,passed:true,state})}catch(error){cases.push({name,passed:false,state,error:error.message})}}
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(path.join(out,'index.html'))
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+5000;const ready=()=>{if(document.querySelectorAll('.fixture-card .project-meta').length===3&&document.querySelector('#fixture-desk .project-queue-card'))return resolve();if(Date.now()>until)return reject(Error('project fixture not mounted'));setTimeout(ready,20)};ready()})`)
  for(const light of [false,true]){
   const theme=light?'light':'dark';await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light})`);await wait(win)
   const state=await win.webContents.executeJavaScript(`(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};const cards=[...document.querySelectorAll('.fixture-card')].map(host=>{const meta=host.querySelector('.project-meta'),a=meta.querySelector('.project-activity'),s=meta.querySelector('.project-last-activity'),word=s.querySelector('.sq-idle'),clock=s.querySelector('.sq-idle-time'),count=a.querySelector('.project-counts'),css=getComputedStyle(a);return{scale:Number(host.dataset.scale),meta:rect(meta),activity:rect(a),status:rect(s),word:rect(word),clock:rect(clock),count:count.textContent,statusText:s.textContent,wordClipped:word.scrollWidth>word.clientWidth+1,overflow:meta.scrollWidth>meta.clientWidth+1,plain:!a.classList.contains('chip')&&css.backgroundColor==='rgba(0, 0, 0, 0)'&&css.borderTopWidth==='0px',bold:getComputedStyle(count).fontWeight,slots:host.querySelector('.project-slots-badge')?.textContent,mail:host.querySelector('.project-queue-badge')?.textContent,event:host.querySelector('.project-listeners-badge')?.textContent}});const desk=document.querySelector('#fixture-desk');return{cards,desk:{slots:desk.querySelector('.project-slots-card')?.textContent,mail:desk.querySelector('.project-queue-card')?.textContent,event:desk.querySelector('.project-listeners-card')?.textContent}}})()`)
   for(const card of state.cards)check(theme+'-same-line-'+card.scale,()=>{
    assert.equal(card.count,'4/24');assert.match(card.statusText,/Active17m/);assert.ok(Math.abs(card.activity.y+card.activity.height/2-card.status.y-card.status.height/2)<3*card.scale,'activity and Active share one visual line')
    assert.equal(card.wordClipped,false,'Active is fully visible at normal card width');assert.equal(card.overflow,false);assert.ok(card.clock.right<=card.meta.right+1);assert.equal(card.plain,true);assert.equal(card.bold,'700')
   },card)
   check(theme+'-all-status-groups',()=>{
    for(const c of state.cards){assert.equal(c.slots,'3/3 held · 2 waiting');assert.equal(c.mail,"2 listeners · 3 q'd · 1 in flight");assert.equal(c.event,'listeners 2/3')}
    assert.equal(state.desk.slots,'slots 3/3 · 2 waiting');assert.equal(state.desk.mail,"2 listeners · 3 q'd · 1 in flight");assert.equal(state.desk.event,'listeners 2/3')
   },state.desk)
   fs.writeFileSync(path.join(out,'project-status-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
  }
 }finally{win.destroy()}
 const failures=cases.filter(c=>!c.passed),receipt={tests:cases.length,passed:cases.length-failures.length,failed:failures.length,cases,expectedRed:red}
 fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));assert.equal(cases.length,8);assert.equal(failures.length,red?6:0)
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
