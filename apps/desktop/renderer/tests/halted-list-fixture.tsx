import {createRoot} from 'react-dom/client'
import {AgentTray} from '../src/canvas/agenttray'
import type {CanvasNode} from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'
import '../src/attention/attention.css'
const now=Date.now(),at=(seconds:number)=>new Date(now-seconds*1000).toISOString()
const status={status:'idle',summary:'Retained status text with a long tail that must clip consistently across every state and list host',at:at(7200)}
const halt={phase:'halted',requested_at:at(7200),at:at(300),by:'user'}
const frozen={until:at(-3600),until_ts:now/1000+3600,detected_at:at(300),error:'usage limit'}
const make=(id:string,extra:Record<string,unknown>={})=>({id,tier:'haiku',state:'live',children:[],lineage:[],turns:[],
  busy:false,waiting:false,occupancy:null,context_window:null,last_status:status,prev_status:null,halt:null,frozen:null,...extra} as unknown as CanvasNode)
const nodes=[make('active',{busy:true,inflight_at:at(10)}),make('halted',{halt}),make('halt-no-status',{halt,last_status:null}),
  make('halt-prev-status',{halt,last_status:null,prev_status:status}),make('halt-and-frozen',{halt,frozen}),make('usage-frozen',{frozen}),
  make('idle'),make('idle-no-status',{last_status:null}),make('blocked',{last_status:{...status,status:'blocked'}}),
  make('done',{last_status:{...status,status:'done'}}),make('queued',{waiting:true,inflight_at:at(15)}),
  make('compacting',{phase:'compacting',inflight_at:at(15)}),make('retired',{state:'retired'})]
const host=document.body.dataset.host
const cls=host==='superior'?'quickchat-pop quickchat-pop-superior':host==='drawer'?'attn-agents':'tray-wrap'
createRoot(document.getElementById('root')!).render(<div className={cls} style={{position:'relative',width:Number(document.body.dataset.width),margin:16}}>
  <AgentTray map={new Map(nodes.map(n=>[n.id,n]))} rows={nodes.map(node=>({node,depth:0}))} query="" onQuery={()=>{}}
    archived={true} onArchived={()=>{}} onPick={()=>{}}/>
</div>)
