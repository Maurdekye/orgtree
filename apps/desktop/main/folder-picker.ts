// Native OS folder picker for local desktop windows
// (USER 2026-11-13 m365cee9110b5, m98bc74e8a3c7; narrowing v1 1ec63e8).
import fs from 'node:fs'
import path from 'node:path'

export interface FolderDialogWindow {
  isDestroyed(): boolean
}

export interface FolderDialogOptions {
  properties: ('openDirectory' | 'createDirectory')[]
  defaultPath?: string
}

export interface FolderDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface FolderDialogApi<W extends FolderDialogWindow = FolderDialogWindow> {
  showOpenDialog(window: W, options: FolderDialogOptions): Promise<FolderDialogResult>
}

/** Open the operating system's native directory chooser modal to the asking
 *  window (popout child when live, else the caller's main BrowserWindow).
 *  `defaultPath` is passed only when it names an existing absolute directory.
 *  Returns one chosen path or `null` on cancel / destroyed window. */
export async function pickNativeFolder<W extends FolderDialogWindow>(
  dialogApi: FolderDialogApi<W>,
  mainWindow: W | null | undefined,
  popoutWindow?: W | null,
  defaultPath?: unknown,
): Promise<string | null> {
  const parent =
    popoutWindow && !popoutWindow.isDestroyed()
      ? popoutWindow
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : null
  if (!parent) return null

  let validDefault: string | undefined
  if (typeof defaultPath === 'string') {
    const trimmed = defaultPath.trim()
    if (trimmed && path.isAbsolute(trimmed)) {
      const normalized = path.normalize(trimmed)
      try {
        if (fs.statSync(normalized).isDirectory()) validDefault = normalized
      } catch {
        /* missing or unreadable directory: open without defaultPath */
      }
    }
  }

  const options: FolderDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    ...(validDefault ? { defaultPath: validDefault } : {}),
  }
  const result = await dialogApi.showOpenDialog(parent, options)
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return null
  return typeof result.filePaths[0] === 'string' && result.filePaths[0] ? result.filePaths[0] : null
}
