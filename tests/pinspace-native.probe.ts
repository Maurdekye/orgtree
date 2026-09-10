import {app,BrowserWindow} from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import assert from 'node:assert/strict'
const root=process.env.ORGTREE_PINSPACE_ROOT!
app.disableHardwareAcceleration();app.setPath('userData',path.join(root,'profile'))
app.whenReady().then(async()=>{
  const server=http.createServer((req,res)=>{
    const file=req.url==='/fixture.js'?'fixture.js':req.url==='/fixture.css'?'fixture.css':null
    if(file){res.setHeader('Content-Type',file.endsWith('js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(root,file)));return}
    res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const w=new BrowserWindow({show:false,width:1100,height:800,frame:false,webPreferences:{sandbox:true}})
  await w.loadURL(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)
  const wait=async(code:string)=>{for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript(code))return;await new Promise(r=>setTimeout(r,30))}throw Error(code)}
  await wait(`document.querySelectorAll('.overlay-pinned').length===2`)
  const measure=`(()=>{const vp=document.querySelector('.viewport').getBoundingClientRect();const b=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};const a=document.querySelector('.fixture-docket'),g=document.querySelector('.fixture-gallery');const hud=document.getElementById('hud-button'),r=hud.getBoundingClientRect();return{vp:{x:vp.x,y:vp.y,right:vp.right,bottom:vp.bottom},a:b(a),g:g?b(g):null,za:+getComputedStyle(a.parentElement).zIndex,zg:g?+getComputedStyle(g.parentElement).zIndex:null,zp:+getComputedStyle(document.getElementById('peer-0')).zIndex,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id,drag:getComputedStyle(a.querySelector('.modalpin-bar')).getPropertyValue('-webkit-app-region')}})()`
  let m=await w.webContents.executeJavaScript(measure)
  assert.ok(m.zg>m.za&&m.za>m.zp,'new pins start frontmost')
  assert.equal(m.hit,'hud-button','canvas controls remain above overlapping pins')
  assert.equal(m.drag.trim(),'no-drag','modal drag remains renderer pointer input')
  for(const width of [1100,650]){
    w.setSize(width,650);await new Promise(r=>setTimeout(r,120));m=await w.webContents.executeJavaScript(measure)
    for(const r of [m.a,m.g])assert.ok(r.x>=m.vp.x&&r.y>=m.vp.y&&r.right<=m.vp.right&&r.bottom<=m.vp.bottom,JSON.stringify(m))
    assert.equal(m.hit,'hud-button')
  }
  // Force the wrong layer as a positive control for the hit-test detector.
  const bad=await w.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.pin-layer');const z=p.style.zIndex;p.style.zIndex='99';const r=document.getElementById('hud-button').getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id;p.style.zIndex=z;return hit})()`)
  assert.notEqual(bad,'hud-button','higher pins really intercept the control')
  await w.webContents.executeJavaScript(`window.togglePin()`);await wait(`!document.querySelector('.fixture-gallery')`)
  // Raise the other pin, then reopen: the reopened one must again be above it.
  await w.webContents.executeJavaScript(`document.querySelector('.fixture-docket').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));window.togglePin()`)
  await wait(`!!document.querySelector('.fixture-gallery')`)
  m=await w.webContents.executeJavaScript(measure);assert.ok(m.zg>m.za,'reopened pin rises above existing pins')
  // Exercise counts that produced invalid fractional CSS ranks, plus >7 pins.
  for (const n of [4,5,7,20]) {
    await w.webContents.executeJavaScript(`window.setCount(${n-2})`)
    await wait(`document.querySelectorAll('.pinwin').length===${n-2}`)
    await new Promise(r=>setTimeout(r,50))
    const ranks = await w.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pin-layer .pinwin,.pin-layer .overlay-pinned')).map(e=>Number(getComputedStyle(e).zIndex))`)
    assert.equal(ranks.length,n)
    assert.ok(ranks.every(Number.isInteger),'Chromium must accept every integer z-index')
    assert.equal(new Set(ranks).size,n,'every window has a distinct rank')
    for (const i of [0,n-3,1]) {
      await w.webContents.executeJavaScript(`document.getElementById('peer-${i}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
      await new Promise(r=>setTimeout(r,30))
      const hit = await w.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.viewport').getBoundingClientRect();return document.elementFromPoint(r.x+180,r.y+180)?.closest('.pinwin')?.id})()`)
      assert.equal(hit,`peer-${i}`,'the clicked window wins hit testing at every count')
      m=await w.webContents.executeJavaScript(measure);assert.equal(m.hit,'hud-button')
    }
  }
  console.log('PINSPACE_NATIVE_PASS bounds, shared layers, frontmost reopen, unobstructed canvas controls; positive control detected')
  w.destroy();server.close();app.exit(0)
}).catch(e=>{console.error(e);app.exit(1)})
setTimeout(()=>{console.error('pinspace probe timed out');app.exit(1)},45000).unref()
