import { BrowserWindow } from 'electron'

/** Electron has no `BrowserWindow.setIcon` on macOS (the Dock shows the app
 * bundle's icon), so the shared window code would throw there. A no-op keeps
 * every call site platform-neutral. */
export function installMacWindowIconShim(platform = process.platform) {
  const proto = BrowserWindow.prototype as unknown as { setIcon?: unknown }
  if (platform === 'darwin' && typeof proto.setIcon !== 'function') proto.setIcon = () => {}
}
