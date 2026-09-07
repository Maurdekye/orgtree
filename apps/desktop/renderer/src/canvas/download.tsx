import { documentDownloadUrl } from '../api'
import { useState } from 'react'

export function documentFilename(title: string, format?: string): string {
  const stem = (title || 'document').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'document'
  return `${stem}.${format === 'html' ? 'html' : 'md'}`
}

export function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i)
  let value = plain?.[1] || plain?.[2] || fallback
  if (encoded) { try { value = decodeURIComponent(encoded) } catch { /* keep plain fallback */ } }
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 180) || fallback
}

/** Fetch executes in this module's authoritative main frame, including when
 * its React handler runs from an adopted popout. The child never signs API
 * requests; only the finished Blob is handed to its native download anchor. */
export async function downloadDocument(owner: Document, slug: string, id: string, title: string, format?: string) {
  const response = await fetch(documentDownloadUrl(slug, id), { signal: AbortSignal.timeout(600_000) })
  if (!response.ok) throw new Error(`Download failed (${response.status}). Try again.`)
  const blob = await response.blob()
  const url = window.URL.createObjectURL(blob)
  const anchor = owner.createElement('a')
  anchor.href = url
  anchor.download = responseFilename(response, documentFilename(title, format))
  owner.body.appendChild(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    window.setTimeout(() => window.URL.revokeObjectURL(url), 30_000)
  }
}

/** Source bytes are downloaded from the engine; HTML never enters app DOM. */
export function DocumentDownload({ slug, id, title, format }: {
  slug: string; id: string; title: string; format?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <><a className="document-download" href={documentDownloadUrl(slug, id)} aria-disabled={busy}
    download={documentFilename(title, format)} title={`Download ${format === 'html' ? 'HTML prototype' : 'Markdown source'}`}
    onPointerDown={e => e.stopPropagation()} onClick={e => {
      e.preventDefault(); e.stopPropagation()
      if (busy) return
      setBusy(true); setError('')
      void downloadDocument(e.currentTarget.ownerDocument, slug, id, title, format)
        .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
    }}>{busy ? 'Downloading…' : 'Download'}</a>{error && <span role="alert" className="ask-warn">{error}</span>}</>
}
