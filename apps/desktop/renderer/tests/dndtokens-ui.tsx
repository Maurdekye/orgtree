import {createRoot} from 'react-dom/client'
import {NodeSquare} from '../src/canvas/cards'
import {DeskChat} from '../src/canvas/desk'
import {ProjectDesk} from '../src/canvas/projectdesk'
import {syncProviderRegistries} from '../src/canvas/shared'
import type {CanvasNode} from '../src/canvas/shared'
import type {TreePayload} from '../src/types'
import '../src/styles.css'
import '../src/shell.css'
const noop=()=>{}
const node={id:'worker',tier:'sol',kind:'agent',state:'live',dnd:true,busy:true,generation:1,model_id:'gpt-6.1-sol',
  children:[],seat:2,grant:0,free:0,scope:{tools:{},add_dirs:[],effort:'high'},configured_scope:{tools:{},add_dirs:[]},
  turns:[],lineage:[],audiences_held:[],mail_pending:0,phase:'thinking'} as unknown as CanvasNode
const project={...node,id:'build',kind:'project',tier:'project',dnd:false,busy:false,children:[node]} as CanvasNode
globalThis.fetch=async()=>new Response(JSON.stringify({messages:[],pending:[],delivered:[],items:[],docs:[],references:{},
  after:'0:0',has_more:false,total:0}),{status:200,headers:{'Content-Type':'application/json'}})
syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol',model:'gpt-6.1-sol',fast_mode:true,effort_levels:['low','medium','high']}]}]})
document.documentElement.dataset.theme='dark'
document.body.style.cssText='margin:0;padding:18px;background:#202020;color:#ddd;font:13px sans-serif;box-sizing:border-box'
const map=new Map([[node.id,node],[project.id,project]]),mode=new URLSearchParams(location.search).get('view')
createRoot(document.getElementById('root')!).render(mode==='card'?<div style={{position:'relative',height:500}}>
  <NodeSquare node={node} pos={{x:20,y:20}} lod="norm" focused={false} dragging={false} isDrop={false}
    seats={{used:2,total:4}} map={map} op={async()=>({})} slug="dnd-fixture" toast={noop} pxc={1} zoom={1}
    compactAt={0.8} maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
    onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/></div>
  :mode==='project'?<ProjectDesk node={project} slug="dnd-fixture" tree={{slug:'dnd-fixture',roots:[project]} as unknown as TreePayload}
    map={map} op={async()=>({})} toast={noop} refs={{world:{org:'dnd-fixture'},onOpen:noop} as never} bare/>
  :<DeskChat node={node} map={map} slug="dnd-fixture" op={async()=>({})} toast={noop} bare/>)
