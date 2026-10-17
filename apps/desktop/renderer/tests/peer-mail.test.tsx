import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { __setGlWiresFactory } from '../src/canvas/glwires'
import type { Wire } from '../src/canvas/glwires'
import { saveView, setChartLayout, layout, withDraftTree, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const node=(id:string,children:CanvasNode[]=[],on?:boolean,project=false):CanvasNode => ({
  id,title:id,tier:project?'project':'haiku',...(project?{kind:'project' as const}:{}),model_id:'haiku',state:'live',
  parent:USER,children,seat:1,grant:10,free:10,turns:[],lineage:[],documents:[],audiences_held:[],
  charter:'',team_charter:'',peer_mail:on,
  scope:{permission_mode:'acceptEdits',add_dirs:[],tools:{bash:true,web:true,edit:true,subagents:true,mcp:[]},
    org_visibility:'team',...(on===undefined?{}:{peer_mail:on})},
} as CanvasNode)
const tree=(root:CanvasNode,slug='peer-mail'):TreePayload => ({slug,name:slug,roots:[root],dirs:[],tiers:{haiku:1},
  max_top_grant:100,default_effort:'',effort_default:'high',cascade_hire:true,audiences:[],watchdogs:[],asks:[],
  audience_requests:[],credit_requests:[],work_items_summary:{attention:0,active:0},org_inbox:null,net:null,
  epoch:1,rev:1} as unknown as TreePayload)
function fetches(posts:Record<string,unknown>[]=[]){
  globalThis.fetch=(async (_url:string,init?:RequestInit)=>{
    if(init?.body)posts.push(JSON.parse(String(init.body)))
    return {ok:true,status:200,headers:new Headers(),json:async()=>({accounts:[],servers:[],turns:[],results:[{ok:true}],warnings:[]})}
  }) as typeof fetch
}
for(const project of [false,true]) for(const saved of [undefined,false]) {
 test(`${project?'project':'manager'} peer toggle defaults on, retains saved state and sends a boolean (${saved})`,async()=>{
  fetches();const posts:Record<string,unknown>[]=[];fetches(posts)
  const n=node('manager',[node('a'),node('b')],saved,project)
  const v=await mountView(<NodeConfig node={n} map={new Map([[n.id,n]])} tree={tree(n)} slug="peer-mail"
    op={async()=>({})} toast={()=>{}} close={()=>{}}/>,el=>el)
  try {
    await inAct(async()=>{await flush(5)})
    const toggle=v.el.querySelector<HTMLInputElement>('input[aria-label="Subordinates may message each other"]')
    assert.equal(toggle!==null,true,'node settings must expose peer-mail control')
    assert.equal(toggle!.checked,saved!==false)
    await inAct(()=>{toggle!.click()})
    const save=[...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='save')!
    await inAct(async()=>{save.click();await flush(8)})
    const expected=saved===false
    assert.ok(posts.some(p=>p.peer_mail===expected || (p.steps as Record<string,unknown>[]|undefined)?.some(s=>s.peer_mail===expected)),
      'saved payload contains the chosen boolean, not an inherited permission')
  } finally {await v.unmount()}
 })
}

for(const renderer of ['svg','gl'] as const) for(const chart of ['row','circular'] as const) for(const zoom of [0.2,1.2]) {
 test(`${renderer} ${chart} at zoom${zoom}: off removes only sibling connectors; on restores them`,async()=>{
  localStorage.clear();setChartLayout(chart);fetches()
  let wires:Wire[]=[];let draws=0
  const real=globalThis.getComputedStyle
  const oldBox=HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('viewport')?({x:0,y:0,left:0,top:0,right:1000,bottom:800,width:1000,height:800,toJSON(){}} as DOMRect):oldBox.call(this)}
  if(renderer==='gl'){
    __setGlWiresFactory(()=>({setWires(w){wires=w;return true},draw(){draws++},resize(){},destroy(){}}))
    const css=(el:Element)=>el.hasAttribute('data-glprobe')?({stroke:'rgb(58, 64, 74)',fill:el.getAttribute('data-glprobe')==='@spark'?'rgb(255, 217, 168)':'none',strokeWidth:'1.6px',opacity:'0.8',strokeDasharray:'none',filter:el.getAttribute('data-glprobe')==='@spark'?'drop-shadow(rgba(255, 128, 0, 0.95) 0px 0px 4px)':'none'} as CSSStyleDeclaration):real(el)
    globalThis.getComputedStyle=css;window.getComputedStyle=css
  }else{__setGlWiresFactory(null);localStorage.setItem('orgtree-canvas-gl-wires','off')}
  const root=node('manager',[node('a'),node('b')],true,chart==='circular')
  const tr=tree(root,`peer-${renderer}-${chart}-${zoom}`)
  const ps=layout(withDraftTree(tr,null),new Map(),chart)
  const p=ps.get('manager')!;saveView(tr.slug,{x:500-(p.x+90)*zoom,y:200-p.y*zoom,z:zoom})
  const content=(t:TreePayload)=><OrgCanvas tree={t} op={async()=>({})} slug={t.slug} toast={()=>{}} mailEvt={null}/>
  const v=await mountView(content(tr),el=>el)
  const count=(peer:boolean)=>renderer==='gl'?wires.filter(w=>peer?w.cls==='edge peer':w.cls==='edge').length:
    v.el.querySelectorAll(peer?'svg.edges path.edge.peer:not([data-glprobe])':'svg.edges path.edge:not(.peer):not(.aud-line):not([data-glprobe])').length
  try {
    await inAct(async()=>{await flush(12)})
    if(renderer==='gl')assert.ok(draws>0,'fake GL path really receives committed wires')
    assert.ok(count(true)>0,'positive control: on draws peer lines')
    const vertical=count(false);assert.ok(vertical>0,'superior/subordinate links exist')
    const off={...tr,rev:2,roots:[{...root,peer_mail:false,scope:{...root.scope!,peer_mail:false}}]}
    await inAct(async()=>{await v.render(content(off));await flush(8)})
    assert.equal(count(true),0,'OFF removes lateral links before either renderer')
    assert.equal(count(false),vertical,'hierarchy links remain')
    await inAct(async()=>{await v.render(content({...tr,rev:3}));await flush(8)})
    assert.ok(count(true)>0,'ON restores lateral links')
  }finally{await v.unmount();__setGlWiresFactory(null);globalThis.getComputedStyle=real;window.getComputedStyle=real;
    HTMLElement.prototype.getBoundingClientRect=oldBox;localStorage.clear()}
 })
}
