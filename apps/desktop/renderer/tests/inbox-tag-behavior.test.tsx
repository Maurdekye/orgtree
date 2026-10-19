import { inAct, mountView, flush, useFakeClock, realClock, advance } from './harness'
import { withoutMailTransfers } from './mailtransfers.fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import { MailTagPicker } from '../src/canvas/mailtagpicker'
import { CurrentOrg } from '../src/popout'
import type { InboxPayload, MailEntry, TreePayload } from '../src/types'
import { useInboxTagSelection,includeSelectedMail } from '../src/inboxselection'
import { MailList } from '../src/canvas/mail'
const noLookup=async()=>null

const tree={slug:'behavior',name:'Behavior',roots:[],nodes:[],tiers:{},default_tools:{},default_visibility:'full'} as unknown as TreePayload
const mail=(id:string,tags=['alpha','build']):MailEntry=>({id,from:'lead',kind:'message',body:`body-${id}`,at:`2026-10-18T10:00:${id==='new'? '03':id==='other'?'02':'01'}Z`,tags})
const box=(rows:MailEntry[]):InboxPayload=>({pending:[],delivered:rows,sent:[]})
const trigger=(el:HTMLElement)=>el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')!
const move=(x:number,y:number)=>document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,clientX:x,clientY:y}))
function geometry(el:HTMLElement){
  const control=el.querySelector<HTMLElement>('.mail-tag-control')!,popover=document.querySelector<HTMLElement>('.mail-tag-popover')!
  control.getBoundingClientRect=()=>({left:100,right:300,top:100,bottom:124,width:200,height:24,x:100,y:100,toJSON(){}})
  popover.getBoundingClientRect=()=>({left:100,right:420,top:128,bottom:300,width:320,height:172,x:100,y:128,toJSON(){}})
}
test('pointer far outside trigger and popup closes after a grace delay',async()=>{
  useFakeClock()
  const v=await mountView(<MailTagPicker selected={[]} choices={['alpha']} onChange={()=>{}}/>,el=>el)
  try{
    await inAct(()=>trigger(v.el).click());geometry(v.el)
    await inAct(()=>{move(600,450)})
    assert.equal(trigger(v.el).getAttribute('aria-expanded'),'true','grace does not close immediately')
    await advance(290)
    assert.equal(trigger(v.el).getAttribute('aria-expanded'),'false')
  }finally{await v.unmount();realClock()}
})
test('returning within the margin cancels closing and typed search keeps its popup',async()=>{
  useFakeClock()
  const v=await mountView(<MailTagPicker selected={[]} choices={['alpha']} onChange={()=>{}}/>,el=>el)
  try{
    await inAct(()=>trigger(v.el).click());geometry(v.el)
    await inAct(()=>{move(600,450);move(450,200)})
    await advance(290)
    assert.equal(trigger(v.el).getAttribute('aria-expanded'),'true')
    const input=document.querySelector<HTMLInputElement>('input[aria-label="Search tags"]')!
    await inAct(()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'alpha')
      input.dispatchEvent(new Event('input',{bubbles:true}));move(900,600)
    })
    await advance(290)
    assert.equal(trigger(v.el).getAttribute('aria-expanded'),'true')
  }finally{await v.unmount();realClock()}
})
async function inbox(slug:string,base:InboxPayload,filtered:InboxPayload,lookup?:MailEntry,initialTags=['alpha','build']){
  const previous=globalThis.fetch,calls:string[]=[]
  localStorage.setItem(`orgtree-user-mail-tags:${slug}`,JSON.stringify(initialTags))
  window.sessionStorage.setItem(`orgtree-user-inbox-arrivals:${slug}`,JSON.stringify(['old']))
  window.sessionStorage.setItem(`orgtree-user-inbox-last-opened:${slug}`,'old')
  globalThis.fetch=withoutMailTransfers((async(url:unknown)=>{
    const p=String(url);calls.push(p)
    const data=p.includes('/mail/user/')?{found:!!lookup,mail:lookup}
      :p.includes('/inbox/filter')?filtered:p.includes('tags_only')?{tag_choices:['alpha','build']}
      :p.includes('/inbox')?base:p.includes('/audiences')?{audiences:[],requests:[]}:{}
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
  }) as typeof fetch)
  const v=await mountView(<CurrentOrg.Provider value={slug}><InboxPanel slug={slug} tree={tree} close={()=>{}} toast={()=>{}} jumpTo={null}/></CurrentOrg.Provider>,el=>el)
  await inAct(async()=>{await flush(20)})
  return{...v,calls,dispose:async()=>{await v.unmount();globalThis.fetch=previous;localStorage.removeItem(`orgtree-user-mail-tags:${slug}`)}}
}
const selected=(el:HTMLElement)=>el.querySelector('.mailrow.on')?.textContent??''

test('user inbox keeps the clicked tagged mail through the server-filtered page update',async()=>{
  const old=mail('old',['alpha']),clicked=mail('other',['Review']),fresh=mail('new',['Review'])
  const v=await inbox('filter-tag-click',box([fresh,clicked,old]),box([fresh,clicked]),undefined,[])
  try{
    await inAct(()=>[...v.el.querySelectorAll<HTMLElement>('.mailrow')].find(r=>r.textContent?.includes('body-old'))!.click())
    await inAct(async()=>{
      const row=[...v.el.querySelectorAll<HTMLElement>('.mailrow')].find(r=>r.textContent?.includes('body-other'))!
      row.querySelector<HTMLButtonElement>('button[data-tag-key="review"]')!.click()
      await flush(30)
    })
    assert.match(selected(v.el),/body-other/)
    assert.match(v.el.querySelector('.mailer-read')?.textContent??'',/body-other/)
    assert.equal(window.sessionStorage.getItem('orgtree-user-inbox-last-opened:filter-tag-click'),'other')
  }finally{await v.dispose()}
})
test('unrelated and partially matching new mail do not replace a filtered remembered selection',async()=>{
  const old=mail('old'),other=mail('other',['alpha'])
  const v=await inbox('filter-remember',box([other,old]),box([old]))
  try{assert.match(selected(v.el),/body-old/)}finally{await v.dispose()}
})
test('a newly arrived mail carrying every selected tag replaces the remembered choice',async()=>{
  const old=mail('old'),fresh=mail('new',['BUILD','Alpha'])
  const v=await inbox('filter-arrival',box([fresh,old]),box([fresh,old]))
  try{assert.match(selected(v.el),/body-new/)}finally{await v.dispose()}
})
test('a remembered matching mail outside the bounded page is fetched and restored in the list',async()=>{
  const old=mail('old')
  const v=await inbox('filter-older',box([]),box([]),old)
  try{
    assert.match(selected(v.el),/body-old/)
    assert.equal(v.calls.filter(p=>p.includes('/mail/user/old')).length,1)
  }finally{await v.dispose()}
})
test('server hidden-unread count clears tags and selects the global oldest unread',async()=>{
  const old=mail('old'),oldest=mail('ancient',['other'])
  const filtered={...box([old]),hidden_unread:802,oldest_unread_id:oldest.id}
  const v=await inbox('filter-unread',box([old]),filtered,oldest)
  try{
    const row=v.el.querySelector<HTMLButtonElement>('.mail-hidden-unread');assert.ok(row)
    assert.equal(row.textContent,'(802 unread)','count comes from the server, beyond loaded rows')
    await inAct(async()=>{row.click();await flush(20)})
    assert.equal(v.el.querySelector('.mail-hidden-unread')===null,true)
    assert.match(v.el.querySelector('.mailer-read')?.textContent??'',/body-ancient/)
    assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-user-mail-tags:filter-unread')! ),[])
  }finally{await v.dispose()}
})
test('live partial arrivals leave selection alone; only a new ALL-tags match changes it',async()=>{
  const slug='filter-live',old=mail('old'),fresh=mail('new'),partial=mail('other',['alpha'])
  window.sessionStorage.setItem(`orgtree-user-inbox-arrivals:${slug}`,JSON.stringify(['old']))
  window.sessionStorage.setItem(`orgtree-user-inbox-last-opened:${slug}`,'old')
  function View({rows}:{rows:MailEntry[]}){
    const selected=useInboxTagSelection(slug,box(rows),['alpha','build'],true,noLookup)
    const current=includeSelectedMail(box(rows),selected.extra,['alpha','build'])!
    return <MailList delivered={current.delivered} selectOldestUnread selectionRequest={selected.request}
      onOpenMail={selected.remember} tagFilter={{selected:['alpha','build'],choices:[],onChange:()=>{}}}/>
  }
  const v=await mountView(<View rows={[old]}/>,el=>el)
  try{
    assert.match(selected(v.el),/body-old/)
    await v.render(<View rows={[partial,old]}/>);assert.match(selected(v.el),/body-old/)
    await v.render(<View rows={[fresh,partial,old]}/>);assert.match(selected(v.el),/body-new/)
    await inAct(()=>[...v.el.querySelectorAll<HTMLElement>('.mailrow')].find(r=>r.textContent?.includes('body-old'))!.click())
    assert.match(selected(v.el),/body-old/)
    await v.render(<View rows={[mail('unrelated',['other']),fresh,partial,old]}/>);assert.match(selected(v.el),/body-old/)
  }finally{await v.unmount()}
})
test('a missing remembered mail and an older mail without ALL tags leave no selection',async()=>{
  for(const row of [undefined,mail('old',['alpha'])]){
    const v=await inbox(`filter-missing-${row?'partial':'gone'}`,box([]),box([]),row)
    try{assert.equal(v.el.querySelector('.mailrow.on')===null,true)}finally{await v.dispose()}
  }
})
