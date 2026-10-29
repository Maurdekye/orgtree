import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { MailList } from '../src/canvas/mail'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { appendReplyTarget, readReplies, readReply, storeReply, storeReplies } from '../src/eventReply'
import { draftKey } from '../src/draftstore'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { ToastFn } from '../src/types'

const writer: CanvasNode = { id:'writer', generation:2, state:'live', tier:'haiku', children:[], seat:1, grant:0, free:0, scope:{tools:{},add_dirs:[]} }
const desk = (toast:ToastFn=()=>{}) => <DeskChat node={writer} map={new Map([[writer.id,writer]])} slug="org" op={async()=>({})} toast={toast} bare />
async function replyOn(element: Element) {
  await inAct(()=>{element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))})
  const button=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(e=>e.textContent==='Reply')
  assert.ok(button,'public Reply menu opens')
  await inAct(()=>button.click())
}

// the composer's count, a visible line of its own (rig-sol-b md1ebaea68c37 C4: "an explicit count")
const countHeading=(el:HTMLElement,text:string)=>[...el.querySelectorAll<HTMLElement>('*')].find(e=>e.children.length===0&&e.textContent?.trim()===text)
const buttonNamed=(el:HTMLElement,text:string)=>[...el.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)

test('desk mixed senders append and one send carries both durable targets after reload',async()=>{
  localStorage.clear(); resetConvos()
  const server=new FakeServer(); server.messages=[
    {role:'assistant',text:'First source',seq:10,event_id:'e10'},
    {role:'user',text:'Second source',seq:11,event_id:'e11'},
  ]; installFetch(server)
  const original=globalThis.fetch; const sends:any[]=[]
  globalThis.fetch=async(url,init)=>String(url).endsWith('/message')
    ? (sends.push({destination:String(url),...JSON.parse(String(init?.body))}),new Response(JSON.stringify({accepted:true,id:'accepted',queued:0}),{headers:{'Content-Type':'application/json'}}))
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
    assert.ok(sends[0].destination.endsWith('/nodes/writer/message'))
    assert.deepEqual(sends[0].replies.map((q:any)=>q.source_event_ref.eventId),['e10','e11'])
    assert.equal(readReplies(draftKey('org','writer',2)).length,0)
  } finally {await view.unmount();resetConvos();globalThis.fetch=original}
})

test('collector accepts different authors only within one transcript identity',()=>{
  const first={org:'org',agent:'writer',generation:2,eventId:'e1',quote:'first',sender:'writer'}
  const next={...first,eventId:'e2',sender:'@user'}
  assert.equal(appendReplyTarget([first],next).length,2)
  for(const other of [{...next,org:'other'},{...next,agent:'other'},{...next,generation:3}]) {
    assert.throws(()=>appendReplyTarget([first],other),/this transcript/)
  }
})

test('inbox reply has no add-this-message link and still sends one selected message',async()=>{
  const sends:any[]=[]
  const row={id:'m1',from:'writer',kind:'message',body:'Single inbox message',at:'2026-10-14T10:00:00Z'}
  const view=await mountView(<MailList org="org" pending={[row]} onReply={async(m,text,_a,_n,targets)=>{sends.push({m,text,targets})}} />,el=>el)
  try {
    await inAct(()=>{(view.el.querySelector('.mailrow') as HTMLElement).click()})
    assert.equal([...view.el.querySelectorAll('button')].some(button=>button.textContent?.trim()==='Add this message to reply'),false,
      'inbox has no unsolicited add-to-reply link')
    const textarea=view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')
    assert.ok(textarea,'single-message inbox Reply remains available')
    await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'A single reply');textarea.dispatchEvent(new Event('input',{bubbles:true}))})
    await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click();await flush(5)})
    assert.equal(sends.length,1)
    assert.equal(sends[0].m.id,'m1')
    assert.equal(sends[0].text,'A single reply')
    assert.deepEqual(sends[0].targets.map((target:any)=>target.id),['m1'])
  } finally { await view.unmount() }
})

test('inbox collects different authors within one conversation and sends together',async()=>{
  localStorage.clear();const sends:any[]=[]
  const rows=[{id:'m1',from:'writer',kind:'message',body:'First mail',at:'2026-10-14T10:00:00Z'},{id:'m2',from:'other',kind:'message',body:'Second mail',at:'2026-10-14T10:01:00Z'}]
  const view=await mountView(<MailList org="org" pending={rows} onReply={async(m,text,_a,_n,targets)=>{sends.push({m,text,targets})}} />,el=>el)
  try{
    await replyOn([...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes('First mail'))!)
    await replyOn([...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes('Second mail'))!)
    assert.equal(view.el.querySelectorAll('.mail-reply-target').length,2)
    await inAct(()=>{const ta=view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')!;Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(ta,'One inbox reply');ta.dispatchEvent(new Event('input',{bubbles:true}))})
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
  installFetch(server);const notices:string[][]=[];const view=await mountView(desk(lines=>notices.push(lines??[])),el=>el)
  try{
    await inAct(async()=>{await refreshConvo('org','writer');await flush(5)})
    await replyOn(view.el.querySelector('[data-reply-mail="m1"]')!)
    await replyOn(view.el.querySelector('[data-reply-mail="m2"]')!)
    await replyOn(view.el.querySelector('[data-reply-mail="m3"]')!)
    const targets=readReplies(draftKey('org','writer',2))
    await replyOn(view.el.querySelector('[data-reply-event="e20"]')!)
    const all=readReplies(draftKey('org','writer',2))
    assert.deepEqual(all.map(r=>r.mailId),['m1','m2','m3',undefined])
    assert.deepEqual(all.map(r=>r.sender),['sender','sender','other','@user'])
    assert.equal(all[3]?.quote,'Card one\n\nCard two\n\nOther card')
    assert.ok(targets.every(r=>!r.quote.includes('HIDDEN')))
    assert.deepEqual(notices,[])
  }finally{await view.unmount();resetConvos()}
})

test('global inbox keeps one recipient conversation and preserves targets on failed send',async()=>{
  const rows=[{id:'m1',from:'writer',kind:'message',body:'First mail',at:'2026-10-14T10:00:00Z'},{id:'m2',from:'writer',kind:'message',body:'Second mail',at:'2026-10-14T10:01:00Z'},{id:'m3',from:'other',kind:'message',body:'Other mail',at:'2026-10-14T10:02:00Z'}]
  const view=await mountView(<MailList org="org" pending={rows} replyConversation={m=>m.from} onReply={async()=>{throw Error('Controlled refusal')}} />,el=>el)
  try{
    for(const name of ['First mail','Second mail','Other mail']) await replyOn([...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes(name))!)
    assert.equal(view.el.querySelectorAll('.mail-reply-target').length,2)
    assert.match(view.el.querySelector('[role=alert]')?.textContent||'',/A multi-reply can only answer messages/)
    await inAct(()=>{const ta=view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')!;Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(ta,'Keep draft');ta.dispatchEvent(new Event('input',{bubbles:true}))})
    await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click();await flush(5)})
    assert.equal(view.el.querySelectorAll('.mail-reply-target').length,2)
    assert.equal(view.el.querySelector<HTMLTextAreaElement>('.mail-reply textarea')?.value,'Keep draft')
  }finally{await view.unmount()}
})

test('sent multi-reply previews disclose two then all, and legacy drafts normalize to one',async()=>{
  localStorage.clear()
  const one={org:'org',agent:'writer',generation:2,eventId:'e1',quote:'legacy'}
  storeReply('legacy',one);assert.deepEqual(readReplies('legacy'),[one]);assert.deepEqual(readReply('legacy'),one)
  const view=await mountView(<MailReplyPreview org="org" row={{replies:[
    {from:'writer',gist:'First retained quote'},{from:'writer',gist:'Second retained quote'},
    {from:'writer',gist:'Third retained quote'},{from:'writer',gist:'Fourth retained quote'},
  ]}} />,el=>el)
  try{
    assert.equal(view.el.querySelectorAll('blockquote').length,2,'the first two sent targets are visible')
    assert.doesNotMatch(view.el.textContent!,/Third retained quote/)
    const more=[...view.el.querySelectorAll('button')].find(b=>b.textContent?.trim()==='and 2 more')
    assert.ok(more,'the sent preview names the hidden target count')
    await inAct(()=>more!.click())
    assert.equal(view.el.querySelectorAll('blockquote').length,4,'expansion reveals every sent target')
    assert.match(view.el.textContent!,/Fourth retained quote/)
    assert.equal(buttonNamed(view.el,'Show fewer replies'),undefined,'expansion is one way, as Hubchat\'s')
    assert.doesNotMatch(view.el.textContent!,/Replying to \d+ messages/,'a sent message names no count, as Hubchat\'s')
  }finally{await view.unmount()}
})

// Hubchat's foldAt (src/lib/replies.ts): up to three show whole, a longer list its first two
test('three reply targets show whole in sent previews and the composer, as Hubchat\'s foldAt',async()=>{
  localStorage.clear();resetConvos()
  const sent=await mountView(<MailReplyPreview org="org" row={{replies:[
    {from:'writer',gist:'First retained quote'},{from:'writer',gist:'Second retained quote'},{from:'writer',gist:'Third retained quote'},
  ]}} />,el=>el)
  try{
    assert.equal(sent.el.querySelectorAll('blockquote').length,3,'three sent targets show whole')
    assert.equal([...sent.el.querySelectorAll('button')].some(b=>/^and \d+ more$/.test(b.textContent?.trim()??'')),false,'no "and 1 more"')
  }finally{await sent.unmount()}
  installFetch(new FakeServer())
  const key=draftKey('org','writer',2)
  storeReplies(key,[1,2,3].map(n=>({org:'org',agent:'writer',generation:2,eventId:`e${n}`,quote:`Quote ${n}`})))
  const view=await mountView(desk(),el=>el)
  try{
    await inAct(async()=>{await flush(5)})
    assert.equal(view.el.querySelectorAll('.reply-preview-composing').length,3,'three draft targets show whole')
    assert.equal([...view.el.querySelectorAll('button')].some(b=>/^and \d+ more$/.test(b.textContent?.trim()??'')),false,'no "and 1 more"')
    assert.ok(countHeading(view.el,'Replying to 3 messages'),'the composer states its count')
  }finally{await view.unmount();resetConvos()}
})

test('the desk composer discloses two reply targets, expands, and removes one exact target',async()=>{
  localStorage.clear();resetConvos()
  installFetch(new FakeServer())
  const key=draftKey('org','writer',2)
  storeReplies(key,[1,2,3,4].map(n=>({org:'org',agent:'writer',generation:2,eventId:`e${n}`,quote:`Quote ${n}`})))
  const view=await mountView(desk(),el=>el)
  try{
    await inAct(async()=>{await flush(5)})
    assert.equal(view.el.querySelectorAll('.reply-preview-composing').length,2,'only the first two draft targets show')
    assert.ok(countHeading(view.el,'Replying to 4 messages'),'the composer states its count, as Hubchat\'s')
    const more=[...view.el.querySelectorAll('button')].find(b=>b.textContent?.trim()==='and 2 more')
    assert.ok(more,'the draft names the hidden target count')
    await inAct(()=>more!.click())
    assert.equal(view.el.querySelectorAll('.reply-preview-composing').length,4,'all draft targets can be reviewed')
    assert.ok(countHeading(view.el,'Replying to 4 messages'),'expanded, the count still reads 4')
    assert.equal(buttonNamed(view.el,'Show fewer replies'),undefined,'expansion is one way, as Hubchat\'s')
    const third=[...view.el.querySelectorAll<HTMLElement>('.reply-preview-composing')].find(p=>p.textContent?.includes('Quote 3'))
    assert.ok(third,'the exact third target is present')
    await inAct(()=>third!.querySelector<HTMLButtonElement>('[aria-label="Remove reply"]')!.click())
    assert.deepEqual(readReplies(key).map(r=>r.eventId),['e1','e2','e4'],'removal preserves the other exact identities and their order')
    assert.equal(view.el.querySelectorAll('.reply-preview-composing').length,3)
    assert.ok(countHeading(view.el,'Replying to 3 messages'),'after a removal the count reads 3')
  }finally{await view.unmount();resetConvos()}
})

// Hubchat's message view folds a sent multi-reply the same way (src/components/MessageView.tsx):
// the desk transcript's own bubble is the third Orgtree surface of #37
test('a sent desk message with four reply targets shows two and "and 2 more", as Hubchat\'s message view',async()=>{
  localStorage.clear();resetConvos()
  const server=new FakeServer()
  const wire=(n:number)=>({source_event_ref:{org:'org',agent:'writer',generation:2,eventId:`e${n}`},quoted_context:`Quote ${n}`})
  server.messages=[
    ...[1,2,3,4].map(n=>({role:'assistant',text:`Source ${n}`,seq:n,event_id:`e${n}`})),
    {role:'user',text:'One reply for four',seq:5,event_id:'e5',replies:[1,2,3,4].map(wire)},
  ] as typeof server.messages
  installFetch(server)
  const view=await mountView(desk(),el=>el)
  try{
    await inAct(async()=>{await refreshConvo('org','writer');await flush(5)})
    const sent=()=>view.el.querySelectorAll('.reply-preview:not(.reply-preview-composing)').length
    assert.equal(sent(),2,'the bubble shows its first two targets')
    assert.doesNotMatch(view.el.textContent!,/Replying to \d+ messages/,'a sent message names no count')
    const more=buttonNamed(view.el,'and 2 more')
    assert.ok(more,'the bubble names the hidden count')
    await inAct(()=>more!.click())
    assert.equal(sent(),4,'expanding shows every target')
    assert.equal(buttonNamed(view.el,'Show fewer replies'),undefined,'one way, as Hubchat\'s')
  }finally{await view.unmount();resetConvos()}
})
