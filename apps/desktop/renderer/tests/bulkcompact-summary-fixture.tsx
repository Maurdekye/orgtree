import type { CanvasNode } from '../src/canvas/shared'
export const agent=(id:string,extra:Partial<CanvasNode>={}):CanvasNode=>({
 id,state:'live',tier:'sonnet',children:[],session_id:id+'-session',
 occupancy:40000,context_window:200000,...extra,
} as CanvasNode)
const batch=(prefix:string,n:number,extra:Partial<CanvasNode>={})=>
 Array.from({length:n},(_,i)=>agent(prefix+'-'+(i+1),extra))
export const summaryTargets=()=>[
 ...batch('busy',5,{busy:true}),...batch('empty',5,{occupancy:0}),
 ...batch('codex',9,{tier:'sol'}),...batch('native',3),
 ...batch('sessionless',2,{session_id:null}),
]
export const supportReply=(id:string)=>id.startsWith('codex-')
 ? {supported:false,reason:'Normal compaction is not available for Codex in Orgtree.'}
 : {supported:true}
export const targetId=(url:unknown)=>decodeURIComponent(String(url).split('/nodes/')[1]?.split('/')[0]??'')
