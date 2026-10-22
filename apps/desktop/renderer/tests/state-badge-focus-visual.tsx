import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { NodeSquare } from '../src/canvas/cards'
import { ServingAccountBadge } from '../src/canvas/desk'
import { setAgentShortcutsOn, syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'

syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol',fast_mode:true}]}]})
setAgentShortcutsOn(true)
const noop=()=>{}
const base:CanvasNode={id:'worker',tier:'sol',state:'live',generation:1,children:[],busy:true,
  seat:2,grant:0,free:0,scope:{tools:{},add_dirs:[],effort:'high',fast_mode:false},
  serving_account:{id:'claude-5',provider:'claude',email:'synthetic@example.test',auth:'authenticated',state:'ready'},
  pending_account:{account:'openai/backup'},pending_switch:{tier:'sol'},
  effort_current:'medium',effort_effective:'high',pending_effort:'high',fast_mode_current:true,dnd:true,
  session_placement:{session:'session0',reason:'preference',at:'2026-10-22T10:00:00Z'},
} as CanvasNode
const stopped={...base,id:'stopped',busy:false,halt:{phase:'halted'},
  frozen:{kind:'limit',error:'Synthetic limit',account:null,provenance:'measured'},
  serving_account:null,pending_account:null,pending_switch:null,pending_effort:null,scope:{...base.scope,effort:null},
} as CanvasNode
let down=''
const evidence={downs:0,ups:0,selected:'',settings:0,targets:[] as string[]}
;(window as any).__badgeEvidence=evidence
function Fixture(){
  const [selected,setSelected]=useState('none')
  return <main style={{padding:28}}>
    <h2>State badges retain the card focus gesture</h2>
    <p>The account label and other state markers are display-only. Clicking one selects its agent.</p>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:35}}>{[base,stopped].map(n=><section key={n.id} data-agent={n.id}>
      <h3>{n.id==='worker'?'Working agent':'Halted agent'}</h3>
      <div style={{height:275,position:'relative'}}><NodeSquare node={n} pos={{x:0,y:0}} lod="norm"
        focused={false} dragging={false} isDrop={false} seats={{sol:2}} map={new Map([[n.id,n]])}
        op={async()=>({})} slug="synthetic" toast={noop} pxc={1} zoom={1} compactAt={0.8}
        maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
        onConfig={()=>{evidence.settings++}} onInbox={noop} onLineage={noop} onOpenDoc={noop}
        onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
        onDragStart={(e,id)=>{down=id;evidence.downs++;evidence.targets.push((e.target as HTMLElement).className)}}
        onDragMove={noop} onDragCancel={()=>{down=''}}
        onDragEnd={(_e,id)=>{evidence.ups++;if(down===id){evidence.selected=id;setSelected(id)}down=''}}/>
      </div>
    </section>)}</div>
    <p data-selection>Selected agent: {selected}</p>
    <h3>Shared account badge on the desk header</h3>
    <div className="cc-head-meta"><ServingAccountBadge account={base.serving_account}/></div>
    <p>Account tooltip and keyboard accessible label: claude-5 · synthetic@example.test</p>
  </main>
}
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture/> )
