const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_PALETTE_CAPTURE_ROOT,red=process.env.ORGTREE_PALETTE_RED==='1'
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=win=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
const ready=(win,selector)=>win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const tick=()=>{if(document.querySelector(${JSON.stringify(selector)}))return resolve(true);if(Date.now()>deadline)return reject(Error('Missing fixture: '+${JSON.stringify(selector)}));setTimeout(tick,20)};tick()})`)
const inspect=win=>win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[role="dialog"]'),s=getComputedStyle(el),r=el.getBoundingClientRect();return {background:s.backgroundColor,image:s.backgroundImage,shadow:s.boxShadow,borders:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],tokens:el.querySelectorAll('.hsof button').length,options:!!el.querySelector('.desk-model-options'),visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}})()`)
app.whenReady().then(async()=>{
 const cases=[]
 function check(name,state,transparent){
  try{assert.equal(state.visible,true);if(transparent){assert.equal(state.background,'rgba(0, 0, 0, 0)');assert.equal(state.image,'none');assert.equal(state.shadow,'none');assert.deepEqual(state.borders,['0px','0px','0px','0px']);assert.ok(state.tokens>0)}else{assert.notEqual(state.background,'rgba(0, 0, 0, 0)');assert.notEqual(state.shadow,'none')}
   cases.push({name,passed:true,state})
  }catch(error){cases.push({name,passed:false,state,error:error.message})}
 }
 for(const light of [false,true])for(const mode of ['desk','quick','card','options']){
  const win=new BrowserWindow({width:800,height:600,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}})
  const label=mode+'-'+(light?'light':'dark')
  try{
   win.webContents.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!/^(file:|data:)/.test(details.url)}))
   await win.loadFile(path.join(out,'index.html'),{query:{mode,light:String(light)}})
   const trigger=mode==='desk'?'.desk-model-button':'#palette-anchor'
   await ready(win,trigger);await wait(win)
   await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(trigger)}).click()`)
   await ready(win,mode==='options'?'[role="dialog"]':'.quickchat-pop-model .t-sol');await wait(win)
   const state=await inspect(win);check(label,state,mode!=='options')
   if(mode==='desk'||mode==='quick')fs.writeFileSync(path.join(out,label+'.png'),(await win.webContents.capturePage()).toPNG())
   if(mode==='desk'){
    await win.webContents.executeJavaScript('document.querySelector(".quickchat-pop-model .t-sol").click()')
    await ready(win,'.desk-model-options');await wait(win)
    const options=await inspect(win);assert.equal(options.options,true);check(label+'-selected',options,true)
    fs.writeFileSync(path.join(out,label+'-selected.png'),(await win.webContents.capturePage()).toPNG())
   }
   if(mode==='card'){
    await win.webContents.executeJavaScript('document.querySelector(".hsof .t-astra").click()');await wait(win)
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#picked").textContent'),'astra')
   }
   await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await wait(win)
   assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("[role=dialog]")'),false)
  }finally{win.destroy()}
 }
 const failed=cases.filter(c=>!c.passed),receipt={cases,tests:cases.length,passed:cases.length-failed.length,failed:failed.length,expectedRed:red}
 fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))
 assert.equal(cases.length,10);assert.equal(failed.length,red?4:0)
 if(red)assert.deepEqual(failed.map(c=>c.name),['desk-dark','desk-dark-selected','desk-light','desk-light-selected'])
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
