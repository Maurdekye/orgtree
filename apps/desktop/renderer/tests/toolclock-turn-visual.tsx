import { createRoot } from 'react-dom/client'
import type { Context, ReactNode } from 'react'
import * as clock from '../src/canvas/toolclock'
import { ToolChip } from '../src/canvas/desk'
import '../src/styles.css'

// The user's report (2026-10-14), at a fixed observed time so before/after
// pixels compare: today's turn was admitted at 17:31:49 and its call started at
// 17:31:57; yesterday's call, left open when its turn ended, started at 18:23:49
// the day before. Before this change the desk only knew that SOME turn ran and
// counted yesterday's call too. The running turn's start is read through the
// module, so the same fixture builds against the renderer before it existed.
const observedNow = Date.parse('2026-10-14T17:32:30.000Z')
Date.now = () => observedNow
const turn = '2026-10-14T17:31:49.000Z'
const RunningTurn = (clock as { RunningTurnContext?: Context<string | null> }).RunningTurnContext
const desk = (node: ReactNode) => <clock.TurnActiveContext.Provider value={true}>
  {RunningTurn ? <RunningTurn.Provider value={turn}>{node}</RunningTurn.Provider> : node}
</clock.TurnActiveContext.Provider>
createRoot(document.getElementById('root')!).render(<main style={{ padding: 32, maxWidth: 900 }}>
  <h2>A turn is running; an earlier turn left a call open</h2>
  {desk(<div className="msgs">
    <div data-chip="old"><ToolChip t={{ id: 'old', name: 'powershell', arg: 'List workspace roots',
      started_at: '2026-10-13T18:23:49.000Z' }} slug="org" nid="worker" /></div>
    <div data-chip="current"><ToolChip t={{ id: 'now', name: 'powershell', arg: 'Show current dir contents',
      started_at: '2026-10-14T17:31:57.000Z' }} slug="org" nid="worker" /></div>
  </div>)}
</main>)
