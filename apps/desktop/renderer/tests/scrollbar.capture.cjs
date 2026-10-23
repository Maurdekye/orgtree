const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path')
const out=path.resolve(process.argv[2])
if(!out.toLowerCase().startsWith('c:\\orgtree-build\\canvas-sol\\'))throw Error('outside owned scope')
app.setPath('userData',path.join(out,'profile'));app.setPath('sessionData',path.join(out,'session'))
app.disableHardwareAcceleration()
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1839,height:1112,frame:false,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}})
  try{
    await win.loadFile(path.join(out,'index.html'));win.webContents.setZoomFactor(1.25);await sleep(2200)
    const sizes=[[1920,1080,1.2],[1920,1080,1],[2284,1383,1.25],[2287,1383,1.25],[2288,1383,1.25],[1282,800,1.25],[1282,800,1.25,true]]
    const rows=[]
    for(const [w,h,zoom,positioned]of sizes){
      win.setContentSize(w,h);win.webContents.setZoomFactor(zoom);await sleep(700)
      await win.webContents.executeJavaScript(`document.querySelector('.canvas-stage').style.cssText=${JSON.stringify(positioned?'position:relative;border:1.6px solid transparent;padding:4.4px':'')}`)
      await sleep(200)
      const samples=await win.webContents.executeJavaScript(`new Promise(resolve=>{
        const rows=[];let n=0;const f=()=>{
          const d=document.documentElement,v=document.querySelector('.viewport'),a=document.querySelector('.app'),s=document.querySelector('.space'),m=document.querySelector('.msgs'),o=document.querySelector('.org-slot');
          const vr=v?.getBoundingClientRect(),or=o?.getBoundingClientRect();
          rows.push({innerW:innerWidth,innerH:innerHeight,dpr:devicePixelRatio,cw:d.clientWidth,ch:d.clientHeight,sw:d.scrollWidth,sh:d.scrollHeight,
            overlayError:vr&&or?Math.max(Math.abs(vr.left-or.left),Math.abs(vr.top-or.top),Math.abs(vr.right-or.right),Math.abs(vr.bottom-or.bottom)):null,
            vp:v?[v.getBoundingClientRect().width,v.getBoundingClientRect().height,v.scrollWidth,v.scrollHeight]:null,
            app:a?[a.getBoundingClientRect().width,a.getBoundingClientRect().height]:null,
            camera:s?.style.transform,msgs:m?[m.clientWidth,m.clientHeight,m.scrollHeight,m.scrollTop]:null});
          if(++n>=90)resolve(rows);else requestAnimationFrame(f)};requestAnimationFrame(f)})`)
      const distinct=[...new Set(samples.map(r=>JSON.stringify([r.cw,r.ch,r.sw,r.sh,r.vp,r.app])))]
      const widths=[...new Set(samples.map(r=>r.cw))],canvasWidths=[...new Set(samples.map(r=>r.vp?.[0]))]
      const overlayError=Math.max(...samples.map(r=>r.overlayError??Infinity))
      rows.push({requested:[w,h,zoom,!!positioned],bounds:win.getBounds(),contentBounds:win.getContentBounds(),distinct,widths,canvasWidths,overlayError,samples})
      console.log(JSON.stringify({requested:[w,h,zoom,!!positioned],widths,canvasWidths,overlayError,distinct:distinct.length,first:samples[0],last:samples.at(-1)}))
    }
    fs.writeFileSync(path.join(out,'sweep.json'),JSON.stringify(rows,null,2))
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await sleep(100)
    fs.writeFileSync(path.join(out,'sweep.png'),(await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript('window.fixtureFocus("neighbor")');await sleep(1500)
    const focus=await win.webContents.executeJavaScript(`(() => {const v=document.querySelector('.viewport').getBoundingClientRect(),n=document.querySelector('[data-first-use-agent="neighbor"]').getBoundingClientRect();return {nodeCenter:[n.x+n.width/2,n.y+n.height/2],viewportCenter:[v.x+v.width/2,v.y+v.height/2],visible:n.width>0&&n.x>=v.x&&n.right<=v.right&&n.y>=v.y&&n.bottom<=v.bottom};})()`)
    fs.writeFileSync(path.join(out,'focus.json'),JSON.stringify(focus,null,2))
    const unstable=rows.filter(row=>row.canvasWidths.length!==1||row.overlayError>0.05)
    console.log(JSON.stringify({checks:rows.length,failed:unstable.map(row=>row.requested)}))
    app.exit(unstable.length||!focus.visible?1:0)
  }catch(e){console.error(e);app.exit(1)}
})
