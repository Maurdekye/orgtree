import { app, BrowserWindow, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { Preferences } from '../apps/desktop/main/preferences'
import { configureEngineSession, configureWindow } from '../apps/desktop/main/windows'
const root=process.env.ORGTREE_THEME_TEST_ROOT!
app.disableHardwareAcceleration()
app.setPath('userData',path.join(root,'profile'))
let server:http.Server
app.whenReady().then(async()=>{
  async function screenshot(w:BrowserWindow) {
    try { return (await w.webContents.capturePage()).toPNG() }
    catch {
      w.webContents.debugger.attach('1.3')
      try { const result=await w.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false});return Buffer.from(result.data,'base64') }
      finally { w.webContents.debugger.detach() }
    }
  }
  const file=path.join(root,'preferences.json'),prefs=new Preferences(file)
  const effectiveThemes:string[]=[]
  ipcMain.handle('desktop:preferences',()=>prefs.get())
  ipcMain.handle('desktop:window-state',()=>({visible:true,restoreWindows:false}))
  ipcMain.handle('desktop:set-effective-theme',(_event,theme)=>{
    assert.ok(['orgtree','claude','codex','antigravity','openrouter'].includes(theme),'invalid effective theme')
    effectiveThemes.push(theme)
  })
  ipcMain.handle('desktop:set-preferences',(_e,patch)=>{
    const next=prefs.set(patch)
    for(const w of BrowserWindow.getAllWindows())w.webContents.send('desktop:event',{type:'preferences',data:next})
    return next
  })
  server=http.createServer((req,res)=>{
    if(req.url==='/themes.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(root,'themes.js')));return}
    if(req.url==='/themes.css'){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,'themes.css')));return}
    res.setHeader('Content-Type','text/html');res.end('<link rel="stylesheet" href="/themes.css"><div id="root"></div><script src="/themes.js"></script>')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const register=configureEngineSession(session.defaultSession,origin,'theme-fixture')
  const main=new BrowserWindow({show:false,width:1000,height:760,webPreferences:{preload:path.join(root,'preload.cjs'),additionalArguments:[`--orgtree-ui-origin=${origin}`],sandbox:true,nodeIntegration:false,contextIsolation:true}})
  configureWindow(main,origin,true,register,()=>{})
  main.webContents.on('console-message',event=>console.log('renderer',event.message))
  await main.loadURL(origin)
  async function waitFor(w:BrowserWindow,code:string){for(let i=0;i<120;i++){if(await w.webContents.executeJavaScript(code))return;await new Promise(r=>setTimeout(r,25))}throw Error(`Timed out ${code}`)}
  await waitFor(main,'document.querySelector("select")?.disabled===false')
  const inspect=`(()=>{const root=getComputedStyle(document.documentElement),panel=document.querySelector('.settings').getBoundingClientRect();return {accent:root.getPropertyValue('--accent').trim(),ok:root.getPropertyValue('--ok').trim(),bad:root.getPropertyValue('--bad').trim(),font:getComputedStyle(document.querySelector('.settings')).fontFamily,background:getComputedStyle(document.querySelector('.settings')).backgroundColor,button:getComputedStyle(document.querySelector('.primary')).backgroundColor,provider:getComputedStyle(document.querySelector('.prov-openai')).getPropertyValue('--accent').trim(),width:panel.width,height:panel.height,text:document.querySelector('.settings').textContent,draft:document.querySelector('textarea').value}})()`
  console.log('stage: initial inspect')
  const before=await main.webContents.executeJavaScript(inspect)
  assert.equal(before.accent,'#d97757','fresh native startup uses the Claude fallback palette')
  assert.equal(before.provider,'#22c4bd','real provider identity positive control')
  await new Promise(r=>setTimeout(r,300))
  fs.writeFileSync(path.join(root,'neutral-main.png'),await screenshot(main))
  console.log('stage: initial capture done')
  const ready=new Promise<BrowserWindow>(resolve=>main.webContents.once('did-create-window',resolve))
  await main.webContents.executeJavaScript(`document.querySelector('[aria-label="Open in new window"]').click();true`)
  const child=await ready
  console.log('stage: child opened')
  await waitFor(child,'document.querySelector("select")?.disabled===false')
  await waitFor(child,`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()==='#d97757'`)
  const neutralChild=await child.webContents.executeJavaScript(inspect)
  await new Promise(r=>setTimeout(r,800))
  for(const key of ['font','background'])assert.equal(neutralChild[key],before[key],`child stylesheet ${key}`)
  fs.writeFileSync(path.join(root,'neutral-popout.png'),await screenshot(child))
  for(const [id,color]of Object.entries({claude:'#d97757',codex:'#22c4bd',antigravity:'#75a5ff',openrouter:'#b69afa'})){
    await child.webContents.executeJavaScript(`(()=>{const s=document.querySelector('select');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    await waitFor(child,`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()===${JSON.stringify(color)}`)
    assert.equal(await main.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`),color)
    await new Promise(r=>setTimeout(r,220))
    const after=await child.webContents.executeJavaScript(inspect)
    for(const key of ['ok','bad','provider','font','background','width','height','text','draft'])assert.equal(after[key],neutralChild[key],`${id} preserves ${key}`)
    assert.equal(new Preferences(file).get().visualTheme,id)
    fs.writeFileSync(path.join(root,`${id}-popout.png`),await screenshot(child))
  }
  assert.ok(effectiveThemes.includes('claude'),'native bridge receives the Claude fallback')
  for(const id of ['claude','codex','antigravity','openrouter'])assert.ok(effectiveThemes.includes(id),'native bridge receives '+id+' changes')
  await child.webContents.executeJavaScript(`document.querySelector('[aria-label="Return to main window"]').click();true`)
  await waitFor(main,'!!document.querySelector("select")')
  const after=await main.webContents.executeJavaScript(inspect)
  for(const key of ['ok','bad','provider','font','background','width','height','text','draft'])assert.equal(after[key],before[key],`redock preserves ${key}`)
  fs.writeFileSync(path.join(root,'openrouter-main.png'),await screenshot(main))
  await main.reload()
  await waitFor(main,'document.querySelector("select")?.value==="openrouter"')
  const evidence={pass:true,root,before,after,persisted:new Preferences(file).get(),effectiveThemes,checks:['real production preload and Preferences','validated set-effective-theme bridge receives fallback and explicit changes','actual PinFrame popout and redock','all four provider accents update both windows','status/provider/layout/draft unchanged','reload restored saved theme']}
  fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
  main.destroy();server.close();app.exit(0)
}).catch(e=>{console.error(e);server?.close();app.exit(1)})
