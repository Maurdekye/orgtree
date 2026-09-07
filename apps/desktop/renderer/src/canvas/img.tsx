// canvas/img.tsx — inline image attachments (user spec 2026-08-25: agents
// present images as part of a response, and images the user attaches render
// viewable directly — in both cases the bytes already sit in a node's scratch
// and the /file endpoint serves them; everything here is presentation).

import { CloseIcon, DownloadIcon } from '../icons'
import { openLightbox } from './lightbox'

// what renders in an <img>: the browser decodes these regardless of the
// served content-type (image sniffing), so the extension is the whole test
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i
export const isImg = (name: string | null | undefined): boolean =>
  IMG_EXT.test(name ?? '')

export const fmtBytes = (n: number | null | undefined) => (n == null ? '0 B'
  : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

/** A filename that must not wrap, split so CSS can elide the MIDDLE.
 *
 *  User report 2026-08-28: a long unbroken name (`kyo_spotlight_fixed_front
 *  .png`) broke mid-word onto a second row inside a caption designed as one
 *  line, doubling its height and leaving the size, the download control and
 *  the caption misaligned against it.
 *
 *  Middle rather than tail: a tail cut keeps `kyo_spotlight_fixed_fro…` and
 *  throws away the extension and the suffix, and these names are told apart
 *  by their ends at least as often as their beginnings — `..._front.png` vs
 *  `..._back.png` is the whole difference. Splitting into a shrinkable head
 *  and a fixed tail lets `text-overflow: ellipsis` do it with no JS
 *  measurement, so it stays correct at every width including ones nobody
 *  tested. The caller keeps the full name in a `title`. */
export function MidElide({ name }: { name: string | null | undefined }) {
  // `string | undefined` deliberately, matching isImg above and the shape of
  // file.name at every call site — a card whose name is missing must render
  // exactly as it did before (empty), not crash the bubble it sits in
  if (!name) return <>{name ?? ''}</>
  // short names are rendered whole — a split with nothing elided would put a
  // pointless element boundary in the middle of ordinary text
  if (name.length <= 24) return <>{name}</>
  const cut = Math.max(name.length - 10, 1)
  return (
    <>
      <span className="fcn-head">{name.slice(0, cut)}</span>
      <span className="fcn-tail">{name.slice(cut)}</span>
    </>
  )
}

/** The caption strip under a PRESENTED image card: name · size, the download
 *  control, and the agent's note on its own row.
 *
 *  Its own component so the layout probe can render the REAL markup rather
 *  than a hand-copied approximation that could drift from desk.tsx without
 *  anyone noticing (the pattern acctcols_probe.py already established here).
 *  See `.imgcard .fc-body` in styles.css for the one-line rule it relies on. */
export function ImgCardCaption({ name, bytes, href, note }: {
  name: string | null | undefined
  bytes?: number | null
  href: string
  note?: string | null
}) {
  return (
    <span className="fc-body">
      {/* ⚠ AN EXPLICIT ROW ELEMENT, not `flex-wrap` on the parent. Wrapping
          was tried first and measured wrong: a flex item whose content is
          wider than the line gets placed on a line of ITS OWN before it is
          asked to shrink, so a very long name pushed the size and the
          download control onto a second row — the same doubled-height strip,
          reached by a different route. A row that cannot wrap cannot do
          that. (imgcap_probe.py catches it; it is how this was found.) */}
      <span className="fc-row">
        {/* title: the visible name may be elided, and the full one must stay
            reachable without downloading the file to find out what it was */}
        <span className="fc-name" title={name ?? undefined}>
          <MidElide name={name} /></span>
        <span className="dim"> · {fmtBytes(bytes)}</span>
        <a className="fdl" href={href} download={name ?? undefined}
          title="download"><DownloadIcon fontSize="inherit" /></a>
      </span>
      {note && <span className="fc-note">{note}</span>}
    </span>
  )
}

/** one image attachment, viewable in place: a bounded thumbnail (click =
 *  lightbox), a caption with the name + size, a download link, and — on the
 *  composer's staged copies — the remove ✕. Non-images keep their existing
 *  chips at every call site; this component is only ever handed an image. */
export function AttachThumb({ href, name, meta, note, dim, onRemove }: {
  href: string
  name: string
  /** pre-formatted size/detail suffix (call sites hold bytes OR a size string) */
  meta?: string
  note?: string
  dim?: boolean
  onRemove?: () => void
}) {
  return (
    <span className={'attach-thumbwrap' + (dim ? ' dim' : '')}>
      <img className="attach-thumb" src={href} alt={name} loading="lazy"
        title={`${name} — click to view`}
        onClick={() => openLightbox(href, { name, download: href })} />
      <span className="attach-thumbcap">
        <span className="atc-name">{name}</span>
        {meta && <span className="dim">{meta}</span>}
        <a className="fdl" href={href} download={name} title="download"
          onClick={(e) => e.stopPropagation()}>
          <DownloadIcon fontSize="inherit" /></a>
        {onRemove && (
          <button className="chip-x" title="remove from this message"
            onClick={onRemove}><CloseIcon fontSize="inherit" /></button>)}
      </span>
      {note && <span className="fc-note">{note}</span>}
    </span>
  )
}
