import { BrowserWindow } from 'electron'
import { activitySoundPage } from './activity-sounds'
import type { ActivitySoundKind } from '../../../packages/contracts/activity-sounds'

/** Private, hidden audio document. It never receives the desktop bridge or token. */
export class SoundPlayer {
  private window: BrowserWindow | null = null
  private loading: Promise<BrowserWindow> | null = null
  private closed = false
  private ready(): Promise<BrowserWindow> {
    if (this.closed) return Promise.reject(new Error('Sound player is closed'))
    if (this.loading) return this.loading
    if (this.window && !this.window.isDestroyed()) return Promise.resolve(this.window)
    const window = new BrowserWindow({ show: false, width: 1, height: 1, focusable: false,
      skipTaskbar: true, webPreferences: { sandbox: true, nodeIntegration: false,
        contextIsolation: true, partition: 'orgtree-activity-sounds', backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required' } })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, reply) => reply(false))
    window.once('closed', () => { if (this.window === window) this.window = null })
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    this.loading = window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(activitySoundPage()))
      .then(() => window).catch(error => {
        if (!window.isDestroyed()) window.destroy()
        throw error
      }).finally(() => { this.loading = null })
    return this.loading
  }
  async play(kind: ActivitySoundKind): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const play = async () => {
      const window = await this.ready()
      if (this.closed || window.isDestroyed()) throw new Error('Sound player is closed')
      await window.webContents.executeJavaScript(`window.playActivitySound(${JSON.stringify(kind)})`)
    }
    try {
      await Promise.race([play(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (this.window && !this.window.isDestroyed()) this.window.destroy()
          reject(new Error('Sound output timed out'))
        }, 3000)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  close() {
    this.closed = true
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }
}
