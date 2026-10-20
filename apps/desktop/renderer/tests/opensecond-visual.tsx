import { createRoot } from 'react-dom/client'
import { MenuFixture, SwitchboardFixture } from './opensecond.fixture'

// Entirely synthetic renderer fixture; menu actions are inert callbacks.
const kind = new URLSearchParams(location.search).get('kind') ?? 'agent'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<main style={{ padding: 36 }}>
  <h2>Open submenu · {kind}</h2>
  <p>Synthetic menu ordering capture</p>
  {kind === 'switchboard' ? <SwitchboardFixture /> : <MenuFixture kind={kind} />}
</main>)
