import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogPanel } from '../src/canvas/modals'
import type { Watchdog } from '../src/types'

const base = { id:'worker/feed',owner:'worker',name:'feed',target:'loopback',state:'armed',interval_s:60,
  fired:0,once:false,spent:false,at:'2026-10-22T13:00:00Z',events:[] }
for (const kind of ['mqtt','websocket'] as const) {
  for (const mode of [undefined,'notice','wake','off'] as const) test(`${kind} connection mode ${mode ?? 'legacy'} is editable without changing data delivery`,async t=>{
    const original=globalThis.fetch, posted:unknown[]=[]
    globalThis.fetch=(async(_url,init)=>{const body=JSON.parse(String(init?.body));posted.push(body)
      return {ok:true,status:200,headers:new Headers(),json:async()=>({connection_messages:body.connection_messages})} as Response
    }) as typeof fetch
    const view=await mountView(<WatchdogPanel slug="synthetic" dog={{...base,kind,notice:true,connection_messages:mode} as Watchdog} toast={()=>{}} close={()=>{}}/>,h=>h)
    t.after(async()=>{await view.unmount();globalThis.fetch=original})
    const select=view.el.querySelector<HTMLSelectElement>('select[aria-label="Connection messages"]')
    assert.equal(!!select,true)
    assert.equal(select!.value,mode ?? 'notice')
    assert.deepEqual([...select!.options].map(o=>o.value),['notice','wake','off'])
    const next=mode==='off'?'wake':'off'
    await inAct(()=>{select!.value=next;select!.dispatchEvent(new Event('change',{bubbles:true}))});await flush()
    assert.equal(select!.value,next)
    assert.deepEqual(posted,[{id:'worker/feed',action:'configure',connection_messages:next}])
    assert.match(view.el.textContent ?? '',/does not change.*data|data messages.*unchanged/i)
    assert.equal(view.el.querySelector('input[aria-label="Notify on (re)connect"]')===null,true)
  })
}
test('failed connection-mode save preserves the previous selection and allows retry',async t=>{
  const original=globalThis.fetch, errors:string[]=[]
  globalThis.fetch=(async()=>({ok:false,status:409,statusText:'Conflict',headers:new Headers(),json:async()=>({detail:'watchdog departed'})} as Response)) as typeof fetch
  const view=await mountView(<WatchdogPanel slug="synthetic" dog={{...base,kind:'mqtt',connection_messages:'wake'} as Watchdog} toast={m=>errors.push(...(m ?? []))} close={()=>{}}/>,h=>h)
  t.after(async()=>{await view.unmount();globalThis.fetch=original})
  const select=view.el.querySelector<HTMLSelectElement>('select[aria-label="Connection messages"]')
  assert.equal(!!select,true)
  await inAct(()=>{select!.value='off';select!.dispatchEvent(new Event('change',{bubbles:true}))});await flush()
  assert.equal(select!.value,'wake');assert.equal(select!.disabled,false)
  assert.match(errors.join(' '),/watchdog departed/)
})
