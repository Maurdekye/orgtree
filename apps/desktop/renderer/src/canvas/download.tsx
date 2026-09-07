import { documentDownloadUrl } from '../api'

export function documentFilename(title: string, format?: string): string {
  const stem = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'document'
  return `${stem}.${format === 'html' ? 'html' : 'md'}`
}

/** Source bytes are downloaded from the engine; HTML is never inserted into this document. */
export function DocumentDownload({ slug, id, title, format }: {
  slug: string; id: string; title: string; format?: string
}) {
  return <a className="document-download" href={documentDownloadUrl(slug, id)}
    download={documentFilename(title, format)} title={`Download ${format === 'html' ? 'HTML prototype' : 'Markdown source'}`}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>Download</a>
}
