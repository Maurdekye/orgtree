import { createRoot } from 'react-dom/client'
import { Msg, ToolChip } from '../src/canvas/desk'
import { RunningTurnContext, TurnActiveContext } from '../src/canvas/toolclock'
const now = Date.parse('2026-10-20T10:00:00.000Z')
Date.now = () => now
const start = new Date(now - 125000).toISOString()
createRoot(document.getElementById('root')!).render(<main style={{ margin: '48px auto', width: 880 }}>
  <h2>Long-running tool and thought clocks</h2>
  <TurnActiveContext.Provider value={true}><RunningTurnContext.Provider value={start}>
    <p className="dim">Executing for two minutes and five seconds</p>
    <ToolChip t={{ id: 'running', name: 'Bash', arg: 'synthetic slow operation', started_at: start }} slug="synthetic" nid="agent" />
    <p className="dim">Writing input for two minutes and five seconds</p>
    <ToolChip t={{ id: 'writing', name: 'Bash', writing_started_at: start }} slug="synthetic" nid="agent" />
    <p className="dim">Finished thought uses the same duration style</p>
    <Msg m={{ role: 'assistant', text: '', thinking_sealed: true, think_secs: 125 }} slug="synthetic" nid="agent" />
  </RunningTurnContext.Provider></TurnActiveContext.Provider>
</main>)
