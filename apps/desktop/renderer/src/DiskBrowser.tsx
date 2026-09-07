// The recovery browser (user verdict 2026-07-31 + explorer request
// 2026-08-01): the org's virtual disk in TWO modes — the flat largest-files
// triage list, and a conventional explorer that descends folders with their
// recursive sizes, entries INTERMIXED by size descending (deliberate
// deviation from folders-first: the view exists for size triage, so a
// 900 MB folder outranks a 200 MB file).
//
// It exists for the state nothing else can fix: a hard-full disk, where no
// turn can run so no agent can delete anything. It therefore depends on
// NOTHING but the backend (reads/deletes go over \\wsl.localhost — the
// container can be stopped, the disk 100% full; both modes read the same
// cached single walk). Kiosk visitors get the full tool (ruled); the server
// enforces the deletion policy, this UI only mirrors it. The system seed is
// SHOWN, marked non-deletable — "4 GB cap, 1.2 GB of it /usr" answers
// "where did my space go" better than any text.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  diskDelete, diskFileUrl, diskResize, diskResizeApply, diskResizeCancel,
  getDisk, getDiskDir,
} from './api'
import type {
  DiskDirEntry, DiskDirPayload, DiskFile, DiskPayload, ToastFn,
} from './types'
import {
  ChevronRightIcon, CloseIcon, DeleteIcon, DownloadIcon, FolderIcon,
  StorageIcon, WarnIcon,
} from './icons'
import { PinFrame } from './canvas/modalpin'

const fmt = (b: number | null | undefined): string => (b == null ? '?'
  : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB'
  : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB'
  : Math.max(1, Math.round(b / 1024)) + ' KB')

type Mode = 'largest' | 'browse'
const MODE_KEY = 'orgtree-diskmode'   // last-used mode (header button entry)

// what the delete footer needs to know about a selected path
interface SelMeta { bytes: number; dir: boolean; files: number }

export function DiskBrowser({ slug, isPublic, toast, close, initialMode }: {
  slug: string
  isPublic: boolean
  toast: ToastFn
  close: () => void
  /** the hard-full alert always opens 'largest' — the triage view is the
   *  fastest path to freeing space (ruled); the header button omits this
   *  and gets the last-used mode */
  initialMode?: Mode
}) {
  const [mode, setModeRaw] = useState<Mode>(() => initialMode
    ?? ((localStorage.getItem(MODE_KEY) === 'browse' ? 'browse' : 'largest')))
  const setMode = (m: Mode) => {
    setModeRaw(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* private mode */ }
  }
  const [flat, setFlat] = useState<DiskPayload | null>(null)
  const [dirData, setDirData] = useState<DiskDirPayload | null>(null)
  const [curPath, setCurPath] = useState('')
  const [sel, setSel] = useState<Map<string, SelMeta>>(() => new Map())
  const [armed, setArmed] = useState(false)   // two-click delete latch

  // mobile audit §3.3: onMouseLeave never fires on touch, so the armed latch
  // used to stay live indefinitely — a multi-GB delete degraded to a single
  // tap. A 3s timeout disarms everywhere (mouse users keep the leave path).
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  const [busy, setBusy] = useState(false)
  const [growTo, setGrowTo] = useState('')
  const selRef = useRef(sel)
  selRef.current = sel

  const loadFlat = useCallback((offset = 0) =>
    getDisk(slug, offset).then((d) => {
      setFlat((prev) => (offset && prev
        ? { ...d, files: [...prev.files, ...d.files] } : d))
    }).catch((e: Error) => toast([`error: ${e.message}`])), [slug, toast])

  const loadDir = useCallback((path: string) =>
    getDiskDir(slug, path).then((d) => { setDirData(d); setCurPath(d.path) })
      .catch((e: Error) => toast([`error: ${e.message}`])), [slug, toast])

  const refresh = useCallback(() => (mode === 'largest'
    ? loadFlat(0) : loadDir(curPath)), [mode, curPath, loadFlat, loadDir])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {              // the live readout: watch the number come down
    const t = setInterval(refresh, 8000)
    return () => clearInterval(t)
  }, [refresh])

  const toggle = (path: string, meta: SelMeta, on: boolean) =>
    setSel((s) => {
      const n = new Map(s)
      if (on) n.set(path, meta); else n.delete(path)
      return n
    })

  const doDelete = () => {
    if (!armed) { setArmed(true); return }
    setArmed(false)
    setBusy(true)
    diskDelete(slug, [...selRef.current.keys()])
      .then((r) => {
        const bad = r.results.filter((x) => !x.ok)
        const ok = r.results.length - bad.length
        toast([`deleted ${ok} item(s)` + (bad.length
          ? ` · ${bad.length} refused (${bad[0]!.error})` : '')])
        setSel(new Map())
        refresh()
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }

  const live = mode === 'largest' ? flat : dirData
  const frac = live?.used != null && live?.total ? live.used / live.total : 0
  let selBytes = 0, selFiles = 0
  for (const m of sel.values()) { selBytes += m.bytes; selFiles += m.files }

  const crumbs = curPath ? curPath.split('/') : []

  const row = (path: string, meta: SelMeta, cls: string, reason: string | undefined,
    name: ReactNode, onOpen?: () => void) => (
    <label key={path}
      className={'disk-row' + (cls === 'blocked' ? ' blocked' : '')}
      title={reason || path}>
      <input type="checkbox" disabled={cls === 'blocked' || busy}
        checked={sel.has(path)}
        onChange={(e) => toggle(path, meta, e.target.checked)} />
      <span className="disk-size mono">{fmt(meta.bytes)}</span>
      {onOpen
        ? <button type="button" className="disk-path disk-dirlink mono"
            onClick={onOpen}>{name}</button>
        : <span className="disk-path mono">{name}</span>}
      {cls === 'reclaimable' && <span className="disk-cls ok">reclaimable</span>}
      {cls === 'blocked' && <span className="disk-cls">{reason}</span>}
      {!meta.dir && (
        <a className="iconbtn" href={diskFileUrl(slug, path)}
          download title="download" onClick={(e) => e.stopPropagation()}>
          <DownloadIcon fontSize="inherit" /></a>
      )}
    </label>
  )

  return (
    // `.disk-overlay` (z-index 55) is kept EXACTLY as it was, so the centred
    // layer does not move: this surface still sits above every other centred
    // modal. Pinned, PinFrame's own inline z-index overrides that class and
    // the window joins the 21-29 band with the rest of them — which is what
    // lets another pinned window be raised over it.
    <PinFrame kind="disk" title="org disk" panel="settings disk-browser"
      overlayClass="disk-overlay" close={close}>
        {/* ⚠ THE CONTROLS ARE OUT OF THE HEADING ON PURPOSE. A pinned window
            hides the panel's own title h3 (its title bar already says it), so
            anything left inside that h3 goes with it — and this surface, alone
            among them, kept its mode tabs and its close button in there. They
            are the same row, and they look the same centred; they are just no
            longer inside the element that stands down. */}
        <h3><StorageIcon fontSize="inherit" /> org disk</h3>
        <div className="disk-head">
          <span className="disk-tabs">
            <button className={mode === 'largest' ? 'on' : ''}
              onClick={() => setMode('largest')}>largest files</button>
            <button className={mode === 'browse' ? 'on' : ''}
              onClick={() => setMode('browse')}>browse</button>
          </span>
          <span className="spacer" />
          <button className="iconbtn" title="close" onClick={close}>
            <CloseIcon fontSize="inherit" /></button>
        </div>
        {live && (
          <div className={'disk-usage' + (frac >= 0.9 ? ' bad'
            : frac >= 0.8 ? ' warn' : '')}>
            <div className="disk-bar">
              <div className="disk-bar-fill"
                style={{ width: `${Math.min(100, frac * 100)}%` }} />
            </div>
            <span>{fmt(live.used)} / {fmt(live.total)}
              {live.full ? ' — FULL (writes are failing)'
                : live.blocked ? ' — turns paused (soft cap)' : ''}</span>
          </div>
        )}
        {/* in-product backstop nudge (review suggestion): org disks are
            sparse, so their per-org caps don't bound the HOST — only Docker
            Desktop's own disk limit does, and it ships unset (~1 TB) */}
        {live && live.vm_cap_mib == null && !isPublic && (
          <div className="dim disk-vmcap">
            host backstop unset: Docker Desktop has no disk usage limit
            (defaults to ~1 TB) — org disks are sparse, so their caps bound
            each org but not the machine. Docker Desktop → Settings →
            Resources → disk usage limit.
          </div>
        )}
        {mode === 'browse' && (
          <div className="disk-crumbs mono">
            <button className="crumb" onClick={() => loadDir('')}>disk</button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <ChevronRightIcon fontSize="inherit" />
                <button className="crumb"
                  onClick={() => loadDir(crumbs.slice(0, i + 1).join('/'))}>
                  {c}</button>
              </span>
            ))}
          </div>
        )}
        <div className="disk-list">
          {!live && <div className="dim pad">measuring…</div>}
          {mode === 'largest' && flat?.files.map((f: DiskFile) =>
            row(f.path, { bytes: f.bytes, dir: false, files: 1 },
              f.class, f.reason, f.path))}
          {mode === 'largest' && flat
            && flat.files.length >= flat.offset + flat.limit && (
            <button className="addrow" onClick={() => loadFlat(flat.files.length)}>
              load more…</button>
          )}
          {mode === 'browse' && dirData?.entries.map((e: DiskDirEntry) =>
            row(e.path, { bytes: e.bytes, dir: e.dir, files: e.files },
              e.class, e.reason,
              e.dir
                ? <><FolderIcon fontSize="inherit" /> {e.name}
                    <span className="dim"> · {e.files} file{e.files === 1 ? '' : 's'}</span></>
                : e.name,
              e.dir ? () => loadDir(e.path) : undefined))}
          {live && (mode === 'largest' ? !flat?.files.length
            : !dirData?.entries.length) &&
            <div className="dim pad">nothing here</div>}
        </div>
        <div className="row">
          {sel.size > 0 && (
            <button className={'disk-del' + (armed ? ' armed' : '')}
              disabled={busy} onClick={doDelete}
              onMouseLeave={() => setArmed(false)}>
              <DeleteIcon fontSize="inherit" />
              {armed
                ? `really delete ${selFiles} file(s) · ${fmt(selBytes)}?`
                : `delete ${sel.size} selected (${selFiles} file(s) · ${fmt(selBytes)})`}
            </button>
          )}
          <span className="spacer" />
          {!isPublic && (
            <>
              {/* pending-shrink divergence (user's design): the amber chip
                  shows requested vs actual until the org's container is
                  next down — or the bridge applies it now */}
              {live?.pending_mb != null && (
                <span className="disk-pending" title={
                  'a shrink is staged: it applies when this org\'s container '
                  + 'is next down (never the backend), or apply it now — '
                  + 'briefly stops this org\'s agents'}>
                  {live.size_mb} MB → {live.pending_mb} MB pending
                  <button disabled={busy} title="briefly stops this org's agents"
                    onClick={() => {
                      setBusy(true)
                      diskResizeApply(slug)
                        .then((r) => { toast([`disk is now ${r.size_mb} MB`]); refresh() })
                        .catch((e: Error) => toast([`error: ${e.message}`]))
                        .finally(() => setBusy(false))
                    }}>apply now</button>
                  <button disabled={busy} title="cancel the staged shrink"
                    onClick={() => {
                      setBusy(true)
                      diskResizeCancel(slug)
                        .then(() => { toast(['staged shrink cancelled']); refresh() })
                        .catch((e: Error) => toast([`error: ${e.message}`]))
                        .finally(() => setBusy(false))
                    }}><CloseIcon fontSize="inherit" /></button>
                </span>
              )}
              <span className="dim disk-grow-note">
                grow applies instantly; a shrink stages until this org's
                container is next down
              </span>
              <input className="disk-grow" type="number" min="1"
                placeholder="resize to MB" value={growTo}
                onChange={(e) => setGrowTo(e.target.value)} />
              <button disabled={busy || !growTo}
                title="grow: online, instant · shrink: staged (refused below current usage)"
                onClick={() => {
                  setBusy(true)
                  diskResize(slug, parseInt(growTo, 10))
                    .then((r) => {
                      toast([r.pending_mb != null
                        ? `shrink to ${r.pending_mb} MB staged — applies when `
                          + 'the container is next down (or use apply now)'
                        : `disk is now ${r.size_mb} MB`])
                      setGrowTo('')
                      refresh()
                    })
                    .catch((e: Error) => toast([`error: ${e.message}`]))
                    .finally(() => setBusy(false))
                }}>resize</button>
            </>
          )}
        </div>
    </PinFrame>
  )
}

// The HARD-FULL alert: screen-wide and PERSISTENT while the condition holds —
// deliberately NOT a toast (toasts self-destruct in 12 s; this is a state
// that requires action). It renders from tree state, so it survives reloads,
// and dismisses itself when usage drops. It does not auto-open the browser
// (explicit user refinement) — it carries the button.
export function DiskFullAlert({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="disk-alert">
      <WarnIcon fontSize="inherit" />
      <b>The org disk is FULL</b> — every write is failing with ENOSPC and no
      agent can fix it from inside. Free space to resume.
      <button onClick={onOpen}>open the recovery browser</button>
    </div>
  )
}
