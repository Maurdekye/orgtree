import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg, ToolChip } from '../src/canvas/desk'
import { AgentDirectoryProvider } from '../src/canvas/identity'
import type { ChatMessage, ToolChip as ToolData } from '../src/types'

const change=(from:string|null='haiku',to='sol',extra:Partial<ToolData>={}):ToolData=>({
  id:'switch-call',name:'mcp__orgtree__orgtree_switch_model',arg:'worker sol',result:'{"node":"worker","tier":"sol"}',
  refs:[{kind:'agent',id:'worker',model_change:{from,to}}] as ToolData['refs'],...extra,
})
const transition=(el:Element)=>el.querySelector('.tool-model-transition')

test('a recorded model change shows shared old and new model cards inline',async t=>{
  const view=await mountView(<ToolChip t={change()} slug="org" nid="boss"/>,h=>h)
  t.after(()=>view.unmount())
  const row=transition(view.el)
  assert.ok(row,'old and new model cards must render in the tool header')
  assert.ok(row.querySelector('.tier.t-haiku'))
  assert.ok(row.querySelector('.tier.t-sol'))
  assert.ok(row.textContent?.includes('→'))
  assert.equal(row.getAttribute('aria-label'),'Model changed: haiku → sol')
  assert.equal(row.querySelector('.tier.t-haiku')?.getAttribute('title'),'haiku')
})

test('unknown historical old model shows only the recorded new card',async t=>{
  const view=await mountView(<ToolChip t={change(null)} slug="org" nid="boss"/>,h=>h)
  t.after(()=>view.unmount())
  const row=transition(view.el)
  assert.ok(row,'known new model is retained without guessing the old model')
  assert.equal(row.querySelectorAll('.tier').length,1)
  assert.ok(row.querySelector('.tier.t-sol'))
  assert.equal(row.textContent?.includes('→'),false)
})

test('model metadata is historical and does not use the current agent model',async t=>{
  const message:ChatMessage={role:'assistant',text:'',tools:[change()]}
  const view=await mountView(<AgentDirectoryProvider value={{resolve:()=>({tier:'astra'})}}>
    <Msg m={JSON.parse(JSON.stringify(message))} slug="org" nid="boss"/>
  </AgentDirectoryProvider>,h=>h)
  t.after(()=>view.unmount())
  assert.equal(transition(view.el)?.getAttribute('aria-label'),'Model changed: haiku → sol')
  assert.equal(transition(view.el)?.querySelector('.tier.t-astra')===null,true)
})

test('failed, unchanged, incomplete and staffing calls get no model transition',async t=>{
  const view=await mountView(<ToolChip t={change()} slug="org" nid="boss"/>,h=>h)
  t.after(()=>view.unmount())
  for(const tool of [change('sol','sol'),change('haiku',''),change('haiku','sol',{error:'refused'}),
    {id:'legacy',name:'orgtree_switch_model',arg:'worker sol'},change('haiku','sol',{name:'orgtree_hire'}),
    change('haiku','sol',{name:'orgtree_staff'})]){
    await view.render(<ToolChip t={tool} slug="org" nid="boss"/>)
    assert.equal(transition(view.el)===null,true)
  }
})

test('the model transition does not fold the tool when clicked',async t=>{
  const view=await mountView(<ToolChip t={change()} slug="org" nid="boss"/>,h=>h)
  t.after(()=>view.unmount())
  const row=transition(view.el) as HTMLElement
  assert.ok(row,'transition has its own click boundary')
  await inAct(()=>row.click())
  assert.equal(view.el.querySelector('.respre-json')===null,true)
})
