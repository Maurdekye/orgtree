import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import { TurnActiveContext } from '../src/canvas/toolclock'
import type { ToolChip as ToolChipData } from '../src/types'
import '../src/styles.css'

Date.now = () => Date.parse('2026-10-14T16:00:01.200Z')
const start = '2026-10-14T16:00:00Z'
const rows: [string, string, ToolChipData][] = [
  ['unknown-muse', 'Muse: writing unobserved', { id: 'muse', name: 'powershell', arg: 'Show current dir contents',
    started_at: start, ended_at: '2026-10-14T16:00:00.784Z', result: 'done' }],
  ['unknown-codex', 'Codex: writing unobserved', { id: 'codex', name: 'orgtree_work', arg: 'update',
    writing_secs: null, started_at: start, ended_at: '2026-10-14T16:00:00.200Z', result: 'done' } as unknown as ToolChipData],
  ['known', 'Observed writing: completed', { id: 'known', name: 'Bash', arg: 'Say hello', writing_secs: 1.2,
    started_at: start, ended_at: '2026-10-14T16:00:00.200Z', result: 'done' }],
  ['running', 'Execution in progress: writing unobserved', { id: 'running', name: 'powershell',
    arg: 'Show current dir contents', started_at: start }],
  ['writing', 'Observed writing: in progress', { id: 'writing', name: 'Bash', arg: 'Say hello', writing_started_at: start }],
  ['presentation', 'Presented document', { id: 'present-report', name: 'orgtree_present', arg: 'Verification report',
    presentation: { id: 'report', title: 'Verification report' }, writing_secs: 1.2,
    started_at: start, ended_at: '2026-10-14T16:00:00.031Z', result: 'Presented report' }],
  ['sentfile', 'Sent file', { id: 'sent-report', name: 'orgtree_send_file', arg: 'report.txt', writing_secs: 1.2,
    started_at: start, ended_at: '2026-10-14T16:00:00.031Z', result: 'Delivered report',
    file: { path: 'report.txt', name: 'report.txt', bytes: 2048, note: 'Exported report' } }],
  ['sentimage', 'Sent image', { id: 'sent-image', name: 'orgtree_send_file', arg: 'shot.png', writing_secs: 1.2,
    started_at: start, ended_at: '2026-10-14T16:00:00.031Z', result: 'Delivered image',
    file: { path: 'shot.png', name: 'shot.png', bytes: 194560, note: 'Synthetic preview' } }],
]
createRoot(document.getElementById('root')!).render(<main style={{ padding: 32, maxWidth: 950 }}>
  <h2>Tool call timing and status</h2>
  <TurnActiveContext.Provider value={true}>
    {rows.map(([id, label, tool]) => <section key={id} data-case={id} style={{ marginTop: 20 }}>
      <div className="dim" style={{ marginBottom: 6 }}>{label}</div>
      <ToolChip t={tool} slug="fixture" nid="worker" onOpenDoc={() => {}} />
    </section>)}
  </TurnActiveContext.Provider>
</main>)
