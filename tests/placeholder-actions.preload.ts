// The native bridge the probe's page gets. The four popout commands are the
// ones a packaged window exposes, wired here to the SAME ipc channel names
// main/index.ts uses, and answered in the probe by the REAL popoutRegistry
// from main/windows.ts — so "reveal this window" is resolved from a frame
// name to a native window exactly as it is in the shipped app.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orgtreeDesktop', {
  onEvent: () => () => {},
  getPreferences: () => Promise.resolve({}),
  setPreferences: () => Promise.resolve({}),
  getPopoutState: (name: string) => ipcRenderer.invoke('desktop:popout-state', name),
  minimizePopout: (name: string) => ipcRenderer.invoke('desktop:popout-minimize', name),
  toggleMaximizePopout: (name: string) => ipcRenderer.invoke('desktop:popout-toggle-maximize', name),
  closePopout: (name: string) => ipcRenderer.invoke('desktop:popout-close', name),
  focusPopout: (name: string) => ipcRenderer.invoke('desktop:popout-focus', name),
})
