import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import { statusLabel } from '../src/canvas/docketstatus'
const statuses = ['open', 'waiting', 'in_progress', 'blocked', 'review', 'approved', 'done', 'backlogged']
window.fetch = (async input => {
  const names = new URL(String(input), location.href).searchParams.get('names')?.split(',') ?? []
  return new Response(JSON.stringify({ references: names.map(id => ({ slug: id, title: 'Synthetic ticket', status: id.replace('fixture-', '') })) }),
    { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
createRoot(document.getElementById('root')!).render(<main style={{ margin: '32px auto', width: 880 }}>
  <h2>Current ticket status</h2><p className="dim">Inline ticket edges use the docket status palette.</p>
  {statuses.map((status, i) => <div key={status} data-state={status} style={{ display: 'grid', gridTemplateColumns: '145px 1fr', alignItems: 'center', minHeight: 57 }}>
    <span className={`docket-status status-${status}`}>{status === 'waiting' ? 'Waiting' : statusLabel(status)}</span>
    <ToolChip slug="synthetic" nid="author" onWorkLink={() => {}} t={{ id: `call-${i}`, name: i % 2 ? 'mcp__orgtree__orgtree_staff' : 'mcp__orgtree__orgtree_work',
      arg: i % 2 ? 'assign' : 'update', result: '{}', refs: [{ kind: 'ticket', id: `fixture-${status}` }] }} />
  </div>)}
</main>)
