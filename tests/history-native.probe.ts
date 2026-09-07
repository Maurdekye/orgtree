import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { configureEngineSession, configureWindow, configureArtifactSession } from '../apps/desktop/main/windows'

const root=process.env.ORGTREE_HISTORY_TEST_ROOT!
app.setPath('userData',path.join(root,'profile'))
const token='history-native-private-fixture'
const seen: {url:string, signed:boolean}[]=[]
let server:http.Server
app.whenReady().then(async()=>{
  const md='# original native download\r\n'
  server=http.createServer((req,res)=>{
    const url=new URL(req.url!,'http://localhost')
    const signed=req.headers['x-orgtree-desktop-token']===token
    seen.push({url:url.pathname,signed})
    if(!signed){res.setHeader('Access-Control-Allow-Origin','*');res.writeHead(401);res.end('unsigned');return}
    if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end('<div id="mount"></div><script src="/history.js"></script>');return}
    if(url.pathname==='/history.js'){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(root,'history.js')));return}
    if(url.pathname.endsWith('/download')) {res.setHeader('Content-Type','text/markdown');res.setHeader('Content-Disposition','attachment; filename="native-source.md"');res.end(md);return}
    if(url.pathname.endsWith('/mockup')) {res.setHeader('Content-Type','text/html');res.end('<h1>Native history HTML viewer</h1>');return}
    res.setHeader('Content-Type','application/json')
    if(url.pathname.endsWith('/history')) res.end(JSON.stringify({collections:[{id:'documents',label:'Presented documents',needs_node:false}],nodes:[]}))
    else if(url.pathname.endsWith('/documents')) res.end(JSON.stringify({total:2,next_cursor:null,items:[{id:'md',title:'Saved markdown',body:md,format:'markdown'},{id:'html',title:'Saved HTML',body:'',format:'html'}]}))
    else res.end(JSON.stringify({total:0,next_cursor:null,items:[]}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const register=configureEngineSession(session.defaultSession,origin,token)
  const completed:{url:string,window:number|undefined}[]=[]
  session.defaultSession.webRequest.onCompleted(details=>{completed.push({url:details.url,window:details.webContentsId})})
  let viewer:BrowserWindow|undefined
  const main=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}})
  configureWindow(main,origin,true,register,url=>{
    const art=session.fromPartition('history-artifact')
    configureArtifactSession(art,url,origin,token)
    viewer=new BrowserWindow({show:false,webPreferences:{session:art,sandbox:true,nodeIntegration:false,contextIsolation:true}})
    void viewer.loadURL(url)
  })
  await main.loadURL(origin)
  async function waitFor(code:string){for(let i=0;i<100;i++){if(await main.webContents.executeJavaScript(code))return;await new Promise(r=>setTimeout(r,25))}throw new Error(`Timed out: ${code}`)}
  await waitFor('Boolean(document.querySelector("select option[value=documents]"))')
  await main.webContents.executeJavaScript(`document.querySelector('select').value='documents';document.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));true`)
  await waitFor('document.querySelectorAll(".document-download").length===2')
  const childReady=new Promise<BrowserWindow>(resolve=>main.webContents.once('did-create-window',resolve))
  await main.webContents.executeJavaScript(`window.historyChild=window.open('about:blank','history-popout');const base=historyChild.document.createElement('base');base.href=document.baseURI;historyChild.document.head.appendChild(base);historyChild.document.body.appendChild(document.getElementById('mount'));true`)
  const child=await childReady
  const unsigned=await child.webContents.executeJavaScript(`fetch(${JSON.stringify(origin+'/api/unsigned-control?unique=1')}).then(r=>r.status)`)
  // Chromium may attribute a trusted adopted frame's fetch to its owning
  // main window. Record that behavior; an unregistered window must fail.
  const outsider=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}})
  await outsider.loadURL('about:blank')
  const denied=await outsider.webContents.executeJavaScript(`fetch(${JSON.stringify(origin+'/api/unregistered-control')}).then(r=>r.status)`)
  assert.equal(denied,401)
  assert.ok(seen.some(r=>r.url==='/api/unregistered-control'&&!r.signed),'actual negative request reached server unsigned')
  outsider.destroy()
  const download=new Promise<string>((resolve,reject)=>{
    session.defaultSession.once('will-download',(_event,item)=>{
      assert.equal(item.getFilename(),'native-source.md')
      const file=path.join(root,item.getFilename());item.setSavePath(file)
      item.once('done',(_e,state)=>state==='completed'?resolve(file):reject(new Error(state)))
    })
  })
  await main.webContents.executeJavaScript(`historyChild.document.querySelector('.document-download').click();true`)
  const file=await download
  assert.equal(fs.readFileSync(file,'utf8'),md)
  assert.ok(seen.some(r=>r.url.endsWith('/md/download')&&r.signed),'History download fetched with engine auth')
  assert.ok(completed.some(r=>r.url.endsWith('/md/download')&&r.window===main.webContents.id),'History download request belongs to authoritative main window')
  await main.webContents.executeJavaScript(`historyChild.document.querySelector('.mockup-open a').click();true`)
  for(let i=0;i<100&&(!viewer||viewer.webContents.isLoading());i++)await new Promise(r=>setTimeout(r,25))
  assert.ok(viewer,'History HTML action opened the supported artifact viewer')
  assert.match(await viewer!.webContents.executeJavaScript('document.body.textContent'),/Native history HTML viewer/)
  assert.equal(await viewer!.webContents.executeJavaScript('typeof window.orgtreeDesktop'),'undefined')
  assert.equal(await viewer!.webContents.executeJavaScript('typeof require'),'undefined')
  assert.ok(seen.some(r=>r.url.endsWith('/html/mockup')&&r.signed))
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({downloadBytes:true,serverFilename:true,popoutFetchStatus:unsigned,unregisteredWindowUnsigned:true,mainFrameFetch:true,htmlArtifactViewer:true,viewerNoBridge:true,mainWindow:main.webContents.id,popoutWindow:child.webContents.id,completed,seen},null,2))
  console.log('HISTORY_NATIVE_PASS '+root)
  for(const w of BrowserWindow.getAllWindows())w.destroy()
  server.close();app.exit(0)
}).catch(error=>{console.error(error);for(const w of BrowserWindow.getAllWindows())w.destroy();server?.close();app.exit(1)})
setTimeout(()=>{console.error('History native test timed out');app.exit(1)},30000).unref()
