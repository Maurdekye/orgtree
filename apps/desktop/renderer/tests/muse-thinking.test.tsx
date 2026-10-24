import {mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Msg} from '../src/canvas/desk'
import {formatSeconds} from '../src/canvas/toolclock'

for(const [name,secs,sealed] of [['readable',7.25,false],['sealed',65,true],['zero',0,true],['unknown',undefined,true]] as const) {
  test(`Muse ${name} reasoning uses the ordinary thought row without inventing a time`,async t=>{
    const m=JSON.parse(JSON.stringify({role:'assistant',text:'',thinking:sealed?'':'Supplied Muse reasoning',thinking_sealed:sealed,think_secs:secs,
      tools:[{id:'read',name:'Read',arg:'fixture.txt',result:'Kept tool output'}],assistant_id:name}))
    const view=await mountView(<Msg m={m} slug="fixture" nid="worker"/>,el=>el.textContent??'')
    t.after(()=>view.unmount())
    assert.match(view.last(),new RegExp(`thought for ${secs===undefined?'a moment':formatSeconds(Math.floor(secs))}`))
    assert.equal(view.el.querySelector('.thoughtline')?.tagName,sealed?'SPAN':'BUTTON')
    assert.equal(view.el.querySelectorAll('.tchip').length,1)
  })
}
