import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { NodeSquare } from '../src/canvas/cards'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

const slug = 'scaled-spelling-fixture', noop = () => {}
const node = { id: 'writer', kind: 'agent', tier: 'sol', state: 'live', generation: 1, children: [], seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [], effort: 'xhigh' }, turns: [], lineage: [], audiences_held: [] } as unknown as CanvasNode
syncProviderRegistries({ providers: [{ id: 'openai', tiers: [{ tier: 'sol' }] }] })
globalThis.fetch = async () => new Response(JSON.stringify({ messages: [], pending_mail: [], live: [], busy: false,
  items: [], docs: [], references: {}, windowed: true, has_older: false, before: null, draft_epoch: 'synthetic:0' }),
{ headers: { 'Content-Type': 'application/json' } })
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  readText: async () => { throw Error('Clipboard denied') }, writeText: async () => { throw Error('Clipboard denied') },
} })
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;background:#222;color:#ddd;overflow:hidden'
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value={slug}>
  <h3 style={{ margin: '10px 20px' }}>Canvas desk spelling at 0.625 text scale</h3>
  <div id="fixture-world" style={{ position: 'absolute', left: 60, top: 65, transform: 'scale(4.6875)', transformOrigin: '0 0' }}>
    <NodeSquare node={node} pos={{ x: 0, y: 0 }} lod="norm" focused dragging={false} isDrop={false} seats={{ sol: 2 }}
      map={new Map([[node.id, node]])} op={async () => ({})} slug={slug} toast={noop} pxc={1} zoom={4.6875}
      compactAt={0.8} maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onWorkLink={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </div>
</CurrentOrg.Provider>)
