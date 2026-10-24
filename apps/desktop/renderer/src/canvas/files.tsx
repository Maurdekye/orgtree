import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fileUrl, getDeliveredFiles, type DeliveredFile, type DeliveredFilesPage } from '../api'
import { onLiveBump } from '../livebus'
import { DownloadIcon } from '../icons'
import { fmtBytes, isImg } from './img'
import { openLightbox } from './lightbox'

/** Bounded retained deliveries; the API is newest-first, the list reads upwards. */
export function AgentFilesView({ slug, nid }: { slug: string; nid: string }) {
  const [page, setPage] = useState<DeliveredFilesPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identity = useRef(0), inFlight = useRef(false), pendingLive = useRef(false)
  const current = useRef<DeliveredFilesPage | null>(null)
  const scroller = useRef<HTMLDivElement>(null), follow = useRef(true)
  const restore = useRef<{ top: number; anchor?: string; offset: number; bottom: boolean } | null>(null)
  const load = useCallback(async (mode: 'reset' | 'older' | 'live' = 'reset'): Promise<void> => {
    if (inFlight.current) { if (mode === 'live') pendingLive.current = true; return }
    const before = mode === 'older' ? current.current?.next_cursor : undefined
    if (mode === 'older' && !before) return
    const request = identity.current
    inFlight.current = true; setBusy(true); setError('')
    try {
      let result = await getDeliveredFiles(slug, nid, before ?? undefined)
      if (request !== identity.current) return
      const previous = current.current
      // Catch up a burst larger than one page before joining retained history.
      if (mode === 'live' && previous?.files.length) {
        const known = new Set(previous.files.map(file => file.delivery_id))
        while (result.next_cursor && !result.files.some(file => known.has(file.delivery_id))) {
          const older = await getDeliveredFiles(slug, nid, result.next_cursor)
          if (request !== identity.current) return
          result = { ...older, files: uniqueFiles([...result.files, ...older.files]) }
        }
      }
      const next = mode === 'older' ? { ...result, files: uniqueFiles([...(previous?.files ?? []), ...result.files]) }
        : mode === 'live' && previous?.files.length ? { ...previous, files: uniqueFiles([...result.files, ...previous.files]) }
          : result
      const host = scroller.current
      if (host && (mode === 'reset' || !restore.current)) {
        const top = host.getBoundingClientRect().top
        const anchor = [...host.querySelectorAll<HTMLLIElement>('li[data-delivery-id]')]
          .find(row => row.getBoundingClientRect().bottom > top)
        restore.current = { top: host.scrollTop, anchor: anchor?.dataset.deliveryId,
          offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
          bottom: mode === 'reset' || follow.current }
      }
      if (mode === 'reset') follow.current = true
      current.current = next; setPage(next)
    } catch (e) {
      if (request === identity.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === identity.current) {
        inFlight.current = false; setBusy(false)
        if (pendingLive.current) { pendingLive.current = false; void load('live') }
      }
    }
  }, [slug, nid])
  useLayoutEffect(() => {
    const host = scroller.current, position = restore.current
    restore.current = null
    if (!host || !position) return
    const anchor = [...host.querySelectorAll<HTMLLIElement>('li[data-delivery-id]')]
      .find(row => row.dataset.deliveryId === position.anchor)
    host.scrollTop = position.bottom ? host.scrollHeight : anchor
      ? host.scrollTop + anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - position.offset
      : position.top
  }, [page])
  useEffect(() => {
    ++identity.current; inFlight.current = false; pendingLive.current = false
    follow.current = true; current.current = null; restore.current = null; setPage(null)
    void load()
    const off = onLiveBump(() => { void load('live') })
    return () => { ++identity.current; off() }
  }, [load])
  return <section className="agent-files" aria-label={`${nid}'s files`}>
    <div className="agent-files-head"><span className="dim">Delivered files</span>
      <button disabled={busy} onClick={() => void load()}>Refresh</button></div>
    {error && <p role="alert">Could not load files: {error}</p>}
    <div className="agent-files-scroll" ref={scroller} onScroll={event => {
      const host = event.currentTarget
      follow.current = host.scrollHeight - host.clientHeight - host.scrollTop <= 24
      if (host.scrollTop <= 48) void load('older')
    }}>
      {busy && <p role="status" className="dim agent-files-loading">Loading files…</p>}
      {page?.files.length === 0 && <p className="dim">No delivered files yet.</p>}
      <ol className="agent-files-list">{[...(page?.files ?? [])].reverse().map(file => {
        const href = fileUrl(slug, nid, file.path)
        return <li key={file.delivery_id} data-delivery-id={file.delivery_id}>
          <a className="agent-file-name" href={href} download={file.name}
            title={file.note ? `${file.name}\n${file.note}` : file.name}>{file.name}</a>
          <span className="dim agent-file-size">{fmtBytes(file.bytes)}</span>
          <time className="dim" dateTime={file.at} title={file.at}>{new Date(file.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
          {isImg(file.name) && <button className="agent-file-view" title="View image"
            aria-label={`View ${file.name}`} onClick={() => openLightbox(href, { name: file.name, download: href })}>View</button>}
          <a className="agent-file-download" href={href} download={file.name}
            title="Download" aria-label={`Download ${file.name}`}><DownloadIcon fontSize="inherit" /></a>
        </li>
      })}</ol>
    </div>
  </section>
}

function uniqueFiles(files: DeliveredFile[]): DeliveredFile[] {
  const seen = new Set<string>()
  return files.filter(file => !seen.has(file.delivery_id) && Boolean(seen.add(file.delivery_id)))
}
