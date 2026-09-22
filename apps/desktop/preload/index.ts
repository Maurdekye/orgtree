import { isAppPath } from '../../../packages/contracts/ui-route'
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopEvent, LoginProvider } from '../../../packages/contracts/index'
import type { OrgWindowIdentity } from '../../../packages/contracts/desktop-window'

// Blank portals inherit webPreferences but never receive their own bridge.
const expectedOrigin = process.argv.find(arg => arg.startsWith('--orgtree-ui-origin='))?.slice('--orgtree-ui-origin='.length)
if (process.isMainFrame && expectedOrigin && location.origin === expectedOrigin && isAppPath(location.pathname)) {
  // ⚠ RESOLVED SYNCHRONOUSLY, BEFORE THE BRIDGE EXISTS. The shell derives
  // its whole view from this - Homepage, Create or an organization's Canvas -
  // and a promise makes the window paint the wrong one for a frame. It is a
  // plain value on the exposed object for that reason.
  //
  // ⚠ AND NOT FROM A LAUNCH ARGUMENT, which is the obvious alternative and
  // is wrong: `additionalArguments` is fixed for the window's whole life, so a
  // baked-in kind goes stale the moment a Homepage window binds itself to an
  // organization, and a reload of that window would report `homepage` for a
  // window that is an organization. Asking the main process answers with what
  // the window IS, every time the document loads.
  //
  // null only when the main process refuses the sender - the same condition
  // under which no bridge is exposed at all.
  // ⚠ THE SAME CALL ALSO MINTS THIS DOCUMENT'S TOKEN. Native holds events a
  // renderer cannot rediscover until the document currently showing says it is
  // listening, and a message from a document that has since been replaced must
  // be recognisable as such. The token is that recognition: private to the
  // preload, quoted back on every message that would end the holding, and
  // never exposed to page script.
  let windowIdentity: OrgWindowIdentity | null = null
  let documentToken = ''
  try {
    const announced = ipcRenderer.sendSync('desktop:window-identity-sync') as
      { identity: OrgWindowIdentity | null; token: string } | null
    windowIdentity = announced?.identity ?? null
    documentToken = announced?.token ?? ''
  } catch { windowIdentity = null; documentToken = '' }
  const bridge: DesktopBridge = {
    windowIdentity,
    getWindowIdentity: () => ipcRenderer.invoke('desktop:window-identity'),
    openHomepageWindow: () => ipcRenderer.invoke('desktop:open-homepage-window'),
    openCreateOrgWindow: () => ipcRenderer.invoke('desktop:open-create-window'),
    requestOrg: (org: string) => ipcRenderer.invoke('desktop:request-org', org),
    bindCreatedOrg: (org: string) => ipcRenderer.invoke('desktop:bind-created-org', org),
    setUnsavedCreation: (dirty: boolean) => ipcRenderer.invoke('desktop:set-unsaved-creation', dirty),
    openOrgs: () => ipcRenderer.invoke('desktop:open-orgs'),
    getMaintenanceStatus: () => ipcRenderer.invoke('desktop:maintenance-status'),
    takePendingWindowEvents: () => ipcRenderer.invoke('desktop:take-pending-events', documentToken),
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
    setPendingAttention: (ids, items) => ipcRenderer.invoke('desktop:pending-attention', ids, items),
    openHarnessLink: id => ipcRenderer.invoke('desktop:open-harness', id),
    openCharterFolder: () => ipcRenderer.invoke('desktop:open-charter-folder'),
    revealFile: (path: string) => ipcRenderer.invoke('desktop:reveal-file', path),
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
      // ⚠ TELL THE MAIN PROCESS A LISTENER NOW EXISTS. Native holds the events
      // a renderer cannot rediscover — an organization to open, an item to
      // reveal — until someone can actually receive them, and it has no way to
      // see an `ipcRenderer.on` registration. Without this the fallback is a
      // guess at how long mounting takes, and a renderer that attaches later
      // than the guess is sent events into a void: delivered, by the main
      // process's reckoning, and gone.
      ipcRenderer.send('desktop:events-listening', documentToken)
      return () => ipcRenderer.removeListener('desktop:event', handler)
    },
  }
  contextBridge.exposeInMainWorld('orgtreeDesktop', bridge)
}

if (process.isMainFrame && location.protocol === 'data:') {
  const wireHoldingControls = () => {
    const refreshBtn = document.querySelector('[aria-label="Refresh app view"]')
    const minBtn = document.querySelector('[aria-label="Minimize window"]')
    const maxBtn = document.querySelector('[aria-label="Maximize window"], [aria-label="Restore window"]')
    const closeBtn = document.querySelector('[aria-label="Close window"]')

    const updateMaxState = (maximized: boolean) => {
      const btn = document.querySelector('[aria-label="Maximize window"], [aria-label="Restore window"]')
      if (!btn) return
      btn.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window')
      btn.setAttribute('title', maximized ? 'Restore window' : 'Maximize window')
      btn.innerHTML = maximized
        ? '<svg viewBox="0 0 24 24"><path d="M3 5v14h14v-2H5V5H3zm18-4H7c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 16H7V3h14v14z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>'
    }

    if (refreshBtn) refreshBtn.addEventListener('click', () => { void ipcRenderer.invoke('desktop:window-refresh').catch(() => location.reload()) })
    if (minBtn) minBtn.addEventListener('click', () => { void ipcRenderer.invoke('desktop:window-minimize').catch(() => {}) })
    if (maxBtn) maxBtn.addEventListener('click', () => { void ipcRenderer.invoke('desktop:window-toggle-maximize').catch(() => {}) })
    if (closeBtn) closeBtn.addEventListener('click', () => { void ipcRenderer.invoke('desktop:window-close').catch(() => {}) })

    void ipcRenderer.invoke('desktop:window-controls-state').then((state: { maximized?: boolean } | null) => {
      if (state && typeof state.maximized === 'boolean') updateMaxState(state.maximized)
    }).catch(() => {})

    ipcRenderer.on('desktop:event', (_e, event: DesktopEvent) => {
      if (event?.type === 'window-state') {
        const data = event.data as { maximized?: boolean } | undefined
        if (data && typeof data.maximized === 'boolean') updateMaxState(data.maximized)
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireHoldingControls)
  } else {
    wireHoldingControls()
  }
}

