import { createRoot } from 'react-dom/client'
import { Msg, ToolChip } from '../src/canvas/desk'
import { LiveTokenContext } from '../src/canvas/tokencount'

// Real shared transcript components; all observations are synthetic fixtures.
createRoot(document.getElementById('root')!).render(<main style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
  <h3>Worker · Chat</h3>
  <div className="msgs" style={{ height: 'auto', minHeight: 0, gap: 14 }}>
    <div className="msg assistant"><div className="md">Completed tool output</div>
      <ToolChip slug="synthetic" nid="worker" t={{ id: 'done', name: 'Read', result: 'Synthetic result',
        started_at: '2026-10-18T07:00:00.123000Z', ended_at: '2026-10-18T07:00:00.123432Z', writing_secs: 0.00433,
        output_tokens: 1234, output_tokens_estimated: true }} /></div>
    <div className="msg assistant"><div className="md">Live tool output</div>
      <LiveTokenContext.Provider value={{ live: { id: 'live', output_tokens: 42, output_tokens_estimated: true } }}>
        <ToolChip slug="synthetic" nid="worker" t={{ id: 'live', name: 'Bash' }} />
      </LiveTokenContext.Provider></div>
    <Msg slug="synthetic" nid="worker" m={{ role: 'assistant', text: '', thinking: 'Synthetic reasoning.',
      think_secs: 6, thinking_tokens: 321 }} />
    <div className="msg assistant"><div className="md">Reported empty output</div>
      <ToolChip slug="synthetic" nid="worker" t={{ id: 'zero', name: 'Read', result: '',
        output_tokens: 0, output_tokens_estimated: false }} /></div>
  </div>
</main>)
