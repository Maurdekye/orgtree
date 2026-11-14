// remote-downloads.ts — the downloads of the Files panel (a scratch folder of a remote
// organization; docs/rust-engine/remote-org.md, "The Files panel").
//
// A download is a plain link in the window, as every file link of the app is, and Electron
// saves it: its own Save dialog asks where. This module only does two things for the links
// of the Files panel: the dialog starts in the Downloads folder with the file's name, and
// the window that asked is told how far the download is, and can stop it.
//
// Nothing else is touched: a download from any other address is left exactly as it was.
import path from 'node:path'

/** The engine route a Files download comes from (`http::scratch_files::download`). */
const FILES_ROUTE = /^\/api\/orgs\/[^/]+\/nodes\/[^/]+\/scratch-files\/file$/

/** What the window is told (`remote-file-download`; the renderer's remotefiles.ts reads it). */
export interface DownloadNews {
  id: string; name: string; received: number; total: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

/** The part of Electron's `DownloadItem` used here. */
export interface ItemLike {
  getURL(): string
  getFilename(): string
  getReceivedBytes(): number
  getTotalBytes(): number
  getSavePath(): string
  setSaveDialogOptions(options: { title?: string; defaultPath?: string }): void
  cancel(): void
  on(event: 'updated', listener: (event: unknown, state: 'progressing' | 'interrupted') => void): unknown
  once(event: 'done', listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void): unknown
}

/** The part of a window's web contents used here. */
export interface ContentsLike { id: number; isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }

export interface SessionLike {
  on(event: 'will-download', listener: (event: unknown, item: ItemLike, contents: ContentsLike) => void): unknown
}

/** Is this the address of a Files download of this app's own engine? */
export function isFilesDownload(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url)
    return !!origin && parsed.origin === new URL(origin).origin && FILES_ROUTE.test(parsed.pathname)
  } catch { return false }
}

/** How often, at most, a running download tells its window where it is. */
const TELL_EVERY_MS = 250

/** Watch `session` for the Files panel's downloads. `origin` is the engine's address now,
 *  `downloads` the folder the Save dialog starts in. The answer stops a download for the
 *  window that began it (and for no other). */
export function watchRemoteFileDownloads(session: SessionLike, origin: () => string, downloads: () => string,
  now: () => number = Date.now): { cancel(id: string, contentsId: number): boolean } {
  const running = new Map<string, { item: ItemLike; contents: ContentsLike }>()
  let serial = 0
  session.on('will-download', (_event, item, contents) => {
    if (!isFilesDownload(item.getURL(), origin())) return
    const id = `dl-${++serial}`
    // a name and nothing of a path, whatever the answer's header said (review F-5)
    const last = path.win32.basename(path.posix.basename(item.getFilename()))
    const name = last && last !== '.' && last !== '..' ? last : 'download'
    item.setSaveDialogOptions({ title: `Save ${name}`, defaultPath: path.join(downloads(), name) })
    let announced = false, told = 0
    const tell = (state: DownloadNews['state']) => {
      if (contents.isDestroyed()) return
      const news: DownloadNews = { id, name, received: item.getReceivedBytes(), total: item.getTotalBytes(), state }
      contents.send('desktop:event', { type: 'remote-file-download', data: news })
    }
    running.set(id, { item, contents })
    item.on('updated', (_e, state) => {
      // nothing is said before the user chose where it goes: a Save dialog closed with
      // Cancel is no download at all
      if (state !== 'progressing' || !item.getSavePath()) return
      const at = now()
      if (announced && at - told < TELL_EVERY_MS) return
      announced = true; told = at
      tell('progressing')
    })
    item.once('done', (_e, state) => {
      running.delete(id)
      if (announced || state === 'completed') tell(state)
    })
  })
  return {
    cancel(id, contentsId) {
      const found = running.get(id)
      if (!found || found.contents.id !== contentsId) return false
      found.item.cancel()
      return true
    },
  }
}
