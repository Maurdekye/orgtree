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
const dir=(tier:string,onFocus?:()=>void)=>({resolve:()=>({tier}),onFocus})
const show=(tool:ToolData,tier='sol',onFocus?:()=>void)=><AgentDirectoryProvider value={dir(tier,onFocus)}>
  <ToolChip t={tool} slug="org" nid="boss"/>
</AgentDirectoryProvider>
const row=(el:Element)=>el.querySelector('.tool-ref-agent')!
const tiers=(el:Element)=>[...el.querySelectorAll('.tier')].map(e=>[...e.classList].find(c=>c.startsWith('t-')))

for(const [name,from,current,expected,arrow] of [
  ['known old, still on the recorded new model','haiku','sol',['t-haiku','t-sol'],true],
  ['known old, changed model again later','haiku','astra',['t-haiku','t-sol','t-astra'],true],
  ['unknown old, still on the recorded new model',null,'sol',['t-sol'],false],
  ['unknown old, changed model again later',null,'astra',['t-sol','t-astra'],true],
] as const){
  test(name,async t=>{
    const view=await mountView(show(change(from),current),h=>h)
    t.after(()=>view.unmount())
    assert.deepEqual(tiers(row(view.el)),[...expected],name)
    assert.equal(row(view.el).textContent?.includes('→'),arrow,name)
    assert.equal(row(view.el).querySelector('[data-copy-agent-name="worker"]')===null,false)
  })
}

test('historical cards survive serialization and never take the current model tooltip',async t=>{
  const message:ChatMessage={role:'assistant',text:'',tools:[change()]}
  const view=await mountView(<AgentDirectoryProvider value={dir('astra')}>
    <Msg m={JSON.parse(JSON.stringify(message))} slug="org" nid="boss"/>
  </AgentDirectoryProvider>,h=>h)
  t.after(()=>view.unmount())
  assert.deepEqual(tiers(row(view.el)),['t-haiku','t-sol','t-astra'])
  assert.equal(row(view.el).querySelector('.t-haiku')?.getAttribute('title'),'haiku')
  assert.equal(row(view.el).querySelector('.t-sol')?.getAttribute('title'),'sol')
})

test('failed, unchanged, incomplete and staffing calls get no model transition',async t=>{
  const view=await mountView(show(change()),h=>h)
  t.after(()=>view.unmount())
  for(const tool of [change('sol','sol'),change('haiku',''),change('haiku','sol',{error:'refused'}),
    {id:'legacy',name:'orgtree_switch_model',arg:'worker sol'},change('haiku','sol',{name:'orgtree_hire'}),
    change('haiku','sol',{name:'orgtree_staff'}),change('haiku','sol',{result:undefined})]){
    await view.render(show(tool))
    assert.equal(view.el.querySelector('.tool-model-transition')===null,true)
  }
})

test('historical cards do not fold the call and the agent link still navigates',async t=>{
  let focused=0
  const view=await mountView(show(change(),'sol',()=>{focused++}),h=>h)
  t.after(()=>view.unmount())
  const transition=view.el.querySelector<HTMLElement>('.tool-model-transition')
  assert.ok(transition,'transition has its own click boundary')
  await inAct(()=>transition.click())
  assert.equal(view.el.querySelector('.respre-json')===null,true)
  await inAct(()=>row(view.el).querySelector<HTMLButtonElement>('[data-agent-nav]')!.click())
  assert.equal(focused,1)
  assert.equal(view.el.querySelector('.respre-json')===null,true)
})
