// Synthetic immutable canvas data; all network/transfer replies stay local.
import {createRoot} from 'react-dom/client';
import {OrgCanvas} from '../src/canvas/OrgCanvas';
import {CurrentOrg} from '../src/popout';
import {setStartView,saveView,setHideRetiredOn,setCrowdPilesOn,EYE_ANCHOR_X,NODE_W} from '../src/canvas/shared';
import '../src/styles.css';
import '../src/shell.css';
const W=window as unknown as {proofZoom:number;proofHide:boolean;proofRequests:string[];proofTree:unknown;proofHideToggle:unknown};
const slug='overview-fixture';
setStartView('remember');setCrowdPilesOn(false);setHideRetiredOn(W.proofHide);
saveView(slug,{x:window.innerWidth/2-(EYE_ANCHOR_X+NODE_W/2)*W.proofZoom,y:160,z:W.proofZoom});
// No real transport: the fixture supplies immutable HTTP snapshots only.
window.WebSocket=class {onmessage=null;onclose=null;onerror=null;close(){}};
window.fetch=async(url)=>{W.proofRequests.push(String(url));let body={ok:true};const s=String(url);
if(s.includes('/transfers?'))body={transfers:[],next_cursor:null};else if(s.includes('/providers'))body={providers:[]};else if(s.includes('/org_inbox'))body={entries:[],total:0,unread:0,holders:['model-blue'],visible:true,enabled:true};
else if(s.includes('/inbox'))body={pending:[],delivered:[],sent:[]};
else if(s.includes('/work-items'))body={items:[],archived:[],backlogged:[],counts:{attention:0,active:0}};
else if(s.includes('/document/'))body={title:'Plan',node:'model-blue',body:'Retained document'};
return {ok:true,status:200,headers:new Headers(),json:async()=>body,text:async()=>JSON.stringify(body)}};
function node(id:string,tier:string,extra:Record<string,unknown>={}){return {id,title:id,tier,model_id:tier,state:'live',seat:1,grant:1,free:1,ui_order:0,cost_usd:0,occupancy:null,context_window:null,charter:null,mail_pending:0,limit_locked:false,last_status:null,prev_status:null,inflight_at:null,last_denials:[],turns:[],frozen:null,audiences_held:[],bearer_state:null,generation:1,children:[],lineage:[],scope:{permission_mode:'default',add_dirs:[],tools:{},org_visibility:'team'},...extra}}
const tree={slug,name:slug,workspace:null,dirs:[],max_top_grant:1000,default_top_grant:50,compact_at:0,default_tools:null,default_visibility:'team',default_effort:'',credit_requests:[],tiers:{'wonder-full':1,haiku:1,sonnet:2},audiences:[],roots:[node('model-blue','wonder-full',{documents:[{id:'plan',title:'Plan',format:'markdown',at:'2026-10-13T00:00:00Z',bytes:10},{id:'mockup',title:'HTML mockup',format:'html',at:'2026-10-13T00:00:01Z',bytes:20}],hidden_retired_children:2,children:[node('model-green','haiku'),node('no-model-colour','unknown-model')]} )],cost_usd_total:0,audit:{live_nodes:3,top_level_holds:0,no_overdraft:true,problems:[]},user_inbox_count:0,user_inbox_newest:null,fable_lock:null,auto_resume:false,cascade_hire:false,cascade_alloc:true,audience_requests:[],org_inbox:{entries:[{dir:'in',peer:'@net:fixture'}],total:1,unread:0,holders:['model-blue'],enabled:true,visible:true,multi_holder_enabled:true},net:null,epoch:1,rev:1,work_items_summary:{attention:0,active:0},asks:[],asks_open:0,watchdogs:[{id:'fixture-dog',owner:'model-blue',name:'fixture-dog',kind:'file',target:'fixture.log',interval_s:30,state:'armed',at:'2026-10-13T00:00:00Z',fired:0,once:false,spent:false}]};
W.proofTree=tree;W.proofHideToggle=setHideRetiredOn;
createRoot(document.getElementById('root')).render(<CurrentOrg.Provider value={slug}><div className="app"><main className="solo"><div className="canvas-stage"><OrgCanvas tree={tree} op={async()=>({})} slug={slug} toast={()=>{}} mailEvt={null}/></div></main></div></CurrentOrg.Provider>);