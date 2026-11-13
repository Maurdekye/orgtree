// attentiondivider.visual.tsx — the fixture for attentiondivider.capture.cjs (user 2026-11-13 m525fd3e66e99: drag the
// Attention divider to the side to hide a panel; a button on the divider swaps the two).
//
// The REAL `AttentionView` with its two real panels, in an organization that holds the eye and nothing else (the same
// arrangement attentionview.test.tsx uses), inside a host that owns the organization's pin layer so the panels' real
// pin and pop-out buttons work. Browser-only: no engine, bridge or live org; every request is answered here with
// nothing waiting. Storage is cleared on the first load only, so a reload shows what was remembered.
import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { adoptPinLayer } from '../src/canvas/pinspace'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import type { OpFn, TreePayload } from '../src/types'
import { attentionLayout, setOrgView } from '../src/attention/mode'
import { AttentionView } from '../src/attention/AttentionView'
import '../src/styles.css'
import '../src/shell.css'

const ORG = 'alpha'
if (!sessionStorage.getItem('attndivider-seeded')) {
  localStorage.clear()
  sessionStorage.setItem('attndivider-seeded', '1')
  setOrgView(ORG, 'attention')
}

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
    active: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const tree = {
  slug: ORG, name: 'Alpha', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload
const map = new Map<string, CanvasNode>([[USER, {
  id: USER, parent: null, tier: null, state: 'user', children: [],
} as unknown as CanvasNode]])
const op: OpFn = () => Promise.resolve({ ok: true } as never)

// what the capture reads back: the remembered layout, straight from the store
Object.assign(window, { attnLayout: () => attentionLayout(ORG) })

document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(
  <CurrentOrg.Provider value={ORG}>
    <div data-pin-org={ORG} ref={(el) => { if (el) adoptPinLayer(ORG, el) }}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>
      <AttentionView slug={ORG} tree={tree} op={op} toast={() => {}} map={map}
        attentionDeskActiveAgentsOnly={false} />
    </div>
  </CurrentOrg.Provider>)
