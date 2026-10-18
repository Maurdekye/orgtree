import { createRoot } from 'react-dom/client'
import { NearCard, agent, seedFastMode } from './fastmode-near-fixture'
import { applyTheme } from '../src/themes'
applyTheme('orgtree'); seedFastMode()
document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden'
const rows = [
  ['Idle - fast on', agent(true, { id: 'idle-on' })],
  ['Idle - fast off', agent(false, { id: 'idle-off' })],
  ['Running fast - queued off', agent(false, { id: 'running-on', busy: true, fast_mode_current: true })],
  ['Running standard - queued on', agent(true, { id: 'queued-on', busy: true, fast_mode_current: false })],
] as const
createRoot(document.getElementById('root')!).render(<main style={{ padding: 24, color: 'var(--ink)' }}>
  <h2>Near zoom - active fast setting</h2>
  <p>The icon card is passive. Hover text: fast.</p>
  {rows.map(([label, node], i) => <section key={node.id} data-fixture={node.id}
    style={{ position: 'absolute', left: 32 + (i % 2) * 470, top: 140 + Math.floor(i / 2) * 240, width: 440, height: 220 }}>
    <h3 style={{ margin: 0, fontSize: 14 }}>{label}</h3>
    <div style={{ position: 'relative', marginTop: 20, transform: 'scale(1.4)', transformOrigin: 'top left' }}>
      <NearCard node={node} />
    </div>
  </section>)}
</main>)
