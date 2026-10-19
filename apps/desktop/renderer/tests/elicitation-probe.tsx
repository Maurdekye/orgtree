import { createRoot } from 'react-dom/client'
import { AskCard } from '../src/canvas/asks'
import { applyTheme } from '../src/themes'
import { elicitationFixture } from './elicitation-fixture'
applyTheme('orgtree')
const ask = elicitationFixture()
if (new URLSearchParams(location.search).get('mode') === 'url') ask.elicitation = {
  ...ask.elicitation!, mode: 'url', url: 'https://example.invalid/permission', schema: undefined,
}
window.fetch = async () => new Response(JSON.stringify({ answered: ask.id, node: ask.node }), { headers: { 'Content-Type': 'application/json' } })
createRoot(document.getElementById('root')!).render(<div style={{ maxWidth: 620, margin: '24px auto', color: 'var(--ink)' }}>
  <p>Synthetic human permission request · existing request card</p>
  <AskCard ask={ask} slug="fixture" toast={() => {}} />
</div>)
