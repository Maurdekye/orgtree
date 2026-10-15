const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {pathToFileURL}=require('node:url')
const root=process.env.THOUGHT_BUILD,evidence=process.env.THOUGHT_EVIDENCE,version=process.env.THOUGHT_VERSION
if(!/^C:\\orgtree-build\\/i.test(root||'')||!/^D:\\orgtree-work\\/i.test(evidence||''))throw Error('Expected C output and D evidence')
fs.mkdirSync(evidence,{recursive:true});app.setPath('userData',path.join(root,'electron-data'))
app.disableHardwareAcceleration()
const receipts=[],errors=[]
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,
    webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.startPainting()
  // Only local, generated fixtures are reachable. No live app/profile/network.
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')}))
  try{
    for(const theme of ['dark','light'])for(const pressure of ['crowded','roomy']){
      for(const [kind,size] of [['live','short'],['live','multi'],['live','long'],['sealed','short'],['collapsed','short'],['expanded','multi']]){
        const id=`${version}-${theme}-${pressure}-${kind}-${size}`
        await win.loadURL(pathToFileURL(path.join(root,'fixture.html')).href+`?kind=${kind==='expanded'?'collapsed':kind}&pressure=${pressure}&size=${size}`)
        await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const limit=Date.now()+5000;const poll=()=>{
          if(document.querySelector('[data-fixture="target"]')?.firstElementChild){resolve(true);return}
          if(Date.now()>limit){reject(Error('thought fixture did not mount'));return}setTimeout(poll,20)};poll()})`)
        await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${theme==='light'});
          ${kind==='expanded'?"document.querySelector('.thoughtline').click();":''}`)
        const state=await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
          const transcript=document.querySelector('.msgs'),target=document.querySelector('[data-fixture="target"]');
          const el=target.querySelector(${JSON.stringify(kind==='expanded'?'.thoughtbody':'.thoughtbody,.thinking,.thoughtline')}),css=getComputedStyle(el);
          transcript.scrollTop=transcript.scrollHeight;
          const original=el.style.flexShrink;el.style.flexShrink='0';const natural=el.getBoundingClientRect().height;el.style.flexShrink=original;
          const r=el.getBoundingClientRect();
          const first=el.querySelector('p')||el,range=document.createRange();range.selectNodeContents(first);
          const line=range.getClientRects()[0];
          resolve({height:r.height,natural,lineHeight:parseFloat(css.lineHeight),scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,
            fontStyle:css.fontStyle,color:css.color,dim:getComputedStyle(transcript).getPropertyValue('--dim').trim(),
            border:css.borderLeftWidth,maxHeight:css.maxHeight,boxSizing:css.boxSizing,overflowY:css.overflowY,flexShrink:css.flexShrink,
            animation:css.animationName,bodyCount:target.querySelectorAll('.thoughtbody').length,
            top:r.top,bottom:r.bottom,firstLineTop:line?.top,firstLineBottom:line?.bottom,
            transcriptHeight:transcript.clientHeight,transcriptScrollHeight:transcript.scrollHeight,
            parentDisplay:getComputedStyle(target).display,viewport:{width:innerWidth,height:innerHeight}})
        })))`)
        // Always give Chromium two new animation frames and a short paint delay
        // immediately before EVERY capturePage, including the diagnostic red.
        await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        await new Promise(r=>setTimeout(r,80))
        const png=await win.webContents.capturePage()
        fs.writeFileSync(path.join(evidence,id+'.png'),png.toPNG())
        const failures=[]
        const check=(ok,message)=>{if(!ok)failures.push(message)}
        check(state.viewport.width===1000&&state.viewport.height===700,'fixture viewport clamped')
        check(state.fontStyle==='italic','italic thought styling preserved')
        if(kind==='live'){
          check(state.parentDisplay==='contents','real reply-event wrapper must expose flex item')
          check(Math.abs(state.height-state.natural)<=0.5,'streaming thought retains natural capped height under pressure')
          check(state.height>=state.lineHeight+8-0.5,'at least one full line plus existing padding visible')
          check(state.border==='2px'&&state.maxHeight==='320px'&&state.overflowY==='auto','border/cap/scroll unchanged')
          if(size==='long')check(state.scrollHeight>state.clientHeight&&state.boxSizing==='border-box'&&Math.abs(state.height-320)<=0.5,'long thought capped at320px border-box and scrollable')
        }else if(kind==='sealed')check(state.animation==='think-breathe'&&state.bodyCount===0,'sealed pulse unchanged')
        else if(kind==='collapsed')check(state.bodyCount===0,'collapsed thought stays collapsed')
        else check(state.bodyCount===1&&state.maxHeight==='320px'&&state.overflowY==='auto','expanded body unchanged')
        receipts.push({id,theme,pressure,kind,size,...state,failures})
        errors.push(...failures.map(message=>id+': '+message))
        fs.writeFileSync(path.join(evidence,version+'-result.json'),JSON.stringify({passed:errors.length===0,receipts,errors},null,2))
      }
    }
    assert.equal(errors.length,0,errors.join('\n'))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{fs.writeFileSync(path.join(evidence,version+'-error.txt'),String(error.stack||error));app.exit(1)})
