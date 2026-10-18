const { app,BrowserWindow }=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=process.env.MAIL_TAG_CAPTURE_ROOT
assert.match(root||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:980,height:640,show:false,useContentSize:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  try{
    await win.loadFile(path.join(root,'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+5000,t=setInterval(()=>{
      if(document.querySelectorAll('.mail-tag-picker').length===2){clearInterval(t);resolve(true)}else if(performance.now()>until){clearInterval(t);reject(Error('fixture did not mount'))}},20)})`)
    const metrics=await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#browse-sample button[aria-label="Filter mail by tags"]').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))));
      const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,center:r.top+r.height/2}};
      const controls=document.querySelector('#inbox-sample .mail-list-controls');
      return {controls:[...controls.querySelectorAll('.mail-tag-control,.mail-tag-clear,.mail-filter')].map(box),
        selected:[...controls.querySelectorAll('.mail-tag-active')].map(box),
        choices:[...document.querySelectorAll('.mail-tag-choice')].map(el=>({...box(el),font:getComputedStyle(el).fontSize})),
        popover:box(document.querySelector('.mail-tag-popover')),anchor:box(document.querySelector('#browse-sample .mail-tag-control')),
        background:getComputedStyle(document.body).backgroundColor};
    })()`)
    assert.equal(metrics.controls.length,3)
    for(const control of metrics.controls){assert.ok(Math.abs(control.height-24)<.1,JSON.stringify(metrics));assert.ok(Math.abs(control.center-metrics.controls[0].center)<.1,JSON.stringify(metrics))}
    assert.equal(metrics.selected.length,2)
    for(const chip of metrics.selected)assert.ok(Math.abs(chip.center-metrics.controls[0].center)<.1,JSON.stringify(metrics))
    assert.equal(metrics.choices.length,5)
    assert.ok(Math.abs(metrics.popover.x-metrics.anchor.x)<.1,JSON.stringify(metrics))
    assert.ok(Math.abs(metrics.popover.y-(metrics.anchor.y+metrics.anchor.height+4))<.1,JSON.stringify(metrics))
    for(const chip of metrics.choices){assert.equal(chip.font,'10px');assert.ok(chip.height<=18);assert.ok(chip.x>=metrics.popover.x&&chip.x+chip.width<=metrics.popover.x+metrics.popover.width)}
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    const image=await win.webContents.capturePage();assert.equal(image.isEmpty(),false)
    fs.writeFileSync(path.join(root,'inbox-tags.png'),image.toPNG());fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify(metrics,null,2))
    console.log(JSON.stringify({capture:'inbox-tags.png',controls:3,choices:5,metrics}))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
