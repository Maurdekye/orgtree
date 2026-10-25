import type { MailAttachment } from '../types'
import { fileUrl } from '../api'
import { DownloadIcon } from '../icons'
import { fmtBytes, ImgCardCaption, isImg } from './img'
import { openLightbox } from './lightbox'
import { MediaCard, mediaFormat } from './media'

/** Download-card renderer for transcript deliveries; Files uses compact rows. */
export function SentFileCard({ slug, nid, file, eventId, quote }: {
  slug: string; nid: string; file: Pick<MailAttachment, 'name' | 'path' | 'bytes'> & { note?: string | null }
  eventId?: string; quote?: string
}) {
  const href = fileUrl(slug, nid, file.path!)
  const reply = { 'data-reply-event': eventId ?? '', 'data-reply-quote': quote ?? '' }
  return mediaFormat(file.name) ? <div {...reply}><MediaCard href={href} name={file.name ?? 'file'} bytes={file.bytes} note={file.note} /></div>
    : isImg(file.name) ? <div className="filecard imgcard" {...reply}>
    <img className="imgcard-img" src={href} alt={file.name ?? ''} loading="lazy"
      title={`${file.name} — click to view`}
      onClick={() => openLightbox(href, { name: file.name, download: href })} />
    <ImgCardCaption name={file.name} bytes={file.bytes} href={href} note={file.note} />
  </div> : <a className="filecard" {...reply} href={href} download={file.name ?? undefined} title="download">
    <DownloadIcon fontSize="inherit" className="fc-ico" />
    <span className="fc-body"><span className="fc-name">{file.name}</span>
      <span className="dim"> · {fmtBytes(file.bytes)}</span>
      {file.note && <span className="fc-note">{file.note}</span>}
    </span>
  </a>
}
