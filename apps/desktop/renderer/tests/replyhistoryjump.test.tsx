import { FakeServer,flush,inAct,installFetch,mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo,resetConvos } from '../src/convo'
import { draftKey } from '../src/draftstore'
import { storeReply } from '../src/eventReply'

const node:CanvasNode={id:'writer',generation:1,state:'live',tier:'haiku',children:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]}}
const desk=()=> <div className="outer-frame"><DeskChat node={node} map={new Map([[node.id,node]])} slug="synthetic" op={async()=>({})} toast={()=>{}} bare/></div>
const reply={org:'synthetic',agent:'writer',generation:1,eventId:'event-0',quote:'Saved earlier message'}

test('a whole-quote jump loads older history and centers only its own transcript list',async()=>{
  localStorage.clear();resetConvos();storeReply(draftKey('synthetic','writer',1),reply)
  const server=new FakeServer();server.cursorPages=true
  server.messages=Array.from({length:40},(_,i)=>({role:'assistant',seq:i,event_id:`event-${i}`,text:`Earlier message ${i}`}))
  installFetch(server)
  const view=await mountView(desk(),el=>el)
  const proto=window.HTMLElement.prototype,oldScroll=proto.scrollIntoView,oldRect=proto.getBoundingClientRect
  try{
    await inAct(async()=>{await refreshConvo('synthetic','writer');await flush(6)})
    const list=view.el.querySelector<HTMLElement>('.msgs')!,frame=view.el.querySelector<HTMLElement>('.outer-frame')!
    assert.ok(list);frame.scrollTop=77;list.scrollTop=0
    Object.defineProperties(list,{scrollHeight:{configurable:true,get:()=>3000},clientHeight:{configurable:true,get:()=>200},offsetHeight:{configurable:true,get:()=>200}})
    proto.getBoundingClientRect=function(){
      if(this===list)return {top:50,bottom:250,left:0,right:500,width:500,height:200,x:0,y:50,toJSON(){}}
      if(this.getAttribute('data-reply-event')==='event-0')return {top:550,bottom:570,left:0,right:500,width:500,height:20,x:0,y:550,toJSON(){}}
      return oldRect.call(this)
    }
    proto.scrollIntoView=()=>assert.fail('reply jump must not scroll the desk frame')
    assert.equal(!!list.querySelector('[data-reply-event="event-0"]'),false,'positive control: target is outside the loaded window')
    const block=view.el.querySelector<HTMLElement>('.reply-preview-composing')!
    assert.equal(block.querySelector<HTMLButtonElement>('.reply-preview-jump')!.disabled,false,'older history is a reachable destination')
    await inAct(()=>block.querySelector<HTMLElement>('blockquote')!.click())
    for(let page=0;page<6;page++)await inAct(async()=>{await flush(6)})
    assert.ok(list.querySelector('[data-reply-event="event-0"]'),'the exact source is loaded')
    assert.ok(server.requests.some(r=>r.before),'jump requests older cursor pages')
    assert.equal(frame.scrollTop,77);assert.ok(list.scrollTop>0,'only the list is centered')
  }finally{proto.scrollIntoView=oldScroll;proto.getBoundingClientRect=oldRect;await view.unmount();resetConvos()}
})

test('exhausted history keeps a missing message quote inert and retained',async()=>{
  localStorage.clear();resetConvos();storeReply(draftKey('synthetic','writer',1),{...reply,eventId:'not-retained'})
  const server=new FakeServer();server.cursorPages=true;server.messages=[{role:'assistant',seq:0,event_id:'present',text:'Present message'}]
  installFetch(server)
  const view=await mountView(desk(),el=>el)
  try{
    await inAct(async()=>{await refreshConvo('synthetic','writer');await flush(6)})
    const block=view.el.querySelector<HTMLElement>('.reply-preview-composing')!
    assert.equal(block.querySelector<HTMLButtonElement>('.reply-preview-jump')!.disabled,true)
    assert.match(block.textContent??'',/Saved earlier message/)
  }finally{await view.unmount();resetConvos()}
})
