import { createRoot } from 'react-dom/client'
import { ToolTimes, TurnActiveContext } from '../src/canvas/toolclock'
import '../src/styles.css'

// Fixed observed elapsed value keeps before/after pixels comparable.
const observedNow = Date.parse('2026-10-14T16:00:01.200Z')
Date.now = () => observedNow
const start = '2026-10-14T16:00:00Z'
createRoot(document.getElementById('root')!).render(<main style={{ padding: 32, maxWidth: 900 }}>
  <h2>Observed tool timing: 1.2 seconds elapsed</h2>
  <TurnActiveContext.Provider value={true}>
    <p data-clock="writing">Writing input <ToolTimes tool={{ name: 'Bash', writing_started_at: start }} /></p>
    <p data-clock="execution">Executing call <ToolTimes tool={{ name: 'Bash', started_at: start }} /></p>
    <p data-clock="final">Completed <ToolTimes tool={{ name: 'Bash', writing_secs: 1.2, started_at: start,
      ended_at: '2026-10-14T16:00:00.200Z', result: 'done' }} /></p>
  </TurnActiveContext.Provider>
</main>)
