import {mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Msg} from '../src/canvas/desk'
import {formatSeconds} from '../src/canvas/toolclock'

test('reloaded sealed Codex thinking stays separate from attached tools and a reply',async t=>{
  const sealed=JSON.parse(JSON.stringify({role:'assistant',text:'',thinking:'',thinking_sealed:true,assistant_id:'sealed',
    tools:[{id:'tool',name:'Bash',arg:'echo fixture',result:'Kept tool output'}]}))
  const view=await mountView(<><Msg m={sealed} slug="fixture" nid="worker"/>
    <Msg m={{role:'assistant',text:'The ordinary reply stays visible.',tools:[]}} slug="fixture" nid="worker"/></>,el=>el.textContent??'')
  t.after(()=>view.unmount())
  assert.equal(view.el.querySelectorAll('.thoughtline.sealed').length,1)
  assert.equal(view.el.querySelector('.thoughtline.sealed')?.tagName,'SPAN')
  assert.match(view.last(),/thought for a moment/)
  assert.match(view.last(),/echo fixture/)
  assert.equal(view.el.querySelectorAll('.msgtext').length,1)
  assert.match(view.el.querySelector('.msgtext')?.textContent??'',/ordinary reply stays visible/)
})

test('readable Codex summary remains expandable rather than sealed',async t=>{
  const view=await mountView(<Msg m={{role:'assistant',text:'',thinking:'A supplied readable summary.',thinking_sealed:false,tools:[],assistant_id:'readable'}} slug="fixture" nid="worker"/>,el=>el.textContent??'')
  t.after(()=>view.unmount())
  assert.equal(view.el.querySelector('.thoughtline.sealed')===null,true)
  assert.equal(view.el.querySelector('button.thoughtline')!==null,true)
})

for(const [name,secs,sealed] of [['readable',125.75,false],['sealed',62,true],['zero',0,true]] as const) {
  test(`Codex ${name} reasoning uses the ordinary measured thought duration`,async t=>{
    const m=JSON.parse(JSON.stringify({role:'assistant',text:'',thinking:sealed?'':'Supplied reasoning',thinking_sealed:sealed,think_secs:secs,tools:[],assistant_id:name}))
    const view=await mountView(<Msg m={m} slug="fixture" nid="worker"/>,el=>el.textContent??'')
    t.after(()=>view.unmount())
    assert.match(view.last(),new RegExp(`thought for ${formatSeconds(Math.floor(secs))}`))
    assert.equal(view.el.querySelector('.thoughtline')?.tagName,sealed?'SPAN':'BUTTON')
    assert.doesNotMatch(view.last(),/a moment/)
  })
}
