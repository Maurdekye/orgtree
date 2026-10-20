import type {TreePayload} from '../src/types'
import type {CanvasNode} from '../src/canvas/shared'

export const refocusNode=(id:string,parent:string|null,extra:Partial<CanvasNode>={}):CanvasNode=>({
 id,title:id,parent,kind:'agent',tier:'sol',model_id:'sol',state:'live',generation:1,
 seat:1,grant:0,free:0,ui_order:0,scope:{tools:{},add_dirs:[]},children:[],lineage:[],turns:[],
 audiences_held:[],last_status:null,prev_status:null,inflight_at:null,last_denials:[],mail_pending:0,
 ...extra,
} as CanvasNode)
export const refocusProject=refocusNode('build',null,{kind:'project',tier:'project',seat:0,
 charter:'Synthetic project. Click empty desk space to bring it back into view.',
 children:[refocusNode('worker','build')]})
export const refocusTree:TreePayload={slug:'refocus',name:'Synthetic refocus',roots:[refocusProject],
 tiers:{sol:5},workspace:null,dirs:[],max_top_grant:1000,default_top_grant:50,compact_at:0,
 default_tools:null,default_visibility:'team',default_effort:'',credit_requests:[],audiences:[],
 cost_usd_total:0,user_inbox_count:0,user_inbox_newest:null,auto_resume:false,cascade_alloc:true,
 audience_requests:[],org_inbox:null,net:null,watchdogs:[],slot_leases:[],
} as unknown as TreePayload
