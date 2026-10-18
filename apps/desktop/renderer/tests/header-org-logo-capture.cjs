const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=process.env.HEADER_LOGO_CAPTURE_ROOT
assert.match(root||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:980,height:620,show:false,useContentSize:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  try {
    await win.loadFile(path.join(root,'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+5000,t=setInterval(()=>{
      const frame=document.querySelector('iframe'),logos=[...document.querySelectorAll('img.org-header-logo'),...(frame?.contentDocument?.querySelectorAll('img.org-header-logo')||[])];
      if(logos.length===4&&logos.every(img=>img.complete&&img.naturalWidth>0)){clearInterval(t);resolve(true)}else if(performance.now()>until){clearInterval(t);reject(Error('header logo fixture did not settle'))}
    },20)})`)
    const metrics=await win.webContents.executeJavaScript(`(async()=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))));
      const heads=[...document.querySelectorAll('.shell-header-title')];
      const frame=document.querySelector('iframe'),separate=frame.contentDocument.querySelector('h3');
      return {heads:heads.map(el=>{const img=el.querySelector('img'),s=getComputedStyle(el);return{text:el.textContent,width:el.clientWidth,scrollWidth:el.scrollWidth,height:el.getBoundingClientRect().height,font:parseFloat(s.fontSize),logo:img?{width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,first:el.firstElementChild===img}:null}}),separate:{text:separate.textContent,logoWidth:separate.querySelector('img').getBoundingClientRect().width,font:parseFloat(frame.contentWindow.getComputedStyle(separate).fontSize)}};
    })()`)
    assert.equal(metrics.heads.length,4)
    for(const index of [0,1,3]){const row=metrics.heads[index];assert.ok(row.logo.first);assert.ok(Math.abs(row.logo.width-row.font)<.5);assert.ok(Math.abs(row.logo.height-row.font)<.5)}
    assert.equal(metrics.heads[2].logo,null);assert.equal(metrics.heads[0].height,metrics.heads[2].height)
    assert.equal(metrics.heads[1].width,metrics.heads[1].scrollWidth,'wide centered header must reserve room for its asynchronously loaded logo')
    assert.ok(metrics.heads[3].scrollWidth>metrics.heads[3].width)
    assert.ok(Math.abs(metrics.separate.logoWidth-metrics.separate.font)<.5)
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    const png=await win.webContents.capturePage();assert.equal(png.isEmpty(),false)
    fs.writeFileSync(path.join(root,'header-org-logo.png'),png.toPNG());fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
