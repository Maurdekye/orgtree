const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.FIRST_USE_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]epic-combo-sol[\\/]/i.test(out||''))throw Error('Owned output required')
fs.mkdirSync(out,{recursive:true})
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1')
const esbuild=require(path.join(deps,'esbuild'))
esbuild.buildSync({entryPoints:['apps/desktop/renderer/tests/firstuse-placement-visual.tsx'],bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl','.svg':'dataurl','.png':'dataurl'}})
esbuild.stop()
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))'
const waitFor=async(win,step)=>win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+10000;let old='',stable=0;function frame(){const card=document.querySelector('.first-use-guide[data-tutorial-step="${step}"] .first-use-card'),group=document.querySelector('${step==='token'?'.sq.user > .hsof':'.sq.draft'}');const value=card&&group?JSON.stringify([card.getBoundingClientRect().toJSON(),group.getBoundingClientRect().toJSON()]):'';if(value&&value===old)stable++;else stable=0;old=value;if(stable>=10)resolve();else if(Date.now()>until)reject(Error('Guide ${step} did not settle'));else requestAnimationFrame(frame)}frame()})`)
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1920,height:1080,useContentSize:true,frame:false,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!/^(file:|data:)/.test(details.url)}))
  const records=[],screenshots=[]
  const deadline=setTimeout(()=>{fs.writeFileSync(out+'/timeout.json',JSON.stringify({error:'capture budget exceeded',records}));app.exit(1)},120000)
  try{
    for(const [width,height] of [[1920,1080],[1366,768],[1024,768],[800,600],[400,760]])for(const step of ['token','name']){
      win.setContentSize(width,height)
      await win.loadFile(out+'/fixture.html')
      await waitFor(win,'token')
      if(step==='name'){
        await win.webContents.executeJavaScript(`document.querySelector('.sq.user button.t-sol').click()`)
        await waitFor(win,'name')
      }
      await win.webContents.executeJavaScript(settle)
      const record=await win.webContents.executeJavaScript(`(()=>{
        const step=${JSON.stringify(step)},card=document.querySelector('.first-use-card'),note=card.getBoundingClientRect(),
          group=document.querySelector(step==='token'?'.sq.user > .hsof':'.sq.draft').getBoundingClientRect(),
          target=document.querySelector(step==='token'?'[data-first-use="token"]:not(:disabled)':'.sq.draft .df-name').getBoundingClientRect()
        const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
        const controls=[...document.querySelectorAll('button,input,textarea,select')].filter(el=>{const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return false;const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===el||!!hit&&el.contains(hit)})
        const covered=controls.filter(el=>overlaps(note,el.getBoundingClientRect())).map(el=>el.title||el.getAttribute('aria-label')||el.textContent||el.tagName)
        const tokens=[...document.querySelectorAll('[data-first-use="token"]')].map(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{disabled:el.disabled,overlap:overlaps(note,r),hit:hit===el||!!hit&&el.contains(hit)}})
        const oldWidth=Math.min(280,innerWidth-24),oldLeft=Math.max(12,Math.min(innerWidth-oldWidth-12,target.left)),below=target.bottom+18,
          oldTop=below+100<innerHeight?below:Math.max(12,target.top-112)
        return{step,width:innerWidth,height:innerHeight,side:card.dataset.placement,note:note.toJSON(),group:group.toJSON(),target:target.toJSON(),covered,tokens,
          inViewport:note.left>=0&&note.top>=0&&note.right<=innerWidth&&note.bottom<=innerHeight,overlap:overlaps(note,group),
          legacyOverlap:overlaps({left:oldLeft,top:oldTop,right:oldLeft+oldWidth,bottom:oldTop+note.height},group),path:document.querySelector('.first-use-guide path').getAttribute('d')}
      })()`)
      records.push(record);fs.writeFileSync(out+'/geometry.json',JSON.stringify({records,screenshots},null,2))
      assert.equal(record.width,width);assert.equal(record.height,height)
      assert.equal(record.inViewport,true);assert.equal(record.overlap,false);assert.deepEqual(record.covered,[])
      const endpoint=record.path.match(/L ([\d.-]+) ([\d.-]+)$/).slice(1).map(Number)
      assert(Math.abs(endpoint[1]-(record.target.top+record.target.height/2))<1)
      assert(Math.abs(endpoint[0]-(record.target.left-4))<1||Math.abs(endpoint[0]-(record.target.right+4))<1)
      assert.equal(record.tokens.some(token=>token.overlap),false)
      if(step==='token')assert.equal(record.tokens.filter(token=>!token.disabled).every(token=>token.hit),true)
      if(width===1920){
        assert.equal(record.side,step==='token'?'left':'right');assert.equal(record.legacyOverlap,true)
        await win.webContents.executeJavaScript(settle)
        const image=await win.webContents.capturePage();assert.equal(image.isEmpty(),false);assert.deepEqual(image.getSize(),{width:1920,height:1080})
        const filename=step+'-1920x1080.png';fs.writeFileSync(out+'/'+filename,image.toPNG());screenshots.push(filename)
      }
    }
    fs.writeFileSync(out+'/geometry.json',JSON.stringify({records,screenshots,passed:true},null,2))
    console.log(JSON.stringify({cases:records.length,screenshots,passed:true}))
  }finally{clearTimeout(deadline);win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
