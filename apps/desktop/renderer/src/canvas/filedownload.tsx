import { useState } from 'react'
import type { ReactNode } from 'react'
import { responseFilename } from './download'

/** A delivered file can be tens of GB (the engine's limit is 32 GiB), so it is never fetched into a
 * Blob: a plain anchor click makes Electron's own download (main/remote-downloads.ts) stream it to
 * the place the user picks in the Save dialog. A HEAD request first shows an engine refusal in the
 * card, since a native download that fails to start says nothing of why. */
export async function downloadFile(owner: Document, href: string, name: string): Promise<void> {
  const check = await fetch(href,{method:'HEAD',signal:AbortSignal.timeout(60_000)})
  if (!check.ok) throw new Error(`Download failed (${check.status}). Try again.`)
  const anchor = owner.createElement('a')
  anchor.href=href;anchor.download=responseFilename(check,name)
  owner.body.appendChild(anchor)
  try { anchor.click() } finally { anchor.remove() }
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
