import { createRoot } from 'react-dom/client'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'
import { ProjectSquare } from '../src/canvas/projectcard'
import { ProjectLink } from '../src/canvas/identity'
import { bunchTree, project } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'
const node = { ...project('test-project'), charter: '# test project', configured_scope: { slots_capacity: 2, mail_queue: 'ack', event_listeners: true } } as unknown as CanvasNode
const watchdogs = [0,1,2].flatMap(i => ['project_listener','fair_queue'].map(kind => ({ id:`observer/${kind}-${i}`, owner:'observer', name:`${kind}-${i}`, kind, state:'armed', target:node.id, at:'' } as Watchdog)))
const tree = { ...bunchTree([node]), watchdogs, slot_leases: [] }, noop = () => {}
const plain = { ...project('plain-project'), charter: '# Summary without fact chips', configured_scope: {} } as unknown as CanvasNode
const plainTree = { ...bunchTree([plain]), watchdogs: [], slot_leases: [] }
function Fixture() {
  useProvideAgentNav(() => [], id => id === plain.id
    ? agentTooltipInfo(plain, [], null, undefined, undefined, plainTree)
    : agentTooltipInfo(node, [], null, undefined, undefined, tree))
  return <><div style={{position:'absolute',left:30,top:25}}>Normal card and far-zoom card · shared native-title inspection</div>
    {(['norm','mini'] as const).map((lod,i) => <ProjectSquare key={lod} node={node} tree={tree} pos={{x:80+i*230,y:95}} lod={lod}
      slug={tree.slug} dragging={false} isDrop={false} op={async()=>({ok:true} as never)} toast={noop} zoom={1} hire={{}} seats={{}}
      onHire={noop} onNewProject={noop} onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />)}
    <div style={{position:'absolute',left:80,top:260}}><ProjectLink id={node.id} onFocus={noop}/></div>
    {(['norm','mini'] as const).map((lod,i) => <ProjectSquare key={'plain-'+lod} node={plain} tree={plainTree} pos={{x:550+i*210,y:95}} lod={lod}
      slug={plainTree.slug} dragging={false} isDrop={false} op={async()=>({ok:true} as never)} toast={noop} zoom={1} hire={{}} seats={{}}
      onHire={noop} onNewProject={noop} onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />)}
    <div style={{position:'absolute',left:550,top:260}}><ProjectLink id={plain.id} onFocus={noop}/></div>
    <div style={{position:'absolute',left:30,top:335,width:900,padding:16,border:'1px solid var(--line-soft)',background:'var(--panel-2)'}}>
      <div>Native title read from hovered target (inspection panel)</div><pre id="inspected-title" style={{whiteSpace:'pre-wrap',font:'14px monospace'}}/></div>
  </>
}
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<AgentNavProvider><Fixture/></AgentNavProvider>)
