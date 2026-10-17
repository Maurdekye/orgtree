import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'

const rows:MailRow[]=Array.from({length:6},(_,i)=>({id:`m${i}`,from:'lead',kind:'message',
  at:`2026-10-17T00:00:0${i}Z`,body:`message${i}`,...(i===0?{tags:['Alpha Build']}:i===1?{tags:['alpha build']}:i===2?{tags:['Progress']}:{}),
}))
function TaggedBox(){
  const [tag,setTag]=useState('')
  return <MailList delivered={rows} tagFilter={{value:tag,choices:['Alpha Build','Progress'],onChange:setTag}}/>
}
const count=(el:HTMLElement)=>el.querySelectorAll('.mailrow').length
test('user mail shows tag chips and a selector; untagged mail remains visible',async()=>{
  const v=await mountView(<TaggedBox/>,el=>el)
  try {
    assert.equal(count(v.el),6,'positive control: all mail is mounted')
    assert.equal(v.el.querySelectorAll('.mail-tag').length>=3,true,'sender tags must be visible')
    assert.equal(v.el.querySelector('select[aria-label="Filter mail by tag"]')!==null,true)
  }finally{await v.unmount()}
})
test('tag selection is case-insensitive, composes with text search, and clearing restores mail',async()=>{
  const v=await mountView(<TaggedBox/>,el=>el)
  try{
    const pick=v.el.querySelector<HTMLSelectElement>('select[aria-label="Filter mail by tag"]')
    assert.equal(pick!==null,true,'user inbox needs its tag selector')
    await inAct(()=>{pick!.value='Alpha Build';pick!.dispatchEvent(new Event('change',{bubbles:true}))})
    assert.equal(count(v.el),2)
    const q=v.el.querySelector<HTMLInputElement>('input.mail-filter')!
    await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(q,'message1');q.dispatchEvent(new Event('input',{bubbles:true}))})
    await inAct(async()=>{await flush(3)})
    assert.equal(count(v.el),1,'text and tag filters must intersect')
    await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(q,'');q.dispatchEvent(new Event('input',{bubbles:true}));pick!.value='';pick!.dispatchEvent(new Event('change',{bubbles:true}))})
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
    assert.equal(v.el.querySelector('select[aria-label="Filter mail by tag"]')===null,true)
  }finally{await v.unmount()}
})
