import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'
import { useTaggedUserMail } from '../src/usemailtags'
import type { InboxPayload } from '../src/types'

const rows:MailRow[]=Array.from({length:6},(_,i)=>({id:`m${i}`,from:'lead',kind:'message',
  at:`2026-10-17T00:00:0${i}Z`,body:`message${i}`,...(i===0?{tags:['Alpha Build']}:i===1?{tags:['alpha build']}:i===2?{tags:['Progress']}:{}),
}))
function TaggedBox(){
  const [tag,setTag]=useState<string[]>([])
  return <MailList delivered={rows} tagFilter={{selected:tag,choices:['Alpha Build','Progress'],onChange:setTag}}/>
}
const count=(el:HTMLElement)=>el.querySelectorAll('.mailrow').length
const change=(input:HTMLInputElement,value:string)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}
test('user mail shows tag chips and a selector; untagged mail remains visible',async()=>{
  const v=await mountView(<TaggedBox/>,el=>el)
  try {
    assert.equal(count(v.el),6,'positive control: all mail is mounted')
    assert.equal(v.el.querySelectorAll('.mail-tag').length>=3,true,'sender tags must be visible')
    assert.equal(v.el.querySelector('button[aria-label="Filter mail by tags"]')!==null,true)
  }finally{await v.unmount()}
})
test('tag selection is case-insensitive, composes with text search, and clearing restores mail',async()=>{
  const v=await mountView(<TaggedBox/>,el=>el)
  try{
    const pick=v.el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
    assert.equal(pick!==null,true,'user inbox needs its tag selector')
    await inAct(()=>pick!.click())
    await inAct(()=>[...v.el.ownerDocument.querySelectorAll<HTMLButtonElement>('button.mail-tag-choice')].find(b=>b.textContent==='Alpha Build')!.click())
    assert.equal(count(v.el),2)
    const q=v.el.querySelector<HTMLInputElement>('input.mail-filter')!
    await inAct(()=>{change(q,'message1')})
    await inAct(async()=>{await flush(3)})
    assert.equal(count(v.el),1,'text and tag filters must intersect')
    await inAct(()=>{change(q,'');v.el.querySelector<HTMLButtonElement>('button[aria-label="Clear tag filter"]')!.click()})
    assert.equal(count(v.el),6)
  }finally{await v.unmount()}
})
test('a tag chip selects its filter; agent mail has no user-tag filter control',async()=>{
  const v=await mountView(<TaggedBox/>,el=>el)
  try{
    const chip=v.el.querySelector<HTMLButtonElement>('button.mail-tag')
    assert.equal(chip!==null,true,'tag chips must select a filter')
    await inAct(()=>{chip!.click()})
    assert.equal(count(v.el),1,'first chronological tag is Progress')
    await v.render(<MailList delivered={rows}/>)
    assert.equal(v.el.querySelector('button[aria-label="Filter mail by tags"]')===null,true)
  }finally{await v.unmount()}
})

test('tag hue is stable for normalized names and differs across tag keys',async()=>{
  const v=await mountView(<TaggedBox/>,el=>el)
  try{
    const same=[...v.el.querySelectorAll<HTMLElement>('.mail-tag[data-tag-key="alpha build"]')]
    assert.equal(same.length,2,'both case variants render chips with their normalized key')
    const hue=same[0]!.style.getPropertyValue('--mail-tag-hue')
    assert.ok(hue.length>0,'a stable hash supplies the chip hue')
    assert.equal(same[1]!.style.getPropertyValue('--mail-tag-hue'),hue)
    const other=v.el.querySelector<HTMLElement>('.mail-tag[data-tag-key="progress"]')!
    assert.notEqual(other.style.getPropertyValue('--mail-tag-hue'),hue)
    await v.render(<MailList delivered={[...rows].reverse()} tagFilter={{selected:[],choices:[],onChange:()=>{}}}/>)
    assert.equal(v.el.querySelector<HTMLElement>('.mail-tag[data-tag-key="alpha build"]')!.style.getPropertyValue('--mail-tag-hue'),hue)
  }finally{await v.unmount()}
})

const base:InboxPayload={pending:[],delivered:rows,sent:[]}
function TagPage({tag}:{tag:string}){
  const page=useTaggedUserMail('tag-org',base,tag?[tag]:[],true)
  return <div data-rows={page.box.delivered.map(m=>m.body).join(',')} data-error={page.error??''}>
    <button onClick={page.loadMore}>older</button>
  </div>
}
test('tag query reads older matching mail before paging and merges its next cursor window',async()=>{
  const real=globalThis.fetch,requests:{url:string;body:{tags:string[];before?:string}}[]=[]
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),body=JSON.parse(String(init?.body)) as {tags:string[];before?:string};requests.push({url,body})
    assert.equal(init?.method,'POST')
    const data={pending:[],delivered:[{...rows[0],id:body.before?'old2':'old1',body:body.before?'older':'old'}],sent:[],next_cursor:body.before?null:'99'}
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
  }) as typeof fetch
  const v=await mountView(<TagPage tag="Alpha Build"/>,el=>el)
  try{
    await inAct(async()=>{await flush(8)})
    assert.equal(v.el.querySelector('[data-rows]')!.getAttribute('data-rows'),'old')
    assert.ok(requests.some(r=>r.url.endsWith('/inbox/filter')&&r.body.tags.join()==='Alpha Build'),'tag is a server query, not a loaded-row-only filter')
    await inAct(async()=>{v.el.querySelector<HTMLButtonElement>('button')!.click();await flush(8)})
    assert.equal(v.el.querySelector('[data-rows]')!.getAttribute('data-rows'),'old,older')
    assert.ok(requests.some(r=>r.body.before==='99'))
  }finally{await v.unmount();globalThis.fetch=real}
})
test('an obsolete tag response cannot replace the current filter',async()=>{
  const real=globalThis.fetch
  let finish:((response:Response)=>void)|undefined
  globalThis.fetch=(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body)) as {tags:string[]}
    if(body.tags[0]==='Alpha')return new Promise<Response>(resolve=>{finish=resolve})
    return new Response(JSON.stringify({pending:[],delivered:[{...rows[0],body:'progress'}],sent:[]}))
  }) as typeof fetch
  const v=await mountView(<TagPage tag="Alpha"/>,el=>el)
  try{
    await inAct(async()=>{await flush(5)})
    assert.ok(finish,'positive control: first request is pending')
    await v.render(<TagPage tag="Progress"/>)
    await inAct(async()=>{await flush(5);finish!(new Response(JSON.stringify({pending:[],delivered:[{...rows[0],body:'obsolete'}],sent:[]})));await flush(5)})
    assert.equal(v.el.querySelector('[data-rows]')!.getAttribute('data-rows'),'progress')
  }finally{await v.unmount();globalThis.fetch=real}
})
