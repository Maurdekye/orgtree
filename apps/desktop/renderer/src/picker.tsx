import { createPortal } from 'react-dom'
import { initiatingDocument } from './windowlife'
// The in-app folder picker (user ruling): a fully custom dialog backed by the
// backend's /api/fs listing, so it works from ANY browser that can reach the
// UI — unlike a native dialog, which opens on the server's own desktop.
//
// Usage: `pickFolder()` from anywhere returns a Promise<{path: string|null}>.
// App mounts one <FolderPickerHost /> that serves every request.
import { useEffect, useRef, useState } from 'react'
import { getFs } from './api'
import type { FsPayload } from './types'
import { ArrowUpIcon, FolderIcon, HomeIcon, StorageIcon } from './icons'

export interface PickResult { path: string | null }
type PickRequest = { document: Document; resolve: (r: PickResult) => void }

let openFn: (() => Promise<PickResult>) | null = null
export const pickFolder = (): Promise<PickResult> =>
  (openFn ? openFn() : Promise.resolve({ path: null }))

export function FolderPickerHost() {
  const [req, setReq] = useState<PickRequest | null>(null)  // while the dialog is up
  const [cur, setCur] = useState<FsPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const homeRef = useRef<string | null>(null)
  const nav = (p: string) => getFs(p)
    .then((r) => { if (r.home) homeRef.current = r.home; setCur(r); setErr(null) })
    .catch((e: Error) => setErr(e.message))
  useEffect(() => {
    openFn = () => new Promise((resolve) => { setReq({ resolve, document: initiatingDocument() }); nav('') })
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
        <h3><FolderIcon fontSize="inherit" /> choose a folder</h3>
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
            {!segs.length && <span className="dim">this computer</span>}
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
