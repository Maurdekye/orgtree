import { BrowserWindow, session } from 'electron'
import type { DataLocationProgress } from '../../../packages/contracts/index'
import { nativeScreenText } from '../../../packages/contracts/streamer'
import { DATA_MOVE_CANCEL_URL, dataMoveProgressHtml } from './datalocation'
import { nativeStreamerOn, watchNativeStreamer } from './streamer-native'

/** Offline, script-free (`javascript: false`) main-process window displayed while
 *  all org windows are closed during a Data location move. Network requests and
 *  permissions (including clipboard) are denied; audio is muted; Cancel is wired
 *  via intercepted navigation to `DATA_MOVE_CANCEL_URL` with zero script execution. */
export class DataMoveWindow {
  private window: BrowserWindow | null = null
  private pending: DataLocationProgress | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly icon: string | undefined,
    private readonly onCancel: () => void,
  ) {}

  update(progress: DataLocationProgress | null): void {
    if (progress === null) {
      this.close()
      return
    }
    this.pending = progress
    if (!this.window) {
      const moveSession = session.fromPartition('in-memory-data-location-move')
      moveSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
      moveSession.setPermissionCheckHandler(() => false)
      moveSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !details.url.startsWith('data:text/html') })
      })

      this.window = new BrowserWindow({
        width: 480,
        height: 190,
        useContentSize: true,
        resizable: false,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: '#191918',
        title: 'Orgtree',
        icon: this.icon,
        webPreferences: {
          session: moveSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
          webviewTag: false,
        },
      })
      this.window.webContents.setAudioMuted(true)
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      this.window.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        if (url === DATA_MOVE_CANCEL_URL && this.pending?.cancellable) {
          this.onCancel()
        }
      })
      this.window.on('close', event => {
        if (this.pending && this.pending.phase !== 'done' && this.pending.phase !== 'error') {
          event.preventDefault()
          if (this.pending.cancellable) this.onCancel()
        }
      })
      const stopPrivacy = watchNativeStreamer(() => this.flush())
      this.window.on('closed', () => {
        stopPrivacy()
        this.window = null
      })
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, 150)
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  private flush(): void {
    if (!this.window || this.window.isDestroyed() || !this.pending) return
    const maskOn = nativeStreamerOn()
    const html = dataMoveProgressHtml(this.pending, text => nativeScreenText(text, maskOn))
    void this.window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {})
  }
}
