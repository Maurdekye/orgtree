// Production roster surfaces, before/after. No engine, real clipboard or OS input.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2])
if(!out.toLowerCase().startsWith('c:\\orgtree-build\\mention-reply-sol\\'))throw Error('Output outside assigned root')
const sessionId=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
assert.equal(sessionId,0,'Session 0 required before any window')
app.setPath('userData',path.join(out,'profile-'+process.pid));app.setPath('sessionData',path.join(out,'session-'+process.pid))
app.disableHardwareAcceleration();app.commandLine.appendSwitch('mute-audio')
const clipboardCalls=[]
for(const key of Object.keys(clipboard))if(typeof clipboard[key]==='function')Object.defineProperty(clipboard,key,{value:()=>{clipboardCalls.push(key);return key==='availableFormats'?[]:key==='has'?false:''}})
fs.writeFileSync(path.join(out,'clipboard.preload.cjs'),`Object.defineProperty(navigator,'clipboard',{value:Object.freeze({read:()=>Promise.reject(Error('Clipboard denied')),readText:()=>Promise.reject(Error('Clipboard denied')),write:()=>Promise.reject(Error('Clipboard denied')),writeText:()=>Promise.reject(Error('Clipboard denied'))})});window.__clipboardBlocked=true;`)
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('net-contact-lists-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1000,height:760,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
  const measured=[]
  try{
    for(const phase of ['base','tip']){
      fs.writeFileSync(path.join(out,phase,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      win.setSize(1000,760)
      await within(win.loadFile(path.join(out,phase,'index.html')),15000,'Fixture load timeout')
      await evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function ready(){if(document.querySelector('.adv-tab'))return resolve();if(Date.now()>end)return reject(Error('Contact fixture not mounted'));setTimeout(ready,20)}ready()})`)
      await evalJs(`[...document.querySelectorAll('.adv-tab')].find(b=>b.textContent==='mailservers').click()`)
      await paint()
      for(const surface of ['mailservers','connections']){
        if(surface==='connections'){
          await evalJs(`window.contactFixture.show('connections')`);await paint()
          await evalJs(`document.querySelector('.connection-row').closest('.set-group').scrollIntoView({block:'start'})`);await paint()
        }
        const info=await evalJs(`(()=>{const scope=document.querySelector('${surface==='mailservers'?'.oi-net':'.connection-peers'}'),r=scope.getBoundingClientRect();return{width:r.width,height:r.height,contacts:[...scope.querySelectorAll('.ref-hub')].map(b=>({address:b.dataset.hubAddress,kind:b.dataset.netKind,icon:b.dataset.netIcon,title:b.title,name:b.querySelector('.net-name')?.dataset.netName,live:b.classList.contains('live')})),body:scope.textContent,clipboard:window.__clipboardBlocked}})()`)
        assert(info.width>0&&info.height>0);assert.equal(info.clipboard,true)
        if(phase==='base'){assert.equal(info.contacts.length,0);assert.match(info.body,/\(person\)/)}
        else{
          assert.equal(info.contacts.length,surface==='mailservers'?5:4)
          assert.deepEqual([...new Set(info.contacts.map(b=>b.kind))].sort(),['chat','org','person'])
          assert(info.contacts.some(b=>b.name==='Penelope'));assert(info.contacts.every(b=>b.live))
          assert.doesNotMatch(info.body,/\(chat\)|\(person\)/)
          if(surface==='mailservers')assert.equal(await evalJs(`document.querySelectorAll('.oi-peer > .oi-dot.ok').length`),2)
          else assert.match(info.body,/Offline.*Independent agent session/)
        }
        fs.writeFileSync(path.join(out,`${phase}-${surface}.png`),(await wc.capturePage()).toPNG());measured.push({phase,surface,...info})
      }
      // The specified narrow settings window, with the same production list.
      win.setSize(480,760);await paint()
      await evalJs(`document.querySelector('.connection-row').closest('.set-group').scrollIntoView({block:'start'})`);await paint()
      const narrow=await evalJs(`(()=>{const p=document.querySelector('.settings'),r=p.getBoundingClientRect(),ul=document.querySelector('.connection-peers'),u=ul.getBoundingClientRect();return{viewport:innerWidth,panel:{x:r.x,right:r.right,width:r.width,client:p.clientWidth,scroll:p.scrollWidth},list:{x:u.x,right:u.right,width:u.width,client:ul.clientWidth,scroll:ul.scrollWidth},chips:[...document.querySelectorAll('.connection-peers .ref-hub')].map(b=>{const q=b.getBoundingClientRect();return{x:q.x,right:q.right,width:q.width,height:q.height}})}})()`)
      assert.equal(narrow.viewport,480);assert(narrow.panel.width>0&&narrow.panel.right<=480.5)
      fs.writeFileSync(path.join(out,`${phase}-connections-480.png`),(await wc.capturePage()).toPNG());measured.push({phase,surface:'connections-480',...narrow})
      if(phase==='tip'){
        const baseline=measured.find(r=>r.phase==='base'&&r.surface==='connections-480')
        // The unchanged settings form already overflows outside the roster.
        // Keep that baseline visible; require the actual contact list to fit.
        assert(narrow.panel.scroll-narrow.panel.client<=baseline.panel.scroll-baseline.panel.client+1)
        assert(narrow.list.scroll<=narrow.list.client+1);assert(narrow.chips.every(b=>b.width>0&&b.right<=narrow.list.right+.5))
      }
      if(phase==='tip'){
        wc.debugger.attach('1.3')
        const point=await evalJs(`(()=>{const b=document.querySelector('.connection-peers .ref-hub'),r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        const press=async(button='left')=>{await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button,clickCount:1,...point});await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button,clickCount:1,...point});await paint()}
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await paint()
        assert.match(await evalJs(`getComputedStyle(document.querySelector('.connection-peers .ref-hub')).textDecorationLine`),/underline/)
        await press();assert.equal(await evalJs('window.contactFixture.opened.length'),1)
        const space={key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32}
        const sendSpace=async()=>{await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',text:' ',unmodifiedText:' ',...space});await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...space});await paint()}
        // A native button is the positive control for CDP's full Space sequence.
        await evalJs(`(()=>{window.spaceControl=0;const b=document.createElement('button');b.id='space-control';b.textContent='Keyboard control';b.onclick=()=>window.spaceControl++;document.body.append(b);b.focus()})()`)
        await sendSpace();assert.equal(await evalJs('window.spaceControl'),1,'native Space input control')
        await evalJs(`document.querySelector('#space-control').remove()`)
        for(const key of ['Enter',' ']){
          await evalJs(`document.querySelector('.connection-peers .ref-hub').focus()`)
          if(key===' ')await sendSpace()
          else{const p={key,code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13};await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...p});await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...p});await paint()}
        }
        assert.equal(await evalJs('window.contactFixture.opened.length'),3)
        await press('right')
        const menu=await evalJs(`(()=>{const m=document.querySelector('[role="menu"]'),r=m.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,labels:[...m.querySelectorAll('[role="menuitem"]')].map(n=>n.textContent)}})()`)
        assert.deepEqual(menu.labels,['Open in Hubchat','Copy identity']);assert(menu.width>0&&menu.height>0&&menu.x>=0&&menu.right<=480.5&&menu.y>=0&&menu.bottom<=760.5)
        fs.writeFileSync(path.join(out,'tip-connections-menu.png'),(await wc.capturePage()).toPNG());measured.push({surface:'menu',...menu})
        await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await paint()
        await evalJs(`window.contactFixture.installed(false)`);await paint();await press()
        assert.equal(await evalJs('window.contactFixture.opened.length'),3)
        assert.equal(await evalJs(`document.querySelectorAll('.connection-peers .ref-hub.inert').length`),5)
      }
    }
    assert.deepEqual(clipboardCalls,[])
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardInitiallyEmpty:true,clipboardCalls,base:JSON.parse(fs.readFileSync(path.join(out,'base/source.json'))),tip:JSON.parse(fs.readFileSync(path.join(out,'tip/source.json'))),measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));app.exit(0)
  }catch(error){console.error(error);fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
