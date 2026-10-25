import {FakeServer,flush,inAct,installFetch,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {req} from '../src/api'
import {onLiveBump} from '../src/livebus'
import {NodeConfig} from '../src/canvas/modals'
import {USER} from '../src/canvas/shared'
import type {CanvasNode} from '../src/canvas/shared'
import type {OpResult,TreePayload} from '../src/types'

test('custom apps requests can invalidate their own resource without refreshing every org reader',async t=>{
  installFetch(new FakeServer())
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async()=>new Response('{}',{status:200,headers:{'Content-Type':'application/json'}})
  let changes=0;const off=onLiveBump(()=>{changes++});t.after(off)
  const request=req as unknown as (path:string,init:RequestInit,timeout:number,expected:readonly number[],invalidate:boolean)=>Promise<unknown>
  await request('/api/orgs/test/apps',{method:'POST',body:'{}'},1000,[],false)
  await new Promise(resolve=>setTimeout(resolve,160))
  assert.equal(changes,0,'resource-local mutation unnecessarily refreshed all org readers')
  await req('/api/orgs/test/ops',{method:'POST',body:'{}'})
  await new Promise(resolve=>setTimeout(resolve,160))
  assert.equal(changes,1,'ordinary org mutations retain their existing invalidation')
})

test('custom apps and Logo share the visible org-modifying Tools category and preserve a legacy denial',async t=>{
  installFetch(new FakeServer())
  const node:CanvasNode={id:'agent',title:'agent',state:'live',tier:'sol',model_id:'sol',parent:USER,children:[],seat:1,grant:10,free:10,
    scope:{permission_mode:'acceptEdits',add_dirs:[],org_visibility:'team',tools:{bash:true,web:true,edit:true,subagents:true,mcp:[],orgtree:{logo:false}}},
    charter:'',team_charter:'',turns:[],audiences_held:[]} as CanvasNode
  const tree={slug:'org',dirs:[],tiers:{sol:2},max_top_grant:100,default_effort:'',effort_default:'high',cascade_hire:true} as TreePayload
  const view=await mountView(<NodeConfig node={node} map={new Map([[node.id,node]])} tree={tree} slug="org" op={async()=>({} as OpResult)} toast={()=>{}} close={()=>{}}/>,el=>el)
  t.after(()=>view.unmount())
  const tab=[...view.el.ownerDocument.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()==='Tools')
  assert.ok(tab);await inAct(async()=>{tab.click();await flush()})
  const rows=[...view.el.ownerDocument.querySelectorAll<HTMLElement>('.set-row')]
  const row=rows.find(r=>r.textContent?.includes('Org-modifying tools'))
  assert.ok(row,'new category must be visible in actual agent settings')
  assert.match(row.textContent??'',/Apps.*[Ll]ogo|[Ll]ogo.*[Aa]pps/)
  assert.equal(row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,false)
  assert.equal(rows.some(r=>r.textContent?.includes('Organization logo')),false)
})
