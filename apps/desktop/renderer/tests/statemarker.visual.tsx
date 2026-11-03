import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import type { ChatMessage } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

// Capture fixture for the transcript's state markers (USER 2026-11-03 m1bfdb3fba01b). Theme: ?theme=light|charcoal.
// Rows, top to bottom: an assistant line, "Active for 32s", "Idle for 19s", a SUB-SECOND ended state (no line, no gap),
// "Blocked for 5m", "Frozen for 2h", then an assistant line again. All data synthetic.
const theme = new URLSearchParams(location.search).get('theme') ?? 'light'
applyContrast(theme === 'charcoal' ? 'charcoal' : 'light'); applyTheme('claude')

const state = (n: number, state: string, prev: string, secs: number): ChatMessage => ({
  role: 'system', kind: 'state', state, prev_state: prev, prev_secs: secs,
  text: `${state} · was ${prev} ${secs}s`, ts: `2026-11-03T10:${String(10 + n).padStart(2, '0')}:00Z`, seq: n, row_id: `r${n}`,
})
const ROWS: ChatMessage[] = [
  { role: 'assistant', text: 'Working on the fix.', ts: '2026-11-03T10:10:00Z', seq: 1 } as ChatMessage,
  state(2, 'idle', 'active', 32),
  state(3, 'active', 'idle', 19),
  state(4, 'blocked', 'active', 0),   // under a second: not drawn
  state(5, 'active', 'blocked', 300),
  state(6, 'frozen', 'active', 7),
  state(7, 'active', 'frozen', 7200),
  { role: 'assistant', text: 'Back at it.', ts: '2026-11-03T12:30:00Z', seq: 8 } as ChatMessage,
]
createRoot(document.getElementById('root')!).render(
  <div className="desk" style={{ width: 520, margin: 24, display: 'flex', flexDirection: 'column', gap: 6 }}>
    {ROWS.map(m => <div key={m.seq} data-transcript-row data-seq={m.seq}><Msg m={m} slug="fixture" nid="worker" /></div>)}
  </div>)
