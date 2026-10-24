import type { BrowserWindow, Input } from 'electron'

/** Windows consumes Alt+Space as WM_SYSCHAR before the page sees Space.
 * Observe that native request, then cancel only its Shift+Alt variant through
 * Electron's cancellable menu event. Never install a global keyboard hook. */
export function installShiftAltSpace(window: BrowserWindow, platform = process.platform): void {
  if (platform !== 'win32') return
  let shift = false, alt = false, control = false, meta = false
  let nativeSpace = false, repeated = false, delivered = false
  let clear: ReturnType<typeof setImmediate> | undefined
  const reset = () => { shift = alt = control = meta = nativeSpace = repeated = delivered = false }
  const input = (_event: Electron.Event, key: Input) => {
    shift = key.shift; alt = key.alt; control = key.control; meta = key.meta
    // A modifier's own release can still carry its old modifier flags.
    if (key.type === 'keyUp') {
      if (key.key === 'Shift') shift = false
      if (key.key === 'Alt') alt = false
      if (key.key === 'Control') control = false
      if (key.key === 'Meta') meta = false
    }
    if (key.code === 'Space' || key.key === ' ') delivered = key.type === 'keyDown'
  }
  window.webContents.on('before-input-event', input)
  window.hookWindowMessage(0x0106, (word, flags) => { // WM_SYSCHAR
    const bits = flags.readUInt32LE()
    nativeSpace = word.readUInt32LE() === 0x20 && !!(bits & 0x20000000)
    repeated = !!(bits & 0x40000000)
    if (clear) clearImmediate(clear)
    clear = setImmediate(() => { nativeSpace = false })
  })
  // Titlebar/context-menu requests must never reuse the keyboard marker.
  for (const message of [0x007b, 0x00a5, 0x0205]) window.hookWindowMessage(message, () => { nativeSpace = false })
  window.on('system-context-menu', event => {
    const chord = nativeSpace && shift && alt && !control && !meta
    nativeSpace = false
    if (!chord) return
    event.preventDefault()
    if (!delivered && !repeated && !window.webContents.isDestroyed()) {
      // Chromium input has no Windows menu default. Reuse the renderer's
      // existing editor/widget/IME/dialog/gesture admission, not a new Fit IPC.
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space', modifiers: ['alt', 'shift'] })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space', modifiers: ['alt', 'shift'] })
    }
  })
  window.on('blur', reset)
  window.once('closed', () => { reset(); if (clear) clearImmediate(clear) })
}
