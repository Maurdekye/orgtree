const {app,BrowserWindow,nativeImage}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_BADGE_CAPTURE_ROOT,root=process.env.ORGTREE_BADGE_SOURCE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
const {TaskbarDot,taskbarDotBitmap,taskbarDotImage}=require(path.join(out,'badge.cjs'))
const {actionPng}=require(path.join(out,'icons.cjs'))
const {taskbarTasks,taskbarAttentionItems}=require(path.join(out,'jumplist.cjs'))
app.setPath('userData',path.join(out,'user-data'));app.disableHardwareAcceleration()
app.setAppUserModelId('Orgtree.SyntheticTaskbarBadge')
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:920,height:650,show:false,skipTaskbar:true,useContentSize:true,
    webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}})
  try {
    const bitmap=taskbarDotBitmap();assert.equal(bitmap.length,16*16*4)
    assert.deepEqual([...bitmap.subarray((8*16+8)*4,(8*16+8)*4+4)],[0x4d,0x48,0xe5,255])
    const dot=taskbarDotImage(nativeImage);assert.equal(dot.isEmpty(),false)
    const scales=dot.getScaleFactors()
    assert.deepEqual(scales,[1,1.25,1.5,1.75,2,2.5,3,4])
    const dpi=[]
    for(const scaleFactor of [1,1.25,1.5,2]){
      const size=16*scaleFactor,png=dot.toPNG({scaleFactor}),pixels=dot.toBitmap({scaleFactor})
      assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size)
      assert.equal(pixels.length,size*size*4)
      let partial=0
      for(let at=0;at<pixels.length;at+=4){
        const alpha=pixels[at+3]
        for(const [channel,red] of [0x4d,0x48,0xe5].entries())assert.ok(Math.abs(pixels[at+channel]-Math.round(red*alpha/255))<=1,'native PNG decoding preserves premultiplied red without a halo')
        if(alpha>0&&alpha<255)partial++
      }
      assert.ok(partial>0)
      fs.writeFileSync(path.join(out,'dot-'+Math.round(100*scaleFactor)+'.png'),png)
      dpi.push({scaleFactor,size,url:'data:image/png;base64,'+png.toString('base64')})
    }
    fs.writeFileSync(path.join(out,'badge-dot.png'),dot.toPNG())
    const calls=[],adapter={isDestroyed:()=>win.isDestroyed(),setOverlayIcon:(image,description)=>{win.setOverlayIcon(image,description);calls.push({active:!!image,description})}}
    const controller=new TaskbarDot({platform:'win32',windows:()=>[adapter],dot:()=>dot})
    controller.set(false);controller.set(true);controller.set(true);controller.set(false)
    assert.deepEqual(calls.map(c=>c.active),[false,true,false])
    const base=nativeImage.createFromPath(path.join(root,'apps/desktop/assets/orgtree-eye-1024.png')).resize({width:32,height:32})
    assert.equal(base.isEmpty(),false)
    const tile=(label,active)=>`<section><div class="icon"><img src="${base.toDataURL()}">${active?`<img class="dot" src="${dot.toDataURL()}">`:''}</div><p>${label}</p></section>`
    const rows=[{kind:'urgent-mail',id:'m',org:'demo',title:'Urgent mail from helper'},
      {kind:'question',id:'q',org:'demo',agent:'helper',title:'helper asks'},
      {kind:'work-attention',id:'w',org:'demo',item:'review-change',title:'Ticket needs you: Review change'},
      {kind:'mention',id:'a',org:'demo',agent:'helper',title:'helper mentioned you'}]
    const attention=taskbarAttentionItems({allNotices:()=>rows})
    const category=taskbarTasks([],'synthetic.exe',undefined,{},attention)[0]
    const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const menu='<aside><h2>'+category.name+'</h2>'+attention.map((entry,i)=>'<div class="menu"><img src="data:image/png;base64,'+actionPng(entry.icon).toString('base64')+'">'+escape(category.items[i].title)+'</div>').join('')+'<footer>Home · New org</footer></aside>'
    const html='<!doctype html><meta charset="utf-8"><style>body{background:#202020;color:#eee;font:14px system-ui;margin:24px}h1{font-size:16px}main{display:flex;gap:18px;margin-top:26px}section{width:168px;text-align:center;background:#303030;padding:18px 0;border-radius:6px}.icon{position:relative;width:32px;height:32px;margin:auto}.icon>img{width:32px;height:32px}.icon .dot{position:absolute;right:0;bottom:0;width:16px;height:16px}p{font-size:12px;margin:12px 0 0}aside{margin-top:20px;padding:12px 18px;background:#303030;border-radius:6px}h2{font-size:13px;color:#aaa;margin:0 0 8px}.menu{display:flex;gap:12px;align-items:center;padding:6px 0}.menu img{width:20px;height:20px}footer{border-top:1px solid #666;padding-top:10px;margin-top:8px;color:#bbb}</style><h1>Taskbar assets and menu · synthetic fixture</h1><main>'+tile('Nothing pending',false)+tile('Needs attention',true)+tile('All resolved',false)+'</main>'+menu
    const grid='<style>.dpi{display:flex;gap:12px;margin-top:18px}.dpi article{flex:1;text-align:center;font-size:12px}.dpi .swatches{display:flex;justify-content:center;margin-top:8px}.dpi .swatches span{width:58px;height:50px;display:flex;align-items:center;justify-content:center}</style><div class="dpi">'+dpi.map(d=>'<article>'+Math.round(100*d.scaleFactor)+'% / '+d.size+'px<div class="swatches">'+['#f7f7f7','#202020','#888'].map(bg=>'<span style="background:'+bg+'"><img width="'+d.size+'" height="'+d.size+'" src="'+d.url+'"></span>').join('')+'</div></article>').join('')+'</div>'
    fs.writeFileSync(path.join(out,'fixture.html'),html+grid)
    await win.loadFile(path.join(out,'fixture.html'))
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    const png=await win.webContents.capturePage();assert.equal(png.isEmpty(),false)
    fs.writeFileSync(path.join(out,'taskbar-dot.png'),png.toPNG())
    fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify({calls,category,attention,scales,dpi:dpi.map(({url,...entry})=>entry),nativeAlphaValidated:true,nativeWindowsApiAccepted:true,nativeTaskbarPixelsCaptured:false,nativeJumpListModified:false,syntheticWindowHidden:true},null,2))
    console.log(JSON.stringify({calls,nativeWindowsApiAccepted:true,nativeTaskbarPixelsCaptured:false}))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
