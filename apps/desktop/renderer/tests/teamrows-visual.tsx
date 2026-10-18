import { createRoot } from 'react-dom/client'
import { TeamChromeFixture, CHROME_ORG, chromeMap } from './teamchrome-fixture'
import { AgentTeamView } from '../src/canvas/team'
import { PanelCorner } from '../src/canvas/panelcorner'
import { forgetModalPins, forgetModalOpenCache, pinModal } from '../src/canvas/modalpin'

window.fetch = (() => Promise.resolve(new Response(JSON.stringify({ items: [], references: {}, revisions: {}, next_cursor: null,
  pending: [], delivered: [], sent: [] }), { headers: { 'content-type': 'application/json' } }))) as typeof fetch
localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
pinModal('agent-list', { x: 25, y: 50, w: 450, h: 420 }, CHROME_ORG)
pinModal('agent-team', { x: 525, y: 50, w: 450, h: 420 }, CHROME_ORG)
createRoot(document.getElementById('root')!).render(<>
  <TeamChromeFixture />
  <section data-inline-team style={{ position: 'fixed', left: 25, top: 510, width: 950, height: 160, display: 'flex' }}>
    <AgentTeamView map={chromeMap} nid="build-team"
      actions={<PanelCorner kind="agent-team" slug={CHROME_ORG} nid="build-team" />} />
  </section>
</>)
