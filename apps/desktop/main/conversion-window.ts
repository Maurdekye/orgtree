import { BrowserWindow } from 'electron'
import { conversionPage } from './policy'

/** A small window shown ONLY while the engine converts a 2.1.12 data folder
 *  on the first v3 start (user decision 38). Startup builds no other window
 *  until the engine is ready, so without this a conversion that takes minutes
 *  would look like Orgtree failing to open. Updates are throttled: progress
 *  lines arrive per rows copied. */
export class ConversionWindow {
  private window: BrowserWindow | null = null
  private pending: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly icon?: string) {}

  /** A phase shows or updates the window; null closes it. */
  update(phase: string | null): void {
    if (phase === null) { this.close(); return }
    this.pending = phase
    if (!this.window) {
      this.window = new BrowserWindow({ width: 460, height: 190, resizable: false, minimizable: true, maximizable: false,
        fullscreenable: false, autoHideMenuBar: true, title: 'Orgtree', icon: this.icon,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webviewTag: false } })
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      this.window.webContents.on('will-navigate', event => event.preventDefault())
      this.window.on('closed', () => { this.window = null })
      this.flush()
    } else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush() }, 500)
  }

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.pending = null
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private flush(): void {
    if (!this.window || this.window.isDestroyed() || this.pending === null) return
    void this.window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(conversionPage(this.pending))).catch(() => {})
  }
}
