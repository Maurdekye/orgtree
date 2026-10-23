import {mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Msg} from '../src/canvas/desk'

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
