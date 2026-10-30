// Run bundled with esbuild (external:electron) by video-fullscreen-native.run.mjs, in Session 0, muted, with an
// isolated Electron profile. USER 2026-10-30 md731a537e304 "issue, i cant maximize inline videos": a chat video's own
// fullscreen control calls element.requestFullscreen(), and Electron asks the session's permission handler for
// "fullscreen" first. configureEngineSession used to answer yes only to a clipboard write, so every video's
// maximize failed with "Permissions check failed". This runs the REAL configureEngineSession/configureWindow.
import { app, BrowserWindow, session } from 'electron'
import { execFileSync } from 'node:child_process'
import { configureEngineSession, configureWindow } from '../apps/desktop/main/windows'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-videofs-')))
app.commandLine.appendSwitch('mute-audio')
app.disableHardwareAcceleration() // Session 0 has no GPU: without this the GPU process dies and the page never answers
let server: http.Server | undefined
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type Target = Electron.WebFrameMain | Electron.WebContents
/** requestFullscreen on the page's <video id="v"> from a user gesture: what the native fullscreen button does */
const maximize = (target: Target) => target.executeJavaScript(
  `(async()=>{const v=document.getElementById('v');const enabled=document.fullscreenEnabled;try{await Promise.race([v.requestFullscreen(),new Promise((_,no)=>setTimeout(()=>no(new Error('request still pending after 8 s')),8000))]);await new Promise(r=>setTimeout(r,150));return{ok:true,enabled,element:document.fullscreenElement&&document.fullscreenElement.id}}catch(e){return{ok:false,enabled,error:String(e)}}})()`, true) as Promise<{ ok: boolean; enabled?: boolean; element?: string; error?: string }>
const leave = (target: Target) => target.executeJavaScript(
  `(async()=>{if(document.fullscreenElement){await document.exitFullscreen();await new Promise(r=>setTimeout(r,150))}return document.fullscreenElement===null})()`, true)
const focused = async (window: BrowserWindow) => {
  window.show(); window.focus(); window.webContents.focus()
  for (let i = 0; i < 20 && !await window.webContents.executeJavaScript('document.hasFocus()'); i++) await wait(50)
}
const results: Record<string, unknown> = {}
// a page that never answers must fail the probe with what it had by then, not hang until the runner's timeout
const stuck = setTimeout(() => { console.error('RESULTS ' + JSON.stringify(results) + ' STUCK after ' + (results.step ?? 'start')); app.exit(3) }, 90000)
app.whenReady().then(async () => {
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  assert.equal(sessionId, 0, 'Session 0 required before any window')
  server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<html><body><div id="card"><video id="v" controls muted></video></div></body></html>') })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
  const ses = session.fromPartition('videofs-fixture')
  const register = configureEngineSession(ses, origin, 'fixture-token')
  const options = { show: false, width: 640, height: 400, webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } }
  const main = new BrowserWindow(options)
  configureWindow(main, origin, true, register)
  await main.loadURL(origin)
  main.webContents.setAudioMuted(true)
  await focused(main)

  results.step = 'main'
  const inMain = await maximize(main.webContents)
  results.main = inMain
  assert.equal(inMain.ok, true, `a video in the trusted app window can be maximized (${inMain.error ?? ''})`)
  assert.equal(inMain.element, 'v', 'the video itself is the fullscreen element')
  assert.equal(await leave(main.webContents), true, 'Escape / exitFullscreen leaves it')

  await main.webContents.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.srcdoc='<html><body><video id="v" controls muted></video></body></html>';f.onload=()=>resolve(true);document.body.appendChild(f)})`)
  results.step = 'subframe'
  const inFrame = await maximize(main.webContents.mainFrame.frames[0]!)
  results.subframe = inFrame
  assert.equal(inFrame.ok, false, 'a subframe still cannot take the screen')

  const childCreated = new Promise<BrowserWindow>(resolve => main.webContents.once('did-create-window', resolve))
  await main.webContents.executeJavaScript("window.open('about:blank');true", true)
  const child = await childCreated
  await child.webContents.executeJavaScript(`document.body.innerHTML='<video id="v" controls muted></video>';true`)
  await focused(child)
  results.step = 'popout'
  const inChild = await maximize(child.webContents)
  results.popout = inChild
  assert.equal(inChild.ok, true, `a video in a registered pop-out can be maximized (${inChild.error ?? ''})`)
  assert.equal(await leave(child.webContents), true)

  const foreign = new BrowserWindow(options)
  await foreign.loadURL(origin)
  await focused(foreign)
  results.step = 'unregistered'
  const inForeign = await maximize(foreign.webContents)
  results.unregistered = inForeign
  assert.equal(inForeign.ok, false, 'an unregistered same-origin window stays denied')

  assert.equal(await main.webContents.executeJavaScript('navigator.clipboard.readText().then(()=>true,()=>false)', true), false, 'clipboard reads stay denied')
  console.log('VIDEO_FULLSCREEN_NATIVE_PASS ' + JSON.stringify({ sessionId, ...results }))
}).catch(error => { console.error(error); console.error('RESULTS ' + JSON.stringify(results)); process.exitCode = 1 }).finally(() => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  clearTimeout(stuck); server?.close(); app.exit(process.exitCode || 0)
})
