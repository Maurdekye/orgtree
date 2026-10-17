import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { MailTagPicker } from '../src/canvas/mailtagpicker'
import { mailMatchesTags, mailTagHue } from '../src/canvas/mailtags'

const choices=['Alpha Build','Progress','Review']
function Picker({initial=[]}:{initial?:string[]}){
  const [selected,setSelected]=useState(initial)
  return <MailTagPicker choices={choices} selected={selected} onChange={setSelected}/>
}
const trigger=(el:HTMLElement)=>el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
const check=(el:HTMLElement,label:string)=>[...el.querySelectorAll('label')].find(e=>e.textContent?.includes(label))?.querySelector<HTMLInputElement>('input[type=checkbox]')
const input=(el:HTMLInputElement,value:string)=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(el,value)
  el.dispatchEvent(new Event('input',{bubbles:true}))
}
test('tag dropdown lists every supplied tag as coloured checkable entries',async()=>{
  const v=await mountView(<Picker/>,el=>el)
  try{
    const button=trigger(v.el);assert.ok(button,'tag filter must be one dropdown control')
    assert.equal(button.getAttribute('aria-expanded'),'false')
    await inAct(()=>button.click())
    assert.equal(v.el.querySelectorAll('input[type=checkbox]').length,3)
    for(const label of choices){
      const c=check(v.el,label);assert.ok(c,label)
      const chip=c.closest('label')?.querySelector<HTMLElement>('.mail-tag')
      assert.ok(chip,'tag choices keep their chip colour')
      assert.equal(chip.style.getPropertyValue('--mail-tag-hue'),mailTagHue(label))
    }
  }finally{await v.unmount()}
})
test('multiple selections stay checked and appear on the closed control',async()=>{
  const v=await mountView(<Picker/>,el=>el)
  try{
    const button=trigger(v.el);assert.ok(button)
    await inAct(()=>button.click())
    await inAct(()=>check(v.el,'Alpha Build')!.click())
    await inAct(()=>check(v.el,'Progress')!.click())
    assert.equal(check(v.el,'Alpha Build')!.checked,true)
    assert.equal(check(v.el,'Progress')!.checked,true)
    await inAct(()=>button.click())
    assert.equal(button.getAttribute('aria-expanded'),'false')
    assert.match(button.textContent??'',/Alpha Build/)
    assert.match(button.textContent??'',/Progress/)
    await inAct(()=>button.click())
    assert.equal(check(v.el,'Alpha Build')!.checked,true)
  }finally{await v.unmount()}
})
test('typing narrows tag choices without changing selected tags',async()=>{
  const v=await mountView(<Picker initial={['Alpha Build']}/>,el=>el)
  try{
    const button=trigger(v.el);assert.ok(button)
    await inAct(()=>button.click())
    const search=v.el.querySelector<HTMLInputElement>('input[aria-label="Search tags"]')
    assert.ok(search)
    await inAct(()=>input(search,'ogre'))
    assert.equal(v.el.querySelectorAll('input[type=checkbox]').length,1)
    assert.ok(check(v.el,'Progress'))
    await inAct(()=>input(search,''))
    assert.equal(check(v.el,'Alpha Build')!.checked,true)
  }finally{await v.unmount()}
})
test('Escape closes the tag dropdown and restores its trigger focus',async()=>{
  const v=await mountView(<Picker/>,el=>el)
  try{
    const button=trigger(v.el);assert.ok(button)
    await inAct(()=>button.click())
    const search=v.el.querySelector<HTMLInputElement>('input[aria-label="Search tags"]')
    assert.ok(search)
    assert.equal(document.activeElement===search,true)
    await inAct(()=>{search.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})
    assert.equal(button.getAttribute('aria-expanded'),'false')
    assert.equal(document.activeElement===button,true)
  }finally{await v.unmount()}
})
test('tag options request another cursor page on scroll instead of stopping at a fixed cutoff',async()=>{
  let pages=0
  const v=await mountView(<MailTagPicker selected={[]} choices={choices} onChange={()=>{}}
    hasMore onLoadMore={()=>{pages++}}/>,el=>el)
  try{
    const button=trigger(v.el);assert.ok(button)
    await inAct(()=>button.click())
    const list=v.el.querySelector<HTMLElement>('[role=group][aria-label="Tag choices"]');assert.ok(list)
    Object.defineProperties(list,{scrollHeight:{value:1000},clientHeight:{value:200},scrollTop:{value:850,writable:true}})
    await inAct(()=>{list.dispatchEvent(new Event('scroll',{bubbles:true}))})
    assert.equal(pages,1)
  }finally{await v.unmount()}
})
test('empty and one-tag match controls remain case insensitive',()=>{
  assert.equal(mailMatchesTags(undefined,[]),true)
  assert.equal(mailMatchesTags([' ALPHA Build '],['alpha build']),true)
  assert.equal(mailMatchesTags(['Progress'],['alpha build']),false)
})
test('mail matching accepts ANY checked tag, including a later selection',()=>{
  assert.equal(mailMatchesTags(['Progress'],['Alpha Build','Progress']),true)
  assert.equal(mailMatchesTags(['Alpha Build','Progress'],['Alpha Build','Progress']),true)
  assert.equal(mailMatchesTags(undefined,['Alpha Build','Progress']),false)
})
