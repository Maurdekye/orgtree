import { app, BrowserWindow } from 'electron'
import path from 'node:path'

// Seed only; shell owner adds managed engine, tray and validated bridge next.
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 840, show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  void window.loadFile(path.join(__dirname, '../renderer/index.html'))
})
