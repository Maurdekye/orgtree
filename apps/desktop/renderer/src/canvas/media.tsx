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

const NOT_SUPPORTED = 'This format is not supported here. Download the file to open it in another app.'

/** Audio waits for Play: nothing is requested before it (4.5.0). A video opens on render (USER 2026-10-30 m478dfd75cf44
 *  "inline videos should open automatically, just not play until clicked"): its player and first frame show while the card
 *  is on screen, loaded with `preload="metadata"`; only its own controls play it. Scrolled away, hidden or unmounted, it
 *  is released, and it comes back paused. */
function MediaPlayer({ href, name, bytes, note }: { href: string; name: string; bytes?: number | null; note?: string | null }) {
  const [active, setActive] = useState(false), [error, setError] = useState('')
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === 'undefined')
  const element = useRef<HTMLMediaElement | null>(null), card = useRef<HTMLDivElement>(null)
  const version = useRef(0), live = useRef(true)
  const format = mediaFormat(name), src = mediaHref(href)
  const tooBig = bytes != null && bytes > MEDIA_MAX_BYTES
  const kind = format?.[0] ?? 'video'
  const release = (media = element.current) => {
    version.current++
    if (media?.hasAttribute('src')) { media.pause(); media.removeAttribute('src'); media.load() }
  }
  useEffect(() => {
    live.current = true
    const mountedMedia = element.current
    const fullscreenDocument = mountedMedia?.ownerDocument ?? document
    let inView = typeof IntersectionObserver === 'undefined', docHidden = false
    const settle = () => {
      // ⚠ A VIDEO THAT HAS TAKEN THE WHOLE SCREEN IS ON SCREEN, whatever its card reports (USER 2026-10-30
      // md731a537e304 "i cant maximize inline videos"): releasing it here would blank the fullscreen player.
      // Leaving fullscreen settles again, so a card that is then out of view still lets go.
      if (mountedMedia && fullscreenDocument.fullscreenElement === mountedMedia) return
      const on = inView && !docHidden
      setOnScreen(on)
      if (!on) { release(); setActive(false) }
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      const latest = entries.at(-1)
      if (latest) { inView = latest.isIntersecting; settle() }
    })
    if (card.current) observer?.observe(card.current)
    const visibility = () => { docHidden = document.hidden; settle() }
    document.addEventListener('visibilitychange', visibility)
    fullscreenDocument.addEventListener('fullscreenchange', settle)
    return () => {
      live.current = false; release(mountedMedia); observer?.disconnect()
      document.removeEventListener('visibilitychange', visibility); fullscreenDocument.removeEventListener('fullscreenchange', settle)
    }
  }, [])
  // a video asks for its metadata and first frame while its card is on screen, and lets go when it is not
  useEffect(() => {
    const media = element.current
    if (kind !== 'video' || !onScreen || !media || !format || !src || tooBig) return
    if (!media.canPlayType(format[1])) { setError(NOT_SUPPORTED); return }
    setError('')
    media.src = src
    return () => release(media)
  }, [onScreen])
  const fail = () => { release(); setActive(false); setError('Preview unavailable. Download the file to open it in another app.') }
  const play = () => {
    const media = element.current
    if (!media || !format || !src || tooBig) return
    if (!media.canPlayType(format[1])) { setError(NOT_SUPPORTED); return }
    const token = ++version.current
    setError(''); setActive(true)
    media.src = src
    void media.play().catch(() => { if (live.current && version.current === token) fail() })
  }
  return <div ref={card} className={`filecard mediacard ${kind}card`}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onPointerDown={event => { if (event.button === 0) event.stopPropagation() }}>
    {!tooBig && src && format ? <>
      {kind === 'video' ? <video ref={node => { element.current = node }} controls preload="metadata" playsInline hidden={!!error} aria-label={name} onError={fail} />
        : <audio ref={node => { element.current = node }} controls preload="none" hidden={!active} aria-label={name} onError={fail} />}
      {kind === 'audio' && !active && <button className="media-play" onClick={play}>Play audio</button>}
    </> : null}
    <span className="fc-body"><span className="fc-row"><span className="fc-name" title={name}><MidElide name={name} /></span>
      <span className="dim"> · {fmtBytes(bytes)}</span>
      <a className="fdl" href={href} download={name} title="Download"><DownloadIcon fontSize="inherit" /></a></span>
      {note && <span className="fc-note">{note}</span>}
      {(error || tooBig) && <span className="fc-note" role="status">{tooBig ? 'Playback is limited to 256 MiB. Download this file to open it.' : error}</span>}
    </span>
  </div>
}
