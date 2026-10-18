const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path')
const root=process.env.TEAM_CAPTURE_ROOT
if(!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root||''))throw Error('Expected own output')
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,
   webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
 try{
  await win.loadFile(path.join(root,'fixture.html'))
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const check=()=>{const tabs=[...document.querySelectorAll('[data-tab="team"]')];
   if(tabs.length===4){tabs.forEach(t=>t.click());resolve()}else if(++n<100)setTimeout(check,20);else reject(Error('Missing Team tabs'))};check()})`)
  let state,image,actual
  for(let i=0;i<5;i++){
   win.webContents.invalidate()
   state=await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}};
    resolve({background:getComputedStyle(document.body).backgroundColor,cases:[...document.querySelectorAll('[data-case]')].map(host=>{
      const p=host.querySelector('.team-tabpanel'),c=p.querySelector('.panel-corner'),f=p.querySelector('.tray-filter'),a=p.querySelector('[aria-label="Only active agents"]'),t=p.querySelector('.tray');
      return{name:host.dataset.case,panel:rect(p),corner:rect(c),filter:rect(f),active:rect(a),tray:rect(t),position:getComputedStyle(c).position,
        buttons:[...c.querySelectorAll('button')].map(b=>({rect:rect(b),font:getComputedStyle(b).fontSize})),
        rows:p.querySelectorAll('.tray-row').length,toolbar:!!p.querySelector('[role="toolbar"][aria-label="Team view controls"]')}})})},250))))`)
   image=await win.webContents.capturePage();if(image.isEmpty())throw Error('Empty PNG')
   const b=image.toBitmap();actual=`rgb(${b[2]}, ${b[1]}, ${b[0]})`;if(actual===state.background)break
  }
  fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify({...state,actual},null,2))
  if(actual!==state.background)throw Error('Capture palette mismatch')
  // Save both red and green geometry evidence before asserting the regression.
  fs.writeFileSync(path.join(root,'team-actions-dark.png'),image.toPNG())
  const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y
  for(const c of state.cases){
   if(c.buttons.length!==3||c.rows!==2)throw Error(c.name+': incorrect fixture')
   if(!c.toolbar||c.position==='absolute'||c.corner.y+c.corner.h>c.tray.y+1||overlap(c.corner,c.filter)||overlap(c.corner,c.active))throw Error(c.name+': Team actions overlap the tray/filter instead of owning a row')
   for(const b of c.buttons)if(b.font!=='14px'||b.rect.x<c.panel.x||b.rect.x+b.rect.w>c.panel.x+c.panel.w+1||b.rect.y<0||b.rect.y+b.rect.h>700)throw Error(c.name+': action size/bounds differ')
  }
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
