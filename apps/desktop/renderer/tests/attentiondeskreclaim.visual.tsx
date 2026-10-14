import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { attentionDeskScene } from './attentiondeskreclaim.fixture'
import '../src/styles.css'

// Isolated browser-only data. No provider, engine, desktop bridge or live org.
window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false,
    last_error: null, messages: [], live: [], draft_epoch: 0, mail_pending: 0, pending_mail: [] } :
    /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } } :
      /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch
const scene = attentionDeskScene()
scene.init()
function Surface() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    Object.assign(window, { deskReclaimVisual: { open: () => setOpen(true), close: () => setOpen(false),
      contrast: (light: boolean) => {
        document.documentElement.classList.toggle('contrast-light', light)
        document.documentElement.classList.toggle('contrast-charcoal', !light)
      } } })
  }, [])
  return <>{scene.wrap(open)}<div style={{ position: 'absolute', left: 24, top: 12 }}>
    Pinned Agent desk · switchboard close fixture
  </div></>
}
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Surface />)
