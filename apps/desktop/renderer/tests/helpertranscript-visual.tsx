import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'

let reads = 0
globalThis.fetch = (async input => new Response(JSON.stringify(String(input).includes('/helpertranscript/')
  ? { live: true, messages: [{ id: 'm1', text: ++reads > 1 ? 'The synthetic fixture is verified. Preparing the result.' : 'Inspecting the synthetic fixture…',
    thinking: 'Checking the source and the expected behavior.', tools: [
      { id: 'read', name: 'Read', input_text: '{"file_path":"fixture.ts"}', result: 'export const greeting = "hello"' },
      { id: 'child', name: 'Agent', input_text: '{"prompt":"Check the fixture"}', result: 'A nested helper stays an ordinary tool row.' },
    ] }] }
  : { input: { prompt: 'Inspect the synthetic greeting fixture and report the result.' } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

createRoot(document.getElementById('root')!).render(<div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
  <h3>Worker · Chat</h3><div className="msgs" style={{ height: 'auto', minHeight: 0 }}><div className="msg assistant">
    <div className="md">I’ll ask a helper to inspect the fixture.</div>
    <ToolChip t={{ id: 'helper', name: 'Agent', arg: 'Inspect greeting fixture', input_seq: 7, helper_transcript: true }} slug="synthetic" nid="worker" />
  </div></div><div className="dim" style={{ marginTop: 12 }}>Synthetic fixture · no provider calls or live data</div>
</div>)
setTimeout(() => { document.querySelector<HTMLElement>('.tline')?.click(); document.body.dataset.ready = 'true' }, 100)
