import { createRoot } from 'react-dom/client'
import { AgentStatesView } from '../src/canvas/statesview'
import '../src/styles.css'

// Capture fixture for the node-settings States tab. Light theme:
// document.documentElement.classList.add('contrast-light') before capture.
// 'Load older' fetches the second page. All data synthetic.
const zero = { active: 0, idle: 0, blocked: 0, halted: 0, frozen: 0 }
const kinds = ['idle', 'active', 'blocked', 'active', 'frozen', 'active', 'halted', 'idle'] as const
// durations spread over the whole 1 s .. 7 d log scale so the bars differ; the
// open first row starts relative to the real clock so its live bar is stable
const LENGTHS = [1800, 5, 90, 7200, 86400, 400000, 30, 700000, 600, 45, 20000, 3 * 86400, 12, 2700, 9 * 86400, 300, 60, 150000, 8, 4000]
const spans = (from: number, n: number, openFirst: boolean) => {
  let end = Date.now() - 20 * 60000 - from * 3 * 3600000
  return Array.from({ length: n }, (_, i) => {
    const k = from + i, secs = LENGTHS[k % LENGTHS.length]!
    const start = new Date((openFirst && i === 0 ? Date.now() - secs * 1000 : end - secs * 1000)).toISOString()
    const out = { state: kinds[k % kinds.length]!, start, end: openFirst && i === 0 ? null : new Date(end).toISOString(), secs }
    end -= secs * 1000 + 40 * 60000
    return out
  })
}
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
