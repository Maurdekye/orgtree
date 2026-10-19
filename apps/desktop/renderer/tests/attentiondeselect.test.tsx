import { flush,inAct,mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AttentionDeselectFixture,installAttentionServer,mention,org,urgent } from './attentiondeselect-fixture'
import { resetLocalReads } from '../src/mailread'
import { resetSeenMentions } from '../src/canvas/agentmentions'
import { bumpLive } from '../src/livebus'
import type { AttentionNotificationFocus } from '../src/attention/AttentionQueue'

const settle = () => inAct(()=>flush(8))
const selected = (el:HTMLElement) => el.querySelector('[data-attn-row][aria-selected="true"]')?.getAttribute('data-attn-row')??null
const repoll = () => inAct(async()=>{bumpLive();await new Promise(r=>setTimeout(r,220));await flush(8)})

for(const kind of ['mention','urgent'] as const) for(const method of ['click','Escape'] as const) {
  test(`${kind} mail can deselect by ${method} without consuming another row`,async t=>{
    localStorage.clear();resetLocalReads();resetSeenMentions()
    const target=kind==='mention'?mention:urgent,state=installAttentionServer(target)
    let focus:AttentionNotificationFocus|null=null
    const v=await mountView(<AttentionDeselectFixture marker={kind==='mention'} onNotificationFocus={f=>{focus=f}}/>,el=>el)
    t.after(async()=>{await v.unmount();resetLocalReads();resetSeenMentions()});await settle()
    assert.equal(selected(v.el),'mail:'+target.id,'initial mail auto-selection remains')
    assert.deepEqual(state.reads,[target.id],'opening reads exactly once')
    const list=v.el.querySelector<HTMLElement>('.attn-mlist')!
    await inAct(()=>{if(method==='click')v.el.querySelector<HTMLElement>('[aria-selected="true"] .mailrow')!.click()
      else {list.focus();list.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))}})
    await settle()
    assert.equal(selected(v.el),null,'explicit deselection must leave no selected row')
    assert.equal(v.el.querySelector('[data-attn-row="mail:'+target.id+'"]')===null,true,'read mail releases on deselect')
    if(kind==='mention')assert.equal(v.el.querySelector('[data-attn-kind="mention"]')===null,true,'matching marker does not reappear')
    assert.equal(!!v.el.querySelector('.mailer-none'),true,'reading pane clears')
    await repoll()
    assert.equal(selected(v.el),null,'refresh must respect deliberate deselection')
    assert.deepEqual(state.reads,[target.id],'remaining mail stays unread')
    assert.equal(focus!({id:'mail:remaining',org,kind:'urgent-mail',title:'Remaining',body:''}),true)
    await settle()
    assert.equal(selected(v.el),'mail:remaining','explicit notification still opens after clearing')
    assert.deepEqual(state.reads,[target.id,'remaining'])
  })
}

test('question deselection survives updates and arrow navigation opens it again',async t=>{
  localStorage.clear();resetLocalReads();resetSeenMentions();const state=installAttentionServer()
  const v=await mountView(<AttentionDeselectFixture withQuestion/>,el=>el)
  t.after(async()=>{await v.unmount();resetLocalReads();resetSeenMentions()});await settle()
  assert.equal(selected(v.el),'question:question')
  await inAct(()=>v.el.querySelector<HTMLElement>('[aria-selected="true"] .mailrow')!.click());await settle()
  assert.equal(selected(v.el),null,'explicit deselection must leave no selected row')
  await repoll();assert.equal(selected(v.el),null)
  assert.deepEqual(state.reads,[],'clearing a question does not read unopened mail')
  const list=v.el.querySelector<HTMLElement>('.attn-mlist')!
  await inAct(()=>{list.focus();list.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})
  await settle();assert.equal(selected(v.el),'question:question')
})
