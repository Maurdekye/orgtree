import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { installAppShortcuts, type CanvasShortcutRef } from '../src/shell/appshortcuts'
import { lastDeskTree } from './lastdesk.fixture'
import '../src/styles.css'
import '../src/shell.css'

// Synthetic renderer only; the capture driver blocks every network request.
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = (async () => new Response(JSON.stringify({ ok: true, rows: [], items: [],
  pending: [], delivered: [], sent: [], transfers: [], counts: {}, agents: [],
  history: [], next_cursor: null }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
localStorage.clear()
const tree = lastDeskTree('last-desk-capture')
const shortcuts: CanvasShortcutRef = { current: null }
installAppShortcuts(window, () => shortcuts.current ?? {})
function Fixture() {
  const [focus, setFocus] = useState<string | null>(null)
  Object.assign(window, { focusLastDesk: setFocus })
  return <CurrentOrg.Provider value={tree.slug}>
    <div className="app"><main className="solo"><div className="canvas-stage">
      <OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
        op={async () => ({})} focusAgent={focus} onFocusAgentHandled={() => setFocus(null)}
        canvasShortcuts={shortcuts} />
    </div></main></div>
  </CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
