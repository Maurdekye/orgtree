const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=process.env.REPLY_QUOTE_CAPTURE_ROOT
assert.match(root||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:980,height:640,show:false,useContentSize:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  try{
    await win.loadFile(path.join(root,'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+5000,t=setInterval(()=>{
      if(document.querySelectorAll('.reply-preview').length===4){clearInterval(t);resolve(true)}else if(performance.now()>until){clearInterval(t);reject(Error('reply fixture did not mount'))}},20)})`)
    const metrics=await win.webContents.executeJavaScript(`(async()=>{
      const first=document.querySelector('.reply-preview');first.focus({preventScroll:true});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))));
      const titles=[...document.querySelectorAll('button.reply-presentation-link')].map(el=>{const label=el.querySelector('span')||el,s=getComputedStyle(label);return{text:el.textContent,title:el.title,width:label.clientWidth,scrollWidth:label.scrollWidth,overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace}});
      return {titles,blocks:[...document.querySelectorAll('.reply-preview')].map(el=>({text:el.textContent,role:el.getAttribute('role'),tabIndex:el.tabIndex,title:el.title})),nestedLink:!!document.querySelector('a[href="https://example.invalid"]')};
    })()`)
    assert.equal(metrics.titles.length,2);assert.match(metrics.titles[0].text,/Project slots: UI\/UX mockups/)
    assert.ok(metrics.titles[0].title.includes(metrics.titles[0].text));assert.ok(metrics.titles[0].scrollWidth>metrics.titles[0].width)
    assert.equal(metrics.titles[0].textOverflow,'ellipsis');assert.equal(metrics.titles[0].whiteSpace,'nowrap')
    assert.equal(metrics.blocks.filter(block=>block.role==='link'&&block.tabIndex===0&&block.title).length,3)
    assert.match(metrics.blocks[3].text,/presentation (removed|unavailable)/i);assert.doesNotMatch(metrics.blocks[3].text,/@doc:|synthetic\/gone/)
    assert.equal(metrics.nestedLink,true)
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    const picture=await win.webContents.capturePage();assert.equal(picture.isEmpty(),false)
    fs.writeFileSync(path.join(root,'reply-quotes.png'),picture.toPNG());fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
