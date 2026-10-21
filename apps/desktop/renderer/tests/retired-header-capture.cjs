const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.RETIRED_HEADER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules',red=process.env.RETIRED_HEADER_RED==='1'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('own output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/retired-header-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))'
app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
const records=[],failures=[]
try{
win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
await win.loadFile(out+'/fixture.html')
for(const kind of ['agent','project'])for(const [count,dogs]of [[1,1],[624,123],[9999,8]]){
await win.webContents.executeJavaScript(`(async()=>{const end=performance.now()+5000;while(!window.retiredHeaderFixture){if(performance.now()>end)throw Error('missing fixture');await new Promise(r=>setTimeout(r,20))}window.retiredHeaderFixture.render('${kind}',${count},${dogs});await new Promise(r=>setTimeout(r,650))})()`)
for(const theme of ['dark','light'])for(const scale of [0.4,0.7,1,1.5]){
const seen=await win.webContents.executeJavaScript(`(async()=>{
document.documentElement.classList.toggle('contrast-light',${theme==='light'})
const card=document.querySelector('.sq[data-copy-agent-name="owner"]'),space=document.querySelector('.space'),vp=document.querySelector('.viewport')
if(!card||!space)throw Error('owner not rendered')
// Scale the actual world DOM to measure its layout rectangles independently
// of the camera's focus/LOD transition. No rectangle is stubbed.
const m=new DOMMatrixReadOnly(card.style.transform),z=${scale},r=vp.getBoundingClientRect()
space.style.transform='translate('+(r.width/2-(m.e+62)*z)+'px,'+(r.height/2-(m.f+62)*z)+'px) scale('+z+')'
await ${settle}
const token=document.querySelector('.retired-token[data-retired-parent="owner"]'),chips=[...document.querySelectorAll('.wd-chip')]
if(!token||!chips.length)throw Error('required retired/watchdog targets absent')
const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}
const overlap=(a,b)=>Math.min(a.right,b.right)>Math.max(a.x,b.x)+.1&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+.1
const a=rect(token),b=rect(card),others=chips.map(rect),point={x:a.x+a.width/2,y:a.y+a.height/2},hit=document.elementFromPoint(point.x,point.y)
return{token:a,card:b,dogs:others,overlap:others.some(c=>overlap(a,c)),inHeader:!!token.closest('.sq-badges'),inOwner:card.contains(token),hit:!!hit&&(hit===token||token.contains(hit)),text:token.textContent,title:token.title,style:{fontSize:getComputedStyle(token).fontSize,padding:getComputedStyle(token).padding,borderRadius:getComputedStyle(token).borderRadius},next:[...document.querySelectorAll('.sq.project')].filter(c=>c!==card).map(rect)}
})()`)
records.push({kind,count,dogs,theme,scale,...seen})
if(seen.overlap)failures.push({kind,count,dogs,theme,scale,reason:'retired/watchdog rectangles intersect'})
if(!red){assert.equal(seen.inHeader,true);assert.equal(seen.inOwner,true);assert.equal(seen.hit,true);assert.equal(seen.overlap,false)}
if(scale===1&&count===624&&theme==='dark'){
await win.webContents.executeJavaScript(settle);const frame=await win.webContents.capturePage();assert.equal(frame.isEmpty(),false);fs.writeFileSync(out+`/${kind}-${theme}.png`,frame.toPNG())
}
}
if(!red){
const behavior=await win.webContents.executeJavaScript(`(async()=>{const token=document.querySelector('.retired-token[data-retired-parent="owner"]');token.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));await ${settle};const labels=[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(b=>b.textContent);token.click();await ${settle};return{labels,picker:!!document.querySelector('.pile-name'),reads:window.retiredHeaderFixture.reads.filter(u=>u.includes('/retired'))}})()`)
assert.deepEqual(behavior.labels,['Open retired list']);assert.equal(behavior.picker,true);assert.ok(behavior.reads.some(u=>u.includes('parent=owner')))
await win.webContents.executeJavaScript(`document.querySelector('.overlay')?.click()`)
}
}
fs.writeFileSync(out+'/geometry.json',JSON.stringify({records,failures},null,2))
assert.equal(failures.length,0,JSON.stringify(failures.slice(0,5)))
}finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
