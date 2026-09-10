import {build} from 'esbuild'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
if(process.platform!=='win32')throw Error('INERT: Windows shell required')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-taskbar-'))
const helper=path.resolve('tests/native-shell-properties.py'),icon=path.resolve('apps/desktop/assets/orgtree-eye.ico')
await build({stdin:{contents:`
import {app,BrowserWindow,nativeImage} from 'electron'
import {appUserModelId,configureTaskbar} from './apps/desktop/main/taskbar'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
app.setPath('userData',${JSON.stringify(path.join(root,'profile'))})
app.whenReady().then(async()=>{
 assert.notEqual(appUserModelId(false),appUserModelId(true),'development cannot share production shell identity')
 assert.equal(appUserModelId(true),'com.maurdekye.orgtree')
 const w=new BrowserWindow({show:false,icon:${JSON.stringify(icon)}})
 const hwnd=w.getNativeWindowHandle().readBigUInt64LE().toString()
 const read=()=>new Promise((resolve,reject)=>{const p=spawn('python',[${JSON.stringify(helper)},hwnd],{windowsHide:true});let s='',e='';p.stdout.on('data',x=>s+=x);p.stderr.on('data',x=>e+=x);p.on('error',reject);p.on('exit',code=>code?reject(Error(e)):resolve(JSON.parse(s)))})
 const before=await read();assert.notEqual(before['5'],'com.maurdekye.orgtree','control has no shell identity')
 assert.equal(nativeImage.createFromPath(${JSON.stringify(icon)}).isEmpty(),false)
 configureTaskbar(w,process.execPath,${JSON.stringify(icon)},'com.maurdekye.orgtree.native-test')
 const after=await read();assert.equal(after['5'],'com.maurdekye.orgtree.native-test');assert.equal(after['2'],'"'+process.execPath+'"');assert.equal(after['4'],'Orgtree');assert.equal(after['3'],${JSON.stringify(icon)}+',0')
 console.log('PASS native shell relaunch command, display name, app ID and readable unpacked icon; missing-properties control detected')
 w.destroy();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
`,resolveDir:process.cwd(),loader:'ts'},outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'probe.cjs')],{env,windowsHide:true,stdio:'inherit'})
const timeout=setTimeout(()=>{child.kill();process.exitCode=1},25000)
child.on('error',e=>{clearTimeout(timeout);console.error(e);process.exitCode=1})
child.on('exit',code=>{clearTimeout(timeout);process.exitCode=code??1})
