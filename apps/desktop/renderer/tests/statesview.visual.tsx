import { createRoot } from 'react-dom/client'
import { AgentStatesView } from '../src/canvas/statesview'
import '../src/styles.css'

// Capture fixture for the node-settings States tab. Light theme:
// document.documentElement.classList.add('contrast-light') before capture.
// Older states load by themselves as the list scrolls: three pages (12, 4 and 4 rows), so a capture scrolls the
// settings list to its end to see the appended pages and the end of the history. The window width comes from
// the page URL (?w=420 and ?w=760 are the two captured widths); ?provider=claude|openai picks the Active colour. All data synthetic.
const zero = { active: 0, idle: 0, blocked: 0, halted: 0, frozen: 0 }
const kinds = ['idle', 'active', 'blocked', 'active', 'frozen', 'active', 'halted', 'idle'] as const
// Durations spread over the whole 1 s .. 7 d log scale so the bars differ. All 20
// spans are built ONCE, contiguously (each span ends where the next newer one
// starts, the way the engine writes them), the first row open and relative to
// the real clock; the two pages are slices of that one list, so "Load older"
// always appends strictly older rows.
const LENGTHS = [1800, 5, 90, 7200, 86400, 400000, 30, 700000, 600, 45, 20000, 3 * 86400, 12, 2700, 9 * 86400, 300, 60, 150000, 8, 4000]
const ALL = (() => {
  let newerStart = Date.now()
  return LENGTHS.map((secs, k) => {
    const open = k === 0
    const end = open ? null : newerStart
    const start = (open ? Date.now() : newerStart) - secs * 1000
    newerStart = start
    return { state: kinds[k % kinds.length]!, start: new Date(start).toISOString(), end: end === null ? null : new Date(end).toISOString(), secs }
  })
})()
window.fetch = (async (url: string) => {
  const before = /before=(\d+)/.exec(String(url))?.[1]
  const [from, to, next] = before === '12' ? [12, 16, '16'] : before === '16' ? [16, 20, null] : [0, 12, '12']
  return new Response(JSON.stringify(before
    ? { node: 'builder', next_cursor: next, states: ALL.slice(from, to) }
    : { node: 'builder', next_cursor: next, states: ALL.slice(from, to),
        totals: { h24: { ...zero, active: 6 * 3600 + 120, idle: 15 * 3600, blocked: 1800, frozen: 2 * 3600 },
                  d7: { ...zero, active: 41 * 3600, idle: 88 * 3600, blocked: 5 * 3600, halted: 900, frozen: 9 * 3600 } } }),
    { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch
const width = Number(new URLSearchParams(location.search).get('w')) || 560
createRoot(document.getElementById('root')!).render(
  <div className="settings cfg" style={{ width, height: 520, margin: 24, display: 'flex', flexDirection: 'column' }}>
    <div className="app-settings-panel agent-history-tab" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <AgentStatesView slug="fixture" nid="builder" provider={new URLSearchParams(location.search).get('provider') ?? 'claude'} />
    </div>
  </div>)
