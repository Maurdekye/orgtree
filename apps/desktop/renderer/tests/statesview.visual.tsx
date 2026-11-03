import { createRoot } from 'react-dom/client'
import { AgentStatesView } from '../src/canvas/statesview'
import '../src/styles.css'

// Capture fixture for the node-settings States tab. Light theme:
// document.documentElement.classList.add('contrast-light') before capture.
// 'Load older' fetches the second page. All data synthetic.
const zero = { active: 0, idle: 0, blocked: 0, halted: 0, frozen: 0 }
const kinds = ['idle', 'active', 'blocked', 'active', 'frozen', 'active', 'halted', 'idle'] as const
const spans = (from: number, n: number, openFirst: boolean) => Array.from({ length: n }, (_, i) => {
  const k = from + i, end = Date.UTC(2026, 10, 2, 12, 0) - k * 47 * 60000, secs = (k % 5 + 1) * 11 * 60 + 5
  return { state: kinds[k % kinds.length]!, start: new Date(end - secs * 1000).toISOString(),
    end: openFirst && i === 0 ? null : new Date(end).toISOString(), secs }
})
window.fetch = (async (url: string) => {
  const older = String(url).includes('before=')
  return new Response(JSON.stringify(older
    ? { node: 'builder', next_cursor: null, states: spans(12, 8, false) }
    : { node: 'builder', next_cursor: '60', states: spans(0, 12, true),
        totals: { h24: { ...zero, active: 6 * 3600 + 120, idle: 15 * 3600, blocked: 1800, frozen: 2 * 3600 },
                  d7: { ...zero, active: 41 * 3600, idle: 88 * 3600, blocked: 5 * 3600, halted: 900, frozen: 9 * 3600 } } }),
    { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch
createRoot(document.getElementById('root')!).render(
  <div className="settings cfg" style={{ width: 560, height: 520, margin: 24, display: 'flex', flexDirection: 'column' }}>
    <div className="app-settings-panel agent-history-tab" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <AgentStatesView slug="fixture" nid="builder" />
    </div>
  </div>)
