const {app,BrowserWindow,nativeImage}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_BADGE_CAPTURE_ROOT,root=process.env.ORGTREE_BADGE_SOURCE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
const {TaskbarDot,taskbarDotBitmap}=require(path.join(out,'badge.cjs'))
app.setPath('userData',path.join(out,'user-data'));app.disableHardwareAcceleration()
app.setAppUserModelId('Orgtree.SyntheticTaskbarBadge')
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:620,height:250,show:false,skipTaskbar:true,useContentSize:true,
    webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}})
  try {
    const bitmap=taskbarDotBitmap();assert.equal(bitmap.length,16*16*4)
    assert.deepEqual([...bitmap.subarray((8*16+8)*4,(8*16+8)*4+4)],[0x4d,0x48,0xe5,255])
    const dot=nativeImage.createFromBitmap(bitmap,{width:16,height:16});assert.equal(dot.isEmpty(),false)
    fs.writeFileSync(path.join(out,'badge-dot.png'),dot.toPNG())
    const calls=[],adapter={isDestroyed:()=>win.isDestroyed(),setOverlayIcon:(image,description)=>{win.setOverlayIcon(image,description);calls.push({active:!!image,description})}}
    const controller=new TaskbarDot({platform:'win32',windows:()=>[adapter],dot:()=>dot})
    controller.set(false);controller.set(true);controller.set(true);controller.set(false)
    assert.deepEqual(calls.map(c=>c.active),[false,true,false])
    const base=nativeImage.createFromPath(path.join(root,'apps/desktop/assets/orgtree-eye-1024.png')).resize({width:32,height:32})
    assert.equal(base.isEmpty(),false)
    const tile=(label,active)=>`<section><div class="icon"><img src="${base.toDataURL()}">${active?`<img class="dot" src="${dot.toDataURL()}">`:''}</div><p>${label}</p></section>`
    const html='<!doctype html><meta charset="utf-8"><style>body{background:#202020;color:#eee;font:14px system-ui;margin:24px}h1{font-size:16px}main{display:flex;gap:18px;margin-top:26px}section{width:168px;text-align:center;background:#303030;padding:18px 0;border-radius:6px}.icon{position:relative;width:32px;height:32px;margin:auto}.icon>img{width:32px;height:32px}.icon .dot{position:absolute;right:0;bottom:0;width:16px;height:16px}p{font-size:12px;margin:12px 0 0}</style><h1>Taskbar badge asset · synthetic fixture</h1><main>'+tile('Nothing pending',false)+tile('Unread mail / attention',true)+tile('All resolved',false)+'</main>'
    fs.writeFileSync(path.join(out,'fixture.html'),html)
    await win.loadFile(path.join(out,'fixture.html'))
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    const png=await win.webContents.capturePage();assert.equal(png.isEmpty(),false)
    fs.writeFileSync(path.join(out,'taskbar-dot.png'),png.toPNG())
    fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify({calls,nativeWindowsApiAccepted:true,nativeTaskbarPixelsCaptured:false,syntheticWindowHidden:true},null,2))
    console.log(JSON.stringify({calls,nativeWindowsApiAccepted:true,nativeTaskbarPixelsCaptured:false}))
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
