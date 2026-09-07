import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopEvent } from '../../../packages/contracts/index'

// Blank portals inherit webPreferences but never receive their own bridge.
if (process.isMainFrame && location.protocol === 'http:' && location.hostname === '127.0.0.1' && (location.pathname === '/' || location.pathname === '/index.html')) {
  const bridge: DesktopBridge = {
    getStatus: () => ipcRenderer.invoke('desktop:status'),
    getPreferences: () => ipcRenderer.invoke('desktop:preferences'),
    setPreferences: patch => ipcRenderer.invoke('desktop:set-preferences', patch),
    showMainWindow: () => ipcRenderer.invoke('desktop:show'),
    quit: () => ipcRenderer.invoke('desktop:quit'),
    getHarnesses: () => ipcRenderer.invoke('desktop:harnesses'),
    openHarnessLink: id => ipcRenderer.invoke('desktop:open-harness', id),
    onEvent: listener => {
      const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => listener(event)
      ipcRenderer.on('desktop:event', handler)
      return () => ipcRenderer.removeListener('desktop:event', handler)
    },
  }
  contextBridge.exposeInMainWorld('orgtreeDesktop', bridge)
}
