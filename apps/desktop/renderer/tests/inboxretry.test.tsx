import './harness'
import { inAct, flush, mountView } from './harness'
import { withoutMailTransfers } from './mailtransfers.fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { flushOpenedMail } from '../src/mailleave'
import { resetLocalReads } from '../src/mailread'
import type { TreePayload } from '../src/types'

test('real user inbox retries a failed close-time save after its toast and optimistic rerender',async()=>{
  const previous=globalThis.fetch,slug='inbox-read-retry'
  const mail={id:'retry',from:'worker',kind:'message',body:'Opened retry mail',at:'2026-10-21T22:00:00Z'}
  let attempts=0
  const toasts:string[][]=[]
  resetLocalReads()
  globalThis.fetch=withoutMailTransfers((async(url:unknown)=>{
    const p=String(url)
    if(p.includes('/inbox/read')) {
      attempts++
      if(attempts===1)return new Response(JSON.stringify({detail:'offline'}),{status:503,headers:{'Content-Type':'application/json'}})
      return new Response('{"read":1}',{headers:{'Content-Type':'application/json'}})
    }
    const data=p.includes('/inbox')?{pending:[mail],delivered:[],sent:[]} :p.includes('/audiences')?{audiences:[],requests:[]}:{}
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
  }) as typeof fetch)
  const tree={slug,name:'Retry',roots:[],nodes:[],tiers:{}} as unknown as TreePayload
  const v=await mountView(<CurrentOrg.Provider value={slug}><InboxPanel slug={slug} tree={tree} close={()=>{}} toast={messages=>{toasts.push(messages)}} jumpTo={null}/></CurrentOrg.Provider>,el=>el)
  try {
    await inAct(async()=>{await flush(15)})
    assert.match(v.el.querySelector('.mailer-read')?.textContent??'',/Opened retry mail/)
    await inAct(async()=>{await flushOpenedMail(window);await flush(10)})
    assert.equal(attempts,1)
    assert.equal(toasts.some(messages=>messages.some(message=>message.includes('could not mark read'))),true)
    await inAct(()=>v.el.querySelector<HTMLElement>('.mailrow.on')!.click())
    await inAct(async()=>{await flush(15)})
    assert.equal(attempts,2)
  } finally {
    await v.unmount();globalThis.fetch=previous;resetLocalReads()
  }
})
