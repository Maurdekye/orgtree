import { createRoot } from 'react-dom/client'
import { HeldAudienceChips } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'

// The user's own example (USER 2026-11-27 md04a9104c63a): integrator-4 under
// project integration-queue, nine agents reached through it, plus one direct grant
// and a second source project, so the picture shows every case the change touches.
const via = ['api-eng', 'diverge-eng', 'engine-architect', 'iter-bench', 'shader-lang', 'vdw-physics',
  'world-chunks', 'world-model', 'xr-eng']
const map = new Map<string, CanvasNode>([...via, 'coordinator-opus', 'bench-lead']
  .map(id => [id, { id, kind: 'agent', state: 'live' } as unknown as CanvasNode]))
const node = {
  id: 'integrator-4', audiences_held: ['coordinator-opus', ...via, 'bench-lead'], audiences_explicit: ['coordinator-opus'],
  audiences_inherited: [...via.map(grantor => ({ grantor, project: 'integration-queue' })),
    { grantor: 'bench-lead', project: 'bench-pool' }],
}
document.body.style.cssText = 'margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<main style={{ padding: 20, width: 1180 }}>
  <h3 style={{ margin: '0 0 10px' }}>integrator-4 desk header audiences</h3>
  <div className="badges" data-fixture="row"><HeldAudienceChips slug="synthetic" toast={() => {}} map={map} node={node}
    onJump={(id) => { ((window as unknown as { __jumps: string[] }).__jumps ??= []).push(id) }} /></div>
  <output style={{ display: 'block', whiteSpace: 'pre-wrap', padding: 10, marginTop: 12, width: 520,
    background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 13 }} />
</main>)
