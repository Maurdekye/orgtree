import { isAppPath } from '../../../packages/contracts/ui-route'
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopEvent } from '../../../packages/contracts/index'

// Blank portals inherit webPreferences but never receive their own bridge.
const expectedOrigin = process.argv.find(arg => arg.startsWith('--orgtree-ui-origin='))?.slice('--orgtree-ui-origin='.length)
if (process.isMainFrame && expectedOrigin && location.origin === expectedOrigin && isAppPath(location.pathname)) {
  const bridge: DesktopBridge = {
    getStatus: () => ipcRenderer.invoke('desktop:status'),
    getWindowState: () => ipcRenderer.invoke('desktop:window-state'),
    getPreferences: () => ipcRenderer.invoke('desktop:preferences'),
    setPreferences: patch => ipcRenderer.invoke('desktop:set-preferences', patch),
    showMainWindow: () => ipcRenderer.invoke('desktop:show'),
    quit: () => ipcRenderer.invoke('desktop:quit'),
    getHarnesses: () => ipcRenderer.invoke('desktop:harnesses'),
    notify: notification => ipcRenderer.invoke('desktop:notify', notification),
    openHarnessLink: id => ipcRenderer.invoke('desktop:open-harness', id),
    onEvent: listener => {
      const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => listener(event)
      ipcRenderer.on('desktop:event', handler)
      return () => ipcRenderer.removeListener('desktop:event', handler)
    },
  }
  contextBridge.exposeInMainWorld('orgtreeDesktop', bridge)
}
