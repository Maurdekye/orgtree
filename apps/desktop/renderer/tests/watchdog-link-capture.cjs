const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_PROJECT_DOG_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=w=>w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}}),cases=[]
 const check=(name,fn,state)=>{try{fn();cases.push({name,passed:true,state})}catch(e){cases.push({name,passed:false,error:e.message,state})}}
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(path.join(out,'index.html'));await wait(win)
  for(const light of [false,true]){
   const theme=light?'light':'dark';await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light})`);await wait(win)
   const states=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.link-sample')).map(row=>{const els=[row.querySelector('.wd-chip'),row.querySelector('.desk-sample .watchdog-link'),row.querySelector('.tool-sample .watchdog-link')];return{kind:row.dataset.kind,once:row.dataset.once==='true',styles:els.map(el=>{const s=getComputedStyle(el);return{border:s.borderColor,style:s.borderStyle,width:s.borderTopWidth,shadow:s.boxShadow,glyph:el.querySelector('.wd-glyph').textContent,org:el.dataset.objectOrg,id:el.dataset.objectId,once:!!el.querySelector('.wd-once')}})}})`)
   assert.equal(states.length,14)
   for(const s of states)check(theme+'-'+s.kind+'-'+s.once,()=>{
    const [card,...links]=s.styles
    for(const link of links){assert.equal(link.border,card.border);assert.equal(link.style,card.style);assert.equal(link.width,card.width);assert.equal(link.glyph,card.glyph);assert.equal(link.org,'fixture');assert.equal(link.once,s.once);if(s.kind==='listener_watch'&&s.once)assert.match(link.shadow,/inset/)}
    assert.equal(card.style,s.once?'dashed':s.kind==='listener_watch'?'double':'solid')
   },s)
   const mail=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#mail-listener-sample .watchdog-link')).map(el=>({kind:el.classList.contains('fair-queue'),once:el.classList.contains('oneshot'),style:getComputedStyle(el).borderStyle}))`)
   check(theme+'-mail-listener-links',()=>{assert.equal(mail.length,2);assert.ok(mail.every(m=>m.kind));assert.deepEqual(mail.map(m=>m.style),['solid','dashed'])},mail)
   const unknown=await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('#unknown-link .watchdog-link');return{tag:el.tagName,cls:el.className,disabled:el.getAttribute('aria-disabled'),title:el.title}})()`)
   check(theme+'-unknown-neutral',()=>{assert.equal(unknown.tag,'SPAN');assert.equal(unknown.disabled,'true');assert.doesNotMatch(unknown.cls,/listener-watch|fair-queue|oneshot/);assert.match(unknown.title,/kind and mode unknown/)},unknown)
   const bounds=await win.webContents.executeJavaScript(`({bottom:document.querySelector('main').getBoundingClientRect().bottom,height:innerHeight,width:document.documentElement.scrollWidth,viewport:innerWidth})`)
   check(theme+'-fixture-fits',()=>{assert.ok(bounds.bottom<=bounds.height);assert.ok(bounds.width<=bounds.viewport)},bounds)
   fs.writeFileSync(path.join(out,'watchdog-links-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
  }
  const action=await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.tool-sample .watchdog-link');el.click();return{expected:el.dataset.objectId,opened:window.fixtureOpened}})()`)
  check('tool-link-opens-real-dog',()=>assert.deepEqual(action.opened,[action.expected]),action)
 }finally{win.destroy()}
 const receipt={tests:cases.length,passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases};fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));assert.equal(receipt.tests,35);assert.equal(receipt.failed,0)
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
