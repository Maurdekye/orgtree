const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=process.env.INBOX_BEHAVIOR_CAPTURE_ROOT
assert.match(root||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:980,height:640,show:false,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  try{
    await win.loadFile(path.join(root,'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+5000,t=setInterval(()=>{
      if(document.querySelector('.mailrow.on')&&document.querySelector('.mail-hidden-unread')){clearInterval(t);resolve(true)}else if(performance.now()>until){clearInterval(t);reject(Error('inbox fixture did not mount'))}},20)})`)
    const metrics=await win.webContents.executeJavaScript(`(async()=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))));
      const unread=document.querySelector('.mail-hidden-unread'),bar=document.querySelector('.mail-list-controls'),first=document.querySelector('.mailrow');
      const rect=el=>{const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,width:r.width}};
      return {text:unread.textContent,title:unread.title,unread:rect(unread),bar:rect(bar),first:rect(first),selected:document.querySelector('.mailrow.on').textContent,role:unread.tagName};
    })()`)
    assert.equal(metrics.text,'(802 unread)');assert.equal(metrics.role,'BUTTON');assert.ok(metrics.unread.height<=24)
    assert.ok(metrics.unread.top>=metrics.bar.bottom-1);assert.ok(metrics.unread.bottom<=metrics.first.top+1)
    assert.match(metrics.title,/oldest unread/);assert.match(metrics.selected,/selected build/)
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    const png=await win.webContents.capturePage();assert.equal(png.isEmpty(),false)
    fs.writeFileSync(path.join(root,'inbox-behavior.png'),png.toPNG());fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
