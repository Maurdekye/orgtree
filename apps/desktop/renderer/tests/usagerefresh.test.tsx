import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getRegisteredAccountUsage } from '../src/api'
import { UsageModal } from '../src/App'
import { UsageBars } from '../src/canvas/accounts'
import { legacyAppBackend } from './appfeed-fixture'
import type { AccountUsage } from '../src/types'

const observed='2026-10-13T18:00:00Z'
const good=(account:string,percent:number):AccountUsage=>({account,provider:'Claude',label:account,
  available:true,plan:'Max',observed_at:observed,limits:[{kind:'session',group:'session',percent,
    severity:'normal',resets_at:null,is_active:false,model:null}]})
const reply=(body:unknown)=>Promise.resolve(new Response(JSON.stringify(body),{status:200,
  headers:{'Content-Type':'application/json'}}))

test('registered usage defaults to cache; only force=true sets the boolean query on the encoded account URL',async()=>{
  const before=globalThis.fetch,urls:string[]=[]
  globalThis.fetch=async url=>{urls.push(String(url));return reply(good('fixture',17))}
  try{
    await getRegisteredAccountUsage('fixture/name ü')
    await getRegisteredAccountUsage('fixture/name ü',false)
    await getRegisteredAccountUsage('fixture/name ü',true)
    assert.deepEqual(urls,[
      '/api/accounts/fixture%2Fname%20%C3%BC/usage',
      '/api/accounts/fixture%2Fname%20%C3%BC/usage',
      '/api/accounts/fixture%2Fname%20%C3%BC/usage?force=true',
    ])
  }finally{globalThis.fetch=before}
})

test('available last-good bars expose provider failure, and a later successful payload clears it',async()=>{
  const payload={...good('fixture',42),error:'provider did not answer'}
  const view=await mountView(<UsageBars u={payload}/>,el=>el)
  try{
    assert.match(view.el.querySelector('[role="alert"]')?.textContent??'',/refresh failed: provider did not answer/)
    assert.match(view.el.textContent??'',/42%/)
    assert.equal(view.el.querySelectorAll('.usage-track').length,1)
    await view.render(<UsageBars u={good('fixture',43)}/> )
    assert.equal(view.el.querySelector('[role="alert"]'),null)
    assert.match(view.el.textContent??'',/43%/)
  }finally{await view.unmount()}
})

test('unavailable and unsupported payloads retain their existing explanations, without invented bars',async()=>{
  const view=await mountView(<UsageBars u={{...good('fixture',0),available:false,limits:[],error:'signed out'}}/>,el=>el)
  try{
    assert.match(view.el.textContent??'',/signed out/)
    assert.doesNotMatch(view.el.textContent??'',/refresh failed:/)
    assert.equal(view.el.querySelectorAll('.usage-track').length,0)
    await view.render(<UsageBars u={{...good('fixture',0),available:false,unsupported:true,limits:[],error:'unsupported kind'}}/> )
    assert.match(view.el.querySelector('.acct-unsupported')?.textContent??'',/unsupported kind/)
    assert.equal(view.el.querySelector('[role="alert"]'),null)
    assert.equal(view.el.querySelectorAll('.usage-track').length,0)
  }finally{await view.unmount()}
})

test('actual native and registered Refresh show HTTP200 retained-bar errors without restamping, then recover',async()=>{
  const id='fixture-refresh-account',before=globalThis.fetch,urls:string[]=[]
  let failed=false
  const payload=(account:string,percent:number)=>({...good(account,percent),...(failed?{error:'fixture provider failed'}:{})})
  globalThis.fetch=legacyAppBackend((async input=>{
    const url=new URL(String(input),'http://localhost'),path=url.pathname
    urls.push(path+url.search)
    if(path==='/api/providers')return reply({providers:[{id:'claude',hire_enabled:true,status:{installed:true}}]})
    if(path==='/api/accounts')return reply({accounts:[{id,provider:'claude',harness:'claude-code',label:'Fixture login',
      mode:'subscription',enabled:true,ambient:false,credential:{kind:'managed',path:'D:/synthetic/profile'},
      identity:{email:'fixture@example.test'},auth:'authenticated',tint_ordinal:1,bound:[]}]})
    if(path==='/api/usage')return reply(payload('primary',17))
    if(path===`/api/accounts/${id}/usage`)return reply(payload(id,42))
    if(path==='/api/langservers')return reply({servers:[]})
    if(path.includes('/keys/usage'))return reply({keys:[]})
    return reply({available:false,limits:[],accounts:[],keys:[]})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<UsageModal close={()=>{}} toast={()=>{}}/>,el=>el)
    await inAct(async()=>{await flush(12)})
    const registered=view.el.querySelector<HTMLElement>(`[data-account="${id}"]`)!
    const native=[...view.el.querySelectorAll<HTMLElement>('.usage-acct')]
      .find(card=>!!card.querySelector('[aria-label="refresh Claude usage"]'))!
    assert.ok(native);assert.ok(registered)
    const stamps=[native,registered].map(card=>card.querySelector('.usage-updated')?.getAttribute('title'))
    assert.ok(stamps.every(Boolean),'both dated readings reached actual cards')
    failed=true
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    for(const [i,card] of [native,registered].entries()){
      assert.match(card.querySelector('[role="alert"]')?.textContent??'',/refresh failed: fixture provider failed/)
      assert.equal(card.querySelectorAll('.usage-track').length,1)
      assert.equal(card.querySelector('.usage-updated')?.getAttribute('title'),stamps[i])
      assert.equal(card.querySelector('.usage-refresh-button')?.getAttribute('aria-busy'),'false')
    }
    assert.ok(urls.includes(`/api/accounts/${id}/usage?force=true`),'registered Refresh forced its own account')
    assert.ok(urls.includes('/api/usage?force=true'),'native force path remains intact')
    failed=false
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    assert.equal(native.querySelector('[role="alert"]'),null)
    assert.equal(registered.querySelector('[role="alert"]'),null)
    assert.match(native.textContent??'',/17%/);assert.match(registered.textContent??'',/42%/)
  }finally{await view?.unmount();globalThis.fetch=before}
})

test('every OpenRouter key has independent Refresh; only the clicked key forces and failures retain its bars',async()=>{
  const before=globalThis.fetch,seen:string[]=[]
  const readings:Record<string,AccountUsage&{name:string}>={
    openrouter:{...good('openrouter',11),provider:'OpenRouter',name:'Original'},
    'openrouter-2':{...good('openrouter-2',22),provider:'OpenRouter',name:'Team budget'},
    'openrouter-3':{...good('openrouter-3',63),provider:'OpenRouter',name:'Other budget'},
  }
  let settle:((value:Response)=>void)|undefined
  globalThis.fetch=legacyAppBackend((async input=>{
    const url=new URL(String(input),'http://localhost'),path=url.pathname
    seen.push(path+url.search)
    if(path==='/api/providers')return reply({providers:[{id:'openrouter',hire_enabled:true,status:{installed:true}}]})
    if(path==='/api/accounts')return reply({accounts:[]})
    if(path==='/api/openrouter/usage')return reply(readings.openrouter)
    if(path==='/api/openrouter/keys/usage')return reply(readings)
    if(path==='/api/accounts/openrouter-2/usage')return new Promise<Response>(resolve=>{settle=resolve})
    if(path==='/api/langservers')return reply({servers:[]})
    return reply({available:false,limits:[]})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<UsageModal close={()=>{}} toast={()=>{}}/>,el=>el)
    await inAct(async()=>{await flush(12)})
    const cards=[...view.el.querySelectorAll<HTMLElement>('.usage-acct')]
    const two=cards.find(card=>card.textContent?.includes('Team budget (openrouter-2)'))!
    const three=cards.find(card=>card.textContent?.includes('Other budget (openrouter-3)'))!
    assert.ok(two);assert.ok(three)
    const button=two.querySelector<HTMLButtonElement>('[aria-label="refresh openrouter-2 usage"]')
    const other=three.querySelector<HTMLButtonElement>('[aria-label="refresh openrouter-3 usage"]')
    assert.ok(button,'secondary key gets the shared Refresh control')
    assert.ok(other,'every added key gets its own Refresh control')
    assert.ok(view.el.querySelector('[aria-label="refresh OpenRouter usage"]'),'original keeps Refresh')
    assert.equal(seen.some(url=>url.startsWith('/api/accounts/openrouter-')),false,'ordinary key reads remain cache-only')
    const stamp=two.querySelector('.usage-updated')?.getAttribute('title')
    assert.ok(stamp)
    await inAct(async()=>{button.click();await flush(4)})
    assert.equal(button.getAttribute('aria-busy'),'true')
    assert.equal(other.getAttribute('aria-busy'),'false')
    await inAct(async()=>{button.click();await flush(4)})
    assert.deepEqual(seen.filter(url=>url.includes('force=')),['/api/accounts/openrouter-2/usage?force=true'],
      'pending duplicate cannot force another call or any sibling/original key')
    assert.ok(settle,'the key-specific synthetic request reached the endpoint')
    await inAct(async()=>{settle!(await reply({...readings['openrouter-2'],error:'key provider failed'}));await flush(12)})
    assert.match(two.querySelector('[role="alert"]')?.textContent??'',/refresh failed: key provider failed/)
    assert.match(two.textContent??'',/22%/)
    assert.equal(two.querySelector('.usage-updated')?.getAttribute('title'),stamp)
    assert.match(three.textContent??'',/63%/)
    assert.equal(three.querySelector('[role="alert"]'),null)
    await inAct(async()=>{button.click();await flush(4)})
    await inAct(async()=>{settle!(await reply({...readings['openrouter-2'],limits:good('openrouter-2',23).limits}));await flush(12)})
    assert.equal(two.querySelector('[role="alert"]'),null)
    assert.match(two.textContent??'',/23%/)
    await inAct(async()=>{button.click();await flush(4)})
    await inAct(async()=>{settle!(new Response(JSON.stringify({detail:'key endpoint down'}),{status:500,
      headers:{'Content-Type':'application/json'}}));await flush(12)})
    assert.match(two.querySelector('[role="alert"]')?.textContent??'',/refresh failed: .*key endpoint down/)
    assert.match(two.textContent??'',/23%/)
    assert.equal(other.getAttribute('aria-busy'),'false')
  }finally{await view?.unmount();globalThis.fetch=before}
})
