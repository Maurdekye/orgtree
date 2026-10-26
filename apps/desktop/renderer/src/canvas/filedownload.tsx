import { useState } from 'react'
import type { ReactNode } from 'react'
import { responseFilename } from './download'

// Matches the engine's immutable delivery snapshot limit. Bound actual response
// bytes as well: a stored file can have been changed outside Orgtree since delivery.
export const FILE_DOWNLOAD_MAX = 256 * 1024 * 1024

export async function readDownloadBlob(response: Response, maxBytes = FILE_DOWNLOAD_MAX): Promise<Blob> {
  const tooLarge = () => new Error('File exceeds the 256 MiB download limit.')
  const length = Number(response.headers.get('Content-Length'))
  if (length > maxBytes) { await response.body?.cancel(); throw tooLarge() }
  const reader = response.body?.getReader()
  const chunks: BlobPart[] = []
  let size = 0
  if (reader) try {
    for (;;) {
      const {done,value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw tooLarge() }
      chunks.push(value as BlobPart)
    }
  } finally { reader.releaseLock() }
  return new Blob(chunks,{type:response.headers.get('Content-Type') ?? 'application/octet-stream'})
}

/** Like presentation downloads, fetch in the authoritative main realm; only
 * the completed Blob goes to the initiating portal's native download anchor. */
export async function downloadFile(owner: Document, href: string, name: string): Promise<void> {
  const response = await fetch(href,{signal:AbortSignal.timeout(600_000)})
  if (!response.ok) throw new Error(`Download failed (${response.status}). Try again.`)
  const blob = await readDownloadBlob(response)
  const url = window.URL.createObjectURL(blob), anchor = owner.createElement('a')
  anchor.href=url;anchor.download=responseFilename(response,name)
  owner.body.appendChild(anchor)
  try { anchor.click() } finally {
    anchor.remove();window.setTimeout(()=>window.URL.revokeObjectURL(url),30_000)
  }
}

export function FileDownload({ href,name,className,title,ariaLabel,children }: {
  href:string;name:string;className:string;title?:string;ariaLabel?:string;children:ReactNode
}) {
  const [busy,setBusy]=useState(false), [error,setError]=useState('')
  return <><a href={href} download={name} className={className} title={title} aria-label={ariaLabel}
    aria-disabled={busy} onClick={event=>{
      event.preventDefault();event.stopPropagation()
      if(busy)return
      const owner=event.currentTarget.ownerDocument
      setBusy(true);setError('')
      void downloadFile(owner,href,name).catch((e:Error)=>setError(e.message)).finally(()=>setBusy(false))
    }}>{children}</a>{error&&<span role="alert">{error}</span>}</>
}
