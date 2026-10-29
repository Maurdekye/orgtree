// Org settings › Connections, the org inbox's sent folder, Presentations and an
// agent's docket, before (base) and after (tip) the UX symmetry fixes #2, #5,
// #6, #7 and #23 (USER 2026-10-29 m019c9500d23a), dark and light, over
// symmetry.visual.tsx's synthetic data. No engine, no real clipboard, no OS
// input: Session 0 only, muted, offscreen; clipboard permissions denied and
// every clipboard path stubbed; input is CDP to this window alone.
//   electron symmetry.capture.cjs <out>
// <out> is below C:\orgtree-build\<ORGTREE_AGENT>\ and holds base\ and tip\,
// each with probe.js and probe.css from the visual bundle. A fixture that never
// starts leaves capture-error.json with the page's own errors (uncaught errors,
// failed loads, console errors and warnings) and each bundle's source.json
// receipt. Native tooltips are drawn by Windows and an offscreen capture cannot
// hold them: a hover shot draws the hovered element's own title in an overlay.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2]||'')
const owner=process.env.ORGTREE_AGENT||''
if(!/^[A-Za-z0-9_-]{1,64}$/.test(owner))throw Error('ORGTREE_AGENT required')
if(!out.toLowerCase().startsWith(('c:\\orgtree-build\\'+owner+'\\').toLowerCase()))throw Error('Output outside the owner\'s build scope')
const sessionId=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
assert.equal(sessionId,0,'Session 0 required before any window')
app.setPath('userData',path.join(out,'profile-'+process.pid));app.setPath('sessionData',path.join(out,'session-'+process.pid))
app.disableHardwareAcceleration();app.commandLine.appendSwitch('mute-audio')
const clipboardCalls=[]
for(const key of Object.keys(clipboard))if(typeof clipboard[key]==='function')Object.defineProperty(clipboard,key,{value:()=>{clipboardCalls.push(key);return key==='availableFormats'?[]:key==='has'?false:''}})
fs.writeFileSync(path.join(out,'clipboard.preload.cjs'),`Object.defineProperty(navigator,'clipboard',{value:Object.freeze({read:()=>Promise.reject(Error('Clipboard denied')),readText:()=>Promise.reject(Error('Clipboard denied')),write:()=>Promise.reject(Error('Clipboard denied')),writeText:()=>Promise.reject(Error('Clipboard denied'))})});window.__clipboardBlocked=true;`)
// index.html's first script: the page's uncaught errors and failed loads, read back when the fixture never starts
const pageErrorHook="window.__pageErrors=[];addEventListener('error',e=>{const t=e.target;window.__pageErrors.push(t&&t!==window?'failed to load '+(t.src||t.href||t.tagName):String(e.error&&e.error.stack||e.message).slice(0,4000))},true);addEventListener('unhandledrejection',e=>window.__pageErrors.push('unhandled rejection: '+String(e.reason&&e.reason.stack||e.reason).slice(0,4000)))"
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
// how long ago, one scale (the tip); the dense month-day stamp (the base)
const AGE=/^\d+(s|m|h|d|w|mo|y)$/,SHORT=/^\d\d-\d\d \d\d:\d\d$/,FULL=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d( \S+)?$/
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('symmetry-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:860,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const show=async(surface,theme)=>{await evalJs(`window.symFixture.show('${surface}','${theme}')`)}
  const themed=async(theme,what)=>assert.equal(await evalJs(`document.documentElement.classList.contains('contrast-light')`),theme==='light',`${what} drawn in ${theme}`)
  // a hover overlay: the pointer over the element (CDP to this window), its own title drawn under it
  let attached=false
  const hoverShot=async(selector,name)=>{
    if(!attached){wc.debugger.attach('1.3');attached=true}
    const at=await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x,y:at.y});await paint()
    const title=await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();const tip=document.createElement('div');tip.id='hover-text';tip.textContent=e.title;
      const light=document.documentElement.classList.contains('contrast-light');Object.assign(tip.style,{position:'fixed',left:Math.max(4,r.right-320)+'px',top:(r.bottom+6)+'px',zIndex:99999,whiteSpace:'pre',font:'12px Segoe UI, sans-serif',padding:'5px 8px',borderRadius:'3px',border:'1px solid '+(light?'#c5ccd4':'#454545'),background:light?'#ffffff':'#252526',color:light?'#2d333b':'#cccccc',boxShadow:'0 2px 8px rgba(0,0,0,.35)'});document.body.append(tip);return e.title})()`)
    await paint();const png=await shot(name)
    await evalJs(`document.getElementById('hover-text').remove()`)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await paint()
    return {title,png}
  }
  const measured=[],bundles={};let current=null
  try{
    for(const phase of ['base','tip']){
      current=phase;const dir=path.join(out,phase),tip=phase==='tip'
      if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no ${phase} bundle in ${dir}: nothing to capture`)
      const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles[phase]={root:s.root,fixture:s.fixture??null,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      await within(win.loadFile(path.join(dir,'index.html')),15000,'Fixture load timeout')
      await until('window.symFixture','fixture not loaded')
      assert.equal(await evalJs('window.__clipboardBlocked'),true)
      for(const theme of tip?['dark','light']:['dark']){
        // 1. Org settings › Connections: the offline ring (#5) and the chips' avatars (#2)
        await show('connections',theme)
        await until(`document.querySelectorAll('.conn-rows [data-hub-address]').length>=8`,'connections not drawn');await paint()
        await themed(theme,'connections')
        const conn=await evalJs(`(()=>{const probe=c=>{const s=document.createElement('span');s.style.color='var('+c+')';document.body.append(s);const r=getComputedStyle(s).color;s.remove();return r}
          const off=document.querySelector('.conn-rows .presence-dot.offline')
          return{offlineBorder:off?getComputedStyle(off).borderTopColor:null,dim:probe('--dim'),bad:probe('--bad'),
            chips:[...document.querySelectorAll('.conn-rows [data-hub-address]')].map(c=>{const m=c.querySelector('.net-mark');const s=m&&getComputedStyle(m);
              return{address:c.dataset.hubAddress,icon:c.dataset.netIcon,cls:m?m.className:'',initials:m?m.getAttribute('data-initials'):null,svg:!!(m&&m.querySelector('svg')),bg:s?s.backgroundColor:null,radius:s?s.borderTopLeftRadius:null,text:c.textContent}})}})()`)
        const record={phase,surface:'connections',theme,png:await shot(`${phase}-connections-${theme}`),...conn}
        const chip=a=>conn.chips.find(c=>c.address.startsWith('@net:'+a+'.'))
        if(tip){
          assert.equal(conn.offlineBorder,conn.dim,'offline is the theme grey');assert.notEqual(conn.offlineBorder,conn.bad,'and not red')
          assert.deepEqual([chip('acme-labs').icon,chip('acme-labs').initials],['letters','AL']);assert.match(chip('acme-labs').cls,/net-av-org/)
          assert.deepEqual([chip('maurdekye').icon,chip('maurdekye').initials],['letters','M']);assert.match(chip('maurdekye').cls,/net-av-person/);assert.equal(chip('maurdekye').radius,'50%')
          assert.equal(chip('claude-code').icon,'terminal');assert.ok(chip('claude-code').svg)
          assert.equal(conn.chips.some(c=>/net-mark-hubchat/.test(c.cls)),false,'no Hubchat mark')
          for(const c of conn.chips)assert.equal(c.text,c.address,'the letters are drawn, so the chip text stays the address')
        }else{
          assert.equal(conn.offlineBorder,conn.bad,'before: the red ring')
          assert.ok(conn.chips.some(c=>/net-mark-hubchat/.test(c.cls)),'before: the Hubchat mark')
        }
        measured.push(record)
        // 2. the org inbox's sent folder, the queued message open (#6, #23, #7)
        // (a production bundle has no data-testid: the clock is known by its hands, the path MUI Schedule and Hubchat's schedule share)
        await show('orginbox',theme)
        await until(`document.querySelectorAll('.mailrow .net-state').length>=5&&document.querySelector('.mailer-read .net-state')`,'org inbox sent folder not drawn');await paint()
        await themed(theme,'org inbox')
        const inbox=await evalJs(`(()=>{const rows=[...document.querySelectorAll('.mailrow')];const mark=m=>m?{text:m.textContent.trim(),role:m.getAttribute('role'),label:m.getAttribute('aria-label'),title:m.getAttribute('title'),clock:!!m.querySelector('svg path[d^="M12.5 7H11v6l5.25 3.15"]'),cls:m.className}:null
          return{rows:rows.map(r=>{const t=r.querySelector('.l1 .mtime');const c=r.querySelector('[data-hub-address]');return{text:(r.textContent||'').slice(0,160),mark:mark(r.querySelector('.net-state')),time:t?{text:t.textContent,title:t.getAttribute('title')}:null,chip:c?{address:c.dataset.hubAddress,icon:c.dataset.netIcon,dot:!!c.querySelector('.net-mark-dot')}:null}}),
            readerMark:mark(document.querySelector('.mailer-read .net-state')),reader:(document.querySelector('.mailer-read')?.textContent||'').slice(0,300)}})()`)
        const inboxRecord={phase,surface:'orginbox',theme,png:await shot(`${phase}-orginbox-${theme}`),...inbox}
        const row=body=>inbox.rows.find(r=>r.text.includes(body))
        if(tip){
          const q=row('confirm the release window').mark
          assert.ok(q.clock&&!q.text.includes('\u25ab'),'queued is the clock');assert.equal(q.role,'img');assert.equal(q.label,'queued \u2014 not yet at the hub')
          assert.ok(inbox.readerMark.clock,'the open message\'s header wears the clock too')
          const x=row('still on this address')
          assert.ok(/stuck/.test(x.mark.cls)&&x.mark.role==='img'&&/4 tries/.test(x.mark.label),'the failing one keeps its warning, named')
          assert.ok(x.chip.dot,'an address no roster lists: the grey dot')
          for(const r of inbox.rows.filter(r=>r.mark))assert.equal(r.mark.label,r.mark.title,'every mark is named by its tooltip')
          assert.deepEqual(['confirm the release window','build for your phone','world file','package update','still on this address'].map(b=>row(b).time.text),['2m','3h','3d','3w','4mo'])
          for(const r of inbox.rows)assert.match(r.time.title,FULL,'the full date and time on hover')
          inboxRecord.hover=await hoverShot('.mailrow .l1 .mtime',`tip-orginbox-${theme}-hover`)
          assert.match(inboxRecord.hover.title,FULL)
        }else{
          assert.equal(row('confirm the release window').mark.text,'\u25ab','before: the hollow square')
          assert.equal(row('confirm the release window').mark.role,null,'before: a title only')
          for(const r of inbox.rows)assert.match(r.time.text,SHORT,'before: the month-day stamp')
        }
        measured.push(inboxRecord)
        // 3. Presentations, the newest open (#7)
        await show('presentations',theme)
        await until(`document.querySelectorAll('.doc-gallery-row').length>=5&&document.querySelector('.doc-pane-head')`,'presentations not drawn');await paint()
        await themed(theme,'presentations')
        const docs=await evalJs(`(()=>({times:[...document.querySelectorAll('.doc-gallery-row .l1 .mtime')].map(t=>({text:t.textContent,title:t.getAttribute('title')})),head:(document.querySelector('.doc-pane-head')?.textContent||'').slice(0,300)}))()`)
        const docsRecord={phase,surface:'presentations',theme,png:await shot(`${phase}-presentations-${theme}`),...docs}
        if(tip){
          assert.deepEqual(docs.times.map(t=>t.text),['5m','5h','9d','2mo','13mo'],'one scale, never hundreds of hours')
          for(const t of docs.times)assert.match(t.title,FULL)
        }else assert.deepEqual(docs.times.map(t=>t.text),['5m','5h','216h','1440h','9600h'],'before: hours without end')
        assert.match(docs.head,/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/,'the open presentation says when in full')
        measured.push(docsRecord)
        // 4. an agent's docket, the two-day item open (#7)
        await show('docket',theme)
        await until(`document.querySelectorAll('.docket-row').length>=4`,'docket not drawn')
        // the docket opens a row by itself; a click on the open row would close it
        await evalJs(`(()=>{const r=[...document.querySelectorAll('.docket-row')].find(r=>r.querySelector('.docket-rowname')?.textContent==='two-day-item');if(!r.classList.contains('on'))r.click()})()`)
        await until(`document.querySelector('.docket-row.on .docket-rowname')?.textContent==='two-day-item'&&document.querySelector('.docket-pane-sub')`,'the ticket did not open');await paint()
        await themed(theme,'docket')
        const docket=await evalJs(`(()=>({ages:[...document.querySelectorAll('.docket-row .l1 .mtime')].map(t=>({text:t.textContent,title:t.getAttribute('title')})),sub:(document.querySelector('.docket-pane-sub')?.textContent||'').slice(0,300)}))()`)
        const docketRecord={phase,surface:'docket',theme,png:await shot(`${phase}-docket-${theme}`),...docket}
        if(tip){
          assert.deepEqual(docket.ages.map(a=>a.text),['30m','2d','3w','13mo'])
          for(const a of docket.ages)assert.match(a.title,/^updated \d{4}-/,'the hover names the sort clock')
          assert.match(docket.sub,/Updated \d{4}-\d\d-\d\d \d\d:\d\d:\d\d/,'the open ticket says when in full')
        }else{
          assert.deepEqual(docket.ages.map(a=>a.text),['30m','50h','480h','9600h'])
          assert.match(docket.sub,/Updated 50h/,'before: the age in the header')
        }
        measured.push(docketRecord)
      }
    }
    assert.deepEqual(clipboardCalls,[])
    // an empty run is not a pass: both phases, every surface, every theme
    assert.equal(measured.length,12,`${measured.length} records`)
    assert.deepEqual([...new Set(measured.map(r=>r.phase))],['base','tip'])
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,bundles,
      tooltipNote:'hover shots draw the hovered element\'s own title attribute in an overlay; native tooltips are not capturable offscreen',measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,records:measured.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
