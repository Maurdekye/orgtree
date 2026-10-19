import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { DeskModelButton } from '../src/canvas/deskmodel'
import { PickerPopover } from '../src/canvas/pickerpopover'
import { SpawnChips } from '../src/canvas/cards'
import { ALL_TIER_SEAT, hireOf, syncProviderRegistries, type CanvasNode } from '../src/canvas/shared'
import type { ProviderInfo } from '../src/types'
import { legacyAppBackend } from './appfeed-fixture'

// Entirely synthetic: neither provider discovery nor model changes reach an engine.
const providers: ProviderInfo[] = ['claude', 'openai', 'google', 'muse'].map(id => ({
  id, label: id, cli: id, hire_enabled: true, user_enabled: true,
  status: { installed: true, connected: true },
}))
const tiers = ['haiku', 'sonnet', 'opus', 'fable', 'luna', 'sol', 'astra', 'flash', 'argon', 'wonder', 'wonder-full']
window.fetch = legacyAppBackend(async input => {
  const route = new URL(String(input), 'http://fixture.invalid').pathname
  const body = route === '/api/providers' ? { providers } : route.endsWith('/staffing-options')
    ? { tiers: tiers.map(tier => ({ tier, seat: 2, default_ok: true, accounts: [], efforts: ['high'] })), errors: [], loading: false }
    : route.endsWith('/hire-providers') ? { providers: providers.map(p => p.id) } : {}
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
})
localStorage.clear()
syncProviderRegistries({ providers })
const node = { id: 'synthetic-worker', state: 'live', tier: 'sol', generation: 1, children: [],
  scope: { tools: {}, add_dirs: [] }, account: 'openai/primary' } as CanvasNode
const query = new URLSearchParams(location.search), mode = query.get('mode') || 'desk'
document.documentElement.classList.toggle('contrast-light', query.get('light') === 'true')
const hires = { claudeHire: hireOf(providers[0]), codexHire: hireOf(providers[1]),
  antigravityHire: hireOf(providers[2]), museHire: hireOf(providers[3]) }
function Surface() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [picked, setPicked] = useState('')
  const chips = <SpawnChips {...hires} seats={ALL_TIER_SEAT} soleHire selected="sol" onSpawn={setPicked} />
  const button = <button id="palette-anchor" onClick={e => setAnchor(e.currentTarget)}>Model choices</button>
  return <>
    <h1>Shared model palette · {mode}</h1>
    <div className="fixture-transcript" aria-hidden="true">Synthetic conversation beneath the floating tokens<br />
      Underlying content remains visible between provider rows<br />No surrounding panel, border or shadow</div>
    {mode === 'desk' ? <header className="fixture-header"><span>Agent desk · </span>
      <DeskModelButton node={node} slug="synthetic" op={async () => { throw Error('No model write is allowed in the visual fixture') }} toast={() => {}} />
      <b> synthetic-worker</b></header>
      : mode === 'quick' ? <footer className="fixture-footer">{button}</footer>
        : <header className="fixture-header">{button}</header>}
    {anchor && <PickerPopover anchor={anchor} onClose={() => setAnchor(null)} kind={mode === 'options' ? 'options' : 'model'}
      label="Synthetic palette" focusFirst>
      {mode === 'options' ? <button>Ordinary options menu</button> : chips}
    </PickerPopover>}
    <output id="picked">{picked}</output>
  </>
}
createRoot(document.getElementById('root')!).render(<Surface />)
