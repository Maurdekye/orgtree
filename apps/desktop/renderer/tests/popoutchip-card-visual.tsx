// popoutchip-card-visual.tsx — the CANVAS-CARD half of the "<X> is in another
// window" capture (@item:orgtree/x-is-in-another-window-placeholder-covers-
// parts-o; tests/popoutchip-visual.tsx is the seven-panel half). The real
// OrgCanvas over the lastdesk fixture tree (production DeskSlot / DeskHost /
// MovableSurface), with a bounded SYNTHETIC child-window adapter: window.open
// returns the contentWindow of a hidden, off-screen same-origin iframe, so no
// native window ever opens. Test-only; bundles unchanged at BASE and the tip.
// Driver globals (main window):
//   popoutCardFixture.focus(id)    -> opens that agent's desk on the canvas
//   popoutCardFixture.children()   -> the synthetic child iframes created so far
//   popoutCardFixture.closeAll()   -> closes them (the surfaces redock)
// The driver pops the desk out by clicking the desk's own "Open in new window"
// button (aria-label), then reads `.popout-notices` / `.desk-elsewhere` in the
// main document; hits() reports elementFromPoint beside the chip and the first
// canvas card centre. The adapter provides exactly: closed, document, name,
// focus(), close(), location, addEventListener / removeEventListener
// (the iframe contentWindow's own), width/height via open() features ignored.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { installAppShortcuts, type CanvasShortcutRef } from '../src/shell/appshortcuts'
import { lastDeskTree } from './lastdesk.fixture'
import '../src/styles.css'
import '../src/shell.css'

window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = (async () => new Response(JSON.stringify({ ok: true, rows: [], items: [],
  pending: [], delivered: [], sent: [], transfers: [], counts: {}, agents: [],
  history: [], next_cursor: null }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
localStorage.clear()

const frames: HTMLIFrameElement[] = []
window.open = ((_url?: string | URL, name?: string) => {
  const f = document.createElement('iframe')
  f.setAttribute('data-synthetic-child', name ?? '')
  f.style.cssText = 'position:fixed;left:-20000px;top:0;width:800px;height:600px;border:0'
  document.body.appendChild(f)
  frames.push(f)
  const w = f.contentWindow!
  try { w.name = name ?? '' } catch { /* cross-realm name */ }
  const closeFrame = () => { w.dispatchEvent(new Event('pagehide')); f.remove() }
  Object.defineProperty(w, 'close', { value: closeFrame, configurable: true })
  return w
}) as typeof window.open

const tree = lastDeskTree('popout-chip-card')
const shortcuts: CanvasShortcutRef = { current: null }
installAppShortcuts(window, () => shortcuts.current ?? {})
function Fixture() {
  const [focus, setFocus] = useState<string | null>(null)
  Object.assign(window, { popoutCardFixture: {
    focus: (id: string) => setFocus(id),
    children: () => frames.map(f => ({ name: f.getAttribute('data-synthetic-child'), connected: f.isConnected })),
    closeAll: () => { for (const f of frames) f.contentWindow?.close() },
    hits: () => {
      const chip = document.querySelector('.desk-elsewhere, .popout-chip'), r = chip?.getBoundingClientRect()
      if (!r) return null
      const at = (x: number, y: number) => document.elementFromPoint(x, y)?.className ?? null
      return { chip: { x: r.x, y: r.y, w: r.width, h: r.height }, besideRight: at(r.right + 8, r.y + 4),
        below: at(r.x + r.width / 2, r.bottom + 8) }
    },
  } })
  return <CurrentOrg.Provider value={tree.slug}>
    <div className="app"><main className="solo"><div className="canvas-stage">
      <OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
        op={async () => ({})} focusAgent={focus} onFocusAgentHandled={() => setFocus(null)}
        canvasShortcuts={shortcuts} />
    </div></main></div>
  </CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
