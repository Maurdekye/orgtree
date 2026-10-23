import { useCallback, useEffect, useRef, useState } from 'react'
import { getDeliveredFiles, type DeliveredFile, type DeliveredFilesPage } from '../api'
import { onLiveBump } from '../livebus'
import { SentFileCard } from './filecard'

/** Retained download cards, read in bounded pages independently of chat history. */
export function AgentFilesView({ slug, nid }: { slug: string; nid: string }) {
  const [page, setPage] = useState<DeliveredFilesPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identity = useRef(0)
  const inFlight = useRef(false)
  const browsingOlder = useRef(false)
  const load = useCallback(async (before?: string) => {
    if (inFlight.current) return
    const request = identity.current
    inFlight.current = true; setBusy(true); setError('')
    try {
      const result = await getDeliveredFiles(slug, nid, before)
      if (request !== identity.current) return
      setPage(previous => ({ ...result, files: before ? uniqueFiles([...(previous?.files ?? []), ...result.files]) : result.files }))
      browsingOlder.current = Boolean(before)
    } catch (e) {
      if (request === identity.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === identity.current) { inFlight.current = false; setBusy(false) }
    }
  }, [slug, nid])
  useEffect(() => {
    ++identity.current; inFlight.current = false; browsingOlder.current = false; setPage(null)
    void load()
    // Keep an older browsing window stable; Refresh explicitly returns to newest.
    const off = onLiveBump(() => { if (!browsingOlder.current) void load() })
    return () => { ++identity.current; off() }
  }, [load])
  return <section className="agent-files" aria-label={`${nid}'s files`}>
    <div className="agent-files-head"><span className="dim">Delivered files · newest first</span>
      <button disabled={busy} onClick={() => void load()}>Refresh</button></div>
    {error && <p role="alert">Could not load files: {error}</p>}
    {!page && busy && <p role="status" className="dim">Loading files…</p>}
    {page?.files.length === 0 && <p className="dim">No delivered files yet.</p>}
    <ol className="agent-files-list">{page?.files.map(file => <li key={file.delivery_id}>
      <time className="dim" dateTime={file.at} title={file.at}>{new Date(file.at).toLocaleString()}</time>
      <SentFileCard slug={slug} nid={nid} file={file} />
    </li>)}</ol>
    {page?.next_cursor && <button disabled={busy} onClick={() => void load(page.next_cursor!)}>{busy ? 'Loading…' : 'Load older files'}</button>}
  </section>
}

function uniqueFiles(files: DeliveredFile[]): DeliveredFile[] {
  const seen = new Set<string>()
  return files.filter(file => !seen.has(file.delivery_id) && Boolean(seen.add(file.delivery_id)))
}
