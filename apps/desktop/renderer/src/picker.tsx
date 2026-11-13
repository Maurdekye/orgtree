import { createPortal } from 'react-dom'
import { desktop } from './desktop'
import { initiatingDocument, popoutNameForDocument } from './windowlife'
// Folder choosing across local desktop windows, remote-engine windows, and
// browsers (USER 2026-11-13 m365cee9110b5, m98bc74e8a3c7, narrowing the v1
// 1ec63e8 ruling):
//   • When the organization's engine runs on THIS PC and the native Electron
//     bridge is present, `pickFolder(defaultPath)` opens the operating system's
//     native directory chooser (`dialog.showOpenDialog` in main, modal to the
//     asking window, `openDirectory` + `createDirectory`, `defaultPath` seeded
//     when an existing directory).
//   • On a remote organization (`remoteHere() !== null`, 4.6.0 remote engine,
//     or if main refuses a cold-start remote window) and on any surface without
//     the Electron bridge (a plain browser / viewer), `pickFolder()` opens the
//     custom in-app dialog backed by `/api/fs` so it lists the ENGINE's disk.
//
// Usage: `pickFolder(defaultPath)` returns `Promise<{ path: string | null }>`.
// App mounts one `<FolderPickerHost />` that serves the custom `/api/fs` path.
import { useEffect, useRef, useState } from 'react'
import { getFs } from './api'
import type { FsPayload } from './types'
import { ArrowUpIcon, FolderIcon, HomeIcon, StorageIcon } from './icons'
import { remoteHere, useRemoteHere } from './remotehere'

export interface PickResult { path: string | null }
type PickRequest = { document: Document; resolve: (r: PickResult) => void }

let openFn: ((doc?: Document) => Promise<PickResult>) | null = null

export async function pickFolder(defaultPath?: string | null): Promise<PickResult> {
  const doc = initiatingDocument()
  const bridge = desktop()
  if (!remoteHere() && typeof bridge?.pickFolder === 'function') {
    try {
      const picked = await bridge.pickFolder(
        typeof defaultPath === 'string' && defaultPath ? defaultPath : null,
        popoutNameForDocument(doc),
      )
      return { path: typeof picked === 'string' && picked ? picked : null }
    } catch (err) {
      if (!err || typeof err !== 'object' || !(err as { remote?: boolean }).remote) {
        throw err
      }
    }
  }
  return openFn ? openFn(doc) : { path: null }
}

export function FolderPickerHost() {
  const [req, setReq] = useState<PickRequest | null>(null)  // while the dialog is up
  const [cur, setCur] = useState<FsPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const homeRef = useRef<string | null>(null)
  // the listing is the engine's (/api/fs): in a remote organization's window, the remote engine's disk
  const remote = useRemoteHere()
  const nav = (p: string) => getFs(p)
    .then((r) => { if (r.home) homeRef.current = r.home; setCur(r); setErr(null) })
    .catch((e: Error) => setErr(e.message))
  useEffect(() => {
    openFn = (doc) => new Promise((resolve) => { setReq({ resolve, document: doc ?? initiatingDocument() }); nav('') })
    return () => { openFn = null }
  }, [])
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(null) } }
    const w = req.document.defaultView ?? window
    const gone = () => finish(null)
    w.addEventListener('keydown', onKey)
    w.addEventListener('pagehide', gone)
    return () => { w.removeEventListener('keydown', onKey); w.removeEventListener('pagehide', gone) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])
  const finish = (path: string | null) => { req?.resolve({ path }); setReq(null); setCur(null) }
  if (!req) return null
  // breadcrumbs from the current path, each segment navigable
  const sep = cur?.path?.includes('/') && !cur?.path?.includes('\\') ? '/' : '\\'
  const segs = (cur?.path ?? '').split(/[\\/]/).filter(Boolean)
  const crumb = (i: number) => {
    const head = segs.slice(0, i + 1).join(sep)
    return head.endsWith(':') ? head + sep : head
  }
  return createPortal(
    <div className="overlay picker-overlay" onClick={() => finish(null)}>
      <div className="settings picker" onClick={(e) => e.stopPropagation()}>
        <h3 title={remote ? `These are folders on ${remote.name}, the remote engine this organization runs on.` : undefined}>
          <FolderIcon fontSize="inherit" /> choose a folder{remote ? ` on ${remote.name}` : ''}</h3>
        <div className="picker-bar">
          <button className="iconbtn" title="drives / roots"
            onClick={() => nav('')}><StorageIcon fontSize="inherit" /></button>
          {homeRef.current &&
            <button className="iconbtn" title="home"
              onClick={() => nav(homeRef.current ?? '')}><HomeIcon fontSize="inherit" /></button>}
          {cur?.parent != null && cur?.path &&
            <button className="iconbtn" title="up"
              onClick={() => nav(cur?.parent ?? '')}><ArrowUpIcon fontSize="inherit" /></button>}
          <span className="picker-crumbs mono">
            {segs.map((s, i) => (
              <span key={i}>
                <button className="crumb" onClick={() => nav(crumb(i))}>{s}</button>
                {i < segs.length - 1 ? sep : ''}
              </span>
            ))}
            {!segs.length && <span className="dim">{remote ? remote.name : 'this computer'}</span>}
          </span>
        </div>
        {err && <div className="picker-err">{err}</div>}
        <div className="picker-list">
          {cur?.dirs.map((d) => (
            <button key={d.path} className="picker-row"
              onDoubleClick={() => nav(d.path)}
              onClick={() => nav(d.path)}>
              <FolderIcon fontSize="inherit" /> {d.name}
            </button>
          ))}
          {cur && !cur.dirs.length && <div className="dim pad">no subfolders</div>}
        </div>
        <div className="row">
          <span className="dim mono picker-sel">{cur?.path || ''}</span>
          <span className="spacer" />
          {/* the two ways this button is dead read identically on screen —
              the path readout beside it is empty in both — so say which. */}
          <button className="primary" disabled={!cur?.path}
            title={cur?.path ? undefined
              : cur ? 'this is the drive list, not a folder — open a drive to '
                + 'choose a folder inside it'
                : 'still reading the folder list'}
            onClick={() => finish(cur?.path ?? null)}>select this folder</button>
          <button onClick={() => finish(null)}>cancel</button>
        </div>
      </div>
    </div>, req.document.body
  )
}
