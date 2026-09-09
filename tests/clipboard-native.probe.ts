// Run bundled with esbuild (external:electron), using an isolated Electron profile.
import { app, BrowserWindow, session, clipboard, ClipboardItem } from 'electron'
import { configureEngineSession, configureWindow } from '../apps/desktop/main/windows'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-clipboard-')))
let server: http.Server | undefined
let saved: ClipboardItem[] = []
const hasText = async (text: string) => {
  for (let i = 0; i < 20; i++) {
    if (await clipboard.readText() === text) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}
const write = async (window: BrowserWindow, text: string) => {
  window.show(); window.focus(); window.webContents.focus()
  for (let i = 0; i < 20 && !await window.webContents.executeJavaScript('document.hasFocus()'); i++) await new Promise(resolve => setTimeout(resolve, 50))
  return window.webContents.executeJavaScript(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(()=>true,()=>false)`, true)
}
app.whenReady().then(async () => {
  // Preserve all readable clipboard formats, never print the user's clipboard.
  saved = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))))
  server = http.createServer((_request, response) => response.end('<html><body>Clipboard fixture</body></html>'))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
  const ses = session.fromPartition('clipboard-fixture')
  const register = configureEngineSession(ses, origin, 'fixture-token')
  const options = { show: false, width: 400, height: 180, webPreferences: { session: ses, sandbox: true, contextIsolation: true } }
  const main = new BrowserWindow(options)
  configureWindow(main, origin, true, register)
  await main.loadURL(origin)
  assert.equal(await write(main, 'copy-me-exactly'), true, 'trusted app copy must resolve')
  assert.equal(await hasText('copy-me-exactly'), true, 'text must reach the real native clipboard')
  assert.equal(await main.webContents.executeJavaScript('navigator.clipboard.readText().then(()=>true,()=>false)', true), false, 'reads stay denied')
  await main.webContents.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.srcdoc='<html><body>embedded fixture</body></html>';f.onload=()=>resolve(true);document.body.appendChild(f)})`)
  assert.equal(await main.webContents.mainFrame.frames[0].executeJavaScript("navigator.clipboard.writeText('forbidden-frame').then(()=>true,()=>false)", true), false, 'subframe copy stays denied')
  const childCreated = new Promise<BrowserWindow>(resolve => main.webContents.once('did-create-window', resolve))
  await main.webContents.executeJavaScript("window.open('about:blank');true", true)
  const child = await childCreated
  assert.equal(await write(child, 'popout-copy'), true, 'registered popout copy must resolve')
  assert.equal(await hasText('popout-copy'), true)
  const foreign = new BrowserWindow(options)
  await foreign.loadURL(origin)
  assert.equal(await write(foreign, 'forbidden-window'), false, 'unregistered same-origin window stays denied')
  assert.equal(await hasText('popout-copy'), true, 'denied requests cannot change clipboard')
  console.log('CLIPBOARD_NATIVE_PASS main/popout writes; read/subframe/unregistered denied')
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  try { if (saved.length) await clipboard.write(saved); else clipboard.clear() }
  finally { for (const window of BrowserWindow.getAllWindows()) window.destroy(); server?.close(); app.exit(process.exitCode || 0) }
})
