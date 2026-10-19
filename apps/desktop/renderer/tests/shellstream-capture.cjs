const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),http=require('node:http')
const output=process.env.SHELL_STREAM_OUT
if(!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(output||''))throw Error('Own output required')
app.setPath('userData',path.join(output,'user-data'));app.disableHardwareAcceleration()
const paint=async w=>{await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))')}
app.whenReady().then(async()=>{
 let w,server
 const deadline=setTimeout(()=>{if(w&&!w.isDestroyed())w.destroy();app.exit(2)},20000)
 try{
  const files={'/':['text/html','<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'],
   '/fixture.js':['text/javascript',fs.readFileSync(path.join(output,'fixture.js'))],'/styles.css':['text/css',fs.readFileSync(process.env.SHELL_STREAM_STYLE)],'/katex/dist/katex.min.css':['text/css',fs.readFileSync(process.env.SHELL_STREAM_KATEX)]}
  server=http.createServer((req,res)=>{const f=files[(req.url||'').split('?')[0]];res.writeHead(f?200:404,{'content-type':f?.[0]||'text/plain'});res.end(f?.[1]||'Synthetic only')})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  w=new BrowserWindow({show:false,width:1000,height:700,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}})
  await w.loadURL('http://127.0.0.1:'+server.address().port+'/');await paint(w)
  await w.webContents.executeJavaScript(`document.querySelectorAll('.tline')[0].click();document.querySelectorAll('.tline')[1].click();true`);await paint(w)
  const before=await w.webContents.executeJavaScript(`document.querySelector('.tool-live-output pre')?.textContent`)
  if(!before?.includes('Preparing workspace'))throw Error('First live chunk was not displayed')
  await w.webContents.executeJavaScript('window.shellStreamStep(2);true');await paint(w)
  const result=await w.webContents.executeJavaScript(`({count:document.querySelectorAll('.tool-live-output').length,text:document.body.innerText,bg:getComputedStyle(document.body).backgroundColor})`)
  if(result.count!==2||!result.text.includes('Validated 42 files')||!result.text.includes('Native controls: 8 passed')||result.text.includes('COLLAPSED_BYTES'))throw Error('Incremental/collapsed capture checks failed')
  const image=await w.webContents.capturePage();if(image.isEmpty())throw Error('Empty capture')
  const rgb=result.bg.match(/\d+/g).slice(0,3).map(Number),pixel=image.toBitmap()
  if(pixel[0]!==rgb[2]||pixel[1]!==rgb[1]||pixel[2]!==rgb[0])throw Error('Stale capture palette')
  fs.writeFileSync(path.join(output,'shell-stream.png'),image.toPNG());fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({before,...result,width:image.getSize().width,height:image.getSize().height},null,2))
 }finally{clearTimeout(deadline);if(w&&!w.isDestroyed())w.destroy();if(server)await new Promise(r=>server.close(r))}
}).then(()=>app.exit(0),e=>{fs.writeFileSync(path.join(output,'instrument-error.txt'),e.stack||String(e));console.error(e);app.exit(2)})
