// tempdeskframe.visual.tsx — the fixture for tempdeskframe.capture.cjs (user 2026-11-13 mf430d688fdcb: the temporary
// agent desk moves onto the shared modal system; design A of m2672b93c2df8).
//
// The real `TempDeskModal` over a real desk registry (`DeskHosts`) with one canvas slot for the agent, as OrgCanvas
// arranges them. What is synthetic: the agent, the host's pin action (it records the box it was handed and closes the
// modal, where OrgCanvas would add the pin), and every request, answered here with an empty conversation. Browser-only:
// no engine, bridge or live org.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { adoptPinLayer } from '../src/canvas/pinspace'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { TempDeskModal } from '../src/canvas/tempdesk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

localStorage.clear()
const ORG = 'alpha'
window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false,
    last_error: null, messages: [], live: [], draft_epoch: 0, mail_pending: 0, pending_mail: [] }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
      : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const node = {
  id: 'scout', tier: 'opus', state: 'live', generation: 0, parent: null, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode
const map = new Map([[node.id, node]])
const op = () => Promise.resolve({} as OpResult)
const noop = () => {}

function App() {
  const [open, setOpen] = useState(false)
  const [offerPin, setOfferPin] = useState(true)
  const [pinnedAt, setPinnedAt] = useState('')
  return <CurrentOrg.Provider value={ORG}>
    <div data-pin-org={ORG} ref={(el) => { if (el) adoptPinLayer(ORG, el) }}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>
      <DeskHosts map={map} slug={ORG}>
        <div style={{ position: 'absolute', left: 16, top: 12, display: 'flex', gap: 8 }}>
          <button type="button" id="open-temp" onClick={() => setOpen(true)}>Open scout's desk temporarily</button>
          <button type="button" id="toggle-pin" onClick={() => setOfferPin((v) => !v)}>pin offered: {String(offerPin)}</button>
          <span id="pinned-at">{pinnedAt}</span>
        </div>
        {/* the agent's place on the canvas: where the one desk lives when nothing borrows it */}
        <div data-which="canvas" style={{ position: 'absolute', left: 16, top: 52, width: 460, height: 420,
          border: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
          <DeskSlot node={node} map={map} op={op} slug={ORG} toast={noop} bare />
        </div>
        {open && <TempDeskModal node={node} close={() => setOpen(false)}
          onPin={offerPin ? (rect) => { setPinnedAt(`pin asked at ${Math.round(rect.w)}x${Math.round(rect.h)}`); setOpen(false) } : undefined}
          desk={{ map, op, slug: ORG, toast: noop }} />}
      </DeskHosts>
    </div>
  </CurrentOrg.Provider>
}

document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<App />)
