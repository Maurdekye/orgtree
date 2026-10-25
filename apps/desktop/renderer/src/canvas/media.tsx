import { useEffect, useRef, useState } from 'react'
import { fmtBytes, MidElide } from './img'
import { DownloadIcon } from '../icons'

export const MEDIA_MAX_BYTES = 256 * 1024 * 1024
const formats: Record<string, [kind: 'video' | 'audio', mime: string]> = {
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'],
  m4a: ['audio', 'audio/mp4'], aac: ['audio', 'audio/aac'], flac: ['audio', 'audio/flac'],
}
export const mediaFormat = (name?: string | null) => formats[name?.split('.').at(-1)?.toLowerCase() ?? '']

/** Only the existing authenticated file route, never authored URLs/file://. */
export function mediaHref(href: string): string | null {
  if (!href.startsWith('/api/orgs/')) return null
  const url = new URL(href, 'http://media.invalid')
  if (url.origin !== 'http://media.invalid' || !/^\/api\/orgs\/[^/]+\/nodes\/[^/]+\/file$/.test(url.pathname)
    || !url.searchParams.has('path')) return null
  url.searchParams.set('media', 'true')
  return url.pathname + url.search
}

/** Shared by delivered files and received/sent message attachment cards. */
export function MediaCard(props: { href: string; name: string; bytes?: number | null; note?: string | null }) {
  return <MediaPlayer key={JSON.stringify([props.href, props.name, props.bytes])} {...props} />
}

function MediaPlayer({ href, name, bytes, note }: { href: string; name: string; bytes?: number | null; note?: string | null }) {
  const [active, setActive] = useState(false), [error, setError] = useState('')
  const element = useRef<HTMLMediaElement | null>(null), card = useRef<HTMLDivElement>(null)
  const version = useRef(0), live = useRef(true)
  const format = mediaFormat(name), src = mediaHref(href)
  const tooBig = bytes != null && bytes > MEDIA_MAX_BYTES
  const release = (media = element.current) => {
    version.current++
    if (media?.hasAttribute('src')) { media.pause(); media.removeAttribute('src'); media.load() }
  }
  useEffect(() => {
    live.current = true
    const mountedMedia = element.current
    const stop = () => { release(); setActive(false) }
    const hidden = () => { if (document.hidden) stop() }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => !entry.isIntersecting)) stop()
    })
    if (card.current) observer?.observe(card.current)
    document.addEventListener('visibilitychange', hidden)
    return () => { live.current = false; release(mountedMedia); observer?.disconnect(); document.removeEventListener('visibilitychange', hidden) }
  }, [])
  const fail = () => { release(); setActive(false); setError('Preview unavailable. Download the file to open it in another app.') }
  const play = () => {
    const media = element.current
    if (!media || !format || !src || tooBig) return
    if (!media.canPlayType(format[1])) { setError('This format is not supported here. Download the file to open it in another app.'); return }
    const token = ++version.current
    setError(''); setActive(true)
    media.src = src
    void media.play().catch(() => { if (live.current && version.current === token) fail() })
  }
  const kind = format?.[0] ?? 'video'
  return <div ref={card} className={`filecard mediacard ${kind}card`}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onPointerDown={event => { if (event.button === 0) event.stopPropagation() }}>
    {!tooBig && src && format ? <>
      {kind === 'video' ? <video ref={node => { element.current = node }} controls preload="none" playsInline hidden={!active} aria-label={name} onError={fail} />
        : <audio ref={node => { element.current = node }} controls preload="none" hidden={!active} aria-label={name} onError={fail} />}
      {!active && <button className="media-play" onClick={play}>Play {kind}</button>}
    </> : null}
    <span className="fc-body"><span className="fc-row"><span className="fc-name" title={name}><MidElide name={name} /></span>
      <span className="dim"> · {fmtBytes(bytes)}</span>
      <a className="fdl" href={href} download={name} title="Download"><DownloadIcon fontSize="inherit" /></a></span>
      {note && <span className="fc-note">{note}</span>}
      {(error || tooBig) && <span className="fc-note" role="status">{tooBig ? 'Playback is limited to 256 MiB. Download this file to open it.' : error}</span>}
    </span>
  </div>
}
