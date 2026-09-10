import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-header-drag-'))
fs.copyFileSync('apps/desktop/renderer/src/styles.css',path.join(root,'styles.css'))
await build({stdin:{contents:`
import {app,BrowserWindow} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root=process.env.ORGTREE_DRAG_PROBE
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,frame:false,width:1000,height:500})
 const html='<style>'+fs.readFileSync(path.join(root,'styles.css'),'utf8')+'</style><header class="orgbar native-header"><div class="native-header-main"><span class="orgname-wrap">Orgtree</span><span class="chip">Cost</span><button class="chip">Menu</button><a href="#">Link</a><input><select><option>A</option></select><span role="button">Action</span></div><div class="window-controls"><button class="window-control">Close</button></div></header>'
 await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html))
 const measure=()=>w.webContents.executeJavaScript('Object.fromEntries(["header",".orgname-wrap","span.chip","button.chip","a","input","select","[role=button]",".window-control"].map(s=>[s,getComputedStyle(document.querySelector(s)).getPropertyValue("-webkit-app-region")]))')
 const got=await measure()
 for(const key of ['header','.orgname-wrap','span.chip'])assert.equal(got[key],'drag',key)
 for(const key of ['button.chip','a','input','select','[role=button]','.window-control'])assert.equal(got[key],'no-drag',key)
 await w.webContents.executeJavaScript('document.querySelector(".orgname-wrap").style.webkitAppRegion="no-drag";document.querySelector("span.chip").style.webkitAppRegion="no-drag"')
 const old=await measure();assert.notEqual(old['span.chip'],'drag','old exclusion must fail the check')
 console.log('PASS native header static drag regions and interactive exclusions; old exclusion detected')
 w.destroy();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
`,resolveDir:process.cwd(),loader:'ts'},outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const env={...process.env,ORGTREE_DRAG_PROBE:root};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'probe.cjs')],{env,windowsHide:true,stdio:'inherit'})
const timeout=setTimeout(()=>{child.kill();process.exitCode=1},20000)
child.on('exit',code=>{clearTimeout(timeout);process.exitCode=code??1})
