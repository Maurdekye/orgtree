const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const root = process.env.TEAM_HEADER_OUTPUT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('Expected assigned output')
app.setPath('userData', path.join(root, 'user-data')); app.disableHardwareAcceleration()
const rows = [], windows = new Set()
const measure = `(() => {
  const panel=document.querySelector('.team-panel'); if(!panel)throw Error('Missing actual Team panel');
  const bar=panel.querySelector('.modalpin-bar'), active=bar.querySelector('.modalpin-active-filter'),
    title=[...panel.querySelectorAll('[role="heading"],h3')].find(e=>getComputedStyle(e).display!=='none'),
    filter=panel.querySelector('.tray-filter');
  const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}};
  const style=title&&getComputedStyle(title);
  return {panel:rect(panel),bar:rect(bar),title:rect(title),titleInBar:!!title&&bar.contains(title),active:rect(active),
    controls:[...bar.querySelectorAll('button,input')].map(e=>({label:e.getAttribute('aria-label'),rect:rect(e)})),
    filter:rect(filter),filterValue:filter.value,mode:panel.className,
    headingCount:[...panel.querySelectorAll('[role="heading"],h3')].filter(e=>getComputedStyle(e).display!=='none').length,
    titleStyle:style&&{overflow:style.overflow,textOverflow:style.textOverflow,whiteSpace:style.whiteSpace},
    titleScroll:title?.scrollWidth,titleClient:title?.clientWidth,background:getComputedStyle(document.body).backgroundColor};
})()`
async function painted(win) {
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
}
function check(s) {
  const errors=[]
  if(!s.titleInBar)errors.push('Title is outside shared header row')
  if(s.headingCount!==1)errors.push('Expected one visible heading')
  if(!s.title||Math.abs((s.title.y+s.title.h/2)-(s.active.y+s.active.h/2))>2)errors.push('Title and Active are on different rows')
  if(s.title&&s.title.x+s.title.w>s.active.x+0.5)errors.push('Title overlaps fixed actions')
  if(s.filter.y<s.bar.y+s.bar.h-0.5)errors.push('Filter overlaps header')
  for(const c of s.controls)if(c.rect.x<s.panel.x-0.5||c.rect.x+c.rect.w>s.panel.x+s.panel.w+0.5)errors.push('Control outside panel: '+c.label)
  if(s.titleStyle?.textOverflow!=='ellipsis'||s.titleStyle?.whiteSpace!=='nowrap'||s.titleScroll<=s.titleClient)errors.push('Long title is not visibly truncated with ellipsis')
  if(s.filterValue!=='member')errors.push('Filter value lost across mode transition')
  return errors
}
async function record(win,label) {
  await painted(win)
  const state=await win.webContents.executeJavaScript(measure)
  const errors=check(state); rows.push({label,state,errors}); console.log((errors.length?'FAIL ':'PASS ')+label+': '+errors.join('; '))
  return state
}
app.whenReady().then(async()=>{
  const parent=new BrowserWindow({width:1000,height:650,useContentSize:true,show:false,paintWhenInitiallyHidden:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}})
  windows.add(parent)
  parent.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,width:480,height:380,
    frame:false,webPreferences:{offscreen:true,backgroundThrottling:false}}}))
  let child
  parent.webContents.on('did-create-window',w=>{child=w;windows.add(w)})
  const deadline=setTimeout(()=>{console.error('Geometry instrument deadline');for(const w of windows)if(!w.isDestroyed())w.destroy();app.exit(2)},25000)
  try {
    await parent.loadFile(path.join(root,'fixture.html'))
    await parent.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{
      const filter=document.querySelector('.team-panel .tray-filter');if(filter){
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(filter,'member');
        filter.dispatchEvent(new Event('input',{bubbles:true}));resolve();
      }else if(++n<100)setTimeout(tick,20);else reject(Error('No Team fixture mounted'));};tick()})`)
    for(const width of [280,220]){
      await parent.webContents.executeJavaScript(`document.querySelector('.team-panel').style.width='${width}px'`)
      await record(parent,'modal-'+width)
      if(width===220){
        const expected=await parent.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor')
        let image,actual
        for(let n=0;n<5;n++){
          parent.webContents.invalidate();await painted(parent);image=await parent.webContents.capturePage()
          if(image.isEmpty())throw Error('Empty capture');const b=image.toBitmap();actual='rgb('+b[2]+', '+b[1]+', '+b[0]+')';if(actual===expected)break
        }
        if(actual!==expected)throw Error('Stale capture palette')
        fs.writeFileSync(path.join(root,'team-header.png'),image.toPNG())
      }
    }
    for(const width of [480,320]){
      await parent.webContents.executeJavaScript(`window.teamHeaderMode('pinned',${width})`)
      await record(parent,'pinned-'+width)
    }
    await parent.webContents.executeJavaScript(`window.teamHeaderMode('modal',280)`);await painted(parent)
    await parent.webContents.executeJavaScript(`document.querySelector('.team-panel .popout-button').click()`)
    await parent.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const check=()=>{
      const children=[...document.querySelectorAll('.popout-placeholder')];
      if(children.length)resolve();else if(++n<100)setTimeout(check,20);else reject(Error('No actual detached surface'));};check()})`)
    if(!child)throw Error('No actual Electron child window')
    for(const width of [480,320]){
      child.setContentSize(width,380)
      const state=await record(child,'detached-'+width)
      if(!state.mode.includes('modalpin-detached')||!state.controls.some(c=>c.label==='Minimize window'))throw Error('Detached instrument omitted native header controls')
    }
    fs.writeFileSync(path.join(root,'geometry.json'),JSON.stringify({rows,pass:rows.filter(r=>!r.errors.length).length,fail:rows.filter(r=>r.errors.length).length},null,2))
  } finally {clearTimeout(deadline);for(const w of [...windows].reverse())if(!w.isDestroyed())w.destroy()}
}).then(()=>app.exit(rows.some(r=>r.errors.length)?1:0),e=>{fs.writeFileSync(path.join(root,'instrument-error.txt'),e.stack||String(e));console.error(e.stack||e);app.exit(2)})
