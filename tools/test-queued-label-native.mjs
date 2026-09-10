import {build} from 'esbuild'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-queued-label-'))
await build({entryPoints:['tests/queued-label.probe.tsx'],outfile:path.join(temp,'view.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
fs.copyFileSync('apps/desktop/renderer/src/styles.css',path.join(temp,'styles.css'))
fs.writeFileSync(path.join(temp,'index.html'),'<link rel="stylesheet" href="styles.css"><div id="root"></div><script src="view.js"></script>')
await build({stdin:{contents:`
import {app,BrowserWindow} from 'electron'
import path from 'node:path'
import assert from 'node:assert/strict'
const dir=process.env.ORGTREE_QUEUED_PROBE
app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:700,height:600})
 await w.loadFile(path.join(dir,'index.html'))
 const measure=()=>w.webContents.executeJavaScript(\`[...document.querySelectorAll('.pendrow')].map(p=>{const c=p.querySelector('.turn-mail').getBoundingClientRect(),t=p.querySelector('.pend-tag').getBoundingClientRect();return {below:t.top>=c.bottom-1,full:Math.abs(c.width-p.getBoundingClientRect().width)<1}})\`)
 for(const width of [350,700]){
  w.setSize(width,600);await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const rows=await measure();assert.equal(rows.length,2)
  for(const row of rows){assert.ok(row.below,'receipt below card');assert.ok(row.full,'card keeps full width')}
 }
 await w.webContents.executeJavaScript(\`document.querySelectorAll('.pendrow').forEach(p=>{p.style.display='flex';p.querySelector('.pend-tag').style.whiteSpace='nowrap'})\`)
 assert.ok((await measure()).some(r=>!r.below||!r.full),'old side-gutter control must fail')
 console.log('PASS queued labels below full-width cards at both widths; old side gutter detected')
 w.destroy();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
`,resolveDir:process.cwd(),loader:'ts'},outfile:path.join(temp,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const env={...process.env,ORGTREE_QUEUED_PROBE:temp};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(temp,'probe.cjs')],{env,windowsHide:true,stdio:'inherit'})
const timer=setTimeout(()=>{child.kill();process.exitCode=1},25000)
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1})
