import { isAppPath } from '../../../packages/contracts/ui-route'
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopEvent, LoginProvider } from '../../../packages/contracts/index'

// Blank portals inherit webPreferences but never receive their own bridge.
const expectedOrigin = process.argv.find(arg => arg.startsWith('--orgtree-ui-origin='))?.slice('--orgtree-ui-origin='.length)
if (process.isMainFrame && expectedOrigin && location.origin === expectedOrigin && isAppPath(location.pathname)) {
  const bridge: DesktopBridge = {
    getAppVersion: () => ipcRenderer.invoke('desktop:app-version'),
    installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
    getStatus: () => ipcRenderer.invoke('desktop:status'),
    getWindowState: () => ipcRenderer.invoke('desktop:window-state'),
    getWindowControlsState: () => ipcRenderer.invoke('desktop:window-controls-state'),
    getPreferences: () => ipcRenderer.invoke('desktop:preferences'),
    setPreferences: patch => ipcRenderer.invoke('desktop:set-preferences', patch),
    setEffectiveTheme: theme => ipcRenderer.invoke('desktop:set-effective-theme', theme),
    showMainWindow: () => ipcRenderer.invoke('desktop:show'),
    quit: () => ipcRenderer.invoke('desktop:quit'),
    minimizeWindow: () => ipcRenderer.invoke('desktop:window-minimize'),
    toggleMaximizeWindow: () => ipcRenderer.invoke('desktop:window-toggle-maximize'),
    closeWindow: () => ipcRenderer.invoke('desktop:window-close'),
    getHarnesses: () => ipcRenderer.invoke('desktop:harnesses'),
    notify: notification => ipcRenderer.invoke('desktop:notify', notification),
    syncNotifications: active => ipcRenderer.invoke('desktop:sync-notifications', active),
    openHarnessLink: id => ipcRenderer.invoke('desktop:open-harness', id),
    openCharterFolder: () => ipcRenderer.invoke('desktop:open-charter-folder'),
    getUpdateStatus: () => ipcRenderer.invoke('desktop:update-status'),
    getUpdateCapability: () => ipcRenderer.invoke('desktop:update-capability'),
    getPopoutState: (name: string) => ipcRenderer.invoke('desktop:popout-state', name),
    minimizePopout: (name: string) => ipcRenderer.invoke('desktop:popout-minimize', name),
    toggleMaximizePopout: (name: string) => ipcRenderer.invoke('desktop:popout-toggle-maximize', name),
    closePopout: (name: string) => ipcRenderer.invoke('desktop:popout-close', name),
    focusPopout: (name: string) => ipcRenderer.invoke('desktop:popout-focus', name),
    checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
    startProviderLogin: (provider: LoginProvider, opts?: { profileDir?: string; accountId?: string }) =>
      ipcRenderer.invoke('desktop:provider-login-start', provider, opts),
    getProviderLoginStatus: (provider: LoginProvider) => ipcRenderer.invoke('desktop:provider-login-status', provider),
    submitProviderLoginCode: (provider: LoginProvider, code: string) =>
      ipcRenderer.invoke('desktop:provider-login-code', provider, code),
    cancelProviderLogin: (provider: LoginProvider) => ipcRenderer.invoke('desktop:provider-login-cancel', provider),
    onEvent: listener => {
      const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => listener(event)
      ipcRenderer.on('desktop:event', handler)
      return () => ipcRenderer.removeListener('desktop:event', handler)
    },
  }
  contextBridge.exposeInMainWorld('orgtreeDesktop', bridge)
}
