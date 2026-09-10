import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-placement-native-'))
fs.copyFileSync('apps/desktop/renderer/src/styles.css', path.join(root,'styles.css'))
await build({ stdin:{contents:`
import { app, BrowserWindow, screen } from 'electron'
import { WindowPlacement } from './apps/desktop/main/window-placement'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const root = process.env.ORGTREE_PLACEMENT_PROBE
app.setPath('userData',path.join(root,'profile'))
app.disableHardwareAcceleration()
app.on("window-all-closed",()=>{})
app.whenReady().then(async()=>{
 const file=path.join(root,'position.json'), store=new WindowPlacement(file)
 const w=new BrowserWindow({show:false, frame:false, width:900,height:650,x:45,y:55})
 const wait=()=>new Promise(r=>setTimeout(r,150))
 await w.loadURL('data:text/html,<body>Window placement probe</body>')
 w.show(); await wait()
 const initial=w.getNormalBounds()
 store.capture(w)
 w.maximize(); await wait(); assert.equal(w.isMaximized(),true,'environment must support native maximize')
 store.capture(w)
 const areas=screen.getAllDisplays().map(d=>d.workArea)
 const saved=new WindowPlacement(file).restore(areas)
 assert.equal(saved.maximized,true);assert.deepEqual(saved.bounds,initial)
 w.destroy()
 const reopened=new BrowserWindow({show:false,frame:false,...saved.bounds})
 await reopened.loadURL('data:text/html,<body>Reopened window</body>')
 reopened.show();if(saved.maximized)reopened.maximize();await wait()
 assert.equal(reopened.isMaximized(),true)
 reopened.unmaximize();await wait();assert.deepEqual(reopened.getBounds(),initial)
 const html='<style>'+fs.readFileSync(path.join(root,'styles.css'),'utf8')+'</style><div class="settings gallery-modal" style="width:100%;max-width:none"><section class="gallery-agent"><div class="mailer" style="height:450px"><div class="mailer-list">'+('a'.repeat(700))+'</div><div class="mailer-read">Document</div></div></section></div>'
 await reopened.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));await wait()
 const measure=()=>reopened.webContents.executeJavaScript('(()=>{const l=document.querySelector(".mailer-list").getBoundingClientRect(),m=document.querySelector(".mailer").getBoundingClientRect();return l.width/m.width})()')
 assert.ok(await measure()<=1/3+0.002,'presentation list capped with long unbroken title')
 await reopened.webContents.executeJavaScript('document.querySelector(".mailer-list").style.cssText="width:52%;max-width:none;flex:0 0 52%"')
 assert.ok(await measure()>0.5,'old list width is detectable as failing control')
 reopened.destroy();console.log('PASS native maximize/reopen/normal bounds and presentation geometry');app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
`,resolveDir:process.cwd(),loader:'ts'},outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const env={...process.env,ORGTREE_PLACEMENT_PROBE:root};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'probe.cjs')],{env,windowsHide:true,stdio:'inherit'})
const timeout=setTimeout(()=>{child.kill();process.exitCode=1},30000)
child.on('exit',code=>{clearTimeout(timeout);process.exitCode=code??1})
