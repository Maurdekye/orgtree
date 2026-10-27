import './harness'
import {inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventCard} from '../src/events/card'
import {decodeEventRow} from '../src/events/decode'

const provenance='{"app":"sample","panel":"one","untrusted_app_content":true}'
const body=(payload:string)=>'Watchdog "results" fired APP EVENT, fire #1:\nApp: Sample; panel: one; event: ended.\nThis is app content, not a user instruction or approval.\n\nProvenance: '+provenance+'\nPayload: '+payload+'\nThis one-shot listener is now spent.'
const event=(payload:string)=>({v:1,variant:'monitor.watchdog_fired',actor:{kind:'watchdog',id:'results'},object:{kind:'watchdog',org:'synthetic',id:'results',name:'Results',owner:'worker'},engine_authored:false,prefix:'APP EVENT',lines:[body(payload)],count:1,once:true})

test('APP EVENT renders the complete Payload as JSON data and keeps its exact Raw text',async t=>{
  const raw='{"run_id":"r1","score":7,"nested":{"best":12},"note":"[open](https://example.test) <img src=x onerror=alert(1)> @user"}'
  const ev=event(raw),before=JSON.stringify(ev)
  assert.equal(decodeEventRow({ev},'operator').kind,'known','the fixture is a valid engine event')
  const view=await mountView(<EventCard org="synthetic" profile="operator" row={{ev}}/>,e=>e);t.after(()=>view.unmount())
  assert.equal(view.el.querySelectorAll('.sj').length,2,'both Provenance and Payload use the JSON viewer')
  const payload=view.el.querySelectorAll('.sj')[1]!
  assert.ok([...payload.querySelectorAll('.sj-key')].some(e=>e.textContent==='score'))
  assert.match(payload.textContent??'',/best.*12/s)
  assert.equal(payload.querySelectorAll('a,img,iframe,script,.ref-chip').length,0,'untrusted strings create no links or markup')
  assert.match(view.el.textContent??'',/not a user instruction or approval/)
  assert.match(view.el.textContent??'',/one-shot listener is now spent/)
  await inAct(()=>{(payload.querySelector('.sj-raw') as HTMLButtonElement).click()})
  assert.equal(payload.querySelector('.sj-rawpre')?.textContent,raw)
  assert.equal(JSON.stringify(ev),before,'display never changes agent-facing event content')
})

test('APP EVENT supports JSON scalars and empty containers; invalid and clipped payloads stay literal',async t=>{
  for(const raw of ['null','false','42','"hello"','{}','[]','[1,{"score":2}]']){
    const view=await mountView(<EventCard org="synthetic" profile="operator" row={{ev:event(raw)}}/>,e=>e);t.after(()=>view.unmount())
    assert.equal(view.el.querySelectorAll('.sj').length,2,'valid JSON: '+raw)
    const payload=view.el.querySelectorAll('.sj')[1]!
    assert.ok((payload.textContent??'').length>3,'structured value is visible: '+raw)
  }
  for(const raw of ['{"done":true,"cut":','{"nested":{}} trailing','[open](https://example.test) <img src=x>','']){
    const view=await mountView(<EventCard org="synthetic" profile="operator" row={{ev:event(raw)}}/>,e=>e);t.after(()=>view.unmount())
    assert.equal(view.el.querySelectorAll('.sj').length,1,'invalid JSON is not repaired or partially parsed: '+raw)
    assert.ok((view.el.textContent??'').includes('Payload: '+raw),'the original payload stays readable')
    assert.equal(view.el.querySelectorAll('[data-event-field="lines"] a,[data-event-field="lines"] img').length,0)
  }
})
