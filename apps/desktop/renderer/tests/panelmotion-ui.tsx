// Fixture for panelmotion-capture.cjs: the org Apps button and its panel
// windows (AppsWorkspace) against the capture's local server, with no fetch
// mock, over a stand-in canvas area that window pins use as their pin space.
import { createRoot } from 'react-dom/client'
import { AppsButton, AppsWorkspace } from '../src/canvas/apps/ui'
import { invalidateCustomApps } from '../src/canvas/apps/store'

const SLUG = 'synthetic-panels'
// The capture stops a panel "elsewhere" (as Stop all or an agent would) and
// then asks for the listing the engine's change notice would trigger.
Object.assign(window, { refreshPanels: () => invalidateCustomApps(SLUG) })

createRoot(document.getElementById('root')!).render(<>
  <style>{`html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--text);font:13px system-ui,sans-serif}
.capture-bar{position:fixed;left:0;right:0;top:0;height:40px;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.capture-canvas{position:fixed;left:0;right:0;top:40px;bottom:0;border:0;background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:24px 24px}
.capture-canvas p{margin:16px;color:var(--dim)}`}</style>
  <div className="capture-canvas" data-pin-org={SLUG}><p>Synthetic org canvas (capture fixture)</p></div>
  <div className="capture-bar"><span>synthetic-panels</span><AppsButton slug={SLUG} /></div>
  <AppsWorkspace slug={SLUG} />
</>)
