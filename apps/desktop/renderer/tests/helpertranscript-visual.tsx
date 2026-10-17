import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'

let reads = 0
const intro = 'Inspecting the **greeting fixture**.\n\n'
const complete = 'The fixture exports `hello`.\n\n- Source checked\n- Result ready'
const thinking = 'Checking the **source** and the expected behavior.'
function snapshot() {
  const text = intro + (++reads > 1 ? complete : 'Checking the result…')
  return { live: true, messages: [{ id: 'm1', text, thinking, think_secs: 2, tools: [
      { id: 'read', name: 'Read', input_text: '{"file_path":"fixture.ts"}', result: 'export const greeting = "hello"',
        started_at: '2026-10-17T15:00:00Z', ended_at: '2026-10-17T15:00:01Z' },
      { id: 'child', name: 'Agent', input_text: '{"prompt":"Check the fixture"}', result: 'A nested helper stays an ordinary tool row.' },
    ], content_blocks: [{ kind: 'thinking', start: 0, end: thinking.length }, { kind: 'text', start: 0, end: intro.length },
      { kind: 'tool', id: 'read' }, { kind: 'tool', id: 'child' }, { kind: 'text', start: intro.length, end: text.length }] }] }
}
globalThis.fetch = (async input => new Response(JSON.stringify(String(input).includes('/helpertranscript/')
  ? snapshot()
  : { input: { prompt: 'Inspect the synthetic greeting fixture and report the result.' } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

createRoot(document.getElementById('root')!).render(<div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
  <h3>Worker · Chat</h3><div className="msgs" style={{ height: 'auto', minHeight: 0 }}><div className="msg assistant">
    <div className="md">I’ll ask a helper to inspect the fixture.</div>
    <ToolChip t={{ id: 'helper', name: 'Agent', arg: 'Inspect greeting fixture', input_seq: 7, helper_transcript: true }} slug="synthetic" nid="worker" />
  </div></div><div className="dim" style={{ marginTop: 12 }}>Synthetic fixture · no provider calls or live data</div>
</div>)
setTimeout(() => document.querySelector<HTMLElement>('.tline')?.click(), 100)
const ready = setInterval(() => {
  if (reads < 2) return
  const thought = document.querySelector<HTMLElement>('.helper-transcript .thoughtline')
  const tool = document.querySelector<HTMLElement>('.helper-transcript .tline')
  if (!thought || !tool) return
  thought.click(); tool.click(); clearInterval(ready)
  document.body.dataset.ready = 'true'
}, 50)
