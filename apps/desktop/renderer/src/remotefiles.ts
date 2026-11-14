// remotefiles.ts — the Files panel of a window on a remote organization: what it asks the
// engine, and what it knows of the transfers under way
// (docs/rust-engine/remote-org.md, "The Files panel").
//
// A remote organization keeps its scratch folders on the other computer, where this computer's
// file manager cannot go. So in such a window the scratch-folder entries open a panel instead
// (scratch-folder.ts): a folder at a time, with Download, Download as zip and Upload. A local
// organization keeps opening the file manager.
//
// - A LISTING is one page of one folder (`GET .../scratch-files`).
// - A DOWNLOAD is a plain link (`<a download>`), as every other file link in the app is: the
//   desktop's own Save dialog asks where it goes, and the main process tells this module how
//   far it is (`remote-file-download` events) and can stop it.
// - An UPLOAD is this module's: the file is sent as it is read from the disk, never held in
//   memory, with its progress, and it can be stopped.
import { useSyncExternalStore } from 'react'
import { desktop } from './desktop'
import { req } from './api'
import { remoteFolderText } from './remotehere'

/** A scratch folder, as scratch-folder.ts names it: an agent's own, its team's, or the
 *  organization's shared one. */
export interface FilesTarget { org: string; node: string; scope?: 'team' | 'shared'; title: string }

export interface FileEntry { name: string; kind: 'folder' | 'file' | 'link'; bytes: number | null; modified: number | null }
export interface FilePage { entries: FileEntry[]; total: number; next: number | null }

export type Conflict = 'ask' | 'replace' | 'keep_both'

/** The most one upload may hold (user ruling 2026-11-14), as the engine enforces it. */
export const UPLOAD_MAX = 2 * 1024 * 1024 * 1024
/** From this size on, a transfer says how large it is before it starts. */
export const LARGE = 100 * 1024 * 1024

/** The organization's shared folder has no agent: the engine knows it by this name. */
const SHARED_NODE = '_shared'

const base = (target: FilesTarget): string =>
  `/api/orgs/${encodeURIComponent(target.org)}/nodes/${encodeURIComponent(target.scope === 'shared' ? SHARED_NODE : target.node)}/scratch-files`

const query = (target: FilesTarget, path: string, more: Record<string, string | number> = {}): string => {
  const q = new URLSearchParams()
  if (target.scope) q.set('scope', target.scope)
  if (path) q.set('path', path)
  for (const [key, value] of Object.entries(more)) q.set(key, String(value))
  const text = q.toString()
  return text ? `?${text}` : ''
}

export const listFiles = (target: FilesTarget, path: string, offset = 0): Promise<FilePage> =>
  req<FilePage>(`${base(target)}${query(target, path, offset ? { offset } : {})}`)

/** The address of a download: a file as it is, a folder as a zip. */
export const downloadUrl = (target: FilesTarget, path: string): string => `${base(target)}/file${query(target, path)}`

/** The first Orgtree whose engine has the Files routes. */
const FILES_SINCE = [4, 6, 0] as const

/** Does the other engine's version say it has no Files routes? Asked BEFORE anything is sent
 *  (scratch-folder.ts), with the version that engine gave when this computer connected
 *  (`version` of the window's connection). Only the three numbers count, and a version that
 *  cannot be read says nothing: then the answer to the first listing decides (`olderEngine`).
 *  An alpha of 4.6.0 is such a case: its first two had no Files routes. */
export const filesNeedUpdate = (version: string | null | undefined): boolean => {
  const numbers = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? '')?.slice(1).map(Number)
  if (!numbers) return false
  for (let i = 0; i < FILES_SINCE.length; i++) if (numbers[i] !== FILES_SINCE[i]) return numbers[i]! < FILES_SINCE[i]!
  return false
}

/** What an entry or the panel says of an engine that cannot show a folder. */
export const filesUpdateText = (name: string, version: string | null | undefined): string =>
  `Orgtree on ${name} needs updating to use the file browser${version ? `: it runs ${version}, and the file browser needs` : ', which needs'} ${FILES_SINCE.join('.')} or later. `
  + remoteFolderText(name)

/** Is this the answer of an engine that has no Files routes? It answers a route it does not
 *  know with a 404 that names the route ("no route GET ..."), and this engine's own 404s say
 *  what is missing. An engine started without a UI folder, which is what one that runs by
 *  itself is, answered such a route "no UI bundle configured" in plain text until 4.6.0 (the
 *  request words it "404: ..." and keeps the text as `body`): that is the same case, and the
 *  one a user met on 2026-11-14. */
export const olderEngine = (error: unknown): boolean => {
  const e = error as { status?: unknown; message?: unknown; body?: unknown } | null
  if (!e || e.status !== 404) return false
  return (typeof e.message === 'string' && e.message.startsWith('no route '))
    || (typeof e.body === 'string' && e.body.trim() === 'no UI bundle configured')
}

// ---------------------------------------------------------------- paths and words

export const joinPath = (folder: string, name: string): string => folder ? `${folder}/${name}` : name
export const parentPath = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
/** The folders from the top down to `path`, each with the path that opens it. */
export const crumbs = (path: string): { name: string; path: string }[] =>
  path.split('/').filter(Boolean).map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') }))

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** How far a transfer is, in words: "12.0 MB of 48.0 MB (25%)", or "12.0 MB" when nobody
 *  knows the whole (a zip is made as it is sent). */
export const progressText = (done: number, total: number | null): string =>
  total && total > 0 ? `${sizeText(done)} of ${sizeText(total)} (${Math.min(100, Math.floor(done / total * 100))}%)` : sizeText(done)

/** `name` as it would be kept beside a file of the same name: the first free `name (n).ext`. */
export function keptBeside(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) { const next = `${stem} (${n})${ext}`; if (!taken.has(next)) return next }
}

// ---------------------------------------------------------------- which folder is open

let opened: FilesTarget | null = null
const openListeners = new Set<() => void>()
const tellOpen = () => { for (const listener of openListeners) listener() }

/** Open the Files panel on a scratch folder (scratch-folder.ts, in a remote window). */
export function openRemoteFiles(target: FilesTarget): void { opened = target; tellOpen() }
export function closeRemoteFiles(): void { if (opened) { opened = null; tellOpen() } }
export const remoteFilesOpen = (): FilesTarget | null => opened
export const useRemoteFilesTarget = (): FilesTarget | null =>
  useSyncExternalStore((listener) => { openListeners.add(listener); return () => { openListeners.delete(listener) } }, remoteFilesOpen, remoteFilesOpen)

// ---------------------------------------------------------------- transfers

export type TransferState = 'running' | 'done' | 'failed' | 'stopped'
export interface Transfer {
  id: string; kind: 'download' | 'upload'; name: string
  done: number; total: number | null; state: TransferState; error?: string
  stop?: () => void
}

let transfers: readonly Transfer[] = []
const transferListeners = new Set<() => void>()
const tellTransfers = () => { for (const listener of transferListeners) listener() }
const put = (next: Transfer) => {
  transfers = transfers.some((t) => t.id === next.id) ? transfers.map((t) => t.id === next.id ? next : t) : [...transfers, next]
  tellTransfers()
}
export const transfersNow = (): readonly Transfer[] => transfers
export const useTransfers = (): readonly Transfer[] =>
  useSyncExternalStore((listener) => { transferListeners.add(listener); return () => { transferListeners.delete(listener) } }, transfersNow, transfersNow)
/** Take a finished transfer's row away (its file stays where it went). */
export function dismissTransfer(id: string): void {
  transfers = transfers.filter((t) => t.id !== id || t.state === 'running')
  tellTransfers()
}
/** Tests only. */
export function forgetRemoteFiles(): void { opened = null; transfers = []; tellOpen(); tellTransfers() }

/** What the main process says of a download of this window's (`remote-file-download`). */
export interface DownloadNews { id: string; name: string; received: number; total: number; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' }

const downloadState = (state: DownloadNews['state']): TransferState =>
  state === 'completed' ? 'done' : state === 'cancelled' ? 'stopped' : state === 'interrupted' ? 'failed' : 'running'

/** A download moved on. `stop` asks the main process to end it. */
export function downloadNews(news: DownloadNews, stop?: (id: string) => void): void {
  const state = downloadState(news.state)
  put({
    id: news.id, kind: 'download', name: news.name, done: news.received, total: news.total > 0 ? news.total : null, state,
    ...(state === 'failed' ? { error: 'The download broke off. What arrived was not kept.' } : {}),
    ...(state === 'running' && stop ? { stop: () => stop(news.id) } : {}),
  })
}

/** Listen to the main process for this window's downloads. Returns the unsubscribe; a plain
 *  browser has no bridge, and there the browser's own download list is what the user has. */
export function watchDownloads(): () => void {
  const bridge = desktop()
  if (!bridge?.onEvent) return () => {}
  return bridge.onEvent((event) => {
    if ((event.type as string) !== 'remote-file-download') return
    const news = event.data as DownloadNews | undefined
    if (news && typeof news.id === 'string') downloadNews(news, bridge.cancelRemoteFileDownload ? (id) => { void bridge.cancelRemoteFileDownload!(id) } : undefined)
  })
}

export interface Uploaded { name: string; bytes: number }

/** The request an upload is sent with. `XMLHttpRequest`, because it is what tells how much
 *  of a body has gone; tests hand in their own. */
export type UploadRequest = Pick<XMLHttpRequest, 'open' | 'send' | 'abort' | 'status' | 'responseText'> & {
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null }
  onload: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null
}

let uploadSerial = 0

/** Send `file` into `folder` of `target`. The row of the transfer is kept current; the
 *  promise settles with the name the file got, or rejects with an error that carries the
 *  engine's `status` (409: a file of that name is there; 413: too large). */
export function uploadFile(target: FilesTarget, folder: string, file: File, conflict: Conflict,
  make: () => UploadRequest = () => new XMLHttpRequest() as unknown as UploadRequest): Promise<Uploaded> {
  const id = `up-${++uploadSerial}`
  const row = (more: Partial<Transfer>): Transfer => ({ id, kind: 'upload', name: file.name, done: 0, total: file.size, state: 'running', ...more })
  if (file.size > UPLOAD_MAX) {
    const error = Object.assign(new Error(`${file.name} is larger than 2 GiB, the most one upload may hold.`), { status: 413 })
    put(row({ state: 'failed', error: error.message }))
    return Promise.reject(error)
  }
  return new Promise<Uploaded>((resolve, reject) => {
    const request = make()
    let done = 0
    const fail = (state: TransferState, message: string, status = 0) => {
      // a refused name is the dialog's to ask about, not a failed transfer's row
      if (status === 409) { transfers = transfers.filter((t) => t.id !== id); tellTransfers() } else put(row({ done, state, error: message }))
      reject(Object.assign(new Error(message), { status }))
    }
    request.upload.onprogress = (event) => { done = event.loaded; put(row({ done, stop: () => request.abort() })) }
    request.onload = () => {
      let parsed: { name?: unknown; bytes?: unknown; detail?: unknown } = {}
      try { parsed = JSON.parse(request.responseText) as typeof parsed } catch { /* not JSON: the status says it */ }
      if (request.status >= 200 && request.status < 300 && typeof parsed.name === 'string') {
        put(row({ name: parsed.name, done: file.size, state: 'done' }))
        resolve({ name: parsed.name, bytes: typeof parsed.bytes === 'number' ? parsed.bytes : file.size })
      } else {
        fail('failed', typeof parsed.detail === 'string' && parsed.detail ? parsed.detail : `The upload was refused (${request.status}).`, request.status)
      }
    }
    request.onerror = () => fail('failed', 'The upload broke off. Nothing was changed on the other computer.')
    request.onabort = () => fail('stopped', 'Stopped. Nothing was changed on the other computer.')
    request.open('PUT', `${base(target)}/upload${query(target, folder, { name: file.name, conflict })}`)
    put(row({ stop: () => request.abort() }))
    request.send(file)
  })
}
