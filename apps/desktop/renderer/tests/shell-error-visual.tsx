import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import '../src/styles.css'
import '../src/shell.css'

const failed = { id: 'visual-fail', name: 'PowerShell', arg: 'synthetic failed command', error: 'SYNTHETIC_ERROR: command failed',
  result: 'SYNTHETIC_ERROR: command failed\nLong detail available on expansion.', output_seq: 7,
  started_at: '2026-10-13T18:00:00Z', ended_at: '2026-10-13T18:00:00.200Z' }
const success = { id: 'visual-ok', name: 'Bash', arg: 'synthetic successful command', result: 'SUCCESS_OUTPUT', result_lines: 1,
  started_at: failed.started_at, ended_at: failed.ended_at }
window.fetch = (async () => new Response(JSON.stringify({ output: failed.result + '\nFULL_OUTPUT_END' }))) as typeof fetch
createRoot(document.getElementById('root')!).render(<main style={{ padding: 24, maxWidth: 1000 }}>
  <h2>Shell call transcript fixture</h2>
  <p>Failed call</p><Msg m={{ role: 'assistant', text: '', tools: [failed] }} slug="synthetic" nid="fixture" />
  <p>Successful call</p><Msg m={{ role: 'assistant', text: '', tools: [success] }} slug="synthetic" nid="fixture" />
</main>)
