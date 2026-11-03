// subtreefold-visual.tsx — capture fixture for the subtree fold tucked stack
// (tests/subtreefold.test.tsx and foldstack.test.tsx hold the behavior). Renders agent and
// project cards in every fold state at one lod: expanded, folded with a
// count, folded while a hidden member works, folded while a hidden member
// needs attention, and a leaf with no chevron. The capture driver calls
// window.subtreeFoldFixture.render('norm' | 'mini') and screenshots each.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { NodeSquare } from '../src/canvas/cards'
import { ProjectSquare } from '../src/canvas/projectcard'
import { agent, project, bunchTree } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { FoldInfo } from '../src/canvas/subtreefold'

const noop = () => {}, op = async () => ({ ok: true } as never)
const hire = { enabled: true, installed: true, reason: null }
const EXPANDED: FoldInfo = { collapsed: false, count: 0, working: false, attention: false }
const FOLDED: FoldInfo = { collapsed: true, count: 5, working: false, attention: false, tucks: [{ id: 'a', project: false, tier: 'sonnet' }, { id: 'b', project: false, tier: 'sol' }, { id: 'c', project: true }] }
const WORKING: FoldInfo = { collapsed: true, count: 12, working: true, attention: false, tucks: [{ id: 'a', project: false, tier: 'sonnet' }, { id: 'b', project: false, tier: 'sol' }, { id: 'c', project: true }] }
const ATTENTION: FoldInfo = { collapsed: true, count: 3, working: false, attention: true, tucks: [{ id: 'a', project: false, tier: 'sonnet' }, { id: 'b', project: false, tier: 'sol' }, { id: 'c', project: true }] }

function Row({ label, y, children }: { label: string; y: number; children: React.ReactNode }) {
  return <>
    <div style={{ position: 'absolute', left: 8, top: y + 52, width: 150, textAlign: 'right', fontSize: 12 }}>{label}</div>
    {children}
  </>
}

function Cards({ lod }: { lod: 'norm' | 'mini' }) {
  const mk = (id: string, kind: 'agent' | 'project'): CanvasNode => ({
    ...(kind === 'agent' ? agent(id, [agent(id + '-kid')]) : project(id, [agent(id + '-kid')])),
    busy: false, occupancy: 0.2, context_window: 1000,
  } as unknown as CanvasNode)
  const agentAt = (id: string, x: number, y: number, fold?: FoldInfo) => {
    const node = mk(id, 'agent')
    return <NodeSquare key={id} node={node} pos={{ x, y }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={{ sol: 1 }} codexHire={hire} antigravityHire={hire}
      claudeHire={hire} map={new Map([[id, node]])} op={op} slug="fold-visual" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} maxTop={100} cascadeAlloc pinned={false}
      fold={fold} onToggleFold={noop}
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop}
      onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  }
  const projectAt = (id: string, x: number, y: number, fold: FoldInfo) => {
    const node = mk(id, 'project')
    return <ProjectSquare key={id} node={node} pos={{ x, y }} lod={lod} dragging={false}
      isDrop={false} zoom={1} op={op} slug="fold-visual" toast={noop}
      tree={bunchTree([node])} hire={{}} seats={{}} fold={fold} onToggleFold={noop}
      onHire={noop} onNewProject={noop} onInbox={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  }
  return <div className="space" style={{ position: 'absolute', inset: 0 }}>
    <Row label="expanded" y={20}>{agentAt('boss-open', 180, 20, EXPANDED)}{projectAt('proj-open', 360, 20, EXPANDED)}</Row>
    <Row label="folded · count" y={180}>{agentAt('boss-folded', 180, 180, FOLDED)}{projectAt('proj-folded', 360, 180, FOLDED)}</Row>
    <Row label="folded · hidden working" y={340}>{agentAt('boss-working', 180, 340, WORKING)}{projectAt('proj-working', 360, 340, WORKING)}</Row>
    <Row label="folded · hidden attention" y={500}>{agentAt('boss-attention', 180, 500, ATTENTION)}{projectAt('proj-attention', 360, 500, ATTENTION)}</Row>
    <Row label="leaf · no chevron" y={660}>{agentAt('leaf-agent', 180, 660)}</Row>
  </div>
}

function Fixture() {
  const [lod, setLod] = useState<'norm' | 'mini'>('norm')
  Object.assign(window, { subtreeFoldFixture: { render: (next: 'norm' | 'mini') => setLod(next) } })
  return <>
    <div style={{ position: 'absolute', left: 170, top: 2 }}>Subtree fold · agent / project · {lod}</div>
    <Cards lod={lod} />
  </>
}
document.body.style.cssText = 'margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture />)
