import { createRoot } from 'react-dom/client'
import { TeamChromeFixture, CHROME_ORG } from './teamchrome-fixture'
import { forgetModalPins, forgetModalOpenCache, pinModal } from '../src/canvas/modalpin'

// Entirely synthetic: no HTTP request reaches an engine or live organization.
window.fetch = (() => Promise.resolve(new Response(JSON.stringify({
  items: [], references: {}, revisions: {}, next_cursor: null,
  pending: [], delivered: [], sent: [],
}), { headers: { 'content-type': 'application/json' } }))) as typeof fetch
localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
pinModal('agent-list', { x: 25, y: 70, w: 450, h: 540 }, CHROME_ORG)
pinModal('agent-team', { x: 525, y: 70, w: 450, h: 540 }, CHROME_ORG)
createRoot(document.getElementById('root')!).render(<TeamChromeFixture />)
