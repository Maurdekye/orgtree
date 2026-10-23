import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { DndControl } from '../src/canvas/dnd'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const worker = {
  id:'worker',tier:'sol',kind:'agent',state:'live',generation:1,children:[],seat:2,grant:0,
  scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[]},turns:[],lineage:[],
  audiences_held:[],mail_pending:0,
} as unknown as CanvasNode

async function header(t:TestContext,node:CanvasNode) {
  resetConvos(); installFetch(new FakeServer())
  const map=new Map([[node.id,node],...node.children.map(c=>[c.id,c] as [string,CanvasNode])])
  const props={node,map,slug:'desk-tooltip-test',tree:{slug:'desk-tooltip-test',roots:[]} as never,
    op:async()=>({}),toast:()=>{},bare:true}
  const view=await mountView(node.kind==='project'
    ? <ProjectDesk {...props} refs={{world:{org:'desk-tooltip-test'},onOpen:()=>{}} as never}/>
    : <DeskChat {...props}/>,el=>el)
  t.after(async()=>{await view.unmount();resetConvos()})
  await inAct(async()=>{await flush(3)})
  return [...view.el.querySelectorAll<HTMLButtonElement>('.cc-head-top button')]
}

test('leaf retire hover explains stopping, released capacity and preservation',async t=>{
  const buttons=await header(t,worker)
  const button=buttons.find(b=>/^retire/.test(b.textContent??''))
  assert.ok(button,'leaf has the retire action')
  assert.match(button.title,/Stop and archive this agent/)
  assert.match(button.title,/freeing.*credits/)
  assert.match(button.title,/History and files are kept/)
})

test('agent dissolve hover explicitly includes the whole team',async t=>{
  const buttons=await header(t,{...worker,id:'manager',children:[worker]})
  const button=buttons.find(b=>/^dissolve/.test(b.textContent??''))
  assert.ok(button,'manager has the dissolve action')
  assert.match(button.title,/this agent and its whole team/)
  assert.match(button.title,/History and files are kept/)
})

test('project dissolve hover retains history without promising automatic team rehire',async t=>{
  const buttons=await header(t,{...worker,id:'project',kind:'project',tier:'project',children:[worker],seat:0})
  const button=buttons.find(b=>b.dataset.action==='dissolve')
  assert.ok(button,'project has the dissolve action')
  assert.match(button.title,/Archive this project/)
  assert.match(button.title,/every agent under it/)
  assert.match(button.title,/History and files are kept/)
  assert.doesNotMatch(button.title,/rehire brings each back/)
})

test('DND hover explains held ordinary mail, urgent bypass and the state-specific action',async t=>{
  const props={slug:'desk-tooltip-test',nid:'worker',toast:()=>{}}
  const view=await mountView(<DndControl {...props}/>,el=>el)
  t.after(()=>view.unmount())
  for(const state of [{active:false,nextTurn:false},{active:true,nextTurn:false},{active:false,nextTurn:true}]) {
    await view.render(<DndControl {...props} {...state}/>)
    const title=view.el.querySelector('button')!.title
    assert.match(title,/holds non-urgent mail/)
    assert.match(title,/urgent mail still arrives/)
    assert.match(title,state.active||state.nextTurn ? /release held mail.*next supported delivery boundary/
      : /this turn, or the next turn if idle/)
  }
})
