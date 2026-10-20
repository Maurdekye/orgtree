import {mountView,inAct} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {MailList} from '../src/canvas/mail'
import type {MailRow} from '../src/canvas/shared'

const uid='u508f0eddef28'
export const monitorMail=(from='user-watch',name='user-watch'):MailRow=>({
 id:'monitor-fire',from,kind:'watchdog',body:'Listeners ready',at:'2026-10-20T18:24:41Z',
 ev:{v:1,variant:'monitor.watchdog_fired',engine_authored:true,actor:{kind:'watchdog',id:uid},
 object:{kind:'watchdog',org:'synthetic',id:uid,name,owner:'user'},prefix:'LISTENERS READY',lines:['Ready'],once:false,count:1},
})
const lookup=async()=>null
const view=(row:MailRow,outgoing=false)=><MailList org="synthetic" delivered={[row]} outgoing={outgoing} lookup={lookup}
 rowSender={id=><span>{id}</span>} sender={id=><b>{id}</b>}/>
async function search(el:HTMLElement,value:string){
 const input=el.querySelector<HTMLInputElement>('.mail-filter')!
 assert.ok(input,'mail search exists')
 await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})
}
test('user monitor list sender matches the opened card name and exposes its full ID',async()=>{
 const v=await mountView(view(monitorMail()),el=>el)
 try{
  const row=v.el.querySelector<HTMLElement>('.mailrow')!
  assert.match(row.textContent??'',/user-watch/)
  assert.doesNotMatch(row.textContent??'',new RegExp(uid))
  assert.ok([...row.querySelectorAll<HTMLElement>('[title]')].some(el=>el.title.includes(uid)))
  await inAct(()=>row.click())
  assert.match(v.el.querySelector('.mailer-read .event-actor')?.textContent??'',/user-watch/)
 }finally{await v.unmount()}
})
test('monitor sender-name search also finds older rows whose stored sender is an ID',async()=>{
 const v=await mountView(view(monitorMail(uid)),el=>el)
 try{await search(v.el,'user-watch');assert.equal(v.el.querySelectorAll('.mailrow').length,1)}finally{await v.unmount()}
})
test('monitor ID remains searchable when its sender displays the name',async()=>{
 const v=await mountView(view(monitorMail()),el=>el)
 try{await search(v.el,uid);assert.equal(v.el.querySelectorAll('.mailrow').length,1)}finally{await v.unmount()}
})
test('missing recorded monitor name falls back to its stable ID',async()=>{
 const v=await mountView(view(monitorMail(uid,'')),el=>el)
 try{assert.match(v.el.querySelector('.mailrow')?.textContent??'',new RegExp(uid))}finally{await v.unmount()}
})
test('legacy watchdog sender labels are unchanged',async()=>{
 const row=monitorMail();delete row.ev
 const v=await mountView(view(row),el=>el)
 try{assert.match(v.el.querySelector('.mailrow')?.textContent??'',/user-watch/)}finally{await v.unmount()}
})
test('outgoing mail keeps its recipient identity',async()=>{
 const row={...monitorMail(),to:'recipient'}
 const v=await mountView(view(row,true),el=>el)
 try{assert.match(v.el.querySelector('.mailrow')?.textContent??'',/recipient/)}finally{await v.unmount()}
})
