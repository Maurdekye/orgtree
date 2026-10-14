import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { MailList } from '../src/canvas/mail'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { readReplies, readReply, storeReply } from '../src/eventReply'
import { draftKey } from '../src/draftstore'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const writer: CanvasNode = { id:'writer', generation:2, state:'live', tier:'haiku', children:[], seat:1, grant:0, free:0, scope:{tools:{},add_dirs:[]} }
const desk = (toast=(lines:string[])=>{}) => <DeskChat node={writer} map={new Map([[writer.id,writer]])} slug="org" op={async()=>({})} toast={toast} bare />
async function replyOn(element: Element) {
  await inAct(()=>element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})))
  const button=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(e=>e.textContent==='Reply')
  assert.ok(button,'public Reply menu opens')
  await inAct(()=>button.click())
}

test('desk append then one send carries both durable targets after reload',async()=>{
  localStorage.clear(); resetConvos()
  const server=new FakeServer(); server.messages=[
    {role:'assistant',text:'First source',seq:10,event_id:'e10'},
    {role:'assistant',text:'Second source',seq:11,event_id:'e11'},
  ]; installFetch(server)
  const original=globalThis.fetch; const sends:any[]=[]
  globalThis.fetch=async(url,init)=>String(url).endsWith('/message')
    ? (sends.push(JSON.parse(String(init?.body))),new Response(JSON.stringify({accepted:true,id:'accepted',queued:0}),{headers:{'Content-Type':'application/json'}}))
    : original(url,init)
  let view=await mountView(desk(),el=>el)
  try {
    await inAct(async()=>{await refreshConvo('org','writer');await flush(5)})
    await replyOn(view.el.querySelector('[data-reply-event="e10"]')!)
    await replyOn(view.el.querySelector('[data-reply-event="e11"]')!)
    await replyOn(view.el.querySelector('[data-reply-event="e11"]')!)
    assert.deepEqual(readReplies(draftKey('org','writer',2)).map(r=>r.eventId),['e10','e11'])
    assert.equal(view.el.querySelectorAll('.desk-control-scope .reply-preview, .desk-over > .reply-preview').length || view.el.querySelectorAll('.reply-preview').length,2)
    await view.unmount(); localStorage.setItem(draftKey('org','writer',2),'One reply for both')
    view=await mountView(desk(),el=>el)
    await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.cc-send')!.click();await flush(10)})
    assert.equal(sends.length,1);assert.equal(sends[0].text,'One reply for both')
    assert.deepEqual(sends[0].replies.map((q:any)=>q.source_event_ref.eventId),['e10','e11'])
    assert.equal(readReplies(draftKey('org','writer',2)).length,0)
  } finally {await view.unmount();resetConvos();globalThis.fetch=original}
})

test('desk blocks adding a different sender without losing the first target',async()=>{
  localStorage.clear();resetConvos()
  const server=new FakeServer();server.messages=[{role:'assistant',text:'Agent source',seq:1,event_id:'e1'},{role:'user',text:'User source',seq:2,event_id:'e2'}]
  installFetch(server);const notices:string[][]=[];const view=await mountView(desk(lines=>notices.push(lines)),el=>el)
  try {
    await inAct(async()=>{await refreshConvo('org','writer');await flush(5)})
    await replyOn(view.el.querySelector('[data-reply-event="e1"]')!)
    await replyOn(view.el.querySelector('[data-reply-event="e2"]')!)
    assert.deepEqual(readReplies(draftKey('org','writer',2)).map(r=>r.eventId),['e1'])
    assert.match(notices.flat().join(),/same sender/)
  }finally{await view.unmount();resetConvos()}
})

test('inbox Reply collects several same-sender rows and sends them together',async()=>{
  localStorage.clear();const sends:any[]=[]
  const rows=[{id:'m1',from:'writer',kind:'message',body:'First mail',at:'2026-10-14T10:00:00Z'},{id:'m2',from:'writer',kind:'message',body:'Second mail',at:'2026-10-14T10:01:00Z'}]
  const view=await mountView(<MailList org="org" pending={rows} onReply={async(m,text,_a,_n,targets)=>{sends.push({m,text,targets})}} />,el=>el)
  try{
    await replyOn([...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes('First mail'))!)
    await replyOn([...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes('Second mail'))!)
    assert.equal(view.el.querySelectorAll('.mail-reply-target').length,2)
    await inAct(()=>{const ta=view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(ta,'One inbox reply');ta.dispatchEvent(new Event('input',{bubbles:true}))})
    const button=view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!
    await inAct(async()=>{button.click();await flush(5)})
    assert.equal(sends.length,1);assert.equal(sends[0].text,'One inbox reply')
    assert.deepEqual(sends[0].targets.map((m:any)=>m.id),['m1','m2'])
  }finally{await view.unmount()}
})

test('individual delivered mail cards retain their sender and separate target identities',async()=>{
  localStorage.clear();resetConvos();const server=new FakeServer()
  const mail=(id:string,from:string,body:string)=>({id,from,body,kind:'message',at:'2026-10-14T10:00:00Z'})
  server.messages=[{role:'user',text:'HIDDEN envelope',seq:20,event_id:'e20',segments:[{kind:'mail',rows:[mail('m1','sender','Card one'),mail('m2','sender','Card two'),mail('m3','other','Other card')]}]}]
  installFetch(server);const notices:string[][]=[];const view=await mountView(desk(lines=>notices.push(lines)),el=>el)
  try{
    await inAct(async()=>{await refreshConvo('org','writer');await flush(5)})
    await replyOn(view.el.querySelector('[data-reply-mail="m1"]')!)
    await replyOn(view.el.querySelector('[data-reply-mail="m2"]')!)
    await replyOn(view.el.querySelector('[data-reply-mail="m3"]')!)
    const targets=readReplies(draftKey('org','writer',2))
    assert.deepEqual(targets.map(r=>r.mailId),['m1','m2'])
    assert.deepEqual(targets.map(r=>r.sender),['sender','sender'])
    assert.ok(targets.every(r=>!r.quote.includes('HIDDEN')))
    assert.match(notices.flat().join(),/same sender/)
  }finally{await view.unmount();resetConvos()}
})

test('inbox refuses another sender and preserves collected targets on failed send',async()=>{
  const rows=[{id:'m1',from:'writer',kind:'message',body:'First mail',at:'2026-10-14T10:00:00Z'},{id:'m2',from:'writer',kind:'message',body:'Second mail',at:'2026-10-14T10:01:00Z'},{id:'m3',from:'other',kind:'message',body:'Other mail',at:'2026-10-14T10:02:00Z'}]
  const view=await mountView(<MailList org="org" pending={rows} onReply={async()=>{throw Error('Controlled refusal')}} />,el=>el)
  try{
    for(const name of ['First mail','Second mail','Other mail']) await replyOn([...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes(name))!)
    assert.equal(view.el.querySelectorAll('.mail-reply-target').length,2)
    assert.match(view.el.querySelector('[role=alert]')?.textContent||'',/same sender/)
    await inAct(()=>{const ta=view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(ta,'Keep draft');ta.dispatchEvent(new Event('input',{bubbles:true}))})
    await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click();await flush(5)})
    assert.equal(view.el.querySelectorAll('.mail-reply-target').length,2)
    assert.equal(view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')?.value,'Keep draft')
  }finally{await view.unmount()}
})

test('all incoming reply snapshots render, and legacy drafts normalize to one',async()=>{
  localStorage.clear()
  const one={org:'org',agent:'writer',generation:2,eventId:'e1',quote:'legacy'}
  storeReply('legacy',one);assert.deepEqual(readReplies('legacy'),[one]);assert.deepEqual(readReply('legacy'),one)
  const view=await mountView(<MailReplyPreview org="org" row={{replies:[{from:'writer',gist:'First retained quote'},{from:'writer',gist:'Second retained quote'}]}} />,el=>el)
  try{assert.equal(view.el.querySelectorAll('blockquote').length,2);assert.match(view.el.textContent!,/Second retained quote/)}
  finally{await view.unmount()}
})
