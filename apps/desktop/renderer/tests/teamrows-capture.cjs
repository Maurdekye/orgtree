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
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const check=()=>{const b=document.querySelector('.tray-toggle');
   if(b){b.click();resolve()}else if(++n<100)setTimeout(check,20);else reject(Error('Missing Agents toggle'))};check()})`)
  let state,image,actual
  for(let attempt=0;attempt<5;attempt++){
   win.webContents.invalidate()
   state=await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}};
    const measure=s=>{const panel=document.querySelector(s);return{rect:rect(panel),rows:[...panel.querySelectorAll('.tray-row')].map(row=>{
      const n=row.querySelector('.tray-name'),p=row.querySelector('.tray-primary'),c=getComputedStyle(n),r=getComputedStyle(row),mark=row.querySelector('.tier,.project-mark');
      return{id:row.dataset.copyAgentName,font:c.font,family:c.fontFamily,name:rect(n),primary:rect(p),rect:rect(row),paddingLeft:r.paddingLeft,
        summary:!!row.querySelector('.tray-sum'),mark:rect(mark)}})}};
    const toolbar=document.querySelector('[data-inline-team] .team-tab-toolbar'),active=toolbar.querySelector('.modalpin-active-filter'),corner=toolbar.querySelector('.panel-corner');
    const panel=document.querySelector('.team-panel'),pinActive=panel.querySelector('.modalpin-active-filter'),pinActions=panel.querySelector('.modalpin-actions');
    resolve({agents:measure('.tray-panel:not(.team-panel)'),team:measure('.team-panel'),inline:{toolbar:rect(toolbar),active:rect(active),corner:rect(corner)},
      pinned:{active:rect(pinActive),actions:rect(pinActions)},background:getComputedStyle(document.body).backgroundColor})},250))))`)
   image=await win.webContents.capturePage();if(image.isEmpty())throw Error('Empty PNG')
   const b=image.toBitmap();actual=`rgb(${b[2]}, ${b[1]}, ${b[0]})`;if(actual===state.background)break
  }
  fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify({...state,actual},null,2))
  if(actual!==state.background)throw Error('Stale capture palette')
  fs.writeFileSync(path.join(root,'team-rows-dark.png'),image.toPNG())
  for(const panel of [state.agents,state.team]){
   const project=panel.rows.find(r=>r.id==='build-team'),member=panel.rows.find(r=>r.id==='layout-author')
   if(!project||!member)throw Error('Missing project/member controls')
   if(project.summary||member.primary.y-(project.primary.y+project.primary.h)>12)throw Error('Blank project status line leaves a gap')
   if(project.font!==member.font||project.mark.w!==member.mark.w||project.mark.h!==member.mark.h)throw Error('Project/member font or icon differs')
   if(member.name.x-project.name.x!==14)throw Error('Shared14px hierarchy indentation changed')
  }
  for(const r of state.team.rows){const a=state.agents.rows.find(a=>a.id===r.id);if(!a||a.font!==r.font||a.paddingLeft!==r.paddingLeft||Math.abs(a.rect.h-r.rect.h)>1)throw Error('Pinned row parity changed')}
  if(state.inline.corner.x-(state.inline.active.x+state.inline.active.w)>12||state.inline.active.x<state.inline.toolbar.x+state.inline.toolbar.w/2)throw Error('Inline Active is separated from the right-hand controls')
  if(state.pinned.active.x<state.pinned.actions.x||state.pinned.active.x+state.pinned.active.w>state.pinned.actions.x+state.pinned.actions.w+1)throw Error('Pinned Active left the right-hand control group')
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
